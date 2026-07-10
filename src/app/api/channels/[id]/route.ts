import { NextResponse } from 'next/server'
import { db } from '@/lib/db'
import { loadEvalRows } from '@/lib/queries'
import { computeMetrics, buildEquityCurve, instrumentBreakdown } from '@/lib/metrics'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const channel = await db.channel.findUnique({ where: { id } })
  if (!channel) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [rows, messageCount] = await Promise.all([
    loadEvalRows(),
    db.message.count({ where: { channelId: id } }),
  ])

  const cRows = rows.filter((r) => r.channelId === id)
  const mapped = cRows.map((r) => ({
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
  const instruments = instrumentBreakdown(mapped).slice(0, 10)

  const recent = await db.signal.findMany({
    where: { channelId: id },
    include: { evaluation: true, message: true },
    orderBy: { parsedAt: 'desc' },
    take: 12,
  })

  return NextResponse.json({
    channel,
    messageCount,
    metrics,
    equity,
    instruments,
    recent: recent.map((s) => ({
      id: s.id,
      instrument: s.instrument,
      action: s.action,
      entryPrice: s.entryPrice,
      outcome: s.evaluation?.outcome,
      rMultiple: s.evaluation?.rMultiple,
      exitReason: s.evaluation?.exitReason,
      postedAt: s.message.postedAt,
      confidence: s.confidence,
    })),
  })
}
