// Read-through cache for OHLC bars with multi-source fallback.
//
// Source priority (for maximum reliability):
//   - Crypto (BTC, ETH, SOL, ...): Binance REST → Binance Vision → Dukascopy
//   - Forex/Metals/Indices/Energy: Dukascopy → Yahoo Finance
//
// Dukascopy is unreliable (frequent socket errors, hangs, rate limiting).
// Binance's free REST API is far more reliable for crypto pairs and is
// tried first. For non-crypto instruments, Yahoo Finance serves as a
// fallback when Dukascopy fails.
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
  source?: string;
};

// ── Instrument classification ───────────────────────────────────────────────
// Determines which data sources can serve this instrument and in what order.

type InstrumentCategory = "crypto" | "forex" | "metal" | "index" | "energy" | "unknown";

const CRYPTO_INSTRUMENTS = new Set([
  "btcusd", "btcusdt", "ethusd", "ethusdt", "solusd", "solusdt",
  "bnbusd", "bnbusdt", "xrpusd", "xrpusdt", "adausd", "adausdt",
  "dotusd", "dotusdt", "linkusd", "linkusdt", "avaxusd", "avaxusdt",
  "dogeusd", "dogeusdt", "maticusd", "maticusdt", "arbusd", "arbusdt",
  "ltcusd", "ltcusdt",
]);

const METAL_INSTRUMENTS = new Set(["xauusd", "xagusd", "xptusd", "xpdusd"]);

const INDEX_INSTRUMENTS = new Set(["spx500", "us30", "nas100", "ger40", "uk100", "jpn225", "fra40"]);

const ENERGY_INSTRUMENTS = new Set(["wtiusd", "wti", "brent", "natgas"]);

function classifyInstrument(instrument: string): InstrumentCategory {
  const key = instrument.toLowerCase().replace(/z$/, "").replace(/usdt$/, "usd");
  if (CRYPTO_INSTRUMENTS.has(key)) return "crypto";
  if (METAL_INSTRUMENTS.has(key)) return "metal";
  if (INDEX_INSTRUMENTS.has(key)) return "index";
  if (ENERGY_INSTRUMENTS.has(key)) return "energy";
  // Forex: 6-letter XXXYYY pattern (e.g. eurusd, gbpjpy)
  if (/^[a-z]{6}$/.test(key)) return "forex";
  return "unknown";
}

// ── Yahoo Finance symbol mapping ─────────────────────────────────────────────
// Maps our instrument IDs to Yahoo Finance ticker symbols.
const YAHOO_SYMBOL_MAP: Record<string, string> = {
  // Metals
  xauusd: "GC=F",   // Gold futures (most liquid)
  xagusd: "SI=F",   // Silver futures
  xptusd: "PL=F",   // Platinum futures
  xpdusd: "PA=F",   // Palladium futures
  // Indices
  spx500: "^GSPC",  // S&P 500
  us30:   "^DJI",   // Dow Jones
  nas100: "^NDX",   // Nasdaq 100
  ger40:  "^GDAXI", // DAX
  uk100:  "^FTSE",  // FTSE 100
  jpn225: "^N225",  // Nikkei 225
  fra40:  "^FCHI",  // CAC 40
  // Energy
  wtiusd: "CL=F",   // WTI Crude Oil futures
  wti:    "CL=F",
  brent:  "BZ=F",   // Brent Crude Oil futures
  natgas: "NG=F",   // Natural Gas futures
};

function toYahooSymbol(instrument: string): string | null {
  const key = instrument.toLowerCase().replace(/z$/, "").replace(/usdt$/, "usd");
  if (YAHOO_SYMBOL_MAP[key]) return YAHOO_SYMBOL_MAP[key];
  // Forex: eurusd → EURUSD=X, gbpjpy → GBPJPY=X
  if (/^[a-z]{6}$/.test(key)) return `${key.toUpperCase()}=X`;
  return null;
}

// ── Binance symbol mapping ───────────────────────────────────────────────────
function toBinanceSymbol(instrument: string): string {
  let s = instrument.toUpperCase().replace(/Z$/, "");
  if (!s.endsWith("USDT") && !s.endsWith("BUSD") && !s.endsWith("USDC")) {
    if (s.endsWith("USD")) s = s + "T"; // BTCUSD → BTCUSDT
    else s = s + "USDT";
  }
  return s;
}

// ── Timeframe mapping ────────────────────────────────────────────────────────
const BINANCE_INTERVAL: Record<string, string> = {
  m1: "1m", m5: "5m", m15: "15m", m30: "30m", h1: "1h", h4: "4h", d1: "1d",
};

