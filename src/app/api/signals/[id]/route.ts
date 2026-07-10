import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const signal = await db.signal.findUnique({
    where: { id },
    include: { evaluation: true, channel: true, message: true },
  })
  if (!signal) return NextResponse.json({ error: 'Not found' }, { status: 404 })

  return NextResponse.json({
    id: signal.id,
    instrument: signal.instrument,
    instrumentType: signal.instrumentType,
    action: signal.action,
    entryPrice: signal.entryPrice,
    entryLow: signal.entryLow,
    entryHigh: signal.entryHigh,
    isRange: signal.isRange,
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
      id: signal.channel.id,
      name: signal.channel.name,
      telegramId: signal.channel.telegramId,
      category: signal.channel.category,
      type: signal.channel.type,
      avatarColor: signal.channel.avatarColor,
      subscriberCount: signal.channel.subscriberCount,
      verified: signal.channel.verified,
    },
    message: {
      id: signal.message.id,
      telegramMessageId: signal.message.telegramMessageId,
      rawText: signal.message.rawText,
      hasMedia: signal.message.hasMedia,
      mediaType: signal.message.mediaType,
      views: signal.message.views,
      forwards: signal.message.forwards,
      reactions: signal.message.reactions,
      postedAt: signal.message.postedAt,
      ingestedAt: signal.message.ingestedAt,
      parseStatus: signal.message.parseStatus,
      ingestSource: signal.message.ingestSource,
    },
    evaluation: signal.evaluation
      ? {
          outcome: signal.evaluation.outcome,
          exitPrice: signal.evaluation.exitPrice,
          exitReason: signal.evaluation.exitReason,
          hitTpLevel: signal.evaluation.hitTpLevel,
          maxFavorablePct: signal.evaluation.maxFavorablePct,
          maxAdversePct: signal.evaluation.maxAdversePct,
          rMultiple: signal.evaluation.rMultiple,
          pnlPercent: signal.evaluation.pnlPercent,
          durationMinutes: signal.evaluation.durationMinutes,
          marketDataSource: signal.evaluation.marketDataSource,
          evaluatedAt: signal.evaluation.evaluatedAt,
        }
      : null,
  })
}
