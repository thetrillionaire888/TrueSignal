// Multi-message signal correlator.
// Handles channels that split a single signal across multiple messages,
// linked by a "magic number" (order ID) — common in MetaTrader-connected
// Telegram channels like Pandai Trading Signal VIP.
//
// Message types in a correlated group:
//   1. Signal message: "SIGNAL PANDAI BARU! Entry Sell: 4037.47 | # 4525221"
//      → has instrument, action, entry, order ID (no SL/TP)
//   2. SL/TP update: "XAUUSDz Sell - dirubah. SL baru: 4045.00 | TP baru: 3990.00 | # 4525221"
//      → has SL (use last "SL baru" = new SL), TP (use last "TP baru"), order ID
//   3. Close message: "Sudah close posisi! Entry Sell: 4037.47 | Exit: 4033.43 | # 4525221"
//      → has entry, exit price (= outcome), order ID
//
// The correlator merges these into a single Signal record (from the signal message)
// and optionally creates an Evaluation record (from the close message).

import { sqlite } from "@/lib/db";
import { cuid } from "./cuid";
import { parseSignal, type ParsedSignal } from "./parser";

// ── Regexes for multi-message field extraction ──────────────────────────────

// Magic number / order ID: "# 4525221" or "No Order: # 4525221"
const ORDER_ID_RE = /#\s*(\d{4,})/;

// "SL baru: 4045.00" (Indonesian: "new SL") — extract the number after "SL baru:"
const SL_BARU_RE = /SL\s*baru\s*:\s*([\d,]+(?:\.\d+)?)/i;

// "TP baru: 3990.00" (Indonesian: "new TP")
const TP_BARU_RE = /TP\s*baru\s*:\s*([\d,]+(?:\.\d+)?)/i;

// Entry from signal message: "Entry Sell: 4037.47" or "Entry Buy: 4037.47"
const ENTRY_SELL_RE = /entry\s*sell\s*(?:stop|limit)?\s*:\s*([\d,]+(?:\.\d+)?)/i;
const ENTRY_BUY_RE = /entry\s*buy\s*(?:stop|limit)?\s*:\s*([\d,]+(?:\.\d+)?)/i;

// Exit from close message: "Exit: 4033.43"
const EXIT_RE = /exit\s*:\s*([\d,]+(?:\.\d+)?)/i;

// Result from close message: "Hasil: 404.0 $" or "Hasil: -105.1 $"
const HASIL_RE = /hasil\s*:\s*(-?[\d,]+(?:\.\d+)?)\s*\$/i;

// Message type detection
const isSignalMessage = (text: string) => /SIGNAL\s*(?:PANDAI\s*)?BARU/i.test(text);
const isDirubahMessage = (text: string) => /dirubah/i.test(text);
const isCloseMessage = (text: string) => /close\s*posisi/i.test(text);
const isCancelMessage = (text: string) => /cancel/i.test(text);

// Instrument detection (reuse from parser)
const COMMODITY_RE = /\b(XAUUSD|XAGUSD|XPTUSD|XPDUSD|GOLD|SILVER|WTI|BRENT|OIL)[a-z]?\b/i;
const COMMODITY_MAP: Record<string, string> = { GOLD: "XAUUSD", SILVER: "XAGUSD", OIL: "WTI", BRENT: "BRENT" };

function detectInstrument(text: string): { instrument: string; type: string } | null {
  const comm = text.match(COMMODITY_RE);
  if (comm) {
    const sym = comm[1].toUpperCase();
    return { instrument: COMMODITY_MAP[sym] ?? sym, type: "commodities" };
  }
  return null; // extend with other instrument types if needed
}

function parseNum(s: string): number {
  return parseFloat(s.replace(/,/g, ""));
}

// ── Types ────────────────────────────────────────────────────────────────────
type MessageRow = {
  id: string;
  channelId: string;
  rawText: string;
  postedAt: string;
  parseStatus: string;
};

type CorrelatedGroup = {
  orderId: string;
  channelId: string;
  signalMessage?: MessageRow;
  dirubahMessages: MessageRow[];
  closeMessage?: MessageRow;
  cancelMessage?: MessageRow;
};