const YAHOO_INTERVAL: Record<string, string> = {
  m1: "1m", m5: "5m", m15: "15m", m30: "30m", h1: "60m", h4: "60m", d1: "1d",
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

// ── Source fetchers ──────────────────────────────────────────────────────────
// Each fetcher is a standalone function that:
//   - Takes (instrument, timeframe, fromTime, toTime, onProgress)
//   - Returns Bar[] on success
//   - Throws on failure (so the dispatcher can try the next source)
//   - Has its own timeout and retry logic

const FETCH_TIMEOUT = 10_000; // 10s per source attempt
const DUKASCOPY_TIMEOUT = 5_000; // 5s — Dukascopy is unreliable, fail fast

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Fetch from Dukascopy. Unreliable — frequent socket errors and hangs.
 * Short timeout (5s) so we fail fast and move to the next source.
 */
async function fetchFromDukascopy(
  instrument: string,
  timeframe: string,
  fromTime: Date,
  toTime: Date,
  onProgress?: (msg: string) => void
): Promise<Bar[]> {
  onProgress?.(`Dukascopy: fetching ${instrument.toUpperCase()}…`);
  try {
    const fetched = await withTimeout(
      getHistoricalRates({
        instrument: instrument as unknown as never,
        dates: { from: fromTime, to: toTime },
        timeframe: timeframe as unknown as never,
        format: "array" as unknown as never,
        priceType: "bid" as unknown as never,
      }),
      DUKASCOPY_TIMEOUT,
      "Dukascopy"
    ) as unknown as unknown[][];
    const bars: Bar[] = (fetched || []).map((row) => ({
      timestamp: Number(row[0]),
      open: Number(row[1]),
      high: Number(row[2]),
      low: Number(row[3]),
      close: Number(row[4]),
      volume: Number(row[5] ?? 0),
    }));
    onProgress?.(`Dukascopy: ${bars.length} bars`);
    return bars;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`[bar-cache] Dukascopy failed for ${instrument}: ${msg}`);
    throw e; // re-throw so dispatcher can try next source
  }
}

/**
 * Fetch from Binance REST API. Reliable for crypto pairs.
 * Retries up to 3 times on transient errors (TLS, rate limiting).
 */
async function fetchFromBinanceRest(
  instrument: string,
  timeframe: string,
  fromTime: Date,
  toTime: Date,
  onProgress?: (msg: string) => void
): Promise<Bar[]> {
  const symbol = toBinanceSymbol(instrument);
  const interval = BINANCE_INTERVAL[timeframe] ?? "15m";
  onProgress?.(`Binance REST: fetching ${symbol}…`);

  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const url = new URL("https://api.binance.com/api/v3/klines");
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("interval", interval);
      url.searchParams.set("startTime", String(fromTime.getTime()));
      url.searchParams.set("endTime", String(toTime.getTime()));
      url.searchParams.set("limit", "1000");

      const res = await withTimeout(fetch(url.toString()), FETCH_TIMEOUT, "Binance REST");
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Binance API error ${res.status}: ${body.slice(0, 200)}`);
      }
      const data = (await res.json()) as unknown[][];
      const bars: Bar[] = data.map((row) => ({
        timestamp: Number(row[0]),
        open: parseFloat(row[1] as string),
        high: parseFloat(row[2] as string),
        low: parseFloat(row[3] as string),
        close: parseFloat(row[4] as string),
        volume: parseFloat(row[5] as string),
      }));
      onProgress?.(`Binance REST: ${bars.length} bars for ${symbol}`);
      return bars;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[bar-cache] Binance REST attempt ${attempt + 1}/3 failed: ${msg}`);
      if (attempt < 2) await sleep(1000 * Math.pow(2, attempt)); // 1s, 2s backoff
    }
  }
  throw lastErr;
}

/**
 * Fetch from Binance Vision data archive (CDN-backed ZIP files).
 * Very reliable — no auth, no rate limit, served via CloudFront/S3.
 * URL pattern: data.binance.vision/data/spot/daily/klines/{SYMBOL}/{INTERVAL}/{SYMBOL}-{INTERVAL}-{DATE}.zip
 */
