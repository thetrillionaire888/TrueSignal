import { NextResponse } from 'next/server'
import { loadEvalRows, loadChannelsWithMeta } from '@/lib/queries'
import { computeMetrics, buildEquityCurve, channelBreakdown } from '@/lib/metrics'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [rows, channels] = await Promise.all([loadEvalRows(), loadChannelsWithMeta()])

  const mapped = rows.map((r) => ({
    rMultiple: r.rMultiple,
    pnlPercent: r.pnlPercent,
    outcome: r.outcome,
    channelId: r.channelId,
    instrument: r.instrument,
    instrumentType: r.instrumentType,
    action: r.action,
    durationMinutes: r.durationMinutes,
    confidence: r.confidence,
    postedAt: r.postedAt,
    evaluatedAt: r.evaluatedAt,
    maxFavorablePct: r.maxFavorablePct,
    maxAdversePct: r.maxAdversePct,
  }))

  const metrics = computeMetrics(mapped)
  const equity = buildEquityCurve(mapped)
  const breakdown = channelBreakdown(
    mapped,
    channels.map((c) => ({ id: c.id, name: c.name, telegramId: c.telegramId, category: c.category }))
  )

  const longs = rows.filter((r) => r.action === 'long').length
  const shorts = rows.filter((r) => r.action === 'short').length

  const categoryMap = new Map<string, { trades: number; wins: number; r: number }>()
  for (const r of rows) {
    const e = categoryMap.get(r.instrumentType) ?? { trades: 0, wins: 0, r: 0 }
    e.trades++
    if (r.outcome === 'win') e.wins++
    e.r += r.rMultiple
    categoryMap.set(r.instrumentType, e)
  }
  const categories = Array.from(categoryMap.entries()).map(([cat, e]) => ({
    category: cat,
    trades: e.trades,
    winRate: e.wins / e.trades,
    totalR: Math.round(e.r * 100) / 100,
  }))

  const now = Date.now()
  const last7 = Array.from({ length: 7 }, (_, i) => {
    const day = new Date(now - (6 - i) * 86400000)
    const key = day.toISOString().slice(0, 10)
    const count = rows.filter((r) => r.postedAt.toISOString().slice(0, 10) === key).length
    return { date: key, trades: count }
  })

  return NextResponse.json({
    metrics,
    equity,
    channels: breakdown,
    categories,
    actionSplit: { longs, shorts },
    last7,
  })
}
