/**
 * Import XAUUSD M1 data from StrategyQuant/Dukascopy CSV export into market.db.
 *
 * Input format: Date,Time,Open,High,Low,Close,Volume
 *   Date: YYYYMMDD
 *   Time: HH:MM:SS
 *
 * Aggregates M1 → M15 (the timeframe used by the evaluator):
 *   - Groups bars into 15-minute buckets
 *   - open  = open of first bar in bucket
 *   - high  = max of all highs in bucket
 *   - low   = min of all lows in bucket
 *   - close = close of last bar in bucket
 *   - volume = sum of all volumes in bucket
 *
 * Inserts into market.PriceBar with:
 *   source='dukascopy', instrument='xauusd', timeframe='m15'
 *
 * Uses INSERT OR IGNORE so existing bars aren't overwritten (same source,
 * same values for overlapping timestamps — safe).
 *
 * Usage:
 *   bun scripts/import-xauusd-csv.ts /path/to/file.csv
 *   bun scripts/import-xauusd-csv.ts  # defaults to upload dir
 */
import { getMarketDbSync } from "@/lib/market-db";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_FILE = "/home/z/my-project/upload/2026.7.12XAUUSD_M1_dukas-M1-No Session.csv";
const INSTRUMENT = "xauusd";
const TIMEFRAME = "m15";
const SOURCE = "dukascopy";

// 15 minutes in milliseconds
const M15_MS = 15 * 60 * 1000;

// Get the per-asset DB connection for this instrument+timeframe
const marketDb = getMarketDbSync(INSTRUMENT, TIMEFRAME);

const insertStmt = marketDb.prepare(
  `INSERT OR IGNORE INTO PriceBar
     (source, instrument, timeframe, timestamp, open, high, low, close, volume, fetchedAt)
   VALUES ($source, $instrument, $timeframe, $timestamp, $open, $high, $low, $close, $volume, datetime('now'))`
);

type M1Bar = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

type M15Bar = {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

/**
 * Parse a row like "20240506,01:00:00,2304.655,2305.855,2303.055,2303.255,93470"
 * into an M1 bar with epoch-millisecond timestamp.
 */
function parseRow(line: string): M1Bar | null {
  const cols = line.split(",");
  if (cols.length < 7) return null;

  const dateStr = cols[0].trim(); // YYYYMMDD
  const timeStr = cols[1].trim(); // HH:MM:SS

  // Parse date: YYYYMMDD
  const year = parseInt(dateStr.slice(0, 4), 10);
  const month = parseInt(dateStr.slice(4, 6), 10);
  const day = parseInt(dateStr.slice(6, 8), 10);
  if (isNaN(year) || isNaN(month) || isNaN(day)) return null;

  // Parse time: HH:MM:SS
  const timeParts = timeStr.split(":");
  const hour = parseInt(timeParts[0], 10);
  const minute = parseInt(timeParts[1], 10);
  const second = timeParts.length > 2 ? parseInt(timeParts[2], 10) : 0;
  if (isNaN(hour) || isNaN(minute)) return null;

  // Build Date in UTC
  const ts = Date.UTC(year, month - 1, day, hour, minute, second);

  const open = parseFloat(cols[2]);
  const high = parseFloat(cols[3]);
  const low = parseFloat(cols[4]);
  const close = parseFloat(cols[5]);
  const volume = parseInt(cols[6], 10) || 0;

  if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) return null;
  // Skip zero-price rows (no-data bars from "No Session" filter)
  if (open === 0 && high === 0 && low === 0 && close === 0) return null;

  return { timestamp: ts, open, high, low, close, volume };
}

/**
 * Aggregate M1 bars into M15 bars.
 * Groups by 15-minute bucket: timestamp → floor(timestamp / M15_MS) * M15_MS
 */
function aggregateM1toM15(m1Bars: M1Bar[]): M15Bar[] {
  const buckets = new Map<number, M1Bar[]>();

  for (const bar of m1Bars) {
    const bucketTs = Math.floor(bar.timestamp / M15_MS) * M15_MS;
    if (!buckets.has(bucketTs)) {
      buckets.set(bucketTs, []);
    }
    buckets.get(bucketTs)!.push(bar);
  }

  const m15Bars: M15Bar[] = [];
  for (const [bucketTs, bars] of buckets) {
    // Sort by timestamp within bucket (should already be sorted, but just in case)
    bars.sort((a, b) => a.timestamp - b.timestamp);

    const open = bars[0].open;
    const high = Math.max(...bars.map((b) => b.high));
    const low = Math.min(...bars.map((b) => b.low));
    const close = bars[bars.length - 1].close;
    const volume = bars.reduce((sum, b) => sum + b.volume, 0);

    m15Bars.push({ timestamp: bucketTs, open, high, low, close, volume });
  }

  // Sort by timestamp
  m15Bars.sort((a, b) => a.timestamp - b.timestamp);
  return m15Bars;
}

