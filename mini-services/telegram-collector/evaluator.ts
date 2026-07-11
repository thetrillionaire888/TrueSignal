// Signal evaluator: fetches historical price data from Dukascopy (with DB
// caching to avoid re-downloading the same bars) and determines whether each
// parsed signal resulted in a win (TP hit) or loss (SL hit).
// Computes R-multiple, MFE, MAE, and duration for each signal.
//
// Uses the shared `sqlite` connection from `@/lib/db` (audit.db is the main
// DB; Signal/Message/Evaluation live there — no prefix needed).
//
// Entry-fill model (driven by `entryType` parsed from signal.notes):
//   - market: fill immediately at the first bar's open
//   - limit:  buy=triggered when bar.low ≤ entry; sell=triggered when bar.high ≥ entry
//   - stop:   buy=triggered when bar.high ≥ entry; sell=triggered when bar.low ≤ entry
//   - range:  walk forward to first range-touch; conservative fill at edge closest to SL
//
// Evaluation runs as 4 parallel async workers, each batching writes (25/batch)
// into a single transaction to amortize COMMIT cost. SQLite writes are
// serialized on the shared connection; reads happen during the async
// `fetchBars` await, so workers interleave productively.
import { sqlite } from "@/lib/db";
import { cuid } from "./cuid";
import { fetchBarsCached, type Bar, type CacheStats } from "./bar-cache";

// ── Instrument mapping: our DB instruments → Dukascopy instrument IDs ────────
const INSTRUMENT_MAP: Record<string, string> = {
  // Commodities / metals
  xauusd: "xauusd",
  xagusd: "xagusd",
  xptusd: "xptusd",
  // Crypto — Dukascopy uses 'btcusd' not 'btcusdt'
  btcusdt: "btcusd",
  btcusd: "btcusd",
  ethusdt: "ethusd",
  ethusd: "ethusd",
  solusdt: "solusd",
  bnbusdt: "bnbusd",
  xrpusdt: "xrpusd",
  // Forex
  eurusd: "eurusd",
  gbpusd: "gbpusd",
  usdjpy: "usdjpy",
  audusd: "audusd",
  usdcad: "usdcad",
  eurgbp: "eurgbp",
  eurjpy: "eurjpy",
  nzdusd: "nzdusd",
  usdchf: "usdchf",
  gbpjpy: "gbpjpy",
  // Indices
  spx500: "spx500",
  us30: "us30",
  nas100: "nas100",
  ger40: "ger40",
  // Energy
  wti: "wtiusd",
  brent: "brent",
};

