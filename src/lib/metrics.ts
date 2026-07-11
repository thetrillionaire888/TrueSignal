// Analytics & metrics engine for the trading signal audit platform.
// Computes performance metrics from signal + evaluation records.

export type EvalRow = {
  rMultiple: number
  pnlPercent: number
  outcome: string
  channelId: string
  instrument: string
  instrumentType: string
  action: string
  durationMinutes: number | null
  confidence: number
  postedAt: Date
  evaluatedAt: Date
  maxFavorablePct: number | null
  maxAdversePct: number | null
}

export type EquityPoint = {
  t: string // ISO date (signal close time, day-bucketed)
  date: string // yyyy-mm-dd
  cumulativeR: number
  cumulativePnl: number
  drawdown: number
  trades: number
}

export type Metrics = {
  totalSignals: number
  closedSignals: number
  wins: number
  losses: number
  breakevens: number
  winRate: number
  avgRR: number // average realized R (expectancy)
  avgWin: number
  avgLoss: number
  profitFactor: number
  expectancy: number // avg R per trade
  totalR: number
  totalPnl: number
  sharpe: number
  sortino: number
  calmar: number
  maxDrawdown: number // in R units
  maxDrawdownPct: number // in account % assuming 1% risk
  avgDurationMinutes: number
  bestTrade: number
  worstTrade: number
  longestStreak: number // winning streak
  worstStreak: number // losing streak
  rMultipleStd: number
}

// Build an equity curve from evaluation rows, ordered by postedAt.
// Each closed trade contributes its R multiple; assumes 1% account risk per trade.
// Days with no closed trades are emitted as zero-trade gap points so the series is
// continuous across the full date range (better for visualization & drawdown charts).
export function buildEquityCurve(rows: EvalRow[]): EquityPoint[] {
  const closed = rows
    .filter((r) => r.outcome !== 'pending')
    .sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime())

  if (closed.length === 0) return []

  const byDay = new Map<string, { r: number; pnl: number; trades: number }>()
  for (const r of closed) {
    const day = r.postedAt.toISOString().slice(0, 10)
    const entry = byDay.get(day) ?? { r: 0, pnl: 0, trades: 0 }
    entry.r += r.rMultiple
    entry.pnl += r.pnlPercent
    entry.trades += 1
    byDay.set(day, entry)
  }

  // Build a complete daily date range from first to last signal day so gap days
  // appear in the curve as zero-trade flat points.
  const allDays = Array.from(byDay.keys()).sort()
  const firstDay = allDays[0]
  const lastDay = allDays[allDays.length - 1]
  const completeDays: string[] = []
  const cursor = new Date(firstDay + 'T00:00:00Z')
  const end = new Date(lastDay + 'T00:00:00Z')
  while (cursor <= end) {
    completeDays.push(cursor.toISOString().slice(0, 10))
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }

  // Build cumulative daily series with drawdown
  const points: EquityPoint[] = []
  let runningR = 0
  let runningPnl = 0
  let runPeak = 0
  for (const day of completeDays) {
    const e = byDay.get(day) ?? { r: 0, pnl: 0, trades: 0 }
    runningR += e.r
    runningPnl += e.pnl
    runPeak = Math.max(runPeak, runningR)
    const dd = runningR - runPeak
    points.push({
      t: new Date(day + 'T00:00:00Z').toISOString(),
      date: day,
      cumulativeR: round(runningR, 2),
      cumulativePnl: round(runningPnl, 2),
      drawdown: round(dd, 2),
      trades: e.trades,
    })
  }
  return points
}

