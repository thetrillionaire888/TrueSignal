// Regex/NLP signal parser for real Telegram trading messages.
// Extracts: instrument, action (long/short), entry (single price or range),
// stop loss, take profits, leverage, timeframe, position size.
// Returns null if no signal is detected.

export type ParsedSignal = {
  instrument: string;
  instrumentType: string;
  action: "long" | "short";
  entryPrice: number;       // single entry price (or range midpoint for display)
  entryLow: number | null;  // for range entries: lower bound
  entryHigh: number | null; // for range entries: upper bound
  isRange: boolean;         // true if entry is a range
  stopLoss: number;
  takeProfits: number[];
  positionSize: string | null;
  leverage: string | null;
  timeframe: string | null;
  confidence: number;
  notes: string | null;
};

// Known instrument patterns — allow optional lowercase suffixes (e.g. XAUUSDz)
const CRYPTO_RE = /\b([A-Z]{2,6}(?:USDT|USD|BTC|ETH|BUSD|USDC)[a-z]?)\b/;
const FOREX_RE = /\b([A-Z]{3}[A-Z]{3})\b(?!\s*(?:USDT|USD))/; // 6-letter pairs
const STOCK_RE = /\b\$([A-Z]{1,5})\b/; // $AAPL
const COMMODITY_RE = /\b(XAUUSD|XAGUSD|XPTUSD|XPDUSD|GOLD|SILVER|WTI|BRENT|OIL)([a-z]?)\b/i;
const INDEX_RE = /\b(SPX500|US30|NAS100|NAS100|GER40|UK100|JP225|US500|DJ30)\b/i;

const ACTION_LONG_RE = /(?:🟢|🟩|▲|⬆️|📈)?\s*(?:LONG|BUY(?:\s+(?:LIMIT|STOP|ZONE))?|GO\s+LONG)/i;
const ACTION_SHORT_RE = /(?:🔴|🟥|🔻|▼|⬇️|📉)?\s*(?:SHORT|SELL(?:\s+(?:LIMIT|STOP|ZONE))?|GO\s+SHORT)/i;

// Entry: allow optional words (Sell Limit, Buy Limit, zone) between keyword and number
const ENTRY_RE = /(?:entry(?:\s+(?:sell|buy))?\s*(?:limit|stop)?|enters?|enter|price|@|open|buy\s*at|sell\s*at|entry\s*price|ref\s*price)\s*[:\-]?\s*[$]?\s*([\d,]+(?:\.\d+)?)/i;
// Range entry: "SELL RANGE: 4110 - 4116", "BUY ZONE: 1.0850 - 1.0860", "ENTRY: 4110-4116"
const RANGE_RE = /(?:sell|buy)?\s*(?:range|zone|entry\s*range|entry\s*zone)\s*[:\-]?\s*[$]?\s*([\d,]+(?:\.\d+)?)\s*(?:[-–—to]+|\s+to\s+)\s*[$]?\s*([\d,]+(?:\.\d+)?)/i;
const SL_RE = /(?:stop\s*loss|sl|stop|stoploss|invalidation|stop\s*l)\s*[:\-]?\s*[$]?\s*([\d,]+(?:\.\d+)?)/i;
const TP_RE = /(?:take\s*profit|tp|target|targets?|t\.p\.?)\s*(\d)?\s*[:\-]?\s*[$]?\s*([\d,]+(?:\.\d+)?)/gi;
const TP_LIST_RE = /(?:targets?|take\s*profits?|tps?)\s*[:\-]\s*([\d,\s.]+)/i;

const LEVERAGE_RE = /\b(\d{1,2})\s*[xX]\b/;
const TIMEFRAME_RE = /\b(scalp(?:ing)?|1m|3m|5m|15m|30m|1h|4h|1d|swing|positional|day\s*trade|intraday)\b/i;
const SIZE_RE = /\b(\d+(?:\.\d+)?\s*(?:%|percent)\s*(?:of\s*)?(?:account|acc|capital|balance)?)\b/;

function parseNumber(s: string): number {
  return parseFloat(s.replace(/,/g, ""));
}