async function fetchFromBinanceVision(
  instrument: string,
  timeframe: string,
  fromTime: Date,
  toTime: Date,
  onProgress?: (msg: string) => void
): Promise<Bar[]> {
  const symbol = toBinanceSymbol(instrument);
  const interval = BINANCE_INTERVAL[timeframe] ?? "15m";
  onProgress?.(`Binance Vision: fetching ${symbol}…`);

  const { writeFileSync, readFileSync, unlinkSync } = await import("node:fs");
  const { execSync } = await import("node:child_process");
  const allBars: Bar[] = [];

  // Iterate each day in the range
  const dayStart = new Date(fromTime);
  dayStart.setUTCHours(0, 0, 0, 0);
  const dayEnd = new Date(toTime);

  for (let d = new Date(dayStart); d <= dayEnd; d.setUTCDate(d.getUTCDate() + 1)) {
    const dateStr = d.toISOString().slice(0, 10);
    const url = `https://data.binance.vision/data/spot/daily/klines/${symbol}/${interval}/${symbol}-${interval}-${dateStr}.zip`;

    try {
      const res = await withTimeout(fetch(url), FETCH_TIMEOUT, `Binance Vision ${dateStr}`);
      if (!res.ok) continue; // skip missing days (weekends, future dates)

      const zipBuf = await res.arrayBuffer();
      const tmpZip = `/tmp/binance-${symbol}-${interval}-${dateStr}.zip`;
      const tmpCsv = `/tmp/${symbol}-${interval}-${dateStr}.csv`;
      writeFileSync(tmpZip, new Uint8Array(zipBuf));
      try {
        execSync(`cd /tmp && unzip -o "${tmpZip}" 2>/dev/null`);
        const csv = readFileSync(tmpCsv, "utf-8");
        const lines = csv.trim().split("\n");
        for (const line of lines) {
          const cols = line.split(",");
          allBars.push({
            timestamp: Math.floor(Number(cols[0]) / 1000), // microseconds → milliseconds
            open: parseFloat(cols[1]),
            high: parseFloat(cols[2]),
            low: parseFloat(cols[3]),
            close: parseFloat(cols[4]),
            volume: parseFloat(cols[5]),
          });
        }
        unlinkSync(tmpCsv);
      } catch {
        // unzip might not be available
      }
      unlinkSync(tmpZip);
    } catch {
      // skip this day on any error
    }
  }

  // Filter to the requested time range
  const fromMs = fromTime.getTime();
  const toMs = toTime.getTime();
  const bars = allBars.filter((b) => b.timestamp >= fromMs && b.timestamp < toMs);
  onProgress?.(`Binance Vision: ${bars.length} bars for ${symbol}`);
  if (bars.length === 0) throw new Error(`Binance Vision: no bars for ${symbol}`);
  return bars;
}

/**
 * Fetch from Yahoo Finance. Covers forex, metals, indices, energy.
 * Yahoo returns timestamps in seconds; we store milliseconds.
 */