type CorrelatedSignal = {
  instrument: string;
  instrumentType: string;
  action: "long" | "short";
  entryPrice: number;
  entryType: "market" | "stop" | "limit" | "range";
  stopLoss: number;
  takeProfits: number[];
  messageId: string;
  channelId: string;
  postedAt: string;
  notes: string;
  // Optional: outcome from close message
  exitPrice?: number;
  outcome?: "win" | "loss" | "breakeven";
  rMultiple?: number;
  pnlPercent?: number;
};

// ── Group messages by order ID ──────────────────────────────────────────────
export function groupByOrderId(messages: MessageRow[]): Map<string, CorrelatedGroup> {
  const groups = new Map<string, CorrelatedGroup>();

  for (const msg of messages) {
    const text = msg.rawText || "";
    const match = text.match(ORDER_ID_RE);
    if (!match) continue;

    const orderId = match[1];
    if (!groups.has(orderId)) {
      groups.set(orderId, {
        orderId,
        channelId: msg.channelId,
        dirubahMessages: [],
      });
    }
    const group = groups.get(orderId)!;

    if (isSignalMessage(text)) {
      group.signalMessage = msg;
    } else if (isCloseMessage(text)) {
      group.closeMessage = msg;
    } else if (isCancelMessage(text)) {
      group.cancelMessage = msg;
    } else if (isDirubahMessage(text)) {
      group.dirubahMessages.push(msg);
    }
  }

  return groups;
}

