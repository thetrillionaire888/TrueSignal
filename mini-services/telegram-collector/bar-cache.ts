// Read-through cache for Dukascopy OHLC bars.
// Checks SQLite first (market.PriceBar — attached market.db), fetches only
// missing time ranges from Dukascopy, and stores the fetched bars for future
// reuse. Uses the shared `sqlite` connection from `@/lib/db`.
//
// Notes:
//   - All PriceBar queries use the `market.PriceBar` prefix because the
//     bars live in the attached market.db.
//   - Batch-inserts bars in a single transaction to amortize COMMIT cost.
//   - `$`-prefixed named params work in both bun:sqlite and better-sqlite3.
import { getHistoricalRates } from "dukascopy-node";
import { sqlite } from "@/lib/db";

// 15-minute bar = 900000 ms
const BAR_INTERVALS: Record<string, number> = {
  m1: 60_000,
  m5: 300_000,
  m15: 900_000,
  m30: 1_800_000,
  h1: 3_600_000,
  h4: 14_400_000,
  d1: 86_400_000,
};

const stmts = {
  getCachedRange: sqlite.prepare(
    "SELECT timestamp, open, high, low, close, volume FROM market.PriceBar WHERE instrument = $instrument AND timeframe = $timeframe AND timestamp >= $from AND timestamp < $to ORDER BY timestamp ASC"
  ),
  countCachedRange: sqlite.prepare(
    "SELECT COUNT(*) as c FROM market.PriceBar WHERE instrument = $instrument AND timeframe = $timeframe AND timestamp >= $from AND timestamp < $to"
  ),
  insertBar: sqlite.prepare(
    "INSERT OR IGNORE INTO market.PriceBar (source, instrument, timeframe, timestamp, open, high, low, close, volume, fetchedAt) VALUES ($source, $instrument, $timeframe, $timestamp, $open, $high, $low, $close, $volume, datetime('now'))"
  ),
  totalCached: sqlite.prepare(
    "SELECT COUNT(*) as c FROM market.PriceBar WHERE instrument = $instrument AND timeframe = $timeframe"
  ),
  cacheSummary: sqlite.prepare(
    "SELECT source, instrument, COUNT(*) as c, MIN(timestamp) as earliest, MAX(timestamp) as latest FROM market.PriceBar GROUP BY source, instrument ORDER BY source, instrument"
  ),
  totalBars: sqlite.prepare("SELECT COUNT(*) as c FROM market.PriceBar"),
};

export type Bar = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export type CacheStats = {
  cached: number;
  fetched: number;
  total: number;
};

/**
 * Batch-insert bars in a single transaction. Each insert uses INSERT OR IGNORE
 * so duplicates (same source+instrument+timeframe+timestamp PK) are silently
 * skipped. Returns the count of bars actually inserted (changes > 0).
 */
function batchInsertBars(
  source: string,
  instrument: string,
  timeframe: string,
  bars: Bar[]
): { inserted: number; skipped: number } {
  let inserted = 0;
  let skipped = 0;
  if (bars.length === 0) return { inserted, skipped };

  const tx = sqlite.transaction(() => {
    for (const bar of bars) {
      const result = stmts.insertBar.run({
        $source: source,
        $instrument: instrument,
        $timeframe: timeframe,
        $timestamp: bar.timestamp,
        $open: bar.open,
        $high: bar.high,
        $low: bar.low,
        $close: bar.close,
        $volume: bar.volume,
      }) as { changes: number };
      if (result.changes > 0) inserted++;
      else skipped++;
    }
  });
  tx();
  return { inserted, skipped };
}

/**
 * Fetch OHLC bars with read-through caching.
 * Returns bars for [fromTime, toTime) at the given timeframe.
 * Checks the DB cache first; only fetches missing bars from Dukascopy.
 */