export function computeMetrics(rows: EvalRow[]): Metrics {
  const closed = rows.filter((r) => r.outcome !== 'pending')
  const n = closed.length
  const wins = closed.filter((r) => r.outcome === 'win')
  const losses = closed.filter((r) => r.outcome === 'loss')
  const breakevens = closed.filter((r) => r.outcome === 'breakeven')

  const rs = closed.map((r) => r.rMultiple)
  const totalR = rs.reduce((a, b) => a + b, 0)
  const totalPnl = closed.reduce((a, b) => a + b.pnlPercent, 0)

  const winSum = wins.reduce((a, b) => a + b.rMultiple, 0)
  const lossSum = Math.abs(losses.reduce((a, b) => a + b.rMultiple, 0))
  const grossProfit = wins.reduce((a, b) => a + b.pnlPercent, 0)
  const grossLoss = Math.abs(losses.reduce((a, b) => a + b.pnlPercent, 0))

  const avgWin = wins.length ? winSum / wins.length : 0
  const avgLoss = losses.length ? lossSum / losses.length : 0

  const expectancy = n ? totalR / n : 0

  // per-trade standard deviation of R
  const mean = expectancy
  const variance = n ? rs.reduce((a, b) => a + (b - mean) ** 2, 0) / n : 0
  const std = Math.sqrt(variance)

  // Build a daily-aggregated R series for risk-adjusted ratios (standard practice:
  // aggregate all closed trades per day into one daily return, then annualize by sqrt(252)).
  const dayMap = new Map<string, number>()
  for (const r of closed) {
    const day = r.evaluatedAt.toISOString().slice(0, 10)
    dayMap.set(day, (dayMap.get(day) ?? 0) + r.rMultiple)
  }
  const dailyRs = Array.from(dayMap.values())
  const dailyMean = dailyRs.length ? dailyRs.reduce((a, b) => a + b, 0) / dailyRs.length : 0
  const dailyVar = dailyRs.length
    ? dailyRs.reduce((a, b) => a + (b - dailyMean) ** 2, 0) / dailyRs.length
    : 0
  const dailyStd = Math.sqrt(dailyVar)
  const downsideDaily = dailyRs.filter((r) => r < 0)
  const downsideDailyVar = downsideDaily.length
    ? downsideDaily.reduce((a, b) => a + b ** 2, 0) / downsideDaily.length
    : 0
  const downsideDailyStd = Math.sqrt(downsideDailyVar)

  const ann = Math.sqrt(252)
  const sharpe = dailyStd > 0 ? (dailyMean / dailyStd) * ann : 0
  const sortino = downsideDailyStd > 0 ? (dailyMean / downsideDailyStd) * ann : 0

  // Max drawdown in R (computed per-trade, not from the daily-aggregated equity
  // curve). Iterating each trade in postedAt order catches intra-day peaks that the
  // daily aggregation would otherwise hide.
  const sortedByPosted = [...closed].sort((a, b) => a.postedAt.getTime() - b.postedAt.getTime())
  let tradePeak = 0
  let tradeMaxDD = 0
  let tradeCumR = 0
  for (const r of sortedByPosted) {
    tradeCumR += r.rMultiple
    tradePeak = Math.max(tradePeak, tradeCumR)
    tradeMaxDD = Math.min(tradeMaxDD, tradeCumR - tradePeak)
  }
  const maxDrawdown = Math.abs(tradeMaxDD)

  // Calmar = annualized return / max drawdown (both in R-space, daily mean × 252)
  const annualizedR = dailyMean * 252
  const calmar = maxDrawdown > 0 ? annualizedR / maxDrawdown : 0

  // streaks
  let curWin = 0
  let curLoss = 0
  let bestStreak = 0
  let worstStreak = 0
  const sorted = [...closed].sort((a, b) => a.evaluatedAt.getTime() - b.evaluatedAt.getTime())
  for (const r of sorted) {
    if (r.outcome === 'win') {
      curWin++
      curLoss = 0
      bestStreak = Math.max(bestStreak, curWin)
    } else if (r.outcome === 'loss') {
      curLoss++
      curWin = 0
      worstStreak = Math.max(worstStreak, curLoss)
    } else {
      curWin = 0
      curLoss = 0
    }
  }

  const durations = closed.map((r) => r.durationMinutes ?? 0).filter(Boolean)
  const avgDurationMinutes = durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0

  // Win rate is computed over *decisive* trades only (wins + losses). Breakevens
  // are excluded from the denominator — they are not wins, but counting them as
  // losses would understate the win rate.
  const decisive = wins.length + losses.length

  return {
    totalSignals: rows.length,
    closedSignals: n,
    wins: wins.length,
    losses: losses.length,
    breakevens: breakevens.length,
    winRate: decisive ? wins.length / decisive : 0,
    avgRR: expectancy,
    avgWin,
    avgLoss,
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0,
    expectancy,
    totalR: round(totalR, 2),
    totalPnl: round(totalPnl, 2),
    sharpe: round(sharpe, 2),
    sortino: round(sortino, 2),
    calmar: round(calmar, 2),
    maxDrawdown: round(maxDrawdown, 2),
    maxDrawdownPct: tradePeak > 0 ? round((maxDrawdown / tradePeak) * 100, 2) : round(maxDrawdown, 2),
    avgDurationMinutes: Math.round(avgDurationMinutes),
    bestTrade: round(rs.length ? Math.max(...rs) : 0, 2),
    worstTrade: round(rs.length ? Math.min(...rs) : 0, 2),
    longestStreak: bestStreak,
    worstStreak: worstStreak,
    rMultipleStd: round(std, 2),
  }
}