// ── Extract correlated signal from a group ──────────────────────────────────
export function extractCorrelatedSignal(group: CorrelatedGroup): CorrelatedSignal | null {
  const { signalMessage, dirubahMessages, closeMessage, cancelMessage, channelId } = group;

  // Skip cancelled orders
  if (cancelMessage && !closeMessage) return null;

  // Need at least a signal message or a close message with entry
  let entryPrice = 0;
  let action: "long" | "short" = "short";
  let entryType: "market" | "stop" | "limit" = "market";
  let instrument = "";
  let instrumentType = "commodities";
  let messageId = "";
  let postedAt = "";

  // Try to extract from signal message first
  if (signalMessage) {
    const text = signalMessage.rawText || "";
    messageId = signalMessage.id;
    postedAt = signalMessage.postedAt;

    // Instrument
    const instInfo = detectInstrument(text);
    if (instInfo) {
      instrument = instInfo.instrument;
      instrumentType = instInfo.type;
    }

    // Action + entry type from text
    if (/\b(?:buy\s+stop|long\s+stop)\b/i.test(text)) { action = "long"; entryType = "stop"; }
    else if (/\b(?:buy\s+limit|long\s+limit)\b/i.test(text)) { action = "long"; entryType = "limit"; }
    else if (/\b(?:sell\s+stop|short\s+stop)\b/i.test(text)) { action = "short"; entryType = "stop"; }
    else if (/\b(?:sell\s+limit|short\s+limit)\b/i.test(text)) { action = "short"; entryType = "limit"; }
    else if (/\b(?:buy|long)\b/i.test(text)) { action = "long"; entryType = "market"; }
    else if (/\b(?:sell|short)\b/i.test(text)) { action = "short"; entryType = "market"; }

    // Entry price
    const entryMatch = action === "long"
      ? text.match(ENTRY_BUY_RE)
      : text.match(ENTRY_SELL_RE);
    if (entryMatch) {
      entryPrice = parseNum(entryMatch[1]);
    }
  }

  // If no signal message, try close message for entry
  if (!signalMessage && closeMessage) {
    const text = closeMessage.rawText || "";
    messageId = closeMessage.id;
    postedAt = closeMessage.postedAt;

    const instInfo = detectInstrument(text);
    if (instInfo) { instrument = instInfo.instrument; instrumentType = instInfo.type; }

    if (/\b(?:buy|long)\b/i.test(text)) action = "long";
    else if (/\b(?:sell|short)\b/i.test(text)) action = "short";

    const entryMatch = action === "long"
      ? text.match(ENTRY_BUY_RE)
      : text.match(ENTRY_SELL_RE);
    if (entryMatch) entryPrice = parseNum(entryMatch[1]);
  }

  if (!instrument || entryPrice <= 0) return null;

  // ── Extract SL from dirubah messages (use LAST "SL baru") ─────────────────
  let stopLoss = 0;
  for (const msg of dirubahMessages) {
    const text = msg.rawText || "";
    const slMatch = text.match(SL_BARU_RE);
    if (slMatch) {
      const val = parseNum(slMatch[1]);
      if (isFinite(val) && val > 0) stopLoss = val;
    }
  }

  // Also check signal message for SL (older format had it inline)
  if (stopLoss === 0 && signalMessage) {
    const slMatch = (signalMessage.rawText || "").match(/(?:SL|stop\s*loss)\s*:\s*([\d,]+(?:\.\d+)?)/i);
    if (slMatch) stopLoss = parseNum(slMatch[1]);
  }

  if (stopLoss <= 0) return null;

  // Validate SL side
  if (action === "long" && stopLoss >= entryPrice) return null;
  if (action === "short" && stopLoss <= entryPrice) return null;

  // ── Extract TP from dirubah messages (use LAST "TP baru") ─────────────────
  const tps: number[] = [];
  for (const msg of dirubahMessages) {
    const text = msg.rawText || "";
    const tpMatch = text.match(TP_BARU_RE);
    if (tpMatch) {
      const val = parseNum(tpMatch[1]);
      if (isFinite(val) && val > 0) tps.push(val);
    }
  }

  // Also check signal message for TP (older format)
  if (tps.length === 0 && signalMessage) {
    const tpMatch = (signalMessage.rawText || "").match(/(?:TP|take\s*profit)\s*:\s*([\d,]+(?:\.\d+)?)/i);
    if (tpMatch) {
      const val = parseNum(tpMatch[1]);
      if (isFinite(val) && val > 0) tps.push(val);
    }
  }

  // Derive 1R/2R if no TPs
  if (tps.length === 0) {
    const direction = action === "long" ? 1 : -1;
    const risk = Math.abs(entryPrice - stopLoss);
    tps.push(entryPrice + direction * risk);
    tps.push(entryPrice + direction * risk * 2);
  }

  // Filter TPs to correct side
  const validTps = tps.filter((tp) => action === "long" ? tp > entryPrice : tp < entryPrice);
  if (validTps.length === 0) {
    const direction = action === "long" ? 1 : -1;
    const risk = Math.abs(entryPrice - stopLoss);
    validTps.push(entryPrice + direction * risk);
    validTps.push(entryPrice + direction * risk * 2);
  }

  // ── Extract outcome from close message ────────────────────────────────────
  let exitPrice: number | undefined;
  let outcome: "win" | "loss" | "breakeven" | undefined;
  let rMultiple: number | undefined;
  let pnlPercent: number | undefined;

  if (closeMessage) {
    const text = closeMessage.rawText || "";
    const exitMatch = text.match(EXIT_RE);
    if (exitMatch) {
      exitPrice = parseNum(exitMatch[1]);
      const risk = Math.abs(entryPrice - stopLoss);
      if (risk > 0) {
        rMultiple = action === "long"
          ? (exitPrice - entryPrice) / risk
          : (entryPrice - exitPrice) / risk;
        rMultiple = Math.round(rMultiple * 100) / 100;
        pnlPercent = rMultiple;

        if (Math.abs(rMultiple) < 0.1) outcome = "breakeven";
        else if (rMultiple > 0) outcome = "win";
        else outcome = "loss";
      }
    }
  }

  const notes = `correlated orderId:${group.orderId} entryType:${entryType}`;

  return {
    instrument, instrumentType, action, entryPrice, entryType,
    stopLoss, takeProfits: validTps, messageId, channelId, postedAt,
    notes, exitPrice, outcome, rMultiple, pnlPercent,
  };
}

