'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChartCard } from '@/components/charts/chart-card'
import { fmtInt, fmtPct, fmtDateTime, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  Download,
  Layers,
  ScanText,
  Target,
  LineChart,
  CheckCircle2,
  ArrowRight,
  Radio,
  Clock,
} from 'lucide-react'

type Stage = {
  id: string
  name: string
  tech: string
  description: string
  status: string
  throughput: string
  processed: number
  extracted?: number
  skipped?: number
  pending?: number
  icon: string
}

type Pipeline = {
  stages: Stage[]
  summary: {
    channels: number
    totalMessages: number
    parsedMessages: number
    noSignalMessages: number
    pendingMessages: number
    totalSignals: number
    evaluated: number
    parseRate: number
    signalYield: number
    evalRate: number
  }
  channelStats: Array<{ name: string; telegramId: string; category: string; messages: number; status: string }>
  recent: Array<{
    id: string
    channel: string
    telegramId: string
    parseStatus: string
    postedAt: string
    ingestedAt: string
    views: number
    preview: string
  }>
}

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  download: Download,
  layers: Layers,
  'scan-text': ScanText,
  target: Target,
  'chart-line': LineChart,
}

export function PipelineView() {
  const { data, isLoading } = useQuery<Pipeline>({
    queryKey: ['pipeline'],
    queryFn: async () => (await fetch('/api/pipeline')).json(),
  })

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <div className="h-32 animate-pulse rounded-xl bg-muted" />
        <div className="grid gap-3 lg:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-48 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      </div>
    )
  }

  const s = data.summary

  return (
    <div className="space-y-5">
      {/* Architecture overview banner */}
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
        <div className="border-b border-border/60 bg-muted/30 px-4 py-2.5">
          <h3 className="text-sm font-semibold">Ingestion & Processing Architecture</h3>
          <p className="text-xs text-muted-foreground">
            Telegram → Collector → Queue → Parser → Evaluator → Metrics → Storage
          </p>
        </div>
        <div className="grid grid-cols-2 gap-px bg-border/40 sm:grid-cols-3 lg:grid-cols-6">
          <SummaryStat label="Channels" value={fmtInt(s.channels)} />
          <SummaryStat label="Messages" value={fmtInt(s.totalMessages)} />
          <SummaryStat label="Signals" value={fmtInt(s.totalSignals)} />
          <SummaryStat label="Parse rate" value={fmtPct(s.parseRate)} />
          <SummaryStat label="Signal yield" value={fmtPct(s.signalYield)} />
          <SummaryStat label="Evaluated" value={fmtPct(s.evalRate)} />
        </div>
      </div>

      {/* Pipeline stages */}
      <div className="grid gap-3 lg:grid-cols-5">
        {data.stages.map((stage, i) => {
          const Icon = ICONS[stage.icon] ?? Download
          return (
            <div key={stage.id} className="relative">
              <div className="flex h-full flex-col rounded-xl border border-border/70 bg-card p-4">
                <div className="flex items-center justify-between">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
                    <Icon className="h-4.5 w-4.5" />
                  </div>
                  <span className="flex items-center gap-1 rounded-full bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium text-emerald-600 dark:text-emerald-400">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                    {stage.status}
                  </span>
                </div>
                <h4 className="mt-3 text-sm font-semibold">{stage.name}</h4>
                <p className="text-[11px] font-medium text-primary">{stage.tech}</p>
                <p className="mt-1.5 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                  {stage.description}
                </p>

                <div className="mt-3 space-y-1.5 border-t border-border/50 pt-3 text-xs">
                  <Row label="Throughput" value={stage.throughput} />
                  <Row label="Processed" value={fmtInt(stage.processed)} />
                  {stage.extracted != null && <Row label="Extracted" value={fmtInt(stage.extracted)} tone="positive" />}
                  {stage.skipped != null && <Row label="No signal" value={fmtInt(stage.skipped)} />}
                  {stage.pending != null && <Row label="Pending" value={fmtInt(stage.pending)} tone={stage.pending > 0 ? 'neutral' : 'muted'} />}
                </div>
              </div>
              {i < data.stages.length - 1 && (
                <ArrowRight className="absolute -right-2.5 top-1/2 z-10 hidden h-5 w-5 -translate-y-1/2 text-muted-foreground/40 lg:block" />
              )}
            </div>
          )
        })}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {/* Per-channel ingestion */}
        <ChartCard
          className="lg:col-span-2"
          title="Ingestion by Channel"
          description="Messages collected per audited source"
        >
          <div className="space-y-2">
            {data.channelStats.map((c) => {
              const max = Math.max(...data.channelStats.map((x) => x.messages), 1)
              return (
                <div key={c.telegramId} className="flex items-center gap-3">
                  <div className="w-40 shrink-0 truncate text-xs">
                    <span className="font-medium">{c.name}</span>
                    <span className="block truncate text-[10px] text-muted-foreground">{c.telegramId}</span>
                  </div>
                  <div className="h-6 flex-1 overflow-hidden rounded-md bg-muted/50">
                    <div
                      className="flex h-full items-center justify-end rounded-md bg-primary/70 px-2 text-[10px] font-medium text-primary-foreground"
                      style={{ width: `${(c.messages / max) * 100}%` }}
                    >
                      {fmtInt(c.messages)}
                    </div>
                  </div>
                  <span className="flex w-16 shrink-0 items-center justify-end gap-1 text-[10px] text-muted-foreground">
                    <Radio className="h-3 w-3" />
                    {c.status}
                  </span>
                </div>
              )
            })}
          </div>
        </ChartCard>

        {/* Health */}
        <ChartCard title="System Health" description="Service status">
          <div className="space-y-2.5">
            {data.stages.map((stage) => (
              <div key={stage.id} className="flex items-center justify-between rounded-lg border border-border/50 px-3 py-2">
                <div className="flex items-center gap-2">
                  <CheckCircle2 className="h-4 w-4 text-emerald-500" />
                  <span className="text-xs font-medium">{stage.name}</span>
                </div>
                <span className="text-[10px] text-muted-foreground">{stage.throughput}</span>
              </div>
            ))}
            <div className="mt-3 rounded-lg bg-muted/40 p-3 text-[11px] text-muted-foreground">
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <Clock className="h-3.5 w-3.5" />
                Storage: PostgreSQL + ElasticSearch + S3/MinIO
              </div>
              <p className="mt-1">
                Raw JSON archived to object storage. Signals & analytics in PostgreSQL. Full-text search via ElasticSearch.
              </p>
            </div>
          </div>
        </ChartCard>
      </div>

      {/* Recent ingestion feed */}
      <ChartCard title="Live Ingestion Feed" description="Most recently collected messages" bodyClassName="p-0">
        <div className="max-h-96 divide-y divide-border/40 overflow-y-auto scroll-thin">
          {data.recent.map((m) => {
            const statusColor =
              m.parseStatus === 'parsed'
                ? 'text-emerald-600 dark:text-emerald-400 bg-emerald-500/10'
                : m.parseStatus === 'no_signal'
                  ? 'text-muted-foreground bg-muted/50'
                  : 'text-amber-600 dark:text-amber-400 bg-amber-500/10'
            return (
              <div key={m.id} className="flex items-start gap-3 px-4 py-2.5">
                <div className="mt-0.5">
                  <span className={cn('inline-flex rounded px-1.5 py-0.5 text-[10px] font-medium uppercase', statusColor)}>
                    {m.parseStatus.replace('_', ' ')}
                  </span>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-semibold">{m.channel}</span>
                    <span className="text-muted-foreground">{fmtInt(m.views)} views</span>
                    <span className="text-muted-foreground">·</span>
                    <span className="text-muted-foreground">{timeAgo(m.ingestedAt)}</span>
                  </div>
                  <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{m.preview}…</p>
                </div>
                <span className="shrink-0 text-[10px] text-muted-foreground">{fmtDateTime(m.postedAt)}</span>
              </div>
            )
          })}
        </div>
      </ChartCard>
    </div>
  )
}

function SummaryStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-card px-4 py-3">
      <div className="text-lg font-bold tnum">{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  )
}

function Row({ label, value, tone }: { label: string; value: string; tone?: 'positive' | 'neutral' | 'muted' }) {
  const toneCls = tone === 'positive' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'neutral' ? 'text-amber-600 dark:text-amber-400' : ''
  return (
    <div className="flex items-center justify-between">
      <span className="text-muted-foreground">{label}</span>
      <span className={`tnum font-medium ${toneCls}`}>{value}</span>
    </div>
  )
}