export async function fetchBarsCached(
  instrument: string,
  timeframe: string,
  fromTime: Date,
  toTime: Date,
  onProgress?: (msg: string) => void
): Promise<{ bars: Bar[]; stats: CacheStats }> {
  const fromMs = fromTime.getTime();
  const toMs = toTime.getTime();
  const interval = BAR_INTERVALS[timeframe] ?? 900_000;
  void interval; // reserved for future gap-detection

  // Check what we already have cached for this exact time range
  const cachedCount = (stmts.countCachedRange.get({
    $instrument: instrument,
    $timeframe: timeframe,
    $from: fromMs,
    $to: toMs,
  }) as { c: number }).c;

  // Cache hit: if we already have bars for this range, use them directly.
  // Dukascopy doesn't return bars for weekends/market-closed periods, so the
  // actual count is always lower than the theoretical max. We treat any
  // non-zero cached count as a hit (the data was already fetched).
  if (cachedCount > 0) {
    const cachedBars = (stmts.getCachedRange.all({
      $instrument: instrument,
      $timeframe: timeframe,
      $from: fromMs,
      $to: toMs,
    }) as Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>).map(
      (r) => ({
        timestamp: r.timestamp,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
      })
    );
    onProgress?.(`cache hit: ${cachedBars.length} bars for ${instrument.toUpperCase()}`);
    return {
      bars: cachedBars,
      stats: { cached: cachedBars.length, fetched: 0, total: cachedBars.length },
    };
  }

  // Cache miss — fetch from Dukascopy
  onProgress?.(`fetching from Dukascopy for ${instrument.toUpperCase()}…`);
  let fetched: unknown[] = [];
  try {
    // Wrap in a 10s timeout — Dukascopy's free API frequently hangs
    // indefinitely (not just socket errors, but complete stalls).
    // Without this, the entire evaluation pipeline blocks forever.
    const FETCH_TIMEOUT = 10_000; // 10 seconds
    const fetchPromise = getHistoricalRates({
      instrument: instrument as unknown as never,
      dates: { from: fromTime, to: toTime },
      timeframe: timeframe as unknown as never,
      format: "array" as unknown as never,
      priceType: "bid" as unknown as never,
    });
    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Dukascopy fetch timed out after ${FETCH_TIMEOUT}ms`)), FETCH_TIMEOUT)
    );
    fetched = (await Promise.race([fetchPromise, timeoutPromise])) as unknown as unknown[][];
  } catch (e) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.warn(
      `[bar-cache] Dukascopy fetch failed for ${instrument} ${fromTime.toISOString()}: ${errMsg}`
    );

    // ── Fallback to Binance for crypto instruments ────────────────────────
    // Dukascopy is unreliable (hangs, socket errors, rate limiting).
    // Binance's free REST API is more reliable for crypto pairs.
    // Dukascopy uses "btcusd" but Binance uses "BTCUSDT" — map back.
    const binanceSymbol = instrument.toUpperCase().replace("USD", "USDT");
    const isCrypto = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
                       "AVAXUSDT", "LINKUSDT", "DOGEUSDT", "MATICUSDT", "ARBUSDT"]
                      .includes(binanceSymbol);
    if (isCrypto) {
      onProgress?.(`Dukascopy failed — trying Binance fallback for ${binanceSymbol}…`);
      try {
        const binanceInterval: Record<string, string> = {
          m1: "1m", m5: "5m", m15: "15m", m30: "30m", h1: "1h", h4: "4h", d1: "1d",
        };
        const bi = binanceInterval[timeframe] ?? "15m";
        const binanceUrl = new URL("https://api.binance.com/api/v3/klines");
        binanceUrl.searchParams.set("symbol", binanceSymbol);
        binanceUrl.searchParams.set("interval", bi);
        binanceUrl.searchParams.set("startTime", String(fromMs));
        binanceUrl.searchParams.set("endTime", String(toMs));
        binanceUrl.searchParams.set("limit", "1000");

        // Wrap Binance fetch in a 10s timeout too (same TLS hang issue)
        const binanceFetchPromise = fetch(binanceUrl.toString());
        const binanceTimeoutPromise = new Promise<Response>((_, reject) =>
          setTimeout(() => reject(new Error("Binance fetch timed out after 10s")), 10000)
        );
        const binanceRes = await Promise.race([binanceFetchPromise, binanceTimeoutPromise]);
        if (binanceRes.ok) {
          const binanceData = (await binanceRes.json()) as unknown[][];
          fetched = binanceData.map((row) => [
            Number(row[0]),  // timestamp
            parseFloat(row[1] as string),  // open
            parseFloat(row[2] as string),  // high
            parseFloat(row[3] as string),  // low
            parseFloat(row[4] as string),  // close
            parseFloat(row[5] as string),  // volume
          ]);
          onProgress?.(`Binance fallback: ${fetched.length} bars for ${binanceSymbol}`);
        }
      } catch (e2) {
        console.warn(`[bar-cache] Binance fallback also failed:`, e2 instanceof Error ? e2.message : String(e2));
      }
    }

    // If we got bars from Binance fallback, proceed to insert
    if (fetched.length === 0) {
      // Fall back to whatever we have cached
      const cachedBars = (stmts.getCachedRange.all({
        $instrument: instrument,
        $timeframe: timeframe,
        $from: fromMs,
        $to: toMs,
      }) as Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>).map(
        (r) => ({
          timestamp: r.timestamp,
          open: r.open,
          high: r.high,
          low: r.low,
          close: r.close,
          volume: r.volume,
        })
      );
      return {
        bars: cachedBars,
        stats: { cached: cachedBars.length, fetched: 0, total: cachedBars.length },
      };
    }
  }

  // Store fetched bars in the cache (batch-insert in a single transaction).
  const fetchedBars: Bar[] = [];
  for (const row of fetched) {
    const r = row as unknown[];
    fetchedBars.push({
      timestamp: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5] ?? 0),
    });
  }
  // Batch-insert in one transaction for amortized COMMIT cost.
  try {
    batchInsertBars("dukascopy", instrument, timeframe, fetchedBars);
  } catch {
    // INSERT OR IGNORE handles duplicates inside the transaction
  }

  // Merge cached + newly fetched (dedup by timestamp)
  const cachedBars = (stmts.getCachedRange.all({
    $instrument: instrument,
    $timeframe: timeframe,
    $from: fromMs,
    $to: toMs,
  }) as Array<{ timestamp: number; open: number; high: number; low: number; close: number; volume: number }>).map(
    (r) => ({
      timestamp: r.timestamp,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    })
  );

  const allBars = new Map<number, Bar>();
  for (const b of cachedBars) allBars.set(b.timestamp, b);
  for (const b of fetchedBars) allBars.set(b.timestamp, b);
  const merged = Array.from(allBars.values()).sort((a, b) => a.timestamp - b.timestamp);

  return {
    bars: merged,
    stats: {
      cached: cachedBars.length,
      fetched: fetchedBars.length,
      total: merged.length,
    },
  };
}

export function getCacheStats(instrument: string, timeframe: string): number {
  return (stmts.totalCached.get({ $instrument: instrument, $timeframe: timeframe }) as { c: number }).c;
}

// ── Generic bar import (for non-Dukascopy sources) ──────────────────────────
// Batch-inserts bars in a single transaction for efficiency.
export function importBars(
  source: string,
  instrument: string,
  timeframe: string,
  bars: Bar[]
): { inserted: number; skipped: number } {
  return batchInsertBars(source, instrument, timeframe, bars);
}

// ── Cache summary for the Data Manager UI ───────────────────────────────────
export function getCacheSummary() {
  const total = (stmts.totalBars.get() as { c: number }).c;
  const bySource = stmts.cacheSummary.all() as Array<{
    source: string;
    instrument: string;
    c: number;
    earliest: number;
    latest: number;
  }>;
  return {
    totalBars: total,
    groups: bySource.map((g) => ({
      source: g.source,
      instrument: g.instrument,
      count: g.c,
      earliest: g.earliest,
      latest: g.latest,
    })),
  };
}
