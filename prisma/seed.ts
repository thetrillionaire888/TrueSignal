import { PrismaClient } from '@prisma/client'

const db = new PrismaClient()

// ── Deterministic PRNG so the dataset is reproducible ────────────────────────
function mulberry32(seed: number) {
  let a = seed
  return function () {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(20240715)
const rand = (min: number, max: number) => min + rng() * (max - min)
const randInt = (min: number, max: number) => Math.floor(rand(min, max + 1))
const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)]
const round = (x: number, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp

// ── Instrument universe ──────────────────────────────────────────────────────
type Inst = { sym: string; base: number; vol: number } // vol = typical daily vol %
const INSTRUMENTS: Record<string, Inst[]> = {
  crypto: [
    { sym: 'BTCUSDT', base: 64200, vol: 3.2 },
    { sym: 'ETHUSDT', base: 3180, vol: 4.1 },
    { sym: 'SOLUSDT', base: 142, vol: 6.5 },
    { sym: 'BNBUSDT', base: 585, vol: 4.0 },
    { sym: 'XRPUSDT', base: 0.52, vol: 5.2 },
    { sym: 'AVAXUSDT', base: 27.4, vol: 6.1 },
    { sym: 'LINKUSDT', base: 14.2, vol: 5.8 },
    { sym: 'DOGEUSDT', base: 0.121, vol: 7.4 },
    { sym: 'MATICUSDT', base: 0.58, vol: 6.0 },
    { sym: 'ARBUSDT', base: 0.84, vol: 8.2 },
  ],
  forex: [
    { sym: 'EURUSD', base: 1.082, vol: 0.6 },
    { sym: 'GBPUSD', base: 1.264, vol: 0.7 },
    { sym: 'USDJPY', base: 156.4, vol: 0.8 },
    { sym: 'AUDUSD', base: 0.658, vol: 0.7 },
    { sym: 'USDCAD', base: 1.371, vol: 0.6 },
    { sym: 'EURGBP', base: 0.856, vol: 0.5 },
    { sym: 'EURJPY', base: 169.2, vol: 0.9 },
    { sym: 'NZDUSD', base: 0.604, vol: 0.7 },
  ],
  stocks: [
    { sym: 'AAPL', base: 189.5, vol: 1.8 },
    { sym: 'TSLA', base: 178.2, vol: 3.5 },
    { sym: 'NVDA', base: 124.6, vol: 3.0 },
    { sym: 'AMZN', base: 184.3, vol: 2.0 },
    { sym: 'MSFT', base: 421.8, vol: 1.6 },
    { sym: 'META', base: 502.4, vol: 2.4 },
    { sym: 'AMD', base: 158.9, vol: 3.2 },
    { sym: 'GOOGL', base: 178.6, vol: 1.9 },
  ],
  commodities: [
    { sym: 'XAUUSD', base: 2328, vol: 1.1 },
    { sym: 'XAGUSD', base: 29.4, vol: 1.8 },
    { sym: 'WTI', base: 78.6, vol: 2.2 },
    { sym: 'XPTUSD', base: 985, vol: 1.6 },
  ],
  index: [
    { sym: 'SPX500', base: 5235, vol: 0.9 },
    { sym: 'NAS100', base: 18240, vol: 1.3 },
    { sym: 'US30', base: 39120, vol: 0.8 },
    { sym: 'GER40', base: 18420, vol: 1.0 },
  ],
}

const COMMENTARY = [
  'Market update: holding key levels, watching for confirmation. Stay disciplined.',
  'Risk first. Size positions so a stop-out never hurts the book.',
  'Patience pays — no A+ setup, no trade.',
  'Liquidity is thin overnight. Reduce size into the session close.',
  'Macro catalysts ahead this week. Manage risk before the print.',
  'Reminder: take partials at first target, move stop to break-even.',
  'Trend is your friend until the bend at the end. Trail stops.',
  'Book some profits into strength. Capital preservation > greed.',
  'Watching order flow — no immediate trigger. Stand aside.',
  'Correlation note: DXY strength pressuring risk assets today.',
  'Volatility expanding. Tighten invalidation, do not chase.',
  'If structure invalidates, exit. Do not hope.',
]

const REASONS = [
  'Reclaim of key support + bullish divergence on RSI. Volume picking up.',
  'Breakout retest of prior range high. Order flow confirms bids.',
  'Liquidity sweep of session lows + reaction. Sellers exhausted.',
  'Trend continuation pullback to 20 EMA. Higher lows intact.',
  'Failed breakdown reversal. Stop hunts below demand complete.',
  'Fibonacci 0.618 confluence with structure. Asymmetric R:R.',
  ' momentum shift on lower timeframe after absorption at range low.',
  'Earnings drift setup. IV crush favors directional move.',
  'DXY rolling over, risk-on correlation supports longs.',
  'Bearish engulfing at supply. Distribution detected.',
]

// ── Channel definitions ──────────────────────────────────────────────────────
type ChanDef = {
  telegramId: string
  name: string
  type: string
  category: string
  description: string
  subscriberCount: number
  verified: boolean
  avatarColor: string
  region: string
  winRate: number
  signalDensity: number // 0..1 fraction of messages that are signals
  msgsPerDay: [number, number]
  longBias: number
  quality: string
}

const CHANNEL_DEFS: ChanDef[] = [
  {
    telegramId: '@cryptovision_signals',
    name: 'CryptoVision Signals',
    type: 'channel',
    category: 'crypto',
    description: 'Institutional-grade crypto signals. On-chain + order flow confluence. BTC & majors.',
    subscriberCount: 128400,
    verified: true,
    avatarColor: 'emerald',
    region: 'global',
    winRate: 0.69,
    signalDensity: 0.62,
    msgsPerDay: [2, 3],
    longBias: 0.6,
    quality: 'A',
  },
  {
    telegramId: '@forexmasters_pro',
    name: 'ForexMasters Pro',
    type: 'channel',
    category: 'forex',
    description: 'London & NY session forex signals. Smart-money concepts, liquidity maps.',
    subscriberCount: 86200,
    verified: true,
    avatarColor: 'teal',
    region: 'EU',
    winRate: 0.66,
    signalDensity: 0.7,
    msgsPerDay: [2, 4],
    longBias: 0.5,
    quality: 'A',
  },
  {
    telegramId: '@alpha_equities',
    name: 'Alpha Equities',
    type: 'supergroup',
    category: 'stocks',
    description: 'US equities swing calls. Earnings, catalysts, technical breakouts.',
    subscriberCount: 54300,
    verified: true,
    avatarColor: 'amber',
    region: 'US',
    winRate: 0.63,
    signalDensity: 0.55,
    msgsPerDay: [1, 3],
    longBias: 0.68,
    quality: 'B',
  },
  {
    telegramId: '@goldcommodity_desk',
    name: 'GoldCommodity Desk',
    type: 'channel',
    category: 'commodities',
    description: 'Precious metals & energy. Macro-driven XAU, XAG, WTI calls.',
    subscriberCount: 31800,
    verified: false,
    avatarColor: 'yellow',
    region: 'global',
    winRate: 0.61,
    signalDensity: 0.5,
    msgsPerDay: [1, 2],
    longBias: 0.55,
    quality: 'B',
  },
  {
    telegramId: '@whalepump_alerts',
    name: 'WhalePump Alerts',
    type: 'channel',
    category: 'crypto',
    description: 'High-leverage crypto calls. Higher risk, higher reward. Not for the faint-hearted.',
    subscriberCount: 214500,
    verified: false,
    avatarColor: 'rose',
    region: 'global',
    winRate: 0.47,
    signalDensity: 0.78,
    msgsPerDay: [3, 5],
    longBias: 0.82,
    quality: 'C',
  },
  {
    telegramId: '@pipsniper_fx',
    name: 'PipSniper FX',
    type: 'group',
    category: 'forex',
    description: 'Scalping-focused forex group. Quick in-and-out, tight stops.',
    subscriberCount: 18400,
    verified: false,
    avatarColor: 'cyan',
    region: 'ASIA',
    winRate: 0.58,
    signalDensity: 0.74,
    msgsPerDay: [3, 4],
    longBias: 0.5,
    quality: 'B',
  },
  {
    telegramId: '@indextrend_research',
    name: 'IndexTrend Research',
    type: 'channel',
    category: 'index',
    description: 'Index futures research. SPX, NAS, Dow directional bias & hedging.',
    subscriberCount: 27600,
    verified: true,
    avatarColor: 'violet',
    region: 'US',
    winRate: 0.64,
    signalDensity: 0.48,
    msgsPerDay: [1, 2],
    longBias: 0.6,
    quality: 'A',
  },
  {
    telegramId: '@defi_alpha_calls',
    name: 'DeFi Alpha Calls',
    type: 'supergroup',
    category: 'crypto',
    description: 'DeFi & mid-cap alt calls. Higher volatility, asymmetric setups.',
    subscriberCount: 42100,
    verified: false,
    avatarColor: 'fuchsia',
    region: 'global',
    winRate: 0.54,
    signalDensity: 0.66,
    msgsPerDay: [2, 4],
    longBias: 0.72,
    quality: 'C',
  },
]

function fmtPrice(p: number, inst: Inst) {
  if (inst.base < 1) return p.toFixed(4)
  if (inst.base < 100) return p.toFixed(2)
  return p.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

function fmtPricePlain(p: number, inst: Inst) {
  if (inst.base < 1) return p.toFixed(4)
  if (inst.base < 100) return p.toFixed(2)
  return p.toFixed(2)
}

const TIMEFRAMES = ['scalping', '15m', '1h', '4h', 'swing', 'positional']
const LEVERAGES = ['1x', '2x', '3x', '5x', '10x', '20x']
const SIZES = ['0.5% account', '1% account', '2% account', '0.25 BTC', '1 lot', '0.5 lot']

function buildSignal(channel: ChanDef, postedAt: Date) {
  const insts = INSTRUMENTS[channel.category] ?? INSTRUMENTS.crypto
  const inst = pick(insts)
  const action = rng() < channel.longBias ? 'long' : 'short'

  // risk as % of entry, scaled by instrument volatility & channel quality
  const riskPct = (inst.vol * rand(0.6, 1.1)) / 100
  const noise = (rng() - 0.5) * inst.vol * 0.4 // entry around base
  const entry = round(inst.base * (1 + noise / 100), inst.base < 1 ? 4 : 2)

  const direction = action === 'long' ? 1 : -1
  const stopDist = entry * riskPct
  const stopLoss = round(entry - direction * stopDist, inst.base < 1 ? 4 : 2)

  // TP levels at 1R, 2R, 3R (sometimes 2 TPs only)
  const tpCount = pick([2, 2, 3, 3, 3])
  const tps: number[] = []
  for (let i = 1; i <= tpCount; i++) {
    tps.push(round(entry + direction * stopDist * i, inst.base < 1 ? 4 : 2))
  }

  const leverage = channel.category === 'crypto' ? pick(LEVERAGES) : pick(['1x', '2x', '3x', '5x'])
  const timeframe = pick(TIMEFRAMES)
  const size = pick(SIZES)
  const confidence = round(rand(0.62, 0.95), 2)

  // raw message text
  const actionEmoji = action === 'long' ? '🟢 LONG' : '🔴 SHORT'
  const tpLines = tps.map((t, i) => `Take Profit ${i + 1}: ${fmtPrice(t, inst)}`).join('\n')
  const rawText = `#${inst.sym} ${actionEmoji}

Entry: ${fmtPrice(entry, inst)}
Leverage: ${leverage}
Stop Loss: ${fmtPrice(stopLoss, inst)}
${tpLines}

Position: ${size}
Timeframe: ${timeframe}

${pick(REASONS)}

@${channel.telegramId.slice(1)}`

  // ── Evaluation outcome ────────────────────────────────────────────────────
  const winRoll = rng()
  let outcome: 'win' | 'loss' | 'breakeven'
  let rMultiple: number
  let exitPrice: number
  let exitReason: string
  let hitTpLevel: number | null = null
  let maxFav: number
  let maxAdv: number

  if (winRoll < channel.winRate) {
    // win — weighted toward TP1/TP2
    const tpRoll = rng()
    let tpIdx: number
    if (tpRoll < 0.5) tpIdx = 0
    else if (tpRoll < 0.85) tpIdx = 1
    else tpIdx = Math.min(2, tps.length - 1)
    rMultiple = tpIdx + 1
    // small slippage
    rMultiple = round(rMultiple * rand(0.96, 1.0), 2)
    exitPrice = tps[tpIdx]
    exitReason = `tp${tpIdx + 1}`
    hitTpLevel = tpIdx + 1
    // favorable excursion reaches the TP, adverse some drawdown
    maxFav = round(rMultiple * 100 * (stopDist / entry), 2)
    maxAdv = round(rand(10, 55) * (stopDist / entry), 2)
    outcome = 'win'
  } else if (winRoll < channel.winRate + 0.06) {
    // breakeven
    rMultiple = round(rand(-0.05, 0.05), 2)
    exitPrice = round(entry * (1 + direction * rand(-0.1, 0.1) * (stopDist / entry)), inst.base < 1 ? 4 : 2)
    exitReason = 'manual'
    maxFav = round(rand(20, 70) * (stopDist / entry), 2)
    maxAdv = round(rand(40, 90) * (stopDist / entry), 2)
    outcome = 'breakeven'
  } else {
    // loss — SL hit, occasionally partial
    const partial = rng() < 0.2
    rMultiple = partial ? round(rand(-0.55, -0.9), 2) : round(rand(-0.95, -1.0), 2)
    exitPrice = partial
      ? round(entry - direction * stopDist * rand(0.55, 0.9), inst.base < 1 ? 4 : 2)
      : stopLoss
    exitReason = partial ? 'manual' : 'sl'
    maxFav = round(rand(0, 40) * (stopDist / entry), 2)
    maxAdv = round(rand(85, 105) * (stopDist / entry), 2)
    outcome = 'loss'
  }

  const durationBase =
    timeframe === 'scalping' ? rand(20, 180) : timeframe === '15m' ? rand(60, 480) : timeframe === '1h' ? rand(180, 1440) : timeframe === '4h' ? rand(480, 4320) : timeframe === 'swing' ? rand(1440, 10080) : rand(4320, 20160)
  const durationMinutes = Math.round(durationBase)

  // pnl % — risk 1% of account per trade, so pnl% = rMultiple * 1 (account %), times leverage effect already in R
  const pnlPercent = round(rMultiple * 1.0, 2)

  return {
    instrument: inst.sym,
    instrumentType: channel.category === 'mixed' ? 'crypto' : channel.category,
    action,
    entry,
    stopLoss,
    takeProfits: JSON.stringify(tps.map((t) => fmtPricePlain(t, inst))),
    positionSize: size,
    leverage,
    timeframe,
    confidence,
    rawText,
    evaluation: {
      outcome,
      exitPrice,
      exitReason,
      hitTpLevel,
      maxFavorablePct: maxFav,
      maxAdversePct: maxAdv,
      rMultiple,
      pnlPercent,
      durationMinutes,
    },
  }
}

async function main() {
  console.log('🗑  Clearing existing data...')
  await db.evaluation.deleteMany()
  await db.signal.deleteMany()
  await db.message.deleteMany()
  await db.channel.deleteMany()

  const now = new Date()
  const DAYS = 90

  let totalSignals = 0
  let totalMessages = 0

  for (const def of CHANNEL_DEFS) {
    const monitoredSince = new Date(now.getTime() - (DAYS + 30) * 86400000)
    const channel = await db.channel.create({
      data: {
        telegramId: def.telegramId,
        name: def.name,
        type: def.type,
        category: def.category,
        description: def.description,
        subscriberCount: def.subscriberCount,
        verified: def.verified,
        avatarColor: def.avatarColor,
        region: def.region,
        monitoredSince,
        status: 'active',
        lastMessageAt: now,
      },
    })

    let msgSeq = 1000
    let lastMessageAt: Date | null = null

    for (let d = DAYS; d >= 0; d--) {
      const dayStart = new Date(now.getTime() - d * 86400000)
      // skip some weekends for forex/equity channels
      const dow = dayStart.getDay()
      const isWeekend = dow === 0 || dow === 6
      if (isWeekend && (def.category === 'forex' || def.category === 'stocks' || def.category === 'index')) {
        if (rng() < 0.8) continue
      }

      const nMsgs = randInt(def.msgsPerDay[0], def.msgsPerDay[1])
      for (let m = 0; m < nMsgs; m++) {
        msgSeq++
        // scatter through the day
        const postedAt = new Date(dayStart.getTime() + randInt(0, 86400000 - 1))
        lastMessageAt = postedAt

        const isSignal = rng() < def.signalDensity
        if (!isSignal) {
          const text = pick(COMMENTARY)
          await db.message.create({
            data: {
              channelId: channel.id,
              telegramMessageId: msgSeq,
              rawText: `${text}\n\n@${def.telegramId.slice(1)}`,
              hasMedia: rng() < 0.25,
              mediaType: rng() < 0.25 ? pick(['photo', 'video', 'document']) : null,
              views: randInt(800, def.subscriberCount),
              forwards: randInt(2, 120),
              reactions: randInt(10, 900),
              postedAt,
              parseStatus: 'no_signal',
            },
          })
          totalMessages++
          continue
        }

        const sig = buildSignal(def, postedAt)
        const message = await db.message.create({
          data: {
            channelId: channel.id,
            telegramMessageId: msgSeq,
            rawText: sig.rawText,
            hasMedia: rng() < 0.35,
            mediaType: rng() < 0.35 ? pick(['photo', 'video', 'document']) : null,
            views: randInt(1200, def.subscriberCount),
            forwards: randInt(5, 240),
            reactions: randInt(30, 1800),
            postedAt,
            parseStatus: 'parsed',
          },
        })
        totalMessages++

        const signal = await db.signal.create({
          data: {
            messageId: message.id,
            channelId: channel.id,
            instrument: sig.instrument,
            instrumentType: sig.instrumentType,
            action: sig.action,
            entryPrice: sig.entry,
            stopLoss: sig.stopLoss,
            takeProfits: sig.takeProfits,
            positionSize: sig.positionSize,
            leverage: sig.leverage,
            timeframe: sig.timeframe,
            confidence: sig.confidence,
            status: 'closed',
          },
        })

        await db.evaluation.create({
          data: {
            signalId: signal.id,
            outcome: sig.evaluation.outcome,
            exitPrice: sig.evaluation.exitPrice,
            exitReason: sig.evaluation.exitReason,
            hitTpLevel: sig.evaluation.hitTpLevel,
            maxFavorablePct: sig.evaluation.maxFavorablePct,
            maxAdversePct: sig.evaluation.maxAdversePct,
            rMultiple: sig.evaluation.rMultiple,
            pnlPercent: sig.evaluation.pnlPercent,
            durationMinutes: sig.evaluation.durationMinutes,
            evaluatedAt: new Date(postedAt.getTime() + sig.evaluation.durationMinutes * 60000),
          },
        })
        totalSignals++
      }
    }

    if (lastMessageAt) {
      await db.channel.update({ where: { id: channel.id }, data: { lastMessageAt } })
    }
    console.log(`✓ ${def.name}: seeded`)
  }

  console.log(`\n✅ Seed complete. Channels: ${CHANNEL_DEFS.length}, Messages: ${totalMessages}, Signals: ${totalSignals}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
