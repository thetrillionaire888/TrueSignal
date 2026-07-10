import { db } from '@/lib/db'

// Load all closed evaluations joined with signal + channel for analytics.
export type EvalRowRaw = {
  signalId: string
  messageId: string
  channelId: string
  channelName: string
  channelTelegramId: string
  channelCategory: string
  instrument: string
  instrumentType: string
  action: string
  entryPrice: number
  stopLoss: number
  takeProfits: string
  leverage: string | null
  timeframe: string | null
  confidence: number
  outcome: string
  exitPrice: number | null
  exitReason: string | null
  hitTpLevel: number | null
  maxFavorablePct: number | null
  maxAdversePct: number | null
  rMultiple: number
  pnlPercent: number
  durationMinutes: number | null
  postedAt: Date
  evaluatedAt: Date
}

export async function loadEvalRows(): Promise<EvalRowRaw[]> {
  const sigs = await db.signal.findMany({
    include: {
      evaluation: true,
      channel: true,
      message: true,
    },
    orderBy: { parsedAt: 'asc' },
  })
  return sigs
    .filter((s) => s.evaluation)
    .map((s) => ({
      signalId: s.id,
      messageId: s.messageId,
      channelId: s.channelId,
      channelName: s.channel.name,
      channelTelegramId: s.channel.telegramId,
      channelCategory: s.channel.category,
      instrument: s.instrument,
      instrumentType: s.instrumentType,
      action: s.action,
      entryPrice: s.entryPrice,
      stopLoss: s.stopLoss,
      takeProfits: s.takeProfits,
      leverage: s.leverage,
      timeframe: s.timeframe,
      confidence: s.confidence,
      outcome: s.evaluation!.outcome,
      exitPrice: s.evaluation!.exitPrice,
      exitReason: s.evaluation!.exitReason,
      hitTpLevel: s.evaluation!.hitTpLevel,
      maxFavorablePct: s.evaluation!.maxFavorablePct,
      maxAdversePct: s.evaluation!.maxAdversePct,
      rMultiple: s.evaluation!.rMultiple,
      pnlPercent: s.evaluation!.pnlPercent,
      durationMinutes: s.evaluation!.durationMinutes,
      postedAt: s.message.postedAt,
      evaluatedAt: s.evaluation!.evaluatedAt,
    }))
}

export async function loadChannelsWithMeta() {
  const channels = await db.channel.findMany({
    orderBy: { subscriberCount: 'desc' },
  })
  const signalCounts = await db.signal.groupBy({
    by: ['channelId'],
    _count: true,
  })
  const countMap = new Map(signalCounts.map((s) => [s.channelId, s._count]))
  return channels.map((c) => ({
    ...c,
    signalCount: countMap.get(c.id) ?? 0,
  }))
}
