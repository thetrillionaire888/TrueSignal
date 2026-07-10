// Signal evaluator: fetches historical price data from Dukascopy (with DB
// caching to avoid re-downloading the same bars) and determines whether each
// parsed signal resulted in a win (TP hit) or loss (SL hit).
// Computes R-multiple, MFE, MAE, and duration for each signal.
import { Database } from "bun:sqlite";
import { resolve } from "node:path";
import { cuid } from "./cuid";
import { fetchBarsCached, type Bar, type CacheStats } from "./bar-cache";

const DB_PATH = resolve(import.meta.dir, "../../db/custom.db");
const db = new Database(DB_PATH);
db.exec("PRAGMA journal_mode = WAL;");
db.exec("PRAGMA busy_timeout = 5000;");

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

// ── Types ────────────────────────────────────────────────────────────────────
// Bar type is imported from bar-cache.ts

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
const stmts = {
  getUnevaluatedSignals: db.prepare<SignalRow, Record<string, never>>(
    `SELECT s.id as signalId, s.messageId, s.channelId, s.instrument, s.action,
            s.entryPrice, s.entryLow, s.entryHigh, s.isRange, s.stopLoss, s.takeProfits, m.postedAt
     FROM Signal s
     JOIN Message m ON s.messageId = m.id
     LEFT JOIN Evaluation e ON e.signalId = s.id
     WHERE e.signalId IS NULL
     ORDER BY m.postedAt ASC`
  ),
  getUnevaluatedByChannel: db.prepare<SignalRow, { $channelId: string }>(
    `SELECT s.id as signalId, s.messageId, s.channelId, s.instrument, s.action,
            s.entryPrice, s.entryLow, s.entryHigh, s.isRange, s.stopLoss, s.takeProfits, m.postedAt
     FROM Signal s
     JOIN Message m ON s.messageId = m.id
     LEFT JOIN Evaluation e ON e.signalId = s.id
     WHERE e.signalId IS NULL AND s.channelId = $channelId
     ORDER BY m.postedAt ASC`
  ),
  insertEvaluation: db.prepare<unknown, Record<string, unknown>>(
    `INSERT OR REPLACE INTO Evaluation
     (id, signalId, outcome, exitPrice, exitReason, hitTpLevel,
      maxFavorablePct, maxAdversePct, rMultiple, pnlPercent, durationMinutes,
      marketDataSource, evaluatedAt)
     VALUES ($id, $signalId, $outcome, $exitPrice, $exitReason, $hitTpLevel,
             $maxFavorablePct, $maxAdversePct, $rMultiple, $pnlPercent, $durationMinutes,
             $marketDataSource, $evaluatedAt)`
  ),
  countEvaluated: db.prepare<{ c: number }, { $channelId?: string }>(
    `SELECT COUNT(*) as c FROM Evaluation e
     JOIN Signal s ON e.signalId = s.id
     ${process.env.EVAL_CHANNEL_FILTER ? "" : ""}`
  ),
  countEvaluatedByChannel: db.prepare<{ c: number }, { $channelId: string }>(
    "SELECT COUNT(*) as c FROM Evaluation e JOIN Signal s ON e.signalId = s.id WHERE s.channelId = $channelId"
  ),
  countTotalSignals: db.prepare<{ c: number }, { $channelId?: string }>(
    "SELECT COUNT(*) as c FROM Signal"
  ),
  countTotalSignalsByChannel: db.prepare<{ c: number }, { $channelId: string }>(
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
function evaluateSignal(signal: SignalRow, bars: Bar[]): EvalResult {
  const tps = JSON.parse(signal.takeProfits) as number[];
  const tp = tps.length > 0 ? tps[0] : null; // evaluate against first TP
  const sl = signal.stopLoss;
  const isLong = signal.action === "long";
  const isRange = signal.isRange === 1;
  const now = new Date().toISOString();

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

  // ── Determine the effective entry price ──────────────────────────────────
  // For range signals: walk forward to find when price first touches the range,
  // then use the conservative fill (range edge closest to SL = worst case).
  // For single-price signals: use the entry price directly.
  let entry: number;
  let fillBarIndex = 0; // index in bars[] where entry was filled

  if (isRange && signal.entryLow != null && signal.entryHigh != null) {
    const entryLow = signal.entryLow;
    const entryHigh = signal.entryHigh;
    // Conservative fill: edge closest to SL (worst-case R)
    // For LONG: SL is below entry, so worst fill = entryHigh (furthest from SL = largest risk... no wait)
    // For LONG: SL below, worst fill = entryLow (closest to SL, smallest buffer) — NO
    // Actually for LONG: risk = entry - SL. Worst case = entry closest to SL = entryLow.
    // For SHORT: SL above, risk = SL - entry. Worst case = entry closest to SL = entryHigh.
    const conservativeFill = isLong ? entryLow : entryHigh;

    // Walk forward to find first bar where price touches the range
    let filled = false;
    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];
      // Range is touched if the bar's high ≥ entryLow AND low ≤ entryHigh
      // (i.e., the bar's price range overlaps with the entry range)
      if (bar.high >= entryLow && bar.low <= entryHigh) {
        entry = conservativeFill;
        fillBarIndex = i;
        filled = true;
        break;
      }
      // Also check if SL or TP is hit BEFORE the range is touched (signal invalidated)
      if (isLong) {
        if (bar.low <= sl) {
          // Price hit SL before touching the buy range — signal never triggered
          return { ...base, outcome: "invalid", exitPrice: sl, exitReason: "sl_before_entry", hitTpLevel: null, maxFavorablePct: 0, maxAdversePct: 0, rMultiple: 0, pnlPercent: 0, durationMinutes: null } as EvalResult;
        }
      } else {
        if (bar.high >= sl) {
          return { ...base, outcome: "invalid", exitPrice: sl, exitReason: "sl_before_entry", hitTpLevel: null, maxFavorablePct: 0, maxAdversePct: 0, rMultiple: 0, pnlPercent: 0, durationMinutes: null } as EvalResult;
        }
      }
    }

    if (!filled) {
      // Range was never touched within the evaluation window
      return { ...base, outcome: "invalid", exitPrice: null, exitReason: "range_not_touched", hitTpLevel: null, maxFavorablePct: 0, maxAdversePct: 0, rMultiple: 0, pnlPercent: 0, durationMinutes: null } as EvalResult;
    }
  } else {
    entry = signal.entryPrice;
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
        durationMinutes: Math.round((lastBar.timestamp - new Date(signal.postedAt).getTime()) / 60000),
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
      durationMinutes: Math.round((lastBar.timestamp - new Date(signal.postedAt).getTime()) / 60000),
    } as EvalResult;
  }

  // Compute R-multiple and PnL
  const rMultiple = isLong
    ? (exitPrice - entry) / risk
    : (entry - exitPrice) / risk;
  const pnlPercent = Math.round(rMultiple * 100) / 100; // 1R = 1% account
  const durationMinutes = exitTime
    ? Math.round((exitTime - new Date(signal.postedAt).getTime()) / 60000)
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

