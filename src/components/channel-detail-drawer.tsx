'use client'

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { ChannelAvatar, VerifiedTick } from '@/components/channel-avatar'
import { OutcomeBadge, ActionBadge, RMultiple } from '@/components/badges'
import { KpiCard } from '@/components/kpi-card'
import { ChartCard } from '@/components/charts/chart-card'
import { EquityCurveChart, type EquityPoint } from '@/components/charts/equity-curve-chart'
import { Button } from '@/components/ui/button'
import { useUI } from '@/lib/store'
import { collectorFetch } from '@/lib/collector-client'
import { fmtPct, fmtInt, fmtCompact, fmtR, fmtPrice, fmtDate, CATEGORY_META } from '@/lib/format'
import { Users, MessageSquare, Target, Scale, Activity, ArrowDownRight, Gauge, Percent, ExternalLink, ChevronRight, RefreshCw, ScanText, Loader2, CheckCircle2, AlertCircle } from 'lucide-react'

type ChannelDetail = {
  channel: {
    id: string
    name: string
    telegramId: string
    type: string
    category: string
    description: string
    subscriberCount: number
    verified: boolean
    avatarColor: string
    region: string
    monitoredSince: string
    lastMessageAt: string | null
    status: string
  }
  messageCount: number
  metrics: {
    winRate: number
    expectancy: number
    profitFactor: number
    totalR: number
    sharpe: number
    sortino: number
    calmar: number
    maxDrawdown: number
    closedSignals: number
    wins: number
    losses: number
    breakevens: number
    longestStreak: number
    worstStreak: number
    avgDurationMinutes: number
  }
  equity: EquityPoint[]
  instruments: Array<{ instrument: string; trades: number; winRate: number; totalR: number; avgR: number }>
  recent: Array<{
    id: string
    instrument: string
    action: string
    entryPrice: number
    outcome: string | null
    rMultiple: number | null
    exitReason: string | null
    postedAt: string
    confidence: number
  }>
}

