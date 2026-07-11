// Test suite for the multi-stage signal parser.
import { parseSignal, type ParsedSignal } from '../mini-services/telegram-collector/parser'

type TestCase = { name: string; text: string; expect?: Partial<ParsedSignal>; expectNull?: boolean }
const cases: TestCase[] = [
  { name: 'S1: Pandai Buy Stop (was zero_risk bug)', text: 'SIGNAL PANDAI BARU! - XAUUSDz Buy Stop 📈 | Entry Buy Stop: 4145.00 | SL: 4125.00 | TP: 4180.00', expect: { instrument: 'XAUUSD', action: 'long', entryPrice: 4145, stopLoss: 4125, takeProfits: [4180], entryType: 'stop' } },
  { name: 'S1: Pandai Sell Limit', text: 'SIGNAL PANDAI BARU! - XAUUSDz Sell Limit 📉 | Entry Sell Limit: 4113.00 | SL: 4134.00 | TP: 4081.00', expect: { instrument: 'XAUUSD', action: 'short', entryPrice: 4113, stopLoss: 4134, takeProfits: [4081], entryType: 'limit' } },
  { name: 'S1: DeFi Alpha full structured', text: '#DOGEUSDT 🟢 LONG | Entry: 0.1205 | Leverage: 2x | Stop Loss: 0.1134 | Take Profit 1: 0.1276 | Take Profit 2: 0.1347', expect: { instrument: 'DOGEUSDT', action: 'long', entryPrice: 0.1205, stopLoss: 0.1134, takeProfits: [0.1276, 0.1347], leverage: '2x', entryType: 'market' } },
  { name: 'S1: Standard BTCUSDT long 3 TPs', text: '#BTCUSDT 🟢 LONG\nEntry: 64200\nLeverage: 10x\nSL: 63500\nTake Profit 1: 65000\nTake Profit 2: 66000\nTake Profit 3: 67000\nTimeframe: 4h', expect: { entryPrice: 64200, stopLoss: 63500, takeProfits: [65000, 66000, 67000], leverage: '10x', timeframe: '4h' } },
  { name: 'S1: TP list format', text: '#EURUSD 🟢 LONG\nEntry: 1.0850\nSL: 1.0820\nTargets: 1.0880, 1.0900, 1.0920', expect: { takeProfits: [1.088, 1.09, 1.092] } },
  { name: 'S1: Range entry', text: '#XAUUSD SELL RANGE: 4110 - 4116\nSL: 4125\nTP: 4090', expect: { entryPrice: 4113, entryLow: 4110, entryHigh: 4116, isRange: true, stopLoss: 4125, takeProfits: [4090], entryType: 'range' } },
  { name: 'S1: TP: OPEN', text: '#XAUUSD SELL\nEntry: 4172\nSL: 4182\nTP: OPEN', expect: { entryPrice: 4172, stopLoss: 4182, takeProfits: [4162, 4152] } },
  { name: 'S2: SMC+CRT SELL NOW @ range', text: 'GOLD / XAUUSD SELL | SELL NOW @ 4172-4179 | SL : 4182 | TP : OPEN', expect: { instrument: 'XAUUSD', action: 'short', entryLow: 4172, entryHigh: 4179, isRange: true, stopLoss: 4182, entryType: 'range' } },
  { name: 'S2: BUY @ single price', text: '#XAUUSD 🟢 LONG\nBUY @ 4145\nSL: 4125\nTP: 4180', expect: { entryPrice: 4145, stopLoss: 4125, takeProfits: [4180] } },
  { name: 'S2: Compact LONG 64200', text: '#BTCUSDT LONG 64200\nSL: 63500\nTP: 65000', expect: { entryPrice: 64200, stopLoss: 63500, takeProfits: [65000] } },
  { name: 'S2: SELL 4008', text: '#XAUUSD SELL 4008\nSL: 4018\nTP: 3970', expect: { entryPrice: 4008, stopLoss: 4018, takeProfits: [3970] } },
  { name: 'S3: Entry without keyword, SL with keyword', text: '#XAUUSD LONG\nSL: 4125\n4145\nTP: 4180', expect: { entryPrice: 4145, stopLoss: 4125, takeProfits: [4180] } },
  { name: 'S3: Compact LONG 4145 SL 4125 TP 4180', text: '#XAUUSD LONG 4145\nSL: 4125\nTP: 4180', expect: { entryPrice: 4145, stopLoss: 4125, takeProfits: [4180] } },
  { name: 'Entry type: BUY STOP', text: '#XAUUSD Buy Stop\nEntry: 4145\nSL: 4125\nTP: 4180', expect: { action: 'long', entryType: 'stop' } },
  { name: 'Entry type: SELL LIMIT', text: '#XAUUSD Sell Limit\nEntry: 4113\nSL: 4134\nTP: 4081', expect: { action: 'short', entryType: 'limit' } },
  { name: 'Entry type: BUY LIMIT', text: '#BTCUSDT Buy Limit\nEntry: 63800\nSL: 63500\nTP: 64500', expect: { action: 'long', entryType: 'limit' } },
  { name: 'Entry type: SELL STOP', text: '#BTCUSDT Sell Stop\nEntry: 63800\nSL: 64100\nTP: 63200', expect: { action: 'short', entryType: 'stop' } },
  { name: 'Bug #1: Buy Stop SL', text: 'XAUUSDz Buy Stop 📈 | Entry Buy Stop: 4145.00 | SL: 4125.00 | TP: 4180.00', expect: { stopLoss: 4125 } },
  { name: 'Bug #3: TP1:4180 no space', text: '#BTCUSDT 🟢 LONG\nEntry: 64200\nSL: 63500\nTP1:65000\nTP2:66000', expect: { takeProfits: [65000, 66000] } },
  { name: 'Empty text → null', text: '', expectNull: true },
  { name: 'Too short → null', text: 'BTCUSDT long', expectNull: true },
  { name: 'No instrument → null', text: 'LONG\nEntry: 100\nSL: 90\nTP: 110', expectNull: true },
  { name: 'No action → null', text: '#BTCUSDT\nEntry: 64200\nSL: 63500\nTP: 65000', expectNull: true },
  { name: 'No SL → null', text: '#BTCUSDT 🟢 LONG\nEntry: 64200\nTP: 65000', expectNull: true },
  { name: 'Commentary → null', text: 'Market update: holding key levels, watching for confirmation. Stay disciplined. Risk first.', expectNull: true },
  { name: 'Long with SL above entry → null', text: '#XAUUSD 🟢 LONG\nEntry: 4145\nSL: 4200\nTP: 4180', expectNull: true },
  { name: 'Short with SL below entry → null', text: '#XAUUSD 🔴 SHORT\nEntry: 4145\nSL: 4100\nTP: 4180', expectNull: true },
  { name: 'Stock: $AAPL long', text: '$AAPL 🟢 LONG\nEntry: 189.50\nSL: 185.00\nTP: 195.00', expect: { instrument: 'AAPL', instrumentType: 'stocks', entryPrice: 189.5, stopLoss: 185, takeProfits: [195] } },
  { name: 'Stock: #NVDA short (hashtag prefix)', text: '#NVDA 🔴 SHORT\nEntry: 125.34\nSL: 127.72\nTP: 122.96', expect: { instrument: 'NVDA', instrumentType: 'stocks', action: 'short', entryPrice: 125.34, stopLoss: 127.72, takeProfits: [122.96] } },
]