// Group R multiples into buckets for histogram
export function rMultipleDistribution(rows: EvalRow[]) {
  const closed = rows.filter((r) => r.outcome !== 'pending')
  const buckets = [
    { label: '< -1R', min: -Infinity, max: -1.01, count: 0 },
    { label: '-1R', min: -1.01, max: -0.5, count: 0 },
    { label: '-0.5R', min: -0.5, max: -0.01, count: 0 },
    { label: '0R', min: -0.01, max: 0.49, count: 0 },
    { label: '+1R', min: 0.49, max: 1.49, count: 0 },
    { label: '+2R', min: 1.49, max: 2.49, count: 0 },
    { label: '+3R', min: 2.49, max: 3.49, count: 0 },
    { label: '> +3R', min: 3.49, max: Infinity, count: 0 },
  ]
  for (const r of closed) {
    for (const b of buckets) {
      if (r.rMultiple > b.min && r.rMultiple <= b.max) {
        b.count++
        break
      }
    }
  }
  return buckets
}

// Monthly performance matrix: rows = month, aggregated R and win rate
export function monthlyPerformance(rows: EvalRow[]) {
  const closed = rows.filter((r) => r.outcome !== 'pending')
  const map = new Map<string, { r: number; pnl: number; trades: number; wins: number }>()
  for (const r of closed) {
    const key = r.evaluatedAt.toISOString().slice(0, 7) // yyyy-mm
    const e = map.get(key) ?? { r: 0, pnl: 0, trades: 0, wins: 0 }
    e.r += r.rMultiple
    e.pnl += r.pnlPercent
    e.trades++
    if (r.outcome === 'win') e.wins++
    map.set(key, e)
  }
  return Array.from(map.entries())
    .map(([month, e]) => ({
      month,
      totalR: round(e.r, 2),
      pnl: round(e.pnl, 2),
      trades: e.trades,
      winRate: round(e.wins / e.trades, 4),
    }))
    .sort((a, b) => a.month.localeCompare(b.month))
}

// Per-channel breakdown
export function channelBreakdown(
  rows: EvalRow[],
  channels: { id: string; name: string; telegramId: string; category: string }[]
) {
  return channels.map((c) => {
    const cRows = rows.filter((r) => r.channelId === c.id)
    const m = computeMetrics(cRows)
    return {
      id: c.id,
      name: c.name,
      telegramId: c.telegramId,
      category: c.category,
      ...m,
    }
  })
}

// Instrument breakdown
export function instrumentBreakdown(rows: EvalRow[]) {
  const map = new Map<string, EvalRow[]>()
  for (const r of rows) {
    const arr = map.get(r.instrument) ?? []
    arr.push(r)
    map.set(r.instrument, arr)
  }
  const result = Array.from(map.entries()).map(([instrument, rs]) => {
    const m = computeMetrics(rs)
    return {
      instrument,
      instrumentType: rs[0]?.instrumentType ?? 'unknown',
      trades: m.closedSignals,
      winRate: m.winRate,
      totalR: m.totalR,
      avgR: round(m.expectancy, 2),
    }
  })
  return result.sort((a, b) => b.trades - a.trades)
}

function round(x: number, dp: number) {
  const f = 10 ** dp
  return Math.round(x * f) / f
}
