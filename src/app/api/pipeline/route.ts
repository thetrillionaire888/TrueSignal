import { NextResponse } from 'next/server'
import { db } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [totalMessages, parsedMessages, noSignalMessages, totalSignals, evaluated, channels] =
    await Promise.all([
      db.message.count(),
      db.message.count({ where: { parseStatus: 'parsed' } }),
      db.message.count({ where: { parseStatus: 'no_signal' } }),
      db.signal.count(),
      db.evaluation.count(),
      db.channel.count(),
    ])

  const pendingMessages = totalMessages - parsedMessages - noSignalMessages

  // recent ingestion events (last 12 messages)
  const recent = await db.message.findMany({
    take: 12,
    orderBy: { ingestedAt: 'desc' },
    include: { channel: true },
  })

  // per-channel ingestion counts
  const perChannel = await db.message.groupBy({
    by: ['channelId'],
    _count: true,
  })
  const channelInfo = await db.channel.findMany()
  const channelMap = new Map(channelInfo.map((c) => [c.id, c]))
  const channelStats = perChannel
    .map((p) => {
      const c = channelMap.get(p.channelId)!
      return {
        name: c.name,
        telegramId: c.telegramId,
        category: c.category,
        messages: p._count,
        status: c.status,
      }
    })
    .sort((a, b) => b.messages - a.messages)

  const stages = [
    {
      id: 'collector',
      name: 'Collector Service',
      tech: 'MTProto / TDLib',
      description: 'Full audit access to channels, groups & supergroups via Telegram client protocol.',
      status: 'operational',
      throughput: '142 msg/min',
      processed: totalMessages,
      icon: 'download',
    },
    {
      id: 'queue',
      name: 'Message Queue',
      tech: 'Redis Streams',
      description: 'Decouples ingestion from processing. Backpressure-aware buffering.',
      status: 'operational',
      throughput: '142 msg/min',
      processed: totalMessages,
      icon: 'layers',
    },
    {
      id: 'parser',
      name: 'Parser Service',
      tech: 'Regex + NLP v1.4',
      description: 'Extracts instrument, action, entry, SL, TPs from raw message text.',
      status: 'operational',
      throughput: '98 msg/min',
      processed: parsedMessages,
      extracted: totalSignals,
      skipped: noSignalMessages,
      pending: pendingMessages,
      icon: 'scan-text',
    },
    {
      id: 'evaluator',
      name: 'Evaluator Service',
      tech: 'Market Data Aggregator',
      description: 'Determines win/loss by replaying price action against entry, SL & TPs.',
      status: 'operational',
      throughput: '76 sig/min',
      processed: evaluated,
      pending: totalSignals - evaluated,
      icon: 'target',
    },
    {
      id: 'metrics',
      name: 'Metrics Engine',
      tech: 'Compute Pipeline',
      description: 'Win rate, R/R, Sharpe, Calmar, drawdown & equity curves on demand.',
      status: 'operational',
      processed: evaluated,
      icon: 'chart-line',
    },
  ]

  return NextResponse.json({
    stages,
    summary: {
      channels,
      totalMessages,
      parsedMessages,
      noSignalMessages,
      pendingMessages,
      totalSignals,
      evaluated,
      parseRate: totalMessages ? parsedMessages / totalMessages : 0,
      signalYield: totalMessages ? totalSignals / totalMessages : 0,
      evalRate: totalSignals ? evaluated / totalSignals : 0,
    },
    channelStats,
    recent: recent.map((m) => ({
      id: m.id,
      channel: m.channel.name,
      telegramId: m.channel.telegramId,
      parseStatus: m.parseStatus,
      postedAt: m.postedAt,
      ingestedAt: m.ingestedAt,
      views: m.views,
      preview: m.rawText.slice(0, 80),
    })),
  })
}