// ── Main correlation function ───────────────────────────────────────────────
// Runs on a channel's messages, groups by order ID, creates Signal + Evaluation
// records from correlated groups. Returns stats.
export function correlateChannelSignals(channelId: string): {
  groupsFound: number;
  signalsCreated: number;
  evaluationsCreated: number;
  skipped: number;
} {
  // Get all no_signal messages that have an order ID
  const messages = sqlite.prepare(
    "SELECT id, channelId, rawText, postedAt, parseStatus FROM Message WHERE channelId = ? AND parseStatus = 'no_signal' ORDER BY postedAt ASC"
  ).all(channelId) as MessageRow[];

  // Group by order ID
  const groups = groupByOrderId(messages);

  let signalsCreated = 0;
  let evaluationsCreated = 0;
  let skipped = 0;

  const stmts = {
    insertSignal: sqlite.prepare(
      `INSERT OR IGNORE INTO Signal
       (id, messageId, channelId, instrument, instrumentType, action, entryPrice,
        entryLow, entryHigh, isRange, stopLoss, takeProfits, positionSize, leverage,
        timeframe, confidence, parserVersion, parsedAt, status, notes, dedupHash)
       VALUES ($id, $messageId, $channelId, $instrument, $instrumentType, $action, $entryPrice,
        $entryLow, $entryHigh, $isRange, $stopLoss, $takeProfits, $positionSize, $leverage,
        $timeframe, $confidence, $parserVersion, $parsedAt, $status, $notes, $dedupHash)`
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
    updateParseStatus: sqlite.prepare(
      "UPDATE Message SET parseStatus = 'parsed' WHERE id = ?"
    ),
    incrementSignalCount: sqlite.prepare(
      "UPDATE catalog.ChannelStats SET signalCount = signalCount + 1, updatedAt = datetime('now') WHERE channelId = ?"
    ),
  };

  const tx = sqlite.transaction(() => {
    for (const [, group] of groups) {
      // Only process groups with 2+ messages (multi-message signals)
      const totalMsgs = (group.signalMessage ? 1 : 0) + group.dirubahMessages.length + (group.closeMessage ? 1 : 0) + (group.cancelMessage ? 1 : 0);
      if (totalMsgs < 2) { skipped++; continue; }

      const signal = extractCorrelatedSignal(group);
      if (!signal) { skipped++; continue; }

      // Create the Signal record
      const signalId = cuid();
      const dedupHash = `${channelId}|${signal.postedAt}`;
      stmts.insertSignal.run({
        $id: signalId,
        $messageId: signal.messageId,
        $channelId: channelId,
        $instrument: signal.instrument,
        $instrumentType: signal.instrumentType,
        $action: signal.action,
        $entryPrice: signal.entryPrice,
        $entryLow: null,
        $entryHigh: null,
        $isRange: 0,
        $stopLoss: signal.stopLoss,
        $takeProfits: JSON.stringify(signal.takeProfits),
        $positionSize: null,
        $leverage: null,
        $timeframe: null,
        $confidence: 0.6,
        $parserVersion: "correlator-v1",
        $parsedAt: new Date().toISOString(),
        $status: signal.outcome ? "closed" : "evaluating",
        $notes: signal.notes,
        $dedupHash: dedupHash,
      });
      signalsCreated++;
      stmts.incrementSignalCount.run({ $channelId: channelId });

      // Mark the signal message as parsed
      if (group.signalMessage) {
        stmts.updateParseStatus.run(group.signalMessage.id);
      }

      // Create Evaluation record if we have a close message with outcome
      if (signal.outcome && signal.exitPrice !== undefined) {
        stmts.insertEvaluation.run({
          $id: cuid(),
          $signalId: signalId,
          $outcome: signal.outcome,
          $exitPrice: signal.exitPrice,
          $exitReason: "manual",
          $hitTpLevel: null,
          $maxFavorablePct: null,
          $maxAdversePct: null,
          $rMultiple: signal.rMultiple ?? 0,
          $pnlPercent: signal.pnlPercent ?? 0,
          $durationMinutes: null,
          $marketDataSource: "channel-reported",
          $evaluatedAt: new Date().toISOString(),
        });
        evaluationsCreated++;
      }
    }
  });
  tx();

  return {
    groupsFound: groups.size,
    signalsCreated,
    evaluationsCreated,
    skipped,
  };
}
