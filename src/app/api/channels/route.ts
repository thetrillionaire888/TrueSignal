import { NextResponse } from 'next/server'
import { loadEvalRows, loadChannelsWithMeta } from '@/lib/queries'
import { computeMetrics } from '@/lib/metrics'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [rows, channels] = await Promise.all([loadEvalRows(), loadChannelsWithMeta()])

  const result = channels.map((c) => {
    const cRows = rows.filter((r) => r.channelId === c.id)
    const m = computeMetrics(
      cRows.map((r) => ({
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
    )
    return {
      id: c.id,
      telegramId: c.telegramId,
      name: c.name,
      type: c.type,
      category: c.category,
      description: c.description,
      subscriberCount: c.subscriberCount,
      verified: Boolean(c.verified),
      avatarColor: c.avatarColor,
      region: c.region,
      monitoredSince: c.monitoredSince,
      lastMessageAt: c.lastMessageAt,
      status: c.status,
      totalSignals: c.signalCount,
      metrics: m,
    }
  })

  return NextResponse.json({ channels: result })
}
