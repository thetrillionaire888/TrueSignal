// Multi-stage signal parser for real Telegram trading messages.
// 3-stage cascade: Stage 1 (keyword) → Stage 2 (action-anchored) → Stage 3 (price-proximity)
// Short-circuits on first success.

export type EntryType = "market" | "stop" | "limit" | "range";

export type ParsedSignal = {
  instrument: string; instrumentType: string; action: "long" | "short";
  entryPrice: number; entryLow: number | null; entryHigh: number | null;
  isRange: boolean; entryType: EntryType; stopLoss: number; takeProfits: number[];
  positionSize: string | null; leverage: string | null; timeframe: string | null;
  confidence: number; notes: string | null;
};

const COMMODITY_MAP: Record<string, string> = { GOLD: "XAUUSD", SILVER: "XAGUSD", OIL: "WTI", BRENT: "BRENT" };
const COMMODITY_RE = /\b(XAUUSD|XAGUSD|XPTUSD|XPDUSD|GOLD|SILVER|WTI|BRENT|OIL)[a-z]?\b/i;
const INDEX_RE = /\b(SPX500|US30|NAS100|GER40|UK100|JP225|US500|DJ30)\b/i;
const CRYPTO_RE = /\b([A-Z]{2,6}(?:USDT|USD|BTC|ETH|BUSD|USDC))\b/;
const STOCK_RE = /\$([A-Z]{1,5})\b/;
const FOREX_PAIRS = ["EURUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","EURGBP","EURJPY","NZDUSD","USDCHF","GBPJPY","EURCAD","AUDJPY","AUDCAD","CADJPY","CHFJPY","EURCHF","EURAUD","GBPAUD","GBPCAD","NZDJPY","XAGUSD"];
const FOREX_RE = new RegExp("\\b(" + FOREX_PAIRS.join("|") + ")\\b", "i");

function detectInstrument(text: string): { instrument: string; type: string } | null {
  const comm = text.match(COMMODITY_RE);
  if (comm) { const sym = comm[1].toUpperCase(); return { instrument: COMMODITY_MAP[sym] ?? sym, type: "commodities" }; }
  const idx = text.match(INDEX_RE); if (idx) return { instrument: idx[1].toUpperCase(), type: "index" };
  const crypto = text.match(CRYPTO_RE); if (crypto) return { instrument: crypto[1].toUpperCase(), type: "crypto" };
  const stock = text.match(STOCK_RE); if (stock) return { instrument: stock[1].toUpperCase(), type: "stocks" };
  const forex = text.match(FOREX_RE); if (forex) return { instrument: forex[1].toUpperCase(), type: "forex" };
  return null;
}

type ActionMatch = { action: "long" | "short"; entryType: EntryType } | null;
function detectAction(text: string): ActionMatch {
  if (/\b(?:buy\s+stop|long\s+stop)\b/i.test(text)) return { action: "long", entryType: "stop" };
  if (/\b(?:buy\s+limit|long\s+limit)\b/i.test(text)) return { action: "long", entryType: "limit" };
  if (/\b(?:sell\s+stop|short\s+stop)\b/i.test(text)) return { action: "short", entryType: "stop" };
  if (/\b(?:sell\s+limit|short\s+limit)\b/i.test(text)) return { action: "short", entryType: "limit" };
  if (/\b(?:long|buy(?!_\w)(?:\s+now|\s+zone|\s+at)?|go\s+long)\b/i.test(text)) return { action: "long", entryType: "market" };
  if (/\b(?:short|sell(?!_\w)(?:\s+now|\s+zone|\s+at)?|go\s+short)\b/i.test(text)) return { action: "short", entryType: "market" };
  return null;
}