export function toDukascopyInstrument(instrument: string): string | null {
  const key = instrument.toLowerCase().replace(/z$/, ""); // strip 'z' suffix
  return INSTRUMENT_MAP[key] ?? null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Parse a date string stored in the DB into epoch milliseconds.
 * Tolerates both:
 *   - epoch-millis strings (e.g. "1720425600000") — emitted by some legacy rows
 *   - ISO 8601 strings (e.g. "2024-07-08T15:20:00.000Z") — the default
 * Falls back to NaN on garbage input (caller should treat NaN as "now").
 */
export function parseDbDate(s: string): Date {
  if (typeof s === "number") return new Date(s);
  if (!s) return new Date(NaN);
  // Pure-digit string → epoch millis
  if (/^\d+$/.test(s)) return new Date(Number(s));
  const t = Date.parse(s);
  return Number.isNaN(t) ? new Date(NaN) : new Date(t);
}

type EntryType = "stop" | "limit" | "market" | "range";

/**
 * Extract the entry-type tag from the signal's notes field. The parser can
 * emit a structured tag like `entryType:stop` / `entryType:limit` /
 * `entryType:market` / `entryType:range` inside the notes string. Defaults to
 * `market` (immediate fill) when no tag is present — the most permissive
 * interpretation.
 */
function extractEntryType(notes: string | null | undefined): EntryType {
  if (!notes) return "market";
  const m = notes.match(/entryType\s*[:=]\s*(stop|limit|market|range)/i);
  return (m?.[1].toLowerCase() as EntryType) ?? "market";
}

// ── Types ────────────────────────────────────────────────────────────────────

export type SignalRow = {
  signalId: string;
  messageId: string;
  channelId: string;
  instrument: string;
  action: string;
  entryPrice: number;
  entryLow: number | null;
  entryHigh: number | null;
  isRange: number; // SQLite stores boolean as 0/1
  stopLoss: number;
  takeProfits: string; // JSON array string
  notes: string | null;
  postedAt: string;
};

type EvalResult = {
  signalId: string;
  outcome: "win" | "loss" | "breakeven" | "invalid" | "no_data";
  exitPrice: number | null;
  exitReason: string | null;
  hitTpLevel: number | null;
  maxFavorablePct: number | null;
  maxAdversePct: number | null;
  rMultiple: number;
  pnlPercent: number;
  durationMinutes: number | null;
  evaluatedAt: string;
  barsAnalyzed: number;
  instrument: string;
  dukascopyInstrument: string;
  marketDataSource: string; // e.g. "dukascopy-m1", "binance-m15", "yahoo-m15"
};

// ── Prepared statements ──────────────────────────────────────────────────────
// Signal/Message/Evaluation live in audit.db (the main DB, no prefix).
const stmts = {
  getUnevaluatedSignals: sqlite.prepare(
    `SELECT s.id as signalId, s.messageId, s.channelId, s.instrument, s.action,
            s.entryPrice, s.entryLow, s.entryHigh, s.isRange, s.stopLoss, s.takeProfits,
            s.notes, m.postedAt
     FROM Signal s
     JOIN Message m ON s.messageId = m.id
     LEFT JOIN Evaluation e ON e.signalId = s.id
     WHERE e.signalId IS NULL OR e.outcome = 'no_data'
     ORDER BY m.postedAt ASC`
  ),
  getUnevaluatedByChannel: sqlite.prepare(
    `SELECT s.id as signalId, s.messageId, s.channelId, s.instrument, s.action,
            s.entryPrice, s.entryLow, s.entryHigh, s.isRange, s.stopLoss, s.takeProfits,
            s.notes, m.postedAt
     FROM Signal s
     JOIN Message m ON s.messageId = m.id
     LEFT JOIN Evaluation e ON e.signalId = s.id
     WHERE (e.signalId IS NULL OR e.outcome = 'no_data') AND s.channelId = $channelId
     ORDER BY m.postedAt ASC`
  ),
  insertEvaluation: sqlite.prepare(
    `INSERT OR REPLACE INTO Evaluation
       (id, signalId, outcome, exitPrice, exitReason, hitTpLevel,
        maxFavorablePct, maxAdversePct, rMultiple, pnlPercent, durationMinutes,
        marketDataSource, evaluatedAt)
     VALUES ($id, $signalId, $outcome, $exitPrice, $exitReason, $hitTpLevel,
             $maxFavorablePct, $maxAdversePct, $rMultiple, $pnlPercent, $durationMinutes,
             $marketDataSource, $evaluatedAt)`
  ),
  // Note: the EVAL_CHANNEL_FILTER branch is intentionally inert — preserved
  // from the original code; the param-binding path is identical either way.
  countEvaluated: sqlite.prepare(
    `SELECT COUNT(*) as c FROM Evaluation e
     JOIN Signal s ON e.signalId = s.id
     ${process.env.EVAL_CHANNEL_FILTER ? "" : ""}`
  ),
  countEvaluatedByChannel: sqlite.prepare(
    "SELECT COUNT(*) as c FROM Evaluation e JOIN Signal s ON e.signalId = s.id WHERE s.channelId = $channelId"
  ),
  countTotalSignals: sqlite.prepare("SELECT COUNT(*) as c FROM Signal"),
  countTotalSignalsByChannel: sqlite.prepare(
    "SELECT COUNT(*) as c FROM Signal WHERE channelId = $channelId"
  ),
};

// ── Fetch historical bars (with DB caching) ──────────────────────────────────
// Uses the read-through cache in bar-cache.ts: checks SQLite first, only
// fetches missing bars from Dukascopy, and stores them for future reuse.
//
// Timeframe strategy (M1-first with M15 fallback):
//   1. Try M1 first — highest resolution, best for precise entry/exit detection.
//      Used when high-quality M1 data has been imported (e.g. Dukascopy CSV).
//   2. Fall back to M15 if M1 has no bars — preserves backward compatibility
//      with the existing m15 cache populated by API fetches.
//
// The 48h evaluation window contains:
//   - M1:  ~2880 bars (one per minute)  — precise but ~15× more data
//   - M15: ~192 bars (one per 15 min)   — coarser but faster
export async function fetchBars(
  instrument: string,
  fromTime: Date,
  hoursForward: number,
  onProgress?: (msg: string) => void,
  forceRefresh: boolean = false
): Promise<{ bars: Bar[]; stats: CacheStats }> {
  const toTime = new Date(fromTime.getTime() + hoursForward * 3600000);

  // Try M1 first (preferred — higher resolution)
  const m1Result = await fetchBarsCached(instrument, "m1", fromTime, toTime, onProgress, forceRefresh);
  if (m1Result.bars.length > 0) {
    return m1Result;
  }

  // Fall back to M15 (existing cache from API fetches)
  onProgress?.(`no M1 bars for ${instrument}, falling back to m15`);
  return fetchBarsCached(instrument, "m15", fromTime, toTime, onProgress, forceRefresh);
}

// ── Evaluate a single signal against historical bars ────────────────────────
// Now supports 4 entry-fill models dispatched via `entryType` parsed from the
// signal's notes field:
//   - market:  immediate fill at first bar's open
//   - limit:   buy when bar.low ≤ entry;  sell when bar.high ≥ entry
//   - stop:    buy when bar.high ≥ entry; sell when bar.low ≤ entry
//   - range:   walk forward to first range-touch; conservative fill at edge
//              closest to SL (worst-case R)
export function evaluateSignal(signal: SignalRow, bars: Bar[], marketDataSource: string = "dukascopy-m15"): EvalResult {
  const tps = JSON.parse(signal.takeProfits) as number[];
  const tp = tps.length > 0 ? tps[0] : null; // evaluate against first TP
  const sl = signal.stopLoss;
  const isLong = signal.action === "long";
  const entryType = extractEntryType(signal.notes);
  const now = new Date().toISOString();
  const postedAtMs = parseDbDate(signal.postedAt).getTime();

  const base: Partial<EvalResult> = {
    signalId: signal.signalId,
    instrument: signal.instrument,
    dukascopyInstrument: toDukascopyInstrument(signal.instrument) ?? signal.instrument,
    evaluatedAt: now,
    barsAnalyzed: bars.length,
    marketDataSource,
  };

  if (!tp) {
    return { ...base, outcome: "invalid", exitPrice: null, exitReason: "no_tp", hitTpLevel: null, maxFavorablePct: null, maxAdversePct: null, rMultiple: 0, pnlPercent: 0, durationMinutes: null } as EvalResult;
  }

  if (bars.length === 0) {
    return { ...base, outcome: "no_data", exitPrice: null, exitReason: null, hitTpLevel: null, maxFavorablePct: null, maxAdversePct: null, rMultiple: 0, pnlPercent: 0, durationMinutes: null } as EvalResult;
  }

  // ── Determine the effective entry price + fill bar index ─────────────────
  let entry: number = signal.entryPrice;
  let fillBarIndex = 0;

  if (entryType === "range" && signal.entryLow != null && signal.entryHigh != null) {
    const entryLow = signal.entryLow;
    const entryHigh = signal.entryHigh;
    // Conservative fill: edge closest to SL (worst-case R).
    //   LONG  → SL is below entry → worst fill = entryLow (closest to SL)
    //   SHORT → SL is above entry → worst fill = entryHigh (closest to SL)
    const conservativeFill = isLong ? entryLow : entryHigh;

    let filled = false;
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      // Range touched = bar's price range overlaps with the entry range
      if (bar.high >= entryLow && bar.low <= entryHigh) {
        entry = conservativeFill;
        fillBarIndex = i;
        filled = true;
        break;
      }
      // SL hit BEFORE range touched → signal never triggered
      if (isLong) {
        if (bar.low <= sl) {
          return { ...base, outcome: "invalid", exitPrice: sl, exitReason: "sl_before_entry", hitTpLevel: null, maxFavorablePct: 0, maxAdversePct: 0, rMultiple: 0, pnlPercent: 0, durationMinutes: null } as EvalResult;
        }
      } else {
        if (bar.high >= sl) {
          return { ...base, outcome: "invalid", exitPrice: sl, exitReason: "sl_before_entry", hitTpLevel: null, maxFavorablePct: 0, maxAdversePct: 0, rMultiple: 0, pnlPercent: 0, durationMinutes: null } as EvalResult;
        }
      }
    }

    if (!filled) {
      return { ...base, outcome: "invalid", exitPrice: null, exitReason: "range_not_touched", hitTpLevel: null, maxFavorablePct: 0, maxAdversePct: 0, rMultiple: 0, pnlPercent: 0, durationMinutes: null } as EvalResult;
    }
  } else if (entryType === "market") {
    // Market entry — fill at the first bar's open (immediate execution).
    entry = bars[0].open;
    fillBarIndex = 0;
  } else if (entryType === "stop") {
    // Stop entry:
    //   Buy stop (LONG):  triggers when bar.high ≥ entry (price rises above stop)
    //   Sell stop (SHORT): triggers when bar.low ≤ entry (price falls below stop)
    let filled = false;
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (isLong) {
        if (bar.low <= sl) {
          return { ...base, outcome: "invalid", exitPrice: sl, exitReason: "sl_before_entry", hitTpLevel: null, maxFavorablePct: 0, maxAdversePct: 0, rMultiple: 0, pnlPercent: 0, durationMinutes: null } as EvalResult;
        }
        if (bar.high >= signal.entryPrice) {
          entry = signal.entryPrice;
          fillBarIndex = i;
          filled = true;
          break;
        }
      } else {
        if (bar.high >= sl) {
          return { ...base, outcome: "invalid", exitPrice: sl, exitReason: "sl_before_entry", hitTpLevel: null, maxFavorablePct: 0, maxAdversePct: 0, rMultiple: 0, pnlPercent: 0, durationMinutes: null } as EvalResult;
        }
        if (bar.low <= signal.entryPrice) {
          entry = signal.entryPrice;
          fillBarIndex = i;
          filled = true;
          break;
        }
      }
    }
    if (!filled) {
      return { ...base, outcome: "invalid", exitPrice: null, exitReason: "stop_not_triggered", hitTpLevel: null, maxFavorablePct: 0, maxAdversePct: 0, rMultiple: 0, pnlPercent: 0, durationMinutes: null } as EvalResult;
    }
  } else if (entryType === "limit") {
    // Limit entry:
    //   Buy limit (LONG):  triggers when bar.low ≤ entry (price falls to limit)
    //   Sell limit (SHORT): triggers when bar.high ≥ entry (price rises to limit)
    let filled = false;
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      if (isLong) {
        if (bar.low <= sl) {
          return { ...base, outcome: "invalid", exitPrice: sl, exitReason: "sl_before_entry", hitTpLevel: null, maxFavorablePct: 0, maxAdversePct: 0, rMultiple: 0, pnlPercent: 0, durationMinutes: null } as EvalResult;
        }
        if (bar.low <= signal.entryPrice) {
          entry = signal.entryPrice;
          fillBarIndex = i;
          filled = true;
          break;
        }
      } else {
        if (bar.high >= sl) {
          return { ...base, outcome: "invalid", exitPrice: sl, exitReason: "sl_before_entry", hitTpLevel: null, maxFavorablePct: 0, maxAdversePct: 0, rMultiple: 0, pnlPercent: 0, durationMinutes: null } as EvalResult;
        }
        if (bar.high >= signal.entryPrice) {
          entry = signal.entryPrice;
          fillBarIndex = i;
          filled = true;
          break;
        }
      }
    }
    if (!filled) {
      return { ...base, outcome: "invalid", exitPrice: null, exitReason: "limit_not_triggered", hitTpLevel: null, maxFavorablePct: 0, maxAdversePct: 0, rMultiple: 0, pnlPercent: 0, durationMinutes: null } as EvalResult;
    }
  } else {
    // Default fallback (no entryType) — treat as immediate market fill.
    entry = signal.entryPrice;
    fillBarIndex = 0;
  }

  // Edge case: SL == entry → risk is 0, can't compute R
  const risk = Math.abs(entry - sl);
  if (risk === 0) {
    return { ...base, outcome: "invalid", exitPrice: null, exitReason: "zero_risk", hitTpLevel: null, maxFavorablePct: null, maxAdversePct: null, rMultiple: 0, pnlPercent: 0, durationMinutes: null } as EvalResult;
  }

  // ── Walk through bars from fill point to find SL/TP hit ──────────────────
  let exitPrice: number | null = null;
  let exitReason: string | null = null;
  let hitTpLevel: number | null = null;
  let exitTime: number | null = null;
  let maxFav = 0;
  let maxAdv = 0;

  for (let i = fillBarIndex; i < bars.length; i++) {
    const bar = bars[i];

    // Track MFE/MAE from entry
    if (isLong) {
      maxFav = Math.max(maxFav, bar.high - entry);
      maxAdv = Math.max(maxAdv, entry - bar.low);
    } else {
      maxFav = Math.max(maxFav, entry - bar.low);
      maxAdv = Math.max(maxAdv, bar.high - entry);
    }

    // Check exit conditions (conservative: if both hit in same bar, SL first)
    if (isLong) {
      if (bar.low <= sl) {
        exitPrice = sl;
        exitReason = "sl";
        exitTime = bar.timestamp;
        break;
      }
      if (bar.high >= tp) {
        exitPrice = tp;
        exitReason = "tp1";
        hitTpLevel = 1;
        exitTime = bar.timestamp;
        break;
      }
    } else {
      if (bar.high >= sl) {
        exitPrice = sl;
        exitReason = "sl";
        exitTime = bar.timestamp;
        break;
      }
      if (bar.low <= tp) {
        exitPrice = tp;
        exitReason = "tp1";
        hitTpLevel = 1;
        exitTime = bar.timestamp;
        break;
      }
    }
  }

  // If no exit, signal is still open (use last bar close)
  if (exitPrice === null) {
    const lastBar = bars[bars.length - 1];
    const currentPrice = lastBar.close;
    const unrealizedR = isLong
      ? (currentPrice - entry) / risk
      : (entry - currentPrice) / risk;
    // If unrealized R is very small, mark breakeven; otherwise mark as still open
    const durationMin = Number.isNaN(postedAtMs)
      ? null
      : Math.round((lastBar.timestamp - postedAtMs) / 60000);
    if (Math.abs(unrealizedR) < 0.1) {
      return {
        ...base,
        outcome: "breakeven",
        exitPrice: currentPrice,
        exitReason: "manual",
        hitTpLevel: null,
        maxFavorablePct: (maxFav / entry) * 100,
        maxAdversePct: (maxAdv / entry) * 100,
        rMultiple: 0,
        pnlPercent: 0,
        durationMinutes: durationMin,
      } as EvalResult;
    }
    // Mark as win/loss based on current direction
    const outcome = unrealizedR > 0 ? "win" : "loss";
    return {
      ...base,
      outcome,
      exitPrice: currentPrice,
      exitReason: "still_open",
      hitTpLevel: null,
      maxFavorablePct: (maxFav / entry) * 100,
      maxAdversePct: (maxAdv / entry) * 100,
      rMultiple: Math.round(unrealizedR * 100) / 100,
      pnlPercent: Math.round(unrealizedR * 100) / 100,
      durationMinutes: durationMin,
    } as EvalResult;
  }

  // Compute R-multiple and PnL
  const rMultiple = isLong
    ? (exitPrice - entry) / risk
    : (entry - exitPrice) / risk;
  const pnlPercent = Math.round(rMultiple * 100) / 100; // 1R = 1% account
  const durationMinutes = exitTime && !Number.isNaN(postedAtMs)
    ? Math.round((exitTime - postedAtMs) / 60000)
    : null;

  return {
    ...base,
    outcome: exitReason === "sl" ? "loss" : "win",
    exitPrice,
    exitReason,
    hitTpLevel,
    maxFavorablePct: Math.round((maxFav / entry) * 10000) / 100,
    maxAdversePct: Math.round((maxAdv / entry) * 10000) / 100,
    rMultiple: Math.round(rMultiple * 100) / 100,
    pnlPercent,
    durationMinutes,
  } as EvalResult;
}

