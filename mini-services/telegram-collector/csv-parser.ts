// Flexible CSV parser for OHLC bar data.
//
// Supports multiple common export formats:
//   1. StrategyQuant / Dukascopy:  Date,Time,Open,High,Low,Close,Volume
//      (Date=YYYYMMDD, Time=HH:MM:SS)
//   2. Combined datetime:          DateTime,Open,High,Low,Close,Volume
//      (DateTime = ISO 8601 or YYYY-MM-DD HH:MM:SS)
//   3. Unix timestamp:             timestamp,open,high,low,close,volume
//      (timestamp = epoch seconds or millis)
//   4. Bid/Ask format:             DateTime,Bid,Ask,Volume
//      (mid-price = (bid+ask)/2 is used for OHLC)
//   5. Tab-separated variants of any of the above
//
// Returns Bar[] with epoch-millisecond timestamps. Zero-price rows are
// filtered out (they indicate "no session" gaps in some exports).

import type { Bar } from "./bar-cache";

type ParsedHeader = {
  colMap: Record<string, number>;
  hasSeparateDateTime: boolean; // Date + Time columns
  hasBidAsk: boolean;           // Bid + Ask columns
  delimiter: string;
  startIndex: number;           // 0 = no header, 1 = skip header row
};

/**
 * Auto-detect the delimiter (comma, semicolon, or tab) from the first line.
 */
function detectDelimiter(line: string): string {
  if (line.includes("\t")) return "\t";
  if (line.includes(";")) return ";";
  return ",";
}

/**
 * Parse a datetime string into epoch milliseconds.
 * Handles:
 *   - "20240506 01:00:00.000"  (StrategyQuant format)
 *   - "20240506 01:00:00"      (without millis)
 *   - "2024-05-06T01:00:00.000Z" (ISO 8601)
 *   - "2024-05-06 01:00:00"    (SQL-style)
 *   - "2024-05-06"             (date only)
 *   - "1714947600000"          (epoch millis)
 *   - "1714947600"             (epoch seconds)
 */
