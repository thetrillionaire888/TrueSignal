// Data source importers: Binance, Yahoo Finance, CSV parsing.
// Dukascopy is handled by bar-cache.ts (fetchBarsCached).
import { importBars, type Bar } from "./bar-cache";

// ── Binance: public REST API, no auth required ──────────────────────────────
// https://binance-docs.github.io/apidocs/spot/en/#kline-candlestick-data
export async function fetchBinance(
  symbol: string,
  interval: string, // our timeframe: m1, m5, m15, m30, h1, h4, d1
  startTime: Date,
  endTime: Date
): Promise<Bar[]> {
  // Map our timeframe names to Binance's interval names
  const binanceInterval: Record<string, string> = {
    m1: "1m", m5: "5m", m15: "15m", m30: "30m",
    h1: "1h", h4: "4h", d1: "1d",
  };
  const bi = binanceInterval[interval] ?? interval;
  const url = new URL("https://api.binance.com/api/v3/klines");
  url.searchParams.set("symbol", symbol.toUpperCase());
  url.searchParams.set("interval", bi);
  url.searchParams.set("startTime", String(startTime.getTime()));
  url.searchParams.set("endTime", String(endTime.getTime()));
  url.searchParams.set("limit", "1000");

  const res = await fetch(url.toString());
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Binance API error ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = (await res.json()) as unknown[][];
  // Binance kline format: [openTime, open, high, low, close, volume, closeTime, ...]
  return data.map((row) => ({
    timestamp: Number(row[0]),
    open: parseFloat(row[1] as string),
    high: parseFloat(row[2] as string),
    low: parseFloat(row[3] as string),
    close: parseFloat(row[4] as string),
    volume: parseFloat(row[5] as string),
  }));
}

// ── Yahoo Finance: public chart API ──────────────────────────────────────────
// https://query1.finance.yahoo.com/v8/finance/chart/{symbol}
export async function fetchYahoo(
  symbol: string,
  interval: string, // 1m, 5m, 15m, 30m, 60m, 1d, 1wk, 1mo
  startTime: Date,
  endTime: Date
): Promise<Bar[]> {
  // Map our timeframe names to Yahoo's
  const yahooInterval: Record<string, string> = {
    m1: "1m",
    m5: "5m",
    m15: "15m",
    m30: "30m",
    h1: "60m",
    d1: "1d",
    wk1: "1wk",
    mn1: "1mo",
  };
  const yi = yahooInterval[interval] ?? "1d";

  const url = new URL(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}`);
  url.searchParams.set("period1", String(Math.floor(startTime.getTime() / 1000)));
  url.searchParams.set("period2", String(Math.floor(endTime.getTime() / 1000)));
  url.searchParams.set("interval", yi);
  url.searchParams.set("includePrePost", "false");

  const res = await fetch(url.toString(), {
    headers: { "User-Agent": "Mozilla/5.0" },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Yahoo Finance API error ${res.status}: ${body.slice(0, 200)}`);
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
    throw new Error(`Yahoo Finance: ${errMsg}`);
  }
  const ts = result.timestamp;
  const q = result.indicators?.quote?.[0];
  if (!q) throw new Error("Yahoo Finance: no quote data");

  const bars: Bar[] = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.open?.[i] == null || q.close?.[i] == null) continue;
    bars.push({
      timestamp: ts[i] * 1000, // Yahoo returns seconds, we store millis
      open: q.open[i]!,
      high: q.high?.[i] ?? q.open[i]!,
      low: q.low?.[i] ?? q.open[i]!,
      close: q.close[i]!,
      volume: q.volume?.[i] ?? 0,
    });
  }
  return bars;
}

// ── CSV parsing: flexible OHLCV format ───────────────────────────────────────
// Expects columns: timestamp (epoch ms or ISO), open, high, low, close, volume (optional)
// Header row optional. Auto-detects delimiter (comma, semicolon, tab).
export function parseCsv(text: string, instrument: string, timeframe: string): Bar[] {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return [];
  const delimiter = lines[0].includes(";") ? ";" : lines[0].includes("\t") ? "\t" : ",";
  let startIndex = 0;
  // Check if first row is a header
  const firstCols = lines[0].split(delimiter).map((c) => c.trim().toLowerCase());
  const isHeader = firstCols.some((c) =>
    ["timestamp", "time", "date", "open", "high", "low", "close", "volume"].includes(c)
  );
  if (isHeader) startIndex = 1;

  // Map column indices
  const colMap: Record<string, number> = {};
  if (isHeader) {
    firstCols.forEach((c, i) => {
      if (c === "timestamp" || c === "time" || c === "date") colMap.timestamp = i;
      else if (c === "open") colMap.open = i;
      else if (c === "high") colMap.high = i;
      else if (c === "low") colMap.low = i;
      else if (c === "close") colMap.close = i;
      else if (c === "volume" || c === "vol") colMap.volume = i;
    });
  }

  const bars: Bar[] = [];
  for (let i = startIndex; i < lines.length; i++) {
    const cols = lines[i].split(delimiter).map((c) => c.trim());
    if (cols.length < 5) continue;

    const tsIdx = colMap.timestamp ?? 0;
    const oIdx = colMap.open ?? 1;
    const hIdx = colMap.high ?? 2;
    const lIdx = colMap.low ?? 3;
    const cIdx = colMap.close ?? 4;
    const vIdx = colMap.volume ?? 5;

    const tsRaw = cols[tsIdx];
    let timestamp: number;
    if (/^\d{10,}$/.test(tsRaw)) {
      timestamp = Number(tsRaw); // epoch ms or epoch s
      if (timestamp < 1e12) timestamp *= 1000; // seconds → millis
    } else {
      timestamp = new Date(tsRaw).getTime();
    }
    if (isNaN(timestamp)) continue;

    const bar: Bar = {
      timestamp,
      open: parseFloat(cols[oIdx]),
      high: parseFloat(cols[hIdx]),
      low: parseFloat(cols[lIdx]),
      close: parseFloat(cols[cIdx]),
      volume: cols[vIdx] ? parseFloat(cols[vIdx]) : 0,
    };
    if (isNaN(bar.open) || isNaN(bar.close)) continue;
    bars.push(bar);
  }
  return bars;
}

// ── Import runner ────────────────────────────────────────────────────────────
export async function importFromSource(
  source: string,
  instrument: string,
  timeframe: string,
  startTime: Date,
  endTime: Date,
  csvText?: string
): Promise<{ bars: Bar[]; inserted: number; skipped: number }> {
  let bars: Bar[] = [];

  switch (source) {
    case "dukascopy": {
      const { fetchBarsCached } = await import("./bar-cache");
      const result = await fetchBarsCached(instrument, timeframe, startTime, endTime);
      // fetchBarsCached already stores bars — return stats
      return {
        bars: result.bars,
        inserted: result.stats.fetched,
        skipped: 0,
      };
    }
    case "binance":
      bars = await fetchBinance(instrument, timeframe, startTime, endTime);
      break;
    case "yahoo":
      bars = await fetchYahoo(instrument, timeframe, startTime, endTime);
      break;
    case "csv":
      if (!csvText) throw new Error("CSV text is required for CSV import");
      bars = parseCsv(csvText, instrument, timeframe);
      break;
    case "darwinex":
      throw new Error(
        "Darwinex API requires OAuth2 authentication. Please export data from Darwinex as CSV and use the CSV import option."
      );
    default:
      throw new Error(`Unknown data source: ${source}`);
  }

  // Store bars in the cache
  const { inserted, skipped } = importBars(source, instrument, timeframe, bars);
  return { bars, inserted, skipped };
}
