// Read-through cache for Dukascopy OHLC bars.
// Checks SQLite first, fetches only missing time ranges from Dukascopy,
// and stores the fetched bars for future reuse.
import { getHistoricalRates } from "dukascopy-node";
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { cuid } from "./cuid";

const DB_PATH = resolve(import.meta.dir, "../../db/custom.db");
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

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
  getCachedRange: db.prepare<
    { timestamp: number; open: number; high: number; low: number; close: number; volume: number },
    { $instrument: string; $timeframe: string; $from: number; $to: number }
  >(
    "SELECT timestamp, open, high, low, close, volume FROM PriceBar WHERE instrument = $instrument AND timeframe = $timeframe AND timestamp >= $from AND timestamp < $to ORDER BY timestamp ASC"
  ),
  countCachedRange: db.prepare<{ c: number }, { $instrument: string; $timeframe: string; $from: number; $to: number }>(
    "SELECT COUNT(*) as c FROM PriceBar WHERE instrument = $instrument AND timeframe = $timeframe AND timestamp >= $from AND timestamp < $to"
  ),
  insertBar: db.prepare<
    unknown,
    { $id: string; $source: string; $instrument: string; $timeframe: string; $timestamp: number; $open: number; $high: number; $low: number; $close: number; $volume: number }
  >(
    "INSERT OR IGNORE INTO PriceBar (id, source, instrument, timeframe, timestamp, open, high, low, close, volume, fetchedAt) VALUES ($id, $source, $instrument, $timeframe, $timestamp, $open, $high, $low, $close, $volume, datetime('now'))"
  ),
  totalCached: db.prepare<{ c: number }, { $instrument: string; $timeframe: string }>(
    "SELECT COUNT(*) as c FROM PriceBar WHERE instrument = $instrument AND timeframe = $timeframe"
  ),
  cacheSummary: db.prepare<
    { source: string; instrument: string; c: number; earliest: number; latest: number },
    Record<string, never>
  >("SELECT source, instrument, COUNT(*) as c, MIN(timestamp) as earliest, MAX(timestamp) as latest FROM PriceBar GROUP BY source, instrument ORDER BY source, instrument"),
  totalBars: db.prepare<{ c: number }, Record<string, never>>("SELECT COUNT(*) as c FROM PriceBar"),
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
    const cachedBars = stmts.getCachedRange
      .all({
        $instrument: instrument,
        $timeframe: timeframe,
        $from: fromMs,
        $to: toMs,
      })
      .map((r) => ({
        timestamp: r.timestamp,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
      }));
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
    fetched = (await getHistoricalRates({
      instrument,
      dates: { from: fromTime, to: toTime },
      timeframe: timeframe as unknown as never,
      format: "array" as unknown as never,
      priceType: "bid" as unknown as never,
    })) as unknown as unknown[][];
  } catch (e) {
    console.warn(
      `[bar-cache] Dukascopy fetch failed for ${instrument} ${fromTime.toISOString()}:`,
      e instanceof Error ? e.message : String(e)
    );
    // Fall back to whatever we have cached
    const cachedBars = stmts.getCachedRange
      .all({
        $instrument: instrument,
        $timeframe: timeframe,
        $from: fromMs,
        $to: toMs,
      })
      .map((r) => ({
        timestamp: r.timestamp,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume,
      }));
    return {
      bars: cachedBars,
      stats: { cached: cachedBars.length, fetched: 0, total: cachedBars.length },
    };
  }

  // Store fetched bars in the cache (insert OR IGNORE for idempotency)
  const bars: Bar[] = [];
  for (const row of fetched) {
    const r = row as unknown[];
    const bar: Bar = {
      timestamp: Number(r[0]),
      open: Number(r[1]),
      high: Number(r[2]),
      low: Number(r[3]),
      close: Number(r[4]),
      volume: Number(r[5] ?? 0),
    };
    bars.push(bar);
    try {
      stmts.insertBar.run({
        $id: cuid(),
        $source: "dukascopy",
        $instrument: instrument,
        $timeframe: timeframe,
        $timestamp: bar.timestamp,
        $open: bar.open,
        $high: bar.high,
        $low: bar.low,
        $close: bar.close,
        $volume: bar.volume,
      });
    } catch {
      // INSERT OR IGNORE handles duplicates
    }
  }

  // Merge cached + newly fetched (dedup by timestamp)
  const cachedBars = stmts.getCachedRange
    .all({
      $instrument: instrument,
      $timeframe: timeframe,
      $from: fromMs,
      $to: toMs,
    })
    .map((r) => ({
      timestamp: r.timestamp,
      open: r.open,
      high: r.high,
      low: r.low,
      close: r.close,
      volume: r.volume,
    }));

  const allBars = new Map<number, Bar>();
  for (const b of cachedBars) allBars.set(b.timestamp, b);
  for (const b of bars) allBars.set(b.timestamp, b);
  const merged = Array.from(allBars.values()).sort((a, b) => a.timestamp - b.timestamp);

  return {
    bars: merged,
    stats: {
      cached: cachedBars.length,
      fetched: bars.length,
      total: merged.length,
    },
  };
}

export function getCacheStats(instrument: string, timeframe: string): number {
  return (stmts.totalCached.get({ $instrument: instrument, $timeframe: timeframe }) as { c: number }).c;
}

// ── Generic bar import (for non-Dukascopy sources) ──────────────────────────
export function importBars(
  source: string,
  instrument: string,
  timeframe: string,
  bars: Bar[]
): { inserted: number; skipped: number } {
  let inserted = 0;
  let skipped = 0;
  for (const bar of bars) {
    try {
      const result = stmts.insertBar.run({
        $id: cuid(),
        $source: source,
        $instrument: instrument,
        $timeframe: timeframe,
        $timestamp: bar.timestamp,
        $open: bar.open,
        $high: bar.high,
        $low: bar.low,
        $close: bar.close,
        $volume: bar.volume,
      });
      if (result.changes > 0) inserted++;
      else skipped++;
    } catch {
      skipped++;
    }
  }
  return { inserted, skipped };
}

// ── Cache summary for the Data Manager UI ───────────────────────────────────
export function getCacheSummary() {
  const total = (stmts.totalBars.get({} as Record<string, never>) as { c: number }).c;
  const bySource = stmts.cacheSummary.all({} as Record<string, never>);
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
