'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { KpiCard } from '@/components/kpi-card'
import { ChartCard } from '@/components/charts/chart-card'
import { DistributionChart, type DistBucket } from '@/components/charts/distribution-chart'
import { MonthlyHeatmap, type MonthCell } from '@/components/charts/monthly-heatmap'
import { MfeMaeScatter, type MfeMaePoint } from '@/components/charts/mfe-mae-scatter'
import { useUI } from '@/lib/store'
import { fmtPct, fmtR, fmtInt } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Target, Scale, Activity, Gauge, ArrowDownRight, TrendingUp, Zap, Flame, Percent, CheckCircle2 } from 'lucide-react'

type Analytics = {
  metrics: {
    winRate: number
    expectancy: number
    profitFactor: number
    sharpe: number
    sortino: number
    calmar: number
    maxDrawdown: number
    totalR: number
    avgWin: number
    avgLoss: number
    bestTrade: number
    worstTrade: number
    longestStreak: number
    worstStreak: number
    rMultipleStd: number
    avgDurationMinutes: number
    closedSignals: number
  }
  totalParsedSignals: number
  distribution: DistBucket[]
  monthly: MonthCell[]
  instruments: Array<{ instrument: string; instrumentType: string; trades: number; winRate: number; totalR: number; avgR: number }>
  byAction: {
    long: { trades: number; winRate: number; avgR: number }
    short: { trades: number; winRate: number; avgR: number }
  }
  mfeMae: MfeMaePoint[]
}

