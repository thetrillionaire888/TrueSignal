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

function toDukascopyInstrument(instrument: string): string | null {
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
function parseDbDate(s: string): number {
  if (typeof s === "number") return s;
  if (!s) return NaN;
  // Pure-digit string → epoch millis (assume ms; if it's a 10-digit number
  // it's likely seconds, but our DB stores ms so we don't try to detect).
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isNaN(t) ? NaN : t;
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

type SignalRow = {
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
     WHERE e.signalId IS NULL
     ORDER BY m.postedAt ASC`
  ),
  getUnevaluatedByChannel: sqlite.prepare(
    `SELECT s.id as signalId, s.messageId, s.channelId, s.instrument, s.action,
            s.entryPrice, s.entryLow, s.entryHigh, s.isRange, s.stopLoss, s.takeProfits,
            s.notes, m.postedAt
     FROM Signal s
     JOIN Message m ON s.messageId = m.id
     LEFT JOIN Evaluation e ON e.signalId = s.id
     WHERE e.signalId IS NULL AND s.channelId = $channelId
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
async function fetchBars(
  instrument: string,
  fromTime: Date,
  hoursForward: number,
  onProgress?: (msg: string) => void
): Promise<{ bars: Bar[]; stats: CacheStats }> {
  const toTime = new Date(fromTime.getTime() + hoursForward * 3600000);
  return fetchBarsCached(instrument, "m15", fromTime, toTime, onProgress);
}

// ── Evaluate a single signal against historical bars ────────────────────────
// Now supports 4 entry-fill models dispatched via `entryType` parsed from the
// signal's notes field:
//   - market:  immediate fill at first bar's open
//   - limit:   buy when bar.low ≤ entry;  sell when bar.high ≥ entry
//   - stop:    buy when bar.high ≥ entry; sell when bar.low ≤ entry
//   - range:   walk forward to first range-touch; conservative fill at edge
//              closest to SL (worst-case R)
function evaluateSignal(signal: SignalRow, bars: Bar[]): EvalResult {
  const tps = JSON.parse(signal.takeProfits) as number[];
  const tp = tps.length > 0 ? tps[0] : null; // evaluate against first TP
  const sl = signal.stopLoss;
  const isLong = signal.action === "long";
  const entryType = extractEntryType(signal.notes);
  const now = new Date().toISOString();
  const postedAtMs = parseDbDate(signal.postedAt);

  const base: Partial<EvalResult> = {
    signalId: signal.signalId,
    instrument: signal.instrument,
    dukascopyInstrument: toDukascopyInstrument(signal.instrument) ?? signal.instrument,
    evaluatedAt: now,
    barsAnalyzed: bars.length,
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
function saveEvaluation(result: EvalResult) {
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
    $marketDataSource: "dukascopy-m15",
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
        $marketDataSource: "dukascopy-m15",
        $evaluatedAt: result.evaluatedAt,
      });
    }
  });
  tx();
}

// ── Parallel 4-worker evaluation runner ──────────────────────────────────────
const NUM_WORKERS = 4;
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
 * Worker function: processes a slice of signals, fetching bars + evaluating
 * each, and batch-writing results in groups of BATCH_SIZE inside a single
 * transaction. Returns the worker's local results + cache stats.
 *
 * Workers interleave on the await boundaries of `fetchBars` (network I/O), so
 * all 4 workers stay busy even though the underlying SQLite connection is
 * single-writer. Writes are serialized but tiny (one tx per 25 rows).
 */