function detectInstrument(text: string): { instrument: string; type: string } | null {
  const comm = text.match(COMMODITY_RE);
  if (comm) {
    // Strip the optional lowercase suffix (e.g. the 'z' in XAUUSDz)
    const sym = comm[1].toUpperCase();
    const map: Record<string, string> = { GOLD: "XAUUSD", SILVER: "XAGUSD", OIL: "WTI", BRENT: "WTI" };
    return { instrument: map[sym] ?? sym, type: "commodities" };
  }
  const idx = text.match(INDEX_RE);
  if (idx) return { instrument: idx[1].toUpperCase(), type: "index" };
  const crypto = text.match(CRYPTO_RE);
  if (crypto) return { instrument: crypto[1].toUpperCase(), type: "crypto" };
  const stock = text.match(STOCK_RE);
  if (stock) return { instrument: stock[1].toUpperCase(), type: "stocks" };
  const forex = text.match(FOREX_RE);
  if (forex) {
    const sym = forex[1].toUpperCase();
    const valid = ["EURUSD", "GBPUSD", "USDJPY", "AUDUSD", "USDCAD", "EURGBP", "EURJPY", "NZDUSD", "USDCHF", "GBPJPY"];
    if (valid.includes(sym)) return { instrument: sym, type: "forex" };
  }
  return null;
}

export function parseSignal(text: string): ParsedSignal | null {
  if (!text || text.length < 15) return null;

  const instrumentInfo = detectInstrument(text);
  if (!instrumentInfo) return null;

  // action
  let action: "long" | "short" | null = null;
  if (ACTION_LONG_RE.test(text)) action = "long";
  else if (ACTION_SHORT_RE.test(text)) action = "short";
  if (!action) return null;

  // ── Entry: try range first, then single price ────────────────────────────
  let entryPrice: number;
  let entryLow: number | null = null;
  let entryHigh: number | null = null;
  let isRange = false;

  const rangeMatch = text.match(RANGE_RE);
  if (rangeMatch) {
    entryLow = parseNumber(rangeMatch[1]);
    entryHigh = parseNumber(rangeMatch[2]);
    if (isFinite(entryLow) && isFinite(entryHigh) && entryLow > 0 && entryHigh > 0) {
      // Normalize: ensure entryLow < entryHigh
      if (entryLow > entryHigh) { const t = entryLow; entryLow = entryHigh; entryHigh = t; }
      entryPrice = (entryLow + entryHigh) / 2; // midpoint for display
      isRange = true;
    } else {
      return null;
    }
  } else {
    const entryMatch = text.match(ENTRY_RE);
    if (!entryMatch) return null;
    entryPrice = parseNumber(entryMatch[1]);
    if (!isFinite(entryPrice) || entryPrice <= 0) return null;
  }

  // stop loss
  const slMatch = text.match(SL_RE);
  if (!slMatch) return null;
  const stopLoss = parseNumber(slMatch[1]);
  if (!isFinite(stopLoss) || stopLoss <= 0) return null;

  // take profits — collect all TP n: value matches
  const tps: number[] = [];
  let m: RegExpExecArray | null;
  const tpRe = new RegExp(TP_RE);
  while ((m = tpRe.exec(text)) !== null) {
    const val = parseNumber(m[2]);
    if (isFinite(val) && val > 0) tps.push(val);
  }
  // fallback: "Targets: 1.2345, 1.2500, 1.2700"
  if (tps.length === 0) {
    const listMatch = text.match(TP_LIST_RE);
    if (listMatch) {
      for (const part of listMatch[1].split(/[,;\s]+/)) {
        const val = parseNumber(part);
        if (isFinite(val) && val > 0) tps.push(val);
      }
    }
  }
  // If still no TPs, derive a default 1R and 2R target from entry/SL
  if (tps.length === 0) {
    const direction = action === "long" ? 1 : -1;
    const risk = Math.abs(entryPrice - stopLoss);
    tps.push(entryPrice + direction * risk);
    tps.push(entryPrice + direction * risk * 2);
  }

  // leverage
  const levMatch = text.match(LEVERAGE_RE);
  const leverage = levMatch ? `${levMatch[1]}x` : null;

  // timeframe
  const tfMatch = text.match(TIMEFRAME_RE);
  const timeframe = tfMatch ? tfMatch[1].toLowerCase() : null;

  // position size
  const sizeMatch = text.match(SIZE_RE);
  const positionSize = sizeMatch ? sizeMatch[1] : null;

  // confidence — higher if more fields present and TP count >= 2
  let confidence = 0.5;
  if (tps.length >= 2) confidence += 0.15;
  if (tps.length >= 3) confidence += 0.1;
  if (leverage) confidence += 0.05;
  if (timeframe) confidence += 0.05;
  if (positionSize) confidence += 0.05;
  if (/#/.test(text)) confidence += 0.05; // tagged instruments are more deliberate
  confidence = Math.min(0.97, confidence);

  return {
    instrument: instrumentInfo.instrument,
    instrumentType: instrumentInfo.type,
    action,
    entryPrice,
    entryLow,
    entryHigh,
    isRange,
    stopLoss,
    takeProfits: tps,
    positionSize,
    leverage,
    timeframe,
    confidence: Math.round(confidence * 100) / 100,
    notes: isRange ? `Range entry: ${entryLow} - ${entryHigh}` : null,
  };
}