export function AnalyticsView() {
  const { filters, setFilter } = useUI()
  const channelId = filters.channelId
  const { data, isLoading } = useQuery<Analytics>({
    queryKey: ['analytics', channelId ?? 'all'],
    queryFn: async () => {
      const url = channelId ? `/api/analytics?channelId=${channelId}` : '/api/analytics'
      return (await fetch(url)).json()
    },
  })

  const channelsQuery = useQuery<{ channels: Array<{ id: string; name: string }> }>({
    queryKey: ['channels-list'],
    queryFn: async () => (await fetch('/api/channels')).json(),
    staleTime: 120_000,
  })

  if (isLoading || !data) {
    return (
      <div className="space-y-4">
        <div className="h-12 animate-pulse rounded-xl bg-muted" />
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-64 animate-pulse rounded-xl bg-muted" />
          ))}
        </div>
      </div>
    )
  }

  const m = data.metrics

  return (
    <div className="space-y-5">
      {/* Scope selector */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Scope</span>
        <Select
          value={channelId ?? 'all'}
          onValueChange={(v) => setFilter('channelId', v === 'all' ? null : v)}
        >
          <SelectTrigger className="h-8 w-56 text-xs">
            <SelectValue placeholder="All channels" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All channels (portfolio)</SelectItem>
            {channelsQuery.data?.channels.map((c) => (
              <SelectItem key={c.id} value={c.id}>
                {c.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard label="Win Rate" value={fmtPct(m.winRate)} sub={`${m.closedSignals} closed`} icon={Percent} tone="primary" />
        <KpiCard label="Expectancy" value={fmtR(m.expectancy)} sub="per trade" icon={Target} tone={m.expectancy >= 0 ? 'positive' : 'negative'} />
        <KpiCard label="Profit Factor" value={m.profitFactor.toFixed(2)} icon={Scale} tone={m.profitFactor >= 1 ? 'positive' : 'negative'} />
        <KpiCard label="Sharpe" value={m.sharpe.toFixed(2)} sub={`Sortino ${m.sortino.toFixed(2)}`} icon={Gauge} tone="muted" />
        <KpiCard label="Calmar" value={m.calmar.toFixed(2)} sub="ann. R / max DD" icon={Activity} tone="muted" />
        <KpiCard label="Max DD" value={`-${m.maxDrawdown.toFixed(2)}R`} icon={ArrowDownRight} tone="negative" />
      </div>

      {/* Validation coverage bar */}
      {data.totalParsedSignals > 0 && (
        <div className="flex items-center gap-4 rounded-xl border border-border/50 bg-muted/20 px-4 py-3">
          <CheckCircle2 className={cn(
            'h-5 w-5 shrink-0',
            m.closedSignals / data.totalParsedSignals >= 0.9 ? 'text-emerald-500' :
            m.closedSignals / data.totalParsedSignals >= 0.5 ? 'text-amber-500' :
            'text-rose-500'
          )} />
          <div className="flex-1">
            <div className="flex items-center justify-between text-xs">
              <span className="font-medium text-foreground">Validation Coverage</span>
              <span className="tnum text-muted-foreground">
                {fmtInt(m.closedSignals)} / {fmtInt(data.totalParsedSignals)} signals evaluated
                ({((m.closedSignals / data.totalParsedSignals) * 100).toFixed(1)}%)
              </span>
            </div>
            <div className="mt-1.5 h-2 overflow-hidden rounded-full bg-muted">
              <div
                className={cn(
                  'h-full rounded-full transition-all',
                  m.closedSignals / data.totalParsedSignals >= 0.9 ? 'bg-emerald-500' :
                  m.closedSignals / data.totalParsedSignals >= 0.5 ? 'bg-amber-500' :
                  'bg-rose-500'
                )}
                style={{ width: `${Math.min(100, (m.closedSignals / data.totalParsedSignals) * 100)}%` }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Distribution + win/loss stats */}
      <div className="grid gap-5 lg:grid-cols-3">
        <ChartCard
          className="lg:col-span-2"
          title="R-Multiple Distribution"
          description="Realized outcome distribution in risk multiples"
        >
          <DistributionChart data={data.distribution} height={240} />
        </ChartCard>

        <ChartCard title="Edge Profile" description="Win/loss asymmetry">
          <div className="space-y-3">
            <StatRow label="Avg win" value={fmtR(m.avgWin)} tone="positive" icon={TrendingUp} />
            <StatRow label="Avg loss" value={fmtR(-m.avgLoss)} tone="negative" icon={ArrowDownRight} />
            <StatRow label="Best trade" value={fmtR(m.bestTrade)} tone="positive" icon={Flame} />
            <StatRow label="Worst trade" value={fmtR(m.worstTrade)} tone="negative" icon={ArrowDownRight} />
            <StatRow label="R std dev" value={`${m.rMultipleStd.toFixed(2)}R`} icon={Activity} />
            <StatRow label="Best streak" value={`${m.longestStreak}W`} tone="positive" icon={Zap} />
            <StatRow label="Worst streak" value={`${m.worstStreak}L`} tone="negative" icon={ArrowDownRight} />
          </div>
        </ChartCard>
      </div>

      {/* Monthly heatmap */}
      <ChartCard title="Monthly Performance" description="Cumulative R & win rate by month">
        <MonthlyHeatmap data={data.monthly} />
      </ChartCard>

      {/* MFE/MAE + action split */}
      <div className="grid gap-5 lg:grid-cols-3">
        <ChartCard
          className="lg:col-span-2"
          title="MFE vs MAE"
          description="Maximum favorable vs adverse excursion per trade (sampled)"
        >
          <MfeMaeScatter data={data.mfeMae} height={300} />
          <div className="mt-2 flex items-center justify-center gap-4 text-[11px] text-muted-foreground">
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500" /> Wins
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-rose-500" /> Losses
            </span>
            <span className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-amber-500" /> Breakeven
            </span>
          </div>
        </ChartCard>

        <ChartCard title="Long vs Short" description="Directional edge">
          <div className="space-y-4">
            <ActionStat label="Long" data={data.byAction.long} />
            <ActionStat label="Short" data={data.byAction.short} />
          </div>
        </ChartCard>
      </div>

      {/* Instrument table */}
      <ChartCard title="Instrument Breakdown" description="All traded instruments, ranked">
        <div className="max-h-96 overflow-y-auto scroll-thin">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-left text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr className="border-b border-border/60">
                <th className="px-3 py-2 font-medium">Instrument</th>
                <th className="px-3 py-2 font-medium">Type</th>
                <th className="px-3 py-2 text-right font-medium">Trades</th>
                <th className="px-3 py-2 text-right font-medium">Win Rate</th>
                <th className="px-3 py-2 text-right font-medium">Avg R</th>
                <th className="px-3 py-2 text-right font-medium">Total R</th>
              </tr>
            </thead>
            <tbody>
              {data.instruments.map((ins) => (
                <tr key={ins.instrument} className="border-b border-border/40 hover:bg-muted/30">
                  <td className="px-3 py-2 font-semibold">{ins.instrument}</td>
                  <td className="px-3 py-2 text-xs text-muted-foreground">{ins.instrumentType}</td>
                  <td className="px-3 py-2 text-right tnum text-muted-foreground">{ins.trades}</td>
                  <td className="px-3 py-2 text-right tnum">
                    <span className={ins.winRate >= 0.5 ? 'text-emerald-600 dark:text-emerald-400' : ''}>
                      {fmtPct(ins.winRate)}
                    </span>
                  </td>
                  <td className={`px-3 py-2 text-right tnum ${ins.avgR >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                    {fmtR(ins.avgR)}
                  </td>
                  <td className={`px-3 py-2 text-right tnum font-semibold ${ins.totalR >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                    {fmtR(ins.totalR)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </div>
  )
}

function StatRow({
  label,
  value,
  tone,
  icon: Icon,
}: {
  label: string
  value: string
  tone?: 'positive' | 'negative'
  icon: React.ComponentType<{ className?: string }>
}) {
  const toneCls = tone === 'positive' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'negative' ? 'text-rose-600 dark:text-rose-400' : ''
  return (
    <div className="flex items-center justify-between">
      <span className="flex items-center gap-2 text-xs text-muted-foreground">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </span>
      <span className={`text-sm font-semibold tnum ${toneCls}`}>{value}</span>
    </div>
  )
}

function ActionStat({ label, data }: { label: string; data: { trades: number; winRate: number; avgR: number } }) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold">{label}</span>
        <span className="text-xs text-muted-foreground">{fmtInt(data.trades)} trades</span>
      </div>
      <div className="mt-2 flex items-end justify-between">
        <div>
          <div className="text-xl font-bold tnum">{fmtPct(data.winRate)}</div>
          <div className="text-[10px] uppercase text-muted-foreground">Win rate</div>
        </div>
        <div className={`text-lg font-bold tnum ${data.avgR >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
          {fmtR(data.avgR)}
        </div>
      </div>
    </div>
  )
}
