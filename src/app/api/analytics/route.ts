import { NextResponse } from 'next/server'
import { loadEvalRows } from '@/lib/queries'
import {
  computeMetrics,
  rMultipleDistribution,
  monthlyPerformance,
  instrumentBreakdown,
  buildEquityCurve,
} from '@/lib/metrics'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const channelId = searchParams.get('channelId')

  let rows = await loadEvalRows()
  if (channelId) rows = rows.filter((r) => r.channelId === channelId)

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
  const distribution = rMultipleDistribution(mapped)
  const monthly = monthlyPerformance(mapped)
  const instruments = instrumentBreakdown(mapped)
  const equity = buildEquityCurve(mapped)

  // outcome by action — win rate computed over decisive trades (wins + losses)
  // only; breakevens are excluded from the denominator.
  const longs = mapped.filter((r) => r.action === 'long')
  const shorts = mapped.filter((r) => r.action === 'short')
  const longDecisive = longs.filter((r) => r.outcome === 'win' || r.outcome === 'loss').length
  const shortDecisive = shorts.filter((r) => r.outcome === 'win' || r.outcome === 'loss').length
  const byAction = {
    long: {
      trades: longs.length,
      winRate: longDecisive ? longs.filter((r) => r.outcome === 'win').length / longDecisive : 0,
      avgR: longs.length ? longs.reduce((a, b) => a + b.rMultiple, 0) / longs.length : 0,
    },
    short: {
      trades: shorts.length,
      winRate: shortDecisive ? shorts.filter((r) => r.outcome === 'win').length / shortDecisive : 0,
      avgR: shorts.length ? shorts.reduce((a, b) => a + b.rMultiple, 0) / shorts.length : 0,
    },
  }

  // MFE/MAE scatter data (sample down for performance)
  const mfeMae = mapped
    .filter((r) => r.maxFavorablePct != null && r.maxAdversePct != null)
    .slice(0, 600)
    .map((r) => ({
      mfe: r.maxFavorablePct,
      mae: r.maxAdversePct,
      outcome: r.outcome,
      r: r.rMultiple,
    }))

  // duration vs R
  const durationR = mapped
    .filter((r) => r.durationMinutes != null)
    .slice(0, 600)
    .map((r) => ({
      duration: r.durationMinutes,
      r: r.rMultiple,
      outcome: r.outcome,
    }))

  // drawdown series (already in equity as `drawdown`)
  const drawdown = equity.map((p) => ({ date: p.date, drawdown: p.drawdown }))

  return NextResponse.json({
    metrics,
    distribution,
    monthly,
    instruments,
    equity,
    drawdown,
    byAction,
    mfeMae,
    durationR,
  })
}