// ── Save evaluation to DB (single-row helper, used outside batches) ─────────
export function saveEvaluation(result: EvalResult) {
  stmts.insertEvaluation.run({
    $id: cuid(),
    $signalId: result.signalId,
    $outcome: result.outcome,
    $exitPrice: result.exitPrice,
    $exitReason: result.exitReason,
    $hitTpLevel: result.hitTpLevel,
    $maxFavorablePct: result.maxFavorablePct,
    $maxAdversePct: result.maxAdversePct,
    $rMultiple: result.rMultiple,
    $pnlPercent: result.pnlPercent,
    $durationMinutes: result.durationMinutes,
    $marketDataSource: result.marketDataSource,
    $evaluatedAt: result.evaluatedAt,
  });
}

/**
 * Save a batch of evaluation results in a single transaction. Amortizes COMMIT
 * cost across BATCH_SIZE rows — critical for keeping up with the 4-worker
 * evaluation throughput.
 */
function saveEvaluationBatch(batch: EvalResult[]) {
  if (batch.length === 0) return;
  const tx = sqlite.transaction(() => {
    for (const result of batch) {
      stmts.insertEvaluation.run({
        $id: cuid(),
        $signalId: result.signalId,
        $outcome: result.outcome,
        $exitPrice: result.exitPrice,
        $exitReason: result.exitReason,
        $hitTpLevel: result.hitTpLevel,
        $maxFavorablePct: result.maxFavorablePct,
        $maxAdversePct: result.maxAdversePct,
        $rMultiple: result.rMultiple,
        $pnlPercent: result.pnlPercent,
        $durationMinutes: result.durationMinutes,
        $marketDataSource: result.marketDataSource,
        $evaluatedAt: result.evaluatedAt,
      });
    }
  });
  tx();
}

