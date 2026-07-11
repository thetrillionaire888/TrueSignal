import { NextResponse } from 'next/server'
import { getSignalById } from '@/lib/queries'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const signal = await getSignalById(id)
  if (!signal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    id: signal.id,
    instrument: signal.instrument,
    instrumentType: signal.instrumentType,
    action: signal.action,
    entryPrice: signal.entryPrice,
    entryLow: signal.entryLow,
    entryHigh: signal.entryHigh,
    isRange: Boolean(signal.isRange),
    stopLoss: signal.stopLoss,
    takeProfits: signal.takeProfits,
    positionSize: signal.positionSize,
    leverage: signal.leverage,
    timeframe: signal.timeframe,
    confidence: signal.confidence,
    parserVersion: signal.parserVersion,
    status: signal.status,
    notes: signal.notes,
    parsedAt: signal.parsedAt,
    channel: {
      id: signal.channelId,
      name: signal.channelName,
      telegramId: signal.telegramId,
      category: signal.category,
      type: signal.channelType,
      avatarColor: signal.avatarColor,
      subscriberCount: signal.subscriberCount,
      verified: Boolean(signal.verified),
    },
    message: {
      id: signal.messageId,
      telegramMessageId: signal.telegramMessageId,
      rawText: signal.rawText,
      hasMedia: signal.hasMedia,
      mediaType: signal.mediaType,
      views: signal.views,
      forwards: signal.forwards,
      reactions: signal.reactions,
      postedAt: signal.postedAt,
      ingestedAt: signal.ingestedAt,
      parseStatus: signal.parseStatus,
      ingestSource: signal.ingestSource,
    },
    evaluation: signal.outcome
      ? {
          outcome: signal.outcome,
          exitPrice: signal.exitPrice,
          exitReason: signal.exitReason,
          hitTpLevel: signal.hitTpLevel,
          maxFavorablePct: signal.maxFavorablePct,
          maxAdversePct: signal.maxAdversePct,
          rMultiple: signal.rMultiple,
          pnlPercent: signal.pnlPercent,
          durationMinutes: signal.durationMinutes,
          marketDataSource: signal.marketDataSource,
          evaluatedAt: signal.evaluatedAt,
        }
      : null,
  })
}