async function runWorker(
  workerId: number,
  workerSignals: SignalRow[],
  onProgress: (p: EvalProgress) => void,
  jobId: string,
  totalSignals: number,
  progressCounter: { current: number }
): Promise<{ results: EvalResult[]; cached: number; fetched: number }> {
  const results: EvalResult[] = [];
  let cached = 0;
  let fetched = 0;
  const pending: EvalResult[] = [];

  for (const signal of workerSignals) {
    progressCounter.current++;
    const current = progressCounter.current;
    const dukascopyInstrument = toDukascopyInstrument(signal.instrument);

    if (!dukascopyInstrument) {
      // Skip instruments we can't map to Dukascopy
      const result: EvalResult = {
        signalId: signal.signalId,
        outcome: "invalid",
        exitPrice: null,
        exitReason: "unknown_instrument",
        hitTpLevel: null,
        maxFavorablePct: null,
        maxAdversePct: null,
        rMultiple: 0,
        pnlPercent: 0,
        durationMinutes: null,
        evaluatedAt: new Date().toISOString(),
        barsAnalyzed: 0,
        instrument: signal.instrument,
        dukascopyInstrument: "n/a",
      };
      pending.push(result);
      results.push(result);
      if (pending.length >= BATCH_SIZE) {
        saveEvaluationBatch(pending.splice(0, BATCH_SIZE));
      }
      if (workerId === 0) {
        onProgress({
          jobId,
          phase: "evaluating",
          message: `[w${workerId}] Skipping unknown instrument ${signal.instrument}`,
          current,
          total: totalSignals,
          instrument: signal.instrument,
        });
      }
      continue;
    }

    onProgress({
      jobId,
      phase: "fetching",
      message: `[w${workerId}] Fetching ${dukascopyInstrument.toUpperCase()} m15 bars for ${signal.instrument} ${signal.action}…`,
      current,
      total: totalSignals,
      instrument: signal.instrument,
    });

    // Fetch 48h of m15 bars starting from signal post time (uses DB cache)
    const signalTime = new Date(parseDbDate(signal.postedAt) || Date.now());
    let cacheMsg = "";
    const { bars, stats: cacheStats } = await fetchBars(
      dukascopyInstrument,
      signalTime,
      48,
      (msg) => { cacheMsg = msg; }
    );

    cached += cacheStats.cached;
    fetched += cacheStats.fetched;

    onProgress({
      jobId,
      phase: "evaluating",
      message: `[w${workerId}] Evaluating ${signal.instrument} ${signal.action} (entry ${signal.entryPrice}) against ${bars.length} bars… (${cacheMsg || "cache ready"})`,
      current,
      total: totalSignals,
      instrument: signal.instrument,
    });

    const result = evaluateSignal(signal, bars);
    pending.push(result);
    results.push(result);

    if (pending.length >= BATCH_SIZE) {
      saveEvaluationBatch(pending.splice(0, BATCH_SIZE));
    }

    // Small delay to avoid hammering Dukascopy
    await new Promise((r) => setTimeout(r, 300));
  }

  // Flush any remaining results in the batch buffer
  if (pending.length > 0) {
    saveEvaluationBatch(pending);
  }

  return { results, cached, fetched };
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
    message: `Found ${signals.length} unevaluated signals to evaluate against Dukascopy historical data. Running ${NUM_WORKERS} parallel workers (batch size ${BATCH_SIZE}).`,
    total: signals.length,
    current: 0,
  });

  if (signals.length === 0) {
    onProgress({
      jobId,
      phase: "complete",
      message: "No unevaluated signals found. All signals already have evaluations.",
      total: 0,
      current: 0,
      summary: { total: 0, wins: 0, losses: 0, breakeven: 0, invalid: 0, noData: 0, winRate: 0, totalR: 0 },
    });
    return;
  }

  // ── Partition signals across NUM_WORKERS workers (round-robin) ───────────
  // Round-robin keeps the workload balanced even if signal difficulty varies
  // (some signals hit cache, others trigger network fetches).
  const workerQueues: SignalRow[][] = Array.from({ length: NUM_WORKERS }, () => []);
  for (let i = 0; i < signals.length; i++) {
    workerQueues[i % NUM_WORKERS].push(signals[i]);
  }

  const progressCounter = { current: 0 };
  const workerResults = await Promise.all(
    workerQueues.map((queue, i) =>
      runWorker(i, queue, onProgress, jobId, signals.length, progressCounter)
    )
  );

  // ── Aggregate results from all workers ───────────────────────────────────
  const results: EvalResult[] = workerResults.flatMap((r) => r.results);
  const totalCached = workerResults.reduce((a, b) => a + b.cached, 0);
  const totalFetched = workerResults.reduce((a, b) => a + b.fetched, 0);

  // Summary
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
    message: `Evaluation complete. ${wins}W / ${losses}L / ${breakeven}B/E / ${invalid} invalid / ${noData} no data. Win rate: ${(winRate * 100).toFixed(1)}%. Total R: ${totalR.toFixed(2)}. Bars: ${totalCached} cached / ${totalFetched} fetched.`,
    current: signals.length,
    total: signals.length,
    summary: {
      total: signals.length,
      wins,
      losses,
      breakeven,
      invalid,
      noData,
      winRate,
      totalR: Math.round(totalR * 100) / 100,
      barsCached: totalCached,
      barsFetched: totalFetched,
    },
    results: results.map((r) => ({
      signalId: r.signalId,
      instrument: r.instrument,
      outcome: r.outcome,
      rMultiple: r.rMultiple,
    })),
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