export function ChannelDetailDrawer() {
  const { channelDetailOpen, selectedChannelId, closeChannel, openSignal } = useUI()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<ChannelDetail>({
    queryKey: ['channel-detail', selectedChannelId],
    queryFn: async () => (await fetch(`/api/channels/${selectedChannelId}`)).json(),
    enabled: !!selectedChannelId && channelDetailOpen,
  })

  // Reparse + re-evaluate state
  const [reparseStatus, setReparseStatus] = React.useState<{ loading: boolean; result?: any; error?: string }>({})
  const [reevalStatus, setReevalStatus] = React.useState<{ loading: boolean; started?: boolean; error?: string }>({})

  const handleReparse = async () => {
    if (!selectedChannelId) return
    setReparseStatus({ loading: true })
    setReevalStatus({})
    try {
      const result = await collectorFetch<any>('/api/parse', {
        method: 'POST', json: { channelId: selectedChannelId },
      })
      setReparseStatus({ loading: false, result })
      // Invalidate queries to refresh data
      qc.invalidateQueries({ queryKey: ['channel-detail', selectedChannelId] })
      qc.invalidateQueries({ queryKey: ['channels'] })
      qc.invalidateQueries({ queryKey: ['overview'] })
    } catch (e) {
      setReparseStatus({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  const handleReevaluate = async () => {
    if (!selectedChannelId) return
    setReevalStatus({ loading: true })
    try {
      // Send forceReevaluate=true to re-evaluate ALL signals for this channel
      // (not just unevaluated/no_data ones). Uses the preloaded M1 data.
      await collectorFetch<any>('/api/evaluate', {
        method: 'POST', json: { channelId: selectedChannelId, forceReevaluate: true },
      })
      setReevalStatus({ loading: false, started: true })
      // Invalidate after a delay (evaluation runs async with 8 workers)
      // Use a longer timeout since re-evaluating ALL signals takes time
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['channel-detail', selectedChannelId] })
        qc.invalidateQueries({ queryKey: ['channels'] })
        qc.invalidateQueries({ queryKey: ['overview'] })
        setReevalStatus({ loading: false, started: false })
      }, 15000)
    } catch (e) {
      setReevalStatus({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <Sheet open={channelDetailOpen} onOpenChange={(o) => !o && closeChannel()}>
      <SheetContent className="w-full overflow-y-auto scroll-thin sm:max-w-2xl">
        <SheetHeader className="pr-2">
          <SheetTitle className="flex items-center gap-3">
            {isLoading || !data ? (
              <div className="h-10 w-10 animate-pulse rounded-lg bg-muted" />
            ) : (
              <>
                <ChannelAvatar name={data.channel.name} color={data.channel.avatarColor} size="lg" />
                <div>
                  <div className="flex items-center gap-1.5">
                    <span className="text-lg">{data.channel.name}</span>
                    {data.channel.verified && <VerifiedTick />}
                  </div>
                  <div className="text-xs font-normal text-muted-foreground">{data.channel.telegramId}</div>
                </div>
              </>
            )}
          </SheetTitle>
          <SheetDescription className="sr-only">Channel detail</SheetDescription>
        </SheetHeader>

        {isLoading || !data ? (
          <div className="space-y-3 p-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-28 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        ) : (
          <div className="space-y-4 pr-2 pb-6">
            <p className="text-sm text-muted-foreground">{data.channel.description}</p>

            {/* Action buttons: Reparse + Re-evaluate */}
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleReparse}
                disabled={reparseStatus.loading}
                className="gap-1.5"
              >
                {reparseStatus.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ScanText className="h-3.5 w-3.5" />}
                Reparse
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={handleReevaluate}
                disabled={reevalStatus.loading}
                className="gap-1.5"
              >
                {reevalStatus.loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                Re-evaluate
              </Button>
            </div>

            {/* Reparse result */}
            {reparseStatus.result && (
              <div className="flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-emerald-500" />
                <div className="text-emerald-700 dark:text-emerald-400">
                  <span className="font-medium">Reparse complete.</span> {reparseStatus.result.signalsParsed} parsed, {reparseStatus.result.signalsCorrelated} correlated, {reparseStatus.result.totalSignals} total signals from {reparseStatus.result.messagesProcessed} messages.
                </div>
              </div>
            )}
            {reparseStatus.error && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-600 dark:text-rose-400">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="break-words">{reparseStatus.error}</span>
              </div>
            )}

            {/* Re-evaluate status */}
            {reevalStatus.started && (
              <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
                <Loader2 className="h-4 w-4 animate-spin" />
                Re-evaluating ALL signals for this channel using preloaded M1 data — results will appear shortly.
              </div>
            )}
            {reevalStatus.error && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-600 dark:text-rose-400">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="break-words">{reevalStatus.error}</span>
              </div>
            )}

            <div className="flex flex-wrap gap-2 text-xs">
              <Badge2>{(CATEGORY_META[data.channel.category] ?? { label: data.channel.category, emoji: '◈' }).emoji} {(CATEGORY_META[data.channel.category] ?? { label: data.channel.category }).label}</Badge2>
              <Badge2 className="capitalize">{data.channel.type}</Badge2>
              <Badge2>{data.channel.region}</Badge2>
              <Badge2 className="capitalize">{data.channel.status}</Badge2>
              <Badge2 className="flex items-center gap-1">
                <Users className="h-3 w-3" /> {fmtCompact(data.channel.subscriberCount)}
              </Badge2>
              <Badge2 className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3" /> {fmtInt(data.messageCount)} msgs
              </Badge2>
            </div>

            {/* KPIs */}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              <KpiCard label="Win Rate" value={fmtPct(data.metrics.winRate)} sub={`${data.metrics.wins}W / ${data.metrics.losses}L`} icon={Percent} tone="primary" />
              <KpiCard label="Total R" value={fmtR(data.metrics.totalR)} sub={`${data.metrics.closedSignals} signals`} icon={Target} tone={data.metrics.totalR >= 0 ? 'positive' : 'negative'} />
              <KpiCard label="Expectancy" value={fmtR(data.metrics.expectancy)} sub="per trade" icon={Activity} tone={data.metrics.expectancy >= 0 ? 'positive' : 'negative'} />
              <KpiCard label="Profit Factor" value={data.metrics.profitFactor.toFixed(2)} icon={Scale} tone={data.metrics.profitFactor >= 1 ? 'positive' : 'negative'} />
              <KpiCard label="Sharpe" value={data.metrics.sharpe.toFixed(2)} sub={`Sortino ${data.metrics.sortino.toFixed(2)}`} icon={Gauge} tone="muted" />
              <KpiCard label="Max DD" value={`-${data.metrics.maxDrawdown.toFixed(2)}R`} sub={`streak ${data.metrics.worstStreak}`} icon={ArrowDownRight} tone="negative" />
            </div>

            {/* Equity */}
            <ChartCard title="Equity Curve" description={`${data.channel.name} · cumulative R`} bodyClassName="p-2 sm:p-3">
              <EquityCurveChart data={data.equity} height={220} />
            </ChartCard>

            {/* Instruments */}
            <ChartCard title="Top Instruments" description="By trade count">
              <div className="overflow-hidden rounded-lg border border-border/60">
                <table className="w-full text-xs">
                  <thead className="bg-muted/40 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">Instrument</th>
                      <th className="px-3 py-2 text-right font-medium">Trades</th>
                      <th className="px-3 py-2 text-right font-medium">Win%</th>
                      <th className="px-3 py-2 text-right font-medium">Total R</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.instruments.map((ins) => (
                      <tr key={ins.instrument} className="border-t border-border/40">
                        <td className="px-3 py-2 font-semibold">{ins.instrument}</td>
                        <td className="px-3 py-2 text-right tnum text-muted-foreground">{ins.trades}</td>
                        <td className="px-3 py-2 text-right tnum">{fmtPct(ins.winRate)}</td>
                        <td className={`px-3 py-2 text-right tnum font-semibold ${ins.totalR >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                          {fmtR(ins.totalR)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </ChartCard>

            {/* Recent signals */}
            <ChartCard title="Recent Signals" description="Latest audited calls">
              <div className="space-y-1.5">
                {data.recent.map((s) => (
                  <button
                    key={s.id}
                    onClick={() => {
                      closeChannel()
                      openSignal(s.id)
                    }}
                    className="flex w-full items-center gap-3 rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-left transition-colors hover:border-primary/40"
                  >
                    <span className="w-20 font-semibold text-sm">{s.instrument}</span>
                    <ActionBadge action={s.action} />
                    {s.outcome && <OutcomeBadge outcome={s.outcome} />}
                    <span className="ml-auto flex items-center gap-3 text-xs text-muted-foreground">
                      <span className="tnum">{fmtPrice(s.entryPrice)}</span>
                      {s.rMultiple != null && <RMultiple value={s.rMultiple} />}
                      <span>{fmtDate(s.postedAt)}</span>
                      <ExternalLink className="h-3 w-3" />
                    </span>
                  </button>
                ))}
              </div>
              <div className="mt-3 flex justify-center border-t border-border/60 pt-3">
                <button
                  onClick={() => {
                    closeChannel()
                    useUI.getState().setFilter('channelId', data.channel.id)
                    useUI.getState().setView('signals')
                  }}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
                >
                  View all {fmtInt(data.metrics.closedSignals)} signals
                  <ChevronRight className="h-3.5 w-3.5" />
                </button>
              </div>
            </ChartCard>
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

function Badge2({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center rounded-md border border-border/60 bg-muted/40 px-2 py-1 font-medium text-muted-foreground ${className}`}>
      {children}
    </span>
  )
}