// ── Save evaluation to DB ────────────────────────────────────────────────────
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

// ── Main evaluation runner ───────────────────────────────────────────────────
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

export async function evaluateSignals(
  channelId: string | null,
  onProgress: (p: EvalProgress) => void
): Promise<void> {
  const jobId = `eval-${Date.now()}`;
  const signals: SignalRow[] = channelId
    ? stmts.getUnevaluatedByChannel.all({ $channelId: channelId })
    : stmts.getUnevaluatedSignals.all({} as never);

  onProgress({
    jobId,
    phase: "starting",
    message: `Found ${signals.length} unevaluated signals to evaluate against Dukascopy historical data.`,
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

  const results: EvalResult[] = [];
  let current = 0;
  let totalCached = 0;
  let totalFetched = 0;

  for (const signal of signals) {
    current++;
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
      saveEvaluation(result);
      results.push(result);
      continue;
    }

    onProgress({
      jobId,
      phase: "fetching",
      message: `Fetching ${dukascopyInstrument.toUpperCase()} m15 bars for ${signal.instrument} ${signal.action} signal…`,
      current,
      total: signals.length,
      instrument: signal.instrument,
    });

    // Fetch 48h of m15 bars starting from signal post time (uses DB cache)
    const signalTime = new Date(signal.postedAt);
    let cacheMsg = "";
    const { bars, stats: cacheStats } = await fetchBars(
      dukascopyInstrument,
      signalTime,
      48,
      (msg) => { cacheMsg = msg; }
    );

    totalCached += cacheStats.cached;
    totalFetched += cacheStats.fetched;

    onProgress({
      jobId,
      phase: "evaluating",
      message: `Evaluating ${signal.instrument} ${signal.action} (entry ${signal.entryPrice}) against ${bars.length} bars… (${cacheMsg || "cache ready"})`,
      current,
      total: signals.length,
      instrument: signal.instrument,
    });

    const result = evaluateSignal(signal, bars);
    saveEvaluation(result);
    results.push(result);

    // Small delay to avoid hammering Dukascopy
    await new Promise((r) => setTimeout(r, 300));
  }

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
    : (stmts.countTotalSignals.get({} as never) as { c: number }).c;
  const evaluated = channelId
    ? (stmts.countEvaluatedByChannel.get({ $channelId: channelId }) as { c: number }).c
    : (stmts.countEvaluated.get({} as never) as { c: number }).c;
  return { total, evaluated, pending: total - evaluated };
}
