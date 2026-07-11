import { NextResponse } from 'next/server'
import { sqlite } from '@/lib/db'
import { loadEvalRows, countMessages } from '@/lib/queries'
import { computeMetrics, buildEquityCurve, instrumentBreakdown } from '@/lib/metrics'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params

  const channel = sqlite
    .prepare(
      `SELECT c.id, c.telegramId, c.name, c.type, c.category, c.description, c.avatarColor, c.language, c.region, c.verified, c.monitoredSince, c.createdAt, cs.subscriberCount, cs.lastMessageAt, cs.messageCount, cs.signalCount, cs.status
       FROM catalog.Channel c
       LEFT JOIN catalog.ChannelStats cs ON cs.channelId = c.id
       WHERE c.id = ?`
    )
    .get(id) as any | null

  if (!channel) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  const [rows, messageCount] = await Promise.all([
    loadEvalRows(),
    countMessages({ channelId: id }),
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

  const recent = sqlite
    .prepare(
      `SELECT s.id, s.instrument, s.action, s.entryPrice, s.confidence, e.outcome, e.rMultiple, e.exitReason, m.postedAt
       FROM Signal s
       LEFT JOIN Message m ON s.messageId = m.id
       LEFT JOIN Evaluation e ON e.signalId = s.id
       WHERE s.channelId = ?
       ORDER BY s.parsedAt DESC
       LIMIT 12`
    )
    .all(id) as Array<any>

  return NextResponse.json({
    channel: {
      ...channel,
      verified: Boolean(channel.verified),
    },
    messageCount,
    metrics,
    equity,
    instruments,
    recent: recent.map((s) => ({
      id: s.id,
      instrument: s.instrument,
      action: s.action,
      entryPrice: s.entryPrice,
      outcome: s.outcome,
      rMultiple: s.rMultiple,
      exitReason: s.exitReason,
      postedAt: s.postedAt,
      confidence: s.confidence,
    })),
  })
}