// ── Parallel 8-worker evaluation runner ─────────────────────────────────────
// 8 workers (up from 4) — the bottleneck is network I/O (Dukascopy API
// latency), not CPU, so more workers = more parallel HTTP requests.
const NUM_WORKERS = 8;
const BATCH_SIZE = 25;

export type EvalProgress = {
  jobId: string;
  phase: "starting" | "fetching" | "evaluating" | "complete" | "error";
  message: string;
  current?: number;
  total?: number;
  instrument?: string;
  results?: Array<{
    signalId: string;
    instrument: string;
    outcome: string;
    rMultiple: number;
  }>;
  summary?: {
    total: number;
    wins: number;
    losses: number;
    breakeven: number;
    invalid: number;
    noData: number;
    winRate: number;
    totalR: number;
    barsCached?: number;
    barsFetched?: number;
  };
};

/**
 * Fetch bars from Dukascopy with retry logic (exponential backoff).
 * Retries up to 3 times on socket connection errors — Dukascopy's free API
 * frequently drops connections, especially for recent or old date ranges.
 */
async function fetchBarsWithRetry(
  instrument: string,
  fromTime: Date,
  hoursForward: number,
  onProgress?: (msg: string) => void
): Promise<{ bars: Bar[]; stats: CacheStats }> {
  const MAX_RETRIES = 3;
  const BASE_DELAY = 1000; // 1s, 2s, 4s

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const { bars, stats } = await fetchBars(instrument, fromTime, hoursForward, onProgress);
    // If we got bars (either cached or fetched), return immediately
    if (bars.length > 0 || stats.fetched > 0) {
      return { bars, stats };
    }
    // Cache miss + fetch returned nothing — could be socket error or empty range
    // Retry with exponential backoff (but only if we haven't exhausted attempts)
    if (attempt < MAX_RETRIES - 1) {
      const delay = BASE_DELAY * Math.pow(2, attempt);
      onProgress?.(`retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms…`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  // All retries exhausted — return empty
  return { bars: [], stats: { cached: 0, fetched: 0, total: 0 } };
}

/**
 * Pre-fetch bars for all unique instruments in the signal set.
 * Groups signals by Dukascopy instrument, finds the full date range
 * (min postedAt → max postedAt + 48h), and fetches one large batch per
 * instrument. This replaces N per-signal fetches with M per-instrument
 * fetches (M << N when many signals share the same instrument).
 *
 * Returns a Map keyed by "instrument|postedAt-ms" → Bar[] for O(1) lookup
 * during evaluation.
 */
async function preFetchBarsByInstrument(
  signals: SignalRow[],
  onProgress: (p: EvalProgress) => void,
  jobId: string
): Promise<{ barCache: Map<string, Bar[]>; sourceMap: Map<string, string>; instrumentsFetched: number; barsCached: number; barsFetched: number }> {
  // Group signals by Dukascopy instrument
  const instrumentGroups = new Map<string, { signals: SignalRow[]; minTime: Date; maxTime: Date }>();

  for (const signal of signals) {
    const dukascopyInstrument = toDukascopyInstrument(signal.instrument);
    if (!dukascopyInstrument) continue;

    if (!instrumentGroups.has(dukascopyInstrument)) {
      instrumentGroups.set(dukascopyInstrument, { signals: [], minTime: new Date(8e15), maxTime: new Date(0) });
    }
    const group = instrumentGroups.get(dukascopyInstrument)!;
    group.signals.push(signal);
    const signalTime = parseDbDate(signal.postedAt);
    if (!isNaN(signalTime.getTime())) {
      if (signalTime < group.minTime) group.minTime = new Date(signalTime);
      if (signalTime > group.maxTime) group.maxTime = new Date(signalTime);
    }
  }

  // Fetch bars for each instrument (parallel, up to 4 at a time)
  const barCache = new Map<string, Bar[]>();
  const sourceMap = new Map<string, string>(); // cacheKey → source label (e.g. "dukascopy-m1")
  let instrumentsFetched = 0;
  let barsCached = 0;
  let barsFetched = 0;
  const instruments = Array.from(instrumentGroups.entries());

  onProgress({
    jobId,
    phase: "fetching",
    message: `Pre-fetching bars for ${instruments.length} unique instruments…`,
    current: 0,
    total: signals.length,
  });

  // Process instruments in parallel batches of 4
  const FETCH_CONCURRENCY = 4;
  for (let i = 0; i < instruments.length; i += FETCH_CONCURRENCY) {
    const batch = instruments.slice(i, i + FETCH_CONCURRENCY);
    await Promise.all(batch.map(async ([instrument, group]) => {
      // Extend range by 48h forward to cover evaluation window
      const fromTime = group.minTime;
      const toTime = new Date(group.maxTime.getTime() + 48 * 3600000);
      const hoursForward = Math.ceil((toTime.getTime() - fromTime.getTime()) / 3600000);

      const { bars, stats } = await fetchBarsWithRetry(
        instrument, fromTime, Math.max(hoursForward, 48),
        (msg) => onProgress({ jobId, phase: "fetching", message: `${instrument.toUpperCase()}: ${msg}`, current: 0, total: signals.length, instrument })
      );

      instrumentsFetched++;
      barsCached += stats.cached;
      barsFetched += stats.fetched;

      // Derive the source label from stats.source (e.g. "Binance REST" → "binance")
      // and the timeframe (m1 or m15, inferred from bar interval if available).
      // Default to "dukascopy-m15" for backward compatibility.
      const sourceLabel = stats.source
        ? stats.source.toLowerCase().split(" ")[0] // "Binance REST" → "binance"
        : "dukascopy";
      // Detect timeframe from bar gaps if we have bars
      let timeframe = "m15";
      if (bars.length >= 2) {
        const gap = bars[1].timestamp - bars[0].timestamp;
        if (gap === 60000) timeframe = "m1";
        else if (gap === 900000) timeframe = "m15";
      }
      const marketDataSource = `${sourceLabel}-${timeframe}`;

      // Cache bars per signal by finding the 48h window starting at each signal's postedAt
      for (const signal of group.signals) {
        const signalTime = parseDbDate(signal.postedAt);
        if (isNaN(signalTime.getTime())) continue;
        const signalEndMs = signalTime.getTime() + 48 * 3600000;
        const signalBars = bars.filter(b => b.timestamp >= signalTime.getTime() && b.timestamp < signalEndMs);
        const cacheKey = `${signal.instrument}|${signal.postedAt}`;
        barCache.set(cacheKey, signalBars);
        sourceMap.set(cacheKey, marketDataSource);
      }

      onProgress({
        jobId,
        phase: "fetching",
        message: `Pre-fetched ${instrument.toUpperCase()}: ${bars.length} bars (${stats.cached} cached / ${stats.fetched} fetched, source=${marketDataSource}) for ${group.signals.length} signals`,
        current: 0,
        total: signals.length,
        instrument,
      });
    }));
  }

  return { barCache, sourceMap, instrumentsFetched, barsCached, barsFetched };
}

/**
 * Worker function: processes a slice of signals using pre-fetched bars from
 * the barCache. No network I/O during evaluation — all bars are already in
 * memory. Workers interleave only on SQLite write transactions.
 */
async function runWorker(
  workerId: number,
  workerSignals: SignalRow[],
  barCache: Map<string, Bar[]>,
  sourceMap: Map<string, string>,
  onProgress: (p: EvalProgress) => void,
  jobId: string,
  totalSignals: number,
  progressCounter: { current: number }
): Promise<{ results: EvalResult[] }> {
  const results: EvalResult[] = [];
  const pending: EvalResult[] = [];

  for (const signal of workerSignals) {
    progressCounter.current++;
    const current = progressCounter.current;
    const dukascopyInstrument = toDukascopyInstrument(signal.instrument);

    if (!dukascopyInstrument) {
      const result: EvalResult = {
        signalId: signal.signalId, outcome: "invalid", exitPrice: null, exitReason: "unknown_instrument",
        hitTpLevel: null, maxFavorablePct: null, maxAdversePct: null, rMultiple: 0, pnlPercent: 0,
        durationMinutes: null, evaluatedAt: new Date().toISOString(), barsAnalyzed: 0,
        instrument: signal.instrument, dukascopyInstrument: "n/a",
        marketDataSource: "n/a",
      };
      pending.push(result);
      results.push(result);
      if (pending.length >= BATCH_SIZE) saveEvaluationBatch(pending.splice(0, BATCH_SIZE));
      continue;
    }

    // Look up pre-fetched bars from cache (O(1) — no network I/O)
    const cacheKey = `${signal.instrument}|${signal.postedAt}`;
    const bars = barCache.get(cacheKey) ?? [];

    if (workerId === 0 && current % 10 === 0) {
      onProgress({
        jobId, phase: "evaluating",
        message: `[w${workerId}] Evaluated ${current}/${totalSignals} signals (${bars.length} bars for ${signal.instrument})`,
        current, total: totalSignals, instrument: signal.instrument,
      });
    }

    const result = evaluateSignal(signal, bars, sourceMap.get(cacheKey) ?? "dukascopy-m15");
    pending.push(result);
    results.push(result);

    if (pending.length >= BATCH_SIZE) {
      saveEvaluationBatch(pending.splice(0, BATCH_SIZE));
    }
  }

  if (pending.length > 0) saveEvaluationBatch(pending);
  return { results };
}

export async function evaluateSignals(
  channelId: string | null,
  onProgress: (p: EvalProgress) => void
): Promise<void> {
  const jobId = `eval-${Date.now()}`;
  const signals: SignalRow[] = channelId
    ? (stmts.getUnevaluatedByChannel.all({ $channelId: channelId }) as SignalRow[])
    : (stmts.getUnevaluatedSignals.all() as SignalRow[]);

  onProgress({
    jobId,
    phase: "starting",
    message: `Found ${signals.length} unevaluated signals. Will pre-fetch bars by instrument, then evaluate with ${NUM_WORKERS} parallel workers.`,
    total: signals.length,
    current: 0,
  });

  if (signals.length === 0) {
    onProgress({
      jobId,
      phase: "complete",
      message: "No unevaluated signals found.",
      total: 0, current: 0,
      summary: { total: 0, wins: 0, losses: 0, breakeven: 0, invalid: 0, noData: 0, winRate: 0, totalR: 0 },
    });
    return;
  }

  // ── Phase 1: Pre-fetch bars by instrument (batch fetch) ──────────────────
  // Groups all signals by Dukascopy instrument, fetches the full date range
  // once per instrument (instead of once per signal). Reduces API calls from
  // N (per-signal) to M (per-instrument) — typically a 10-20× reduction.
  const { barCache, sourceMap, instrumentsFetched, barsCached, barsFetched } = await preFetchBarsByInstrument(signals, onProgress, jobId);

  onProgress({
    jobId,
    phase: "evaluating",
    message: `Bars pre-fetched: ${instrumentsFetched} instruments, ${barsCached} cached / ${barsFetched} fetched. Starting ${NUM_WORKERS}-worker evaluation…`,
    current: 0,
    total: signals.length,
  });

  // ── Phase 2: Evaluate signals in parallel (8 workers, no network I/O) ────
  // All bars are in memory — workers only do CPU work + batched DB writes.
  const workerQueues: SignalRow[][] = Array.from({ length: NUM_WORKERS }, () => []);
  for (let i = 0; i < signals.length; i++) {
    workerQueues[i % NUM_WORKERS].push(signals[i]);
  }

  const progressCounter = { current: 0 };
  const workerResults = await Promise.all(
    workerQueues.map((queue, i) =>
      runWorker(i, queue, barCache, sourceMap, onProgress, jobId, signals.length, progressCounter)
    )
  );

  // ── Aggregate results ────────────────────────────────────────────────────
  const results: EvalResult[] = workerResults.flatMap((r) => r.results);
  const wins = results.filter((r) => r.outcome === "win").length;
  const losses = results.filter((r) => r.outcome === "loss").length;
  const breakeven = results.filter((r) => r.outcome === "breakeven").length;
  const invalid = results.filter((r) => r.outcome === "invalid").length;
  const noData = results.filter((r) => r.outcome === "no_data").length;
  const totalR = results.reduce((a, b) => a + b.rMultiple, 0);
  const decisive = wins + losses;
  const winRate = decisive > 0 ? wins / decisive : 0;

  onProgress({
    jobId,
    phase: "complete",
    message: `Evaluation complete. ${wins}W / ${losses}L / ${breakeven}B/E / ${invalid} invalid / ${noData} no data. Win rate: ${(winRate * 100).toFixed(1)}%. Total R: ${totalR.toFixed(2)}. Bars: ${barsCached} cached / ${barsFetched} fetched (${instrumentsFetched} instruments).`,
    current: signals.length,
    total: signals.length,
    summary: {
      total: signals.length, wins, losses, breakeven, invalid, noData, winRate,
      totalR: Math.round(totalR * 100) / 100, barsCached, barsFetched,
    },
    results: results.map((r) => ({ signalId: r.signalId, instrument: r.instrument, outcome: r.outcome, rMultiple: r.rMultiple })),
  });
}

// ── Stats endpoint ────────────────────────────────────────────────────────────
export function getEvalStats(channelId?: string) {
  const total = channelId
    ? (stmts.countTotalSignalsByChannel.get({ $channelId: channelId }) as { c: number }).c
    : (stmts.countTotalSignals.get() as { c: number }).c;
  const evaluated = channelId
    ? (stmts.countEvaluatedByChannel.get({ $channelId: channelId }) as { c: number }).c
    : (stmts.countEvaluated.get() as { c: number }).c;
  return { total, evaluated, pending: total - evaluated };
}