async function fetchFromYahoo(
  instrument: string,
  timeframe: string,
  fromTime: Date,
  toTime: Date,
  onProgress?: (msg: string) => void
): Promise<Bar[]> {
  const symbol = toYahooSymbol(instrument);
  if (!symbol) throw new Error(`Yahoo: cannot map ${instrument} to a symbol`);
  const interval = YAHOO_INTERVAL[timeframe] ?? "1d";
  onProgress?.(`Yahoo: fetching ${symbol}…`);

  let lastErr: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
      url.searchParams.set("period1", String(Math.floor(fromTime.getTime() / 1000)));
      url.searchParams.set("period2", String(Math.floor(toTime.getTime() / 1000)));
      url.searchParams.set("interval", interval);
      url.searchParams.set("includePrePost", "false");

      const res = await withTimeout(
        fetch(url.toString(), { headers: { "User-Agent": "Mozilla/5.0" } }),
        FETCH_TIMEOUT,
        "Yahoo"
      );
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Yahoo API error ${res.status}: ${body.slice(0, 200)}`);
      }
      const json = (await res.json()) as {
        chart?: {
          result?: Array<{
            timestamp?: number[];
            indicators?: {
              quote?: Array<{
                open?: number[];
                high?: number[];
                low?: number[];
                close?: number[];
                volume?: number[];
              }>;
            };
          }>;
          error?: { description?: string };
        };
      };
      const result = json.chart?.result?.[0];
      if (!result || !result.timestamp) {
        const errMsg = json.chart?.error?.description ?? "no data";
        throw new Error(`Yahoo: ${errMsg}`);
      }
      const ts = result.timestamp;
      const q = result.indicators?.quote?.[0];
      if (!q) throw new Error("Yahoo: no quote data");

      const bars: Bar[] = [];
      for (let i = 0; i < ts.length; i++) {
        if (q.open?.[i] == null || q.close?.[i] == null) continue;
        bars.push({
          timestamp: ts[i] * 1000, // seconds → millis
          open: q.open[i]!,
          high: q.high?.[i] ?? q.open[i]!,
          low: q.low?.[i] ?? q.open[i]!,
          close: q.close[i]!,
          volume: q.volume?.[i] ?? 0,
        });
      }
      onProgress?.(`Yahoo: ${bars.length} bars for ${symbol}`);
      if (bars.length === 0) throw new Error(`Yahoo: no bars for ${symbol}`);
      return bars;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      console.warn(`[bar-cache] Yahoo attempt ${attempt + 1}/2 failed: ${msg}`);
      if (attempt < 1) await sleep(1000);
    }
  }
  throw lastErr;
}

// ── Source priority dispatcher ───────────────────────────────────────────────
type SourceFetcher = {
  name: string;
  sourceLabel: string; // value stored in PriceBar.source column
  fetch: (instrument: string, timeframe: string, from: Date, to: Date, onProgress?: (msg: string) => void) => Promise<Bar[]>;
};

/**
 * Get the ordered list of data sources to try for this instrument.
 * Crypto: Binance first (more reliable), then Dukascopy (last resort).
 * Non-crypto: Dukascopy first (more comprehensive), then Yahoo (fallback).
 */
function getSourcePriority(instrument: string): SourceFetcher[] {
  const category = classifyInstrument(instrument);

  if (category === "crypto") {
    return [
      { name: "Binance REST", sourceLabel: "binance", fetch: fetchFromBinanceRest },
      { name: "Binance Vision", sourceLabel: "binance", fetch: fetchFromBinanceVision },
      { name: "Dukascopy", sourceLabel: "dukascopy", fetch: fetchFromDukascopy },
    ];
  }

  // Non-crypto: Dukascopy first, Yahoo as fallback.
  // Dukascopy has more comprehensive historical data and supports m15 natively.
  // Yahoo is a good fallback when Dukascopy is unreachable.
  return [
    { name: "Dukascopy", sourceLabel: "dukascopy", fetch: fetchFromDukascopy },
    { name: "Yahoo", sourceLabel: "yahoo", fetch: fetchFromYahoo },
  ];
}

// ── Main entry point: fetch with read-through cache + multi-source fallback ──
/**
 * Fetch OHLC bars with read-through caching.
 * Returns bars for [fromTime, toTime) at the given timeframe.
 *
 * Source priority (for maximum reliability):
 *   - Crypto: Binance REST → Binance Vision → Dukascopy
 *   - Non-crypto: Dukascopy → Yahoo Finance
 *
 * Pass forceRefresh=true to bypass the cache-hit optimization and always
 * try fetching fresh data. Useful for re-evaluating 'no_data' signals.
 */
export async function fetchBarsCached(
  instrument: string,
  timeframe: string,
  fromTime: Date,
  toTime: Date,
  onProgress?: (msg: string) => void,
  forceRefresh: boolean = false
): Promise<{ bars: Bar[]; stats: CacheStats }> {
  const fromMs = fromTime.getTime();
  const toMs = toTime.getTime();
  void BAR_INTERVALS[timeframe]; // reserved for future gap-detection

  // Check what we already have cached for this exact time range
  const cachedCount = (stmts.countCachedRange.get({
    $instrument: instrument,
    $timeframe: timeframe,
    $from: fromMs,
    $to: toMs,
  }) as { c: number }).c;

  // Cache hit: if we already have bars for this range, use them directly.
  // Skip this optimization when forceRefresh=true.
  if (!forceRefresh && cachedCount > 0) {
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

  // ── Cache miss — try each source in priority order ───────────────────────
  const sources = getSourcePriority(instrument);
  let lastError: unknown = null;

  for (const source of sources) {
    try {
      const bars = await source.fetch(instrument, timeframe, fromTime, toTime, onProgress);
      if (bars.length > 0) {
        // Store fetched bars in the cache (batch-insert in a single transaction).
        try {
          batchInsertBars(source.sourceLabel, instrument, timeframe, bars);
        } catch {
          // INSERT OR IGNORE handles duplicates inside the transaction
        }
        onProgress?.(`${source.name}: success — ${bars.length} bars (cached for future use)`);

        // Re-read from cache to get the merged view (cached + newly fetched)
        const mergedBars = (stmts.getCachedRange.all({
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
          bars: mergedBars,
          stats: {
            cached: mergedBars.length - bars.length,
            fetched: bars.length,
            total: mergedBars.length,
            source: source.name,
          },
        };
      }
    } catch (e) {
      lastError = e;
      const msg = e instanceof Error ? e.message : String(e);
      onProgress?.(`${source.name}: failed — ${msg.slice(0, 100)}`);
      // continue to next source
    }
  }

  // ── All sources failed — fall back to whatever we have cached ───────────
  onProgress?.(`all sources failed — falling back to cache (${cachedCount} bars)`);
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
