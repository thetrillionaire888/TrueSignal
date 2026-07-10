import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const channelId = searchParams.get('channelId') || undefined
  const instrument = searchParams.get('instrument') || undefined
  const outcome = searchParams.get('outcome') || undefined
  const action = searchParams.get('action') || undefined
  const category = searchParams.get('category') || undefined
  const q = searchParams.get('q')?.toLowerCase() || undefined
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  const pageSize = Math.min(100, Math.max(10, parseInt(searchParams.get('pageSize') || '25', 10)))
  const sort = searchParams.get('sort') || 'postedAt'

  const where: {
    channelId?: string
    instrument?: string
    action?: string
    channel?: { category?: string }
    evaluation?: { outcome?: string }
    OR?: Array<Record<string, unknown>>
  } = {}

  if (channelId) where.channelId = channelId
  if (instrument) where.instrument = instrument
  if (action) where.action = action
  if (category) where.channel = { category }
  if (outcome) where.evaluation = { outcome }
  if (q) {
    where.OR = [{ instrument: { contains: q } }, { message: { rawText: { contains: q } } }]
  }

  const orderBy: Record<string, 'asc' | 'desc'> = {
    postedAt: 'desc',
    rMultiple: 'desc',
    confidence: 'desc',
    pnl: 'desc',
  } as const
  const orderKey = (sort in orderBy ? sort : 'postedAt') as keyof typeof orderBy

  let orderByClause
  if (sort === 'rMultiple' || sort === 'outcome') {
    orderByClause = { evaluation: { rMultiple: 'desc' as const } }
  } else if (sort === 'confidence') {
    orderByClause = { confidence: 'desc' as const }
  } else {
    orderByClause = { message: { postedAt: 'desc' as const } }
  }
  void orderKey

  const [total, signals] = await Promise.all([
    db.signal.count({ where }),
    db.signal.findMany({
      where,
      include: { evaluation: true, channel: true, message: true },
      orderBy: orderByClause,
      skip: (page - 1) * pageSize,
      take: pageSize,
    }),
  ])

  const data = signals.map((s) => ({
    id: s.id,
    instrument: s.instrument,
    instrumentType: s.instrumentType,
    action: s.action,
    entryPrice: s.entryPrice,
    entryLow: s.entryLow,
    entryHigh: s.entryHigh,
    isRange: s.isRange,
    stopLoss: s.stopLoss,
    takeProfits: s.takeProfits,
    leverage: s.leverage,
    timeframe: s.timeframe,
    confidence: s.confidence,
    status: s.status,
    postedAt: s.message.postedAt,
    channel: {
      id: s.channel.id,
      name: s.channel.name,
      telegramId: s.channel.telegramId,
      category: s.channel.category,
      avatarColor: s.channel.avatarColor,
    },
    evaluation: s.evaluation
      ? {
          outcome: s.evaluation.outcome,
          rMultiple: s.evaluation.rMultiple,
          pnlPercent: s.evaluation.pnlPercent,
          exitPrice: s.evaluation.exitPrice,
          exitReason: s.evaluation.exitReason,
          hitTpLevel: s.evaluation.hitTpLevel,
          durationMinutes: s.evaluation.durationMinutes,
          maxFavorablePct: s.evaluation.maxFavorablePct,
          maxAdversePct: s.evaluation.maxAdversePct,
          evaluatedAt: s.evaluation.evaluatedAt,
        }
      : null,
  }))

  return NextResponse.json({
    signals: data,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  })
}