function parseTimestamp(s: string): number {
  const trimmed = s.trim();
  if (!trimmed) return NaN;

  // Pure digit string → epoch
  if (/^\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    // Heuristic: if it's 13 digits, it's millis; if 10, it's seconds
    return trimmed.length >= 13 ? n : n * 1000;
  }

  // StrategyQuant format: YYYYMMDD HH:MM:SS[.mmm]
  const sqMatch = trimmed.match(/^(\d{4})(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?$/);
  if (sqMatch) {
    const [, y, mo, d, h, mi, se, ms] = sqMatch;
    return Date.UTC(
      parseInt(y), parseInt(mo) - 1, parseInt(d),
      parseInt(h), parseInt(mi), parseInt(se),
      ms ? parseInt(ms.padEnd(3, "0").slice(0, 3)) : 0
    );
  }

  // ISO 8601 or SQL-style: let Date.parse handle it
  const t = Date.parse(trimmed.replace(" ", "T"));
  return Number.isNaN(t) ? NaN : t;
}

/**
 * Inspect the CSV header (if present) and build a column map.
 * If no header is found, assumes the first 5-6 columns are
 * timestamp/datetime + OHLC(+V).
 */
function parseHeader(lines: string[], delimiter: string): ParsedHeader {
  const firstCols = lines[0].split(delimiter).map((c) => c.trim().toLowerCase());

  // Check if first row looks like a header
  const headerKeywords = [
    "date", "time", "datetime", "timestamp",
    "open", "high", "low", "close", "volume", "vol",
    "bid", "ask",
  ];
  const isHeader = firstCols.some((c) => headerKeywords.includes(c));

  const colMap: Record<string, number> = {};
  let startIndex = 0;

  if (isHeader) {
    startIndex = 1;
    firstCols.forEach((c, i) => {
      if (c === "date") colMap.date = i;
      else if (c === "time") colMap.time = i;
      else if (c === "datetime" || c === "timestamp") colMap.datetime = i;
      else if (c === "open" || c === "o") colMap.open = i;
      else if (c === "high" || c === "h") colMap.high = i;
      else if (c === "low" || c === "l") colMap.low = i;
      else if (c === "close" || c === "c") colMap.close = i;
      else if (c === "volume" || c === "vol") colMap.volume = i;
      else if (c === "bid") colMap.bid = i;
      else if (c === "ask") colMap.ask = i;
    });
  } else {
    // No header — assume standard layout based on column count
    const n = firstCols.length;
    if (n >= 6) {
      // timestamp/datetime, open, high, low, close, volume
      colMap.datetime = 0;
      colMap.open = 1;
      colMap.high = 2;
      colMap.low = 3;
      colMap.close = 4;
      colMap.volume = 5;
    } else if (n >= 5) {
      colMap.datetime = 0;
      colMap.open = 1;
      colMap.high = 2;
      colMap.low = 3;
      colMap.close = 4;
    }
  }

  const hasSeparateDateTime = colMap.date !== undefined && colMap.time !== undefined;
  const hasBidAsk = colMap.bid !== undefined && colMap.ask !== undefined;

  return { colMap, hasSeparateDateTime, hasBidAsk, delimiter, startIndex };
}

/**
 * Parse a CSV text into Bar[].
 *
 * Supported formats (auto-detected):
 *   - StrategyQuant:  Date,Time,Open,High,Low,Close,Volume
 *   - Combined:       DateTime,Open,High,Low,Close,Volume
 *   - Unix:           timestamp,open,high,low,close,volume
 *   - Bid/Ask:        DateTime,Bid,Ask,Volume
 *
 * Zero-price rows are filtered out (they indicate "no session" gaps).
 */
export function parseCsvFlexible(text: string): Bar[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return [];

  const delimiter = detectDelimiter(lines[0]);
  const { colMap, hasSeparateDateTime, hasBidAsk, startIndex } = parseHeader(lines, delimiter);

  const bars: Bar[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const cols = lines[i].split(delimiter).map((c) => c.trim());
    if (cols.length < 5) continue;

    // Parse timestamp
    let ts: number;
    if (hasSeparateDateTime) {
      ts = parseTimestamp(`${cols[colMap.date!]} ${cols[colMap.time!]}`);
    } else if (colMap.datetime !== undefined) {
      ts = parseTimestamp(cols[colMap.datetime]);
    } else {
      continue; // can't determine timestamp
    }
    if (isNaN(ts)) continue;

    let open: number, high: number, low: number, close: number;
    let volume = 0;

    if (hasBidAsk) {
      // Bid/Ask format: derive OHLC from mid-price
      const bid = parseFloat(cols[colMap.bid!]);
      const ask = parseFloat(cols[colMap.ask!]);
      if (isNaN(bid) || isNaN(ask)) continue;
      const mid = (bid + ask) / 2;
      // For tick data with only bid+ask, OHLC = mid (no intra-bar range)
      open = high = low = close = mid;
      if (colMap.volume !== undefined) volume = parseFloat(cols[colMap.volume]) || 0;
    } else {
      open = parseFloat(cols[colMap.open!]);
      high = parseFloat(cols[colMap.high!]);
      low = parseFloat(cols[colMap.low!]);
      close = parseFloat(cols[colMap.close!]);
      if (colMap.volume !== undefined) volume = parseFloat(cols[colMap.volume]) || 0;
    }

    if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;

    // Skip zero-price rows (no-data bars from "No Session" filter)
    if (open === 0 && high === 0 && low === 0 && close === 0) continue;

    bars.push({ timestamp: ts, open, high, low, close, volume });
  }

  // Sort by timestamp (just in case the input wasn't sorted)
  bars.sort((a, b) => a.timestamp - b.timestamp);
  return bars;
}

// ── Aggregation ─────────────────────────────────────────────────────────────

const TIMEFRAME_MS: Record<string, number> = {
  m1: 60_000,
  m5: 300_000,
  m15: 900_000,
  m30: 1_800_000,
  h1: 3_600_000,
  h4: 14_400_000,
  d1: 86_400_000,
};

/**
 * Aggregate bars from a finer timeframe to a coarser one.
 * e.g., aggregate M1 bars into M15 bars by grouping into 15-min buckets.
 *
 * If sourceBars are already at the target timeframe (or coarser), they're
 * returned unchanged.
 */
export function aggregateBars(
  sourceBars: Bar[],
  fromTimeframe: string,
  toTimeframe: string
): Bar[] {
  // No aggregation needed if same timeframe
  if (fromTimeframe === toTimeframe) return sourceBars;

  const fromMs = TIMEFRAME_MS[fromTimeframe];
  const toMs = TIMEFRAME_MS[toTimeframe];

  if (!fromMs || !toMs) {
    throw new Error(`Unknown timeframe: ${fromTimeframe} → ${toTimeframe}`);
  }

  // Can only aggregate from finer → coarser
  if (fromMs >= toMs) {
    return sourceBars; // already at or coarser than target
  }

  const buckets = new Map<number, Bar[]>();
  for (const bar of sourceBars) {
    const bucketTs = Math.floor(bar.timestamp / toMs) * toMs;
    if (!buckets.has(bucketTs)) {
      buckets.set(bucketTs, []);
    }
    buckets.get(bucketTs)!.push(bar);
  }

  const aggregated: Bar[] = [];
  for (const [bucketTs, bars] of buckets) {
    bars.sort((a, b) => a.timestamp - b.timestamp);
    aggregated.push({
      timestamp: bucketTs,
      open: bars[0].open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: bars[bars.length - 1].close,
      volume: bars.reduce((sum, b) => sum + b.volume, 0),
    });
  }

  aggregated.sort((a, b) => a.timestamp - b.timestamp);
  return aggregated;
}

/**
 * Detect the source timeframe from bar timestamps.
 * Looks at the median gap between consecutive bars.
 */
export function detectTimeframe(bars: Bar[]): string | null {
  if (bars.length < 2) return null;

  // Compute gaps between consecutive bars
  const gaps: number[] = [];
  for (let i = 1; i < Math.min(bars.length, 100); i++) {
    gaps.push(bars[i].timestamp - bars[i - 1].timestamp);
  }

  // Use median to avoid outliers (gaps at session boundaries)
  gaps.sort((a, b) => a - b);
  const median = gaps[Math.floor(gaps.length / 2)];

  // Match to known timeframe
  for (const [tf, ms] of Object.entries(TIMEFRAME_MS)) {
    if (Math.abs(median - ms) < ms * 0.1) { // within 10% tolerance
      return tf;
    }
  }

  return null;
}