async function main() {
  const filePath = process.argv[2] || DEFAULT_FILE;
  console.log(`Importing XAUUSD M1 data from: ${filePath}`);
  console.log(`Target: market.PriceBar (source=${SOURCE}, instrument=${INSTRUMENT}, timeframe=${TIMEFRAME})`);
  console.log();

  // Read and parse the file
  console.log("Reading file…");
  const text = readFileSync(filePath, "utf-8");
  const lines = text.trim().split("\n");
  console.log(`Total lines: ${lines.length}`);

  // Skip header
  const header = lines[0];
  console.log(`Header: ${header}`);

  let m1Bars: M1Bar[] = [];
  let skipped = 0;
  let lineNum = 0;

  for (let i = 1; i < lines.length; i++) {
    lineNum = i;
    const bar = parseRow(lines[i]);
    if (bar) {
      m1Bars.push(bar);
    } else {
      skipped++;
    }
  }

  console.log(`Parsed M1 bars: ${m1Bars.length}`);
  console.log(`Skipped (zero-price or invalid): ${skipped}`);

  if (m1Bars.length === 0) {
    console.error("No valid bars to import. Aborting.");
    process.exit(1);
  }

  // Show date range
  const firstTs = m1Bars[0].timestamp;
  const lastTs = m1Bars[m1Bars.length - 1].timestamp;
  console.log(`M1 date range: ${new Date(firstTs).toISOString()} → ${new Date(lastTs).toISOString()}`);
  console.log();

  // Aggregate M1 → M15
  console.log("Aggregating M1 → M15…");
  const m15Bars = aggregateM1toM15(m1Bars);
  console.log(`M15 bars: ${m15Bars.length}`);
  console.log(`M15 date range: ${new Date(m15Bars[0].timestamp).toISOString()} → ${new Date(m15Bars[m15Bars.length - 1].timestamp).toISOString()}`);
  console.log();

  // Check what's currently in the DB
  const existingCount = (marketDb.prepare(
    "SELECT COUNT(*) as c FROM PriceBar"
  ).get() as { c: number }).c;
  console.log(`Existing ${INSTRUMENT} ${TIMEFRAME} bars in DB: ${existingCount}`);

  // Insert in batches (transaction for speed)
  console.log("Inserting bars (INSERT OR IGNORE)…");
  const BATCH_SIZE = 1000;
  let inserted = 0;
  let ignored = 0;
  let totalProcessed = 0;

  const startTime = Date.now();

  for (let i = 0; i < m15Bars.length; i += BATCH_SIZE) {
    const batch = m15Bars.slice(i, i + BATCH_SIZE);

    const tx = marketDb.transaction(() => {
      for (const bar of batch) {
        const result = insertStmt.run({
          $source: SOURCE,
          $instrument: INSTRUMENT,
          $timeframe: TIMEFRAME,
          $timestamp: bar.timestamp,
          $open: bar.open,
          $high: bar.high,
          $low: bar.low,
          $close: bar.close,
          $volume: bar.volume,
        }) as { changes: number };
        if (result.changes > 0) inserted++;
        else ignored++;
      }
    });
    tx();

    totalProcessed += batch.length;
    if (totalProcessed % 5000 === 0 || totalProcessed === m15Bars.length) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`  ${totalProcessed}/${m15Bars.length} processed (${inserted} inserted, ${ignored} ignored) — ${elapsed}s`);
    }
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log();
  console.log("─".repeat(60));
  console.log(`Import complete in ${elapsed}s`);
  console.log(`  Inserted: ${inserted}`);
  console.log(`  Ignored (already existed): ${ignored}`);
  console.log(`  Total processed: ${totalProcessed}`);

  // Verify
  const newCount = (marketDb.prepare(
    "SELECT COUNT(*) as c FROM PriceBar"
  ).get() as { c: number }).c;
  console.log(`  DB now has: ${newCount} ${INSTRUMENT} ${TIMEFRAME} bars (was ${existingCount})`);

  const range = marketDb.prepare(
    "SELECT MIN(timestamp) as earliest, MAX(timestamp) as latest FROM PriceBar"
  ).get() as { earliest: number; latest: number };
  console.log(`  Date range: ${new Date(range.earliest).toISOString()} → ${new Date(range.latest).toISOString()}`);
  console.log();
}

main().catch((e) => {
  console.error("Fatal error:", e);
  process.exit(1);
});
