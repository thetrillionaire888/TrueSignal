import { NextResponse } from 'next/server'
import {
  countMessages,
  countMessagesByParseStatus,
  countSignals,
  countEvaluations,
  countChannels,
  getRecentMessages,
  getMessageCountsPerChannel,
} from '@/lib/queries'

export const dynamic = 'force-dynamic'

export async function GET() {
  const [totalMessages, parsedMessages, noSignalMessages, totalSignals, evaluated, channels] =
    await Promise.all([
      countMessages(),
      countMessagesByParseStatus('parsed'),
      countMessagesByParseStatus('no_signal'),
      countSignals(),
      countEvaluations(),
      countChannels(),
    ])

  const pendingMessages = totalMessages - parsedMessages - noSignalMessages

  // recent ingestion events (last 12 messages)
  const recent = await getRecentMessages(12)

  // per-channel ingestion counts
  const channelStats = await getMessageCountsPerChannel()

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
      channel: m.channelName,
      telegramId: m.telegramId,
      parseStatus: m.parseStatus,
      postedAt: m.postedAt,
      ingestedAt: m.ingestedAt,
      views: m.views,
      preview: (m.rawText ?? '').slice(0, 80),
    })),
  })
}