const NUM = "([\\d,]+(?:\\.\\d+)?)";
const SL_RE = new RegExp("(?:stop\\s*loss|stoploss|\\bsl\\b|invalidation|stop\\s*l)\\s*[:\\-]?\\s*\\$?\\s*" + NUM, "i");
const TP_LIST_RE = new RegExp("(?:targets?|take\\s*profits?|tps?)\\s*[:\\-]\\s*([\\d,\\s.]+)", "i");
const TP_RE = new RegExp("(?:take\\s*profit|\\btp\\d*|target|t\\.p\\.?)\\s*(?:\\d+\\s*[:\\-]?)?\\s*\\$?\\s*" + NUM, "gi");
const ENTRY_KEYWORD_RE = new RegExp("(?:entry(?:\\s+(?:sell|buy))?(?:\\s+(?:limit|stop|zone))?|enters?|buy\\s*at|sell\\s*at|ref\\s*price)\\s*[:\\-]?\\s*\\$?\\s*" + NUM, "i");
const RANGE_KEYWORD_RE = new RegExp("(?:sell|buy)?\\s*(?:range|zone)\\s*[:\\-]?\\s*\\$?\\s*" + NUM + "\\s*(?:[-–—to]+|\\s+to\\s+)\\s*\\$?\\s*" + NUM, "i");
const ACTION_PRICE_RE = new RegExp("(?:buy|sell|long|short)\\s*(?:now|stop|limit|zone)?\\s*@?\\s*\\$?\\s*" + NUM, "i");
const ACTION_RANGE_RE = new RegExp("(?:buy|sell|long|short)\\s*(?:now|stop|limit|zone)?\\s*@?\\s*\\$?\\s*" + NUM + "\\s*(?:[-–—to]+|\\s+to\\s+)\\s*\\$?\\s*" + NUM, "i");
const AT_RANGE_RE = new RegExp("@\\s*\\$?\\s*" + NUM + "\\s*(?:[-–—to]+|\\s+to\\s+)\\s*\\$?\\s*" + NUM, "i");
const AT_SINGLE_RE = new RegExp("@\\s*\\$?\\s*" + NUM, "i");
const TP_OPEN_RE = /\btp\s*[:\-]?\s*open\b/i;
const LEVERAGE_RE = /\b(\d{1,2})\s*[xX]\b/;
const TIMEFRAME_RE = /\b(scalp(?:ing)?|1m|3m|5m|15m|30m|1h|4h|1d|swing|positional|day\s*trade|intraday)\b/i;
const SIZE_RE = /\b(\d+(?:\.\d+)?\s*(?:%|percent)\s*(?:of\s*)?(?:account|acc|capital|balance)?)\b/i;

function parseNumber(s: string): number { return parseFloat(s.replace(/,/g, "")); }
function splitLines(text: string): string[] { return text.split(/[\r\n|]+/).map((l) => l.trim()).filter((l) => l.length > 0); }

function extractStopLoss(lines: string[]): number | null {
  let stopLoss: number | null = null;
  for (const line of lines) { const m = line.match(SL_RE); if (m) { const v = parseNumber(m[1]); if (isFinite(v) && v > 0) stopLoss = v; } }
  return stopLoss;
}

function extractTakeProfits(lines: string[], text: string, entryPrice: number, stopLoss: number, action: "long" | "short"): { tps: number[]; warnings: string[] } {
  const tps: number[] = []; const warnings: string[] = [];
  if (TP_OPEN_RE.test(text)) { warnings.push("TP: OPEN — derived 1R, 2R"); }
  else {
    for (const line of lines) { const m = line.match(TP_LIST_RE); if (m) { for (const p of m[1].split(/[,;\s]+/)) { if (!p) continue; const v = parseNumber(p); if (isFinite(v) && v > 0) tps.push(v); } if (tps.length > 0) break; } }
    if (tps.length === 0) { for (const line of lines) { const tpRe = new RegExp(TP_RE.source, "gi"); let m; while ((m = tpRe.exec(line)) !== null) { const v = parseNumber(m[1]); if (isFinite(v) && v > 0) tps.push(v); } } }
  }
  if (tps.length === 0) { const d = action === "long" ? 1 : -1; const r = Math.abs(entryPrice - stopLoss); tps.push(entryPrice + d * r); tps.push(entryPrice + d * r * 2); if (warnings.length === 0) warnings.push("TPs derived from entry/SL (1R, 2R)"); }
  const validTps = tps.filter((tp) => action === "long" ? tp > entryPrice : tp < entryPrice);
  if (validTps.length === 0) { const d = action === "long" ? 1 : -1; const r = Math.abs(entryPrice - stopLoss); validTps.push(entryPrice + d * r); validTps.push(entryPrice + d * r * 2); warnings.push("All TPs on wrong side — derived 1R, 2R"); }
  return { tps: validTps, warnings };
}

function extractMetadata(text: string) {
  const levMatch = text.match(LEVERAGE_RE); const tfMatch = text.match(TIMEFRAME_RE); const sizeMatch = text.match(SIZE_RE);
  return { leverage: levMatch ? `${levMatch[1]}x` : null, timeframe: tfMatch ? tfMatch[1].toLowerCase().replace(/\s+/g, "") : null, positionSize: sizeMatch ? sizeMatch[1] : null };
}