let pass = 0, fail = 0
function approx(a: number, b: number, eps = 0.001): boolean { return Math.abs(a - b) < eps }
function arrApprox(a: number[], b: number[], eps = 0.001): boolean { return a.length === b.length && a.every((v, i) => approx(v, b[i], eps)) }

for (const tc of cases) {
  const r = parseSignal(tc.text)
  if (tc.expectNull) { if (r === null) { console.log(`✅ ${tc.name}`); pass++ } else { console.log(`❌ ${tc.name}\n   expected null, got: entry=${r.entryPrice} SL=${r.stopLoss}`); fail++ } continue }
  if (!r) { console.log(`❌ ${tc.name}\n   expected a signal, got null`); fail++; continue }
  const e = tc.expect!; const issues: string[] = []
  if (e.instrument !== undefined && r.instrument !== e.instrument) issues.push(`instrument=${r.instrument} (exp ${e.instrument})`)
  if (e.action !== undefined && r.action !== e.action) issues.push(`action=${r.action} (exp ${e.action})`)
  if (e.entryPrice !== undefined && !approx(r.entryPrice, e.entryPrice)) issues.push(`entry=${r.entryPrice} (exp ${e.entryPrice})`)
  if (e.entryLow !== undefined && r.entryLow !== e.entryLow) issues.push(`entryLow=${r.entryLow} (exp ${e.entryLow})`)
  if (e.entryHigh !== undefined && r.entryHigh !== e.entryHigh) issues.push(`entryHigh=${r.entryHigh} (exp ${e.entryHigh})`)
  if (e.isRange !== undefined && r.isRange !== e.isRange) issues.push(`isRange=${r.isRange} (exp ${e.isRange})`)
  if (e.entryType !== undefined && r.entryType !== e.entryType) issues.push(`entryType=${r.entryType} (exp ${e.entryType})`)
  if (e.stopLoss !== undefined && !approx(r.stopLoss, e.stopLoss)) issues.push(`SL=${r.stopLoss} (exp ${e.stopLoss})`)
  if (e.takeProfits !== undefined && !arrApprox(r.takeProfits, e.takeProfits)) issues.push(`TPs=${JSON.stringify(r.takeProfits)} (exp ${JSON.stringify(e.takeProfits)})`)
  if (e.leverage !== undefined && r.leverage !== e.leverage) issues.push(`leverage=${r.leverage} (exp ${e.leverage})`)
  if (e.timeframe !== undefined && r.timeframe !== e.timeframe) issues.push(`timeframe=${r.timeframe} (exp ${e.timeframe})`)
  if (issues.length === 0) { console.log(`✅ ${tc.name}`); pass++ } else { console.log(`❌ ${tc.name}\n   ${issues.join(', ')}`); fail++ }
}
console.log(`\nResults: ${pass} passed, ${fail} failed (of ${cases.length} total)`)
if (fail > 0) process.exit(1)