function computeConfidence(base: number, tps: number[], leverage: string | null, timeframe: string | null, positionSize: string | null, hasHashtag: boolean, warnings: string[]): number {
  let c = base; if (tps.length >= 2) c += 0.15; if (tps.length >= 3) c += 0.1; if (leverage) c += 0.05; if (timeframe) c += 0.05; if (positionSize) c += 0.05; if (hasHashtag) c += 0.05; if (warnings.length > 0) c -= 0.1;
  return Math.max(0.3, Math.min(0.97, c));
}

function validateSides(action: "long" | "short", entryPrice: number, stopLoss: number): boolean {
  if (action === "long" && stopLoss >= entryPrice) return false;
  if (action === "short" && stopLoss <= entryPrice) return false;
  return true;
}

function extractEntryType(notes: string | null): "market" | "stop" | "limit" | "range" {
  if (!notes) return "market";
  const m = notes.match(/entryType:(\w+)/);
  if (m && ["stop","limit","range","market"].includes(m[1])) return m[1] as any;
  return "market";
}

// Stage 1: Keyword-structured
function parseStage1(lines: string[], text: string, instrument: string, instrumentType: string, action: "long" | "short", entryType: EntryType): ParsedSignal | null {
  let entryPrice = 0, entryLow: number | null = null, entryHigh: number | null = null, isRange = false;
  for (const line of lines) { const m = line.match(RANGE_KEYWORD_RE); if (m) { const lo = parseNumber(m[1]), hi = parseNumber(m[2]); if (isFinite(lo) && isFinite(hi) && lo > 0 && hi > 0) { entryLow = Math.min(lo,hi); entryHigh = Math.max(lo,hi); entryPrice = (entryLow+entryHigh)/2; isRange = true; entryType = "range"; } } }
  if (!isRange) { let found = false; for (const line of lines) { const m = line.match(ENTRY_KEYWORD_RE); if (m) { const v = parseNumber(m[1]); if (isFinite(v) && v > 0) { entryPrice = v; found = true; } } } if (!found) return null; }
  const stopLoss = extractStopLoss(lines); if (stopLoss === null) return null;
  if (!validateSides(action, entryPrice, stopLoss)) return null;
  const { tps, warnings } = extractTakeProfits(lines, text, entryPrice, stopLoss, action);
  const { leverage, timeframe, positionSize } = extractMetadata(text);
  const confidence = computeConfidence(0.8, tps, leverage, timeframe, positionSize, /#/.test(text), warnings);
  const notes: string[] = []; if (isRange) notes.push(`Range entry: ${entryLow} - ${entryHigh}`); notes.push(`stage:1 entryType:${entryType}`); if (warnings.length > 0) notes.push(...warnings);
  return { instrument, instrumentType, action, entryPrice, entryLow, entryHigh, isRange, entryType, stopLoss, takeProfits: tps, positionSize, leverage, timeframe, confidence: Math.round(confidence * 100) / 100, notes: notes.join(" | ") };
}

// Stage 2: Action-anchored
function parseStage2(lines: string[], text: string, instrument: string, instrumentType: string, action: "long" | "short", entryType: EntryType): ParsedSignal | null {
  let entryPrice = 0, entryLow: number | null = null, entryHigh: number | null = null, isRange = false;
  for (const line of lines) { const m = line.match(ACTION_RANGE_RE); if (m) { const lo = parseNumber(m[1]), hi = parseNumber(m[2]); if (isFinite(lo) && isFinite(hi) && lo > 0 && hi > 0) { entryLow = Math.min(lo,hi); entryHigh = Math.max(lo,hi); entryPrice = (entryLow+entryHigh)/2; isRange = true; entryType = "range"; break; } } }
  if (!isRange) { for (const line of lines) { const m = line.match(AT_RANGE_RE); if (m) { const lo = parseNumber(m[1]), hi = parseNumber(m[2]); if (isFinite(lo) && isFinite(hi) && lo > 0 && hi > 0) { entryLow = Math.min(lo,hi); entryHigh = Math.max(lo,hi); entryPrice = (entryLow+entryHigh)/2; isRange = true; entryType = "range"; break; } } } }
  if (!isRange) { for (const line of lines) { const m = line.match(ACTION_PRICE_RE); if (m) { const v = parseNumber(m[1]); if (isFinite(v) && v > 0) { entryPrice = v; break; } } } }
  if (!isRange && entryPrice === 0) { for (const line of lines) { const m = line.match(AT_SINGLE_RE); if (m) { const v = parseNumber(m[1]); if (isFinite(v) && v > 0) { entryPrice = v; break; } } } }
  if (!isRange && entryPrice === 0) return null;
  const stopLoss = extractStopLoss(lines); if (stopLoss === null) return null;
  if (!validateSides(action, entryPrice, stopLoss)) return null;
  const { tps, warnings } = extractTakeProfits(lines, text, entryPrice, stopLoss, action);
  const { leverage, timeframe, positionSize } = extractMetadata(text);
  const confidence = computeConfidence(0.6, tps, leverage, timeframe, positionSize, /#/.test(text), warnings);
  const notes: string[] = []; if (isRange) notes.push(`Range entry: ${entryLow} - ${entryHigh}`); notes.push(`stage:2 entryType:${entryType}`); if (warnings.length > 0) notes.push(...warnings);
  return { instrument, instrumentType, action, entryPrice, entryLow, entryHigh, isRange, entryType, stopLoss, takeProfits: tps, positionSize, leverage, timeframe, confidence: Math.round(confidence * 100) / 100, notes: notes.join(" | ") };
}

// Stage 3: Price-proximity (last resort)
function parseStage3(lines: string[], text: string, instrument: string, instrumentType: string, action: "long" | "short", entryType: EntryType): ParsedSignal | null {
  if (/\b(?:close\s*posisi|position\s*closed|sudah\s*close|laporan\s*harian|daily\s*report|recap|winrate)\b/i.test(text)) return null;
  const stopLoss = extractStopLoss(lines); if (stopLoss === null) return null;
  const PRICE_RE = /(?<![%\d])(\d{1,6}(?:\.\d{1,5})?)(?![%\d])/g;
  const prices: { value: number; index: number }[] = []; let m;
  while ((m = PRICE_RE.exec(text)) !== null) { const v = parseFloat(m[1]); if (v > 0.0001 && v < 1000000) { const before = text.slice(Math.max(0, m.index - 2), m.index), after = text.slice(m.index + m[1].length, m.index + m[1].length + 2); if (!before.includes('%') && !after.includes('%')) prices.push({ value: v, index: m.index }); } }
  if (prices.length === 0) return null;
  const actionMatch = text.match(/\b(?:buy|sell|long|short)\b/i); if (!actionMatch) return null;
  const actionPos = actionMatch.index ?? 0;
  const candidates = prices.filter((p) => p.value !== stopLoss).filter((p) => action === "long" ? p.value > stopLoss : p.value < stopLoss).sort((a, b) => Math.abs(a.index - actionPos) - Math.abs(b.index - actionPos));
  if (candidates.length === 0) return null;
  const entryPrice = candidates[0].value;
  if (!validateSides(action, entryPrice, stopLoss)) return null;
  const tps = prices.filter((p) => p.value !== entryPrice && p.value !== stopLoss).filter((p) => action === "long" ? p.value > entryPrice : p.value < entryPrice).map((p) => p.value);
  if (tps.length === 0) { const d = action === "long" ? 1 : -1; const r = Math.abs(entryPrice - stopLoss); tps.push(entryPrice + d * r); tps.push(entryPrice + d * r * 2); }
  const { leverage, timeframe, positionSize } = extractMetadata(text);
  const warnings = ["stage:3 price-proximity (low confidence)"];
  const confidence = computeConfidence(0.4, tps, leverage, timeframe, positionSize, /#/.test(text), warnings);
  return { instrument, instrumentType, action, entryPrice, entryLow: null, entryHigh: null, isRange: false, entryType, stopLoss, takeProfits: tps, positionSize, leverage, timeframe, confidence: Math.round(confidence * 100) / 100, notes: [`entryType:${entryType}`, ...warnings].join(" | ") };
}

export function parseSignal(text: string): ParsedSignal | null {
  if (!text || text.length < 15) return null;
  const instrumentInfo = detectInstrument(text); if (!instrumentInfo) return null;
  const actionMatch = detectAction(text); if (!actionMatch) return null;
  const lines = splitLines(text); const { action, entryType } = actionMatch;
  return parseStage1(lines, text, instrumentInfo.instrument, instrumentInfo.type, action, entryType)
    || parseStage2(lines, text, instrumentInfo.instrument, instrumentInfo.type, action, entryType)
    || parseStage3(lines, text, instrumentInfo.instrument, instrumentInfo.type, action, entryType)
    || null;
}
