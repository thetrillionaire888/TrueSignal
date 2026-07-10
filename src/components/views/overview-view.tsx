'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { KpiCard } from '@/components/kpi-card'
import { ChartCard } from '@/components/charts/chart-card'
import { EquityCurveChart, DrawdownChart, type EquityPoint } from '@/components/charts/equity-curve-chart'
import { WinLossDonut } from '@/components/charts/win-loss-donut'
import { ChannelBarChart, type ChannelBar } from '@/components/charts/channel-bar-chart'
import { useUI } from '@/lib/store'
import { fmtPct, fmtInt, fmtR, fmtCompact, CATEGORY_META } from '@/lib/format'
import {
  Trophy,
  Target,
  TrendingUp,
  Scale,
  Activity,
  Percent,
  ArrowDownRight,
  Gauge,
  Zap,
} from 'lucide-react'

type Overview = {
  metrics: {
    totalSignals: number
    closedSignals: number
    wins: number
    losses: number
    breakevens: number
    winRate: number
    expectancy: number
    profitFactor: number
    totalR: number
    totalPnl: number
    sharpe: number
    sortino: number
    calmar: number
    maxDrawdown: number
    longestStreak: number
    worstStreak: number
    avgDurationMinutes: number
  }
  equity: EquityPoint[]
  channels: Array<{ id: string; name: string; telegramId: string; category: string; totalR: number; winRate: number; closedSignals: number; expectancy: number }>
  categories: Array<{ category: string; trades: number; winRate: number; totalR: number }>
  actionSplit: { longs: number; shorts: number }
  last7: Array<{ date: string; trades: number }>
}

export function OverviewView() {
  const { openChannel } = useUI()
  const { data, isLoading, refetch, isFetching } = useQuery<Overview>({
    queryKey: ['overview'],
    queryFn: async () => (await fetch('/api/overview')).json(),
  })

  if (isLoading || !data) return <OverviewSkeleton />

  const m = data.metrics
  const topChannels = [...data.channels]
    .sort((a, b) => b.totalR - a.totalR)
    .slice(0, 7)
    .map((c) => ({ name: c.name, totalR: c.totalR, winRate: c.winRate, trades: c.closedSignals }))

  const last7Total = data.last7.reduce((a, b) => a + b.trades, 0)

  return (
    <div className="space-y-5">
      {/* Hero equity strip */}
      <div className="grid gap-5 lg:grid-cols-3">
        <ChartCard
          className="lg:col-span-2"
          title="Equity Curve"
          description={`Cumulative performance across ${data.metrics.closedSignals.toLocaleString()} closed signals · 1R = 1% account risk`}
          actions={
            <div className="text-right">
              <div className="text-lg font-bold tnum text-emerald-600 dark:text-emerald-400">
                {fmtR(data.metrics.totalR)}
              </div>
              <div className="text-[11px] text-muted-foreground">{fmtPct(data.metrics.winRate)} win rate</div>
            </div>
          }
          bodyClassName="p-2 sm:p-4"
        >
          <EquityCurveChart data={data.equity} height={300} />
        </ChartCard>

        <ChartCard title="Win / Loss Split" description="Closed signal outcomes" bodyClassName="flex flex-col items-center gap-4">
          <WinLossDonut wins={m.wins} losses={m.losses} breakevens={m.breakevens} size={180} />
          <div className="grid w-full grid-cols-3 gap-2 text-center">
            <div className="rounded-lg bg-emerald-500/10 py-2">
              <div className="text-sm font-bold tnum text-emerald-600 dark:text-emerald-400">{m.wins}</div>
              <div className="text-[10px] uppercase text-muted-foreground">Wins</div>
            </div>
            <div className="rounded-lg bg-rose-500/10 py-2">
              <div className="text-sm font-bold tnum text-rose-600 dark:text-rose-400">{m.losses}</div>
              <div className="text-[10px] uppercase text-muted-foreground">Losses</div>
            </div>
            <div className="rounded-lg bg-amber-500/10 py-2">
              <div className="text-sm font-bold tnum text-amber-600 dark:text-amber-400">{m.breakevens}</div>
              <div className="text-[10px] uppercase text-muted-foreground">B/E</div>
            </div>
          </div>
        </ChartCard>
      </div>

      {/* KPI row */}
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <KpiCard
          label="Win Rate"
          value={fmtPct(m.winRate)}
          sub={`${m.wins}W / ${m.losses}L / ${m.breakevens}B/E`}
          icon={Percent}
          tone="primary"
          delta={`Best streak ${m.longestStreak}`}
          deltaTone="positive"
        />
        <KpiCard
          label="Expectancy"
          value={fmtR(m.expectancy)}
          sub="avg R per trade"
          icon={Target}
          tone={m.expectancy >= 0 ? 'positive' : 'negative'}
          delta={`PF ${m.profitFactor.toFixed(2)}`}
          deltaTone="positive"
        />
        <KpiCard
          label="Profit Factor"
          value={m.profitFactor.toFixed(2)}
          sub="gross win / gross loss"
          icon={Scale}
          tone={m.profitFactor >= 1 ? 'positive' : 'negative'}
        />
        <KpiCard
          label="Sharpe"
          value={m.sharpe.toFixed(2)}
          sub={`Sortino ${m.sortino.toFixed(2)}`}
          icon={Gauge}
          tone="muted"
        />
        <KpiCard
          label="Calmar"
          value={m.calmar.toFixed(2)}
          sub="annualized R / max DD"
          icon={Activity}
          tone="muted"
        />
        <KpiCard
          label="Max Drawdown"
          value={`-${m.maxDrawdown.toFixed(2)}R`}
          sub={`worst streak ${m.worstStreak}`}
          icon={ArrowDownRight}
          tone="negative"
        />
      </div>

      {/* Channel leaderboard + categories */}
      <div className="grid gap-5 lg:grid-cols-3">
        <ChartCard
          className="lg:col-span-2"
          title="Channel Leaderboard"
          description="Total R contribution by audited channel"
          actions={
            <button
              onClick={() => useUI.getState().setView('channels')}
              className="text-xs font-medium text-primary hover:underline"
            >
              View all →
            </button>
          }
        >
          <ChannelBarChart data={topChannels as ChannelBar[]} height={Math.max(220, topChannels.length * 36)} />
        </ChartCard>

        <div className="space-y-5">
          <ChartCard title="By Asset Class" description="Performance per instrument category">
            <div className="space-y-2.5">
              {data.categories
                .sort((a, b) => b.totalR - a.totalR)
                .map((c) => {
                  const meta = CATEGORY_META[c.category] ?? { label: c.category, emoji: '◈' }
                  const maxR = Math.max(...data.categories.map((x) => Math.abs(x.totalR)), 1)
                  const positive = c.totalR >= 0
                  return (
                    <div key={c.category}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span className="flex items-center gap-1.5 font-medium">
                          <span>{meta.emoji}</span>
                          {meta.label}
                          <span className="text-muted-foreground">· {c.trades}</span>
                        </span>
                        <span
                          className={`tnum font-semibold ${
                            positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                          }`}
                        >
                          {fmtR(c.totalR)}
                        </span>
                      </div>
                      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
                        <div
                          className={`h-full rounded-full ${positive ? 'bg-emerald-500' : 'bg-rose-500'}`}
                          style={{ width: `${(Math.abs(c.totalR) / maxR) * 100}%` }}
                        />
                      </div>
                    </div>
                  )
                })}
            </div>
          </ChartCard>

          <ChartCard title="Last 7 Days" description={`${last7Total} signals ingested`}>
            <div className="flex items-end justify-between gap-1.5" style={{ height: 80 }}>
              {data.last7.map((d) => {
                const max = Math.max(...data.last7.map((x) => x.trades), 1)
                const h = (d.trades / max) * 100
                return (
                  <div key={d.date} className="flex flex-1 flex-col items-center gap-1">
                    <div className="flex w-full flex-1 items-end">
                      <div
                        className="w-full rounded-t bg-primary/70 transition-all hover:bg-primary"
                        style={{ height: `${Math.max(h, 4)}%` }}
                        title={`${d.trades} signals`}
                      />
                    </div>
                    <span className="text-[9px] text-muted-foreground">
                      {new Date(d.date).toLocaleDateString('en-US', { weekday: 'short' }).slice(0, 1)}
                    </span>
                  </div>
                )
              })}
            </div>
          </ChartCard>
        </div>
      </div>

      {/* Drawdown */}
      <ChartCard
        title="Drawdown Curve"
        description="Peak-to-trough decline in cumulative R"
        actions={
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <TrendingUp className="h-3.5 w-3.5" />
            <span className="tnum">Max DD {m.maxDrawdown.toFixed(2)}R</span>
          </div>
        }
        bodyClassName="p-2 sm:p-4"
      >
        <DrawdownChart data={data.equity} height={130} />
      </ChartCard>

      {/* Top channels quick cards */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {[...data.channels]
          .sort((a, b) => b.expectancy - a.expectancy)
          .slice(0, 4)
          .map((c) => {
            const meta = CATEGORY_META[c.category] ?? { label: c.category, emoji: '◈' }
            return (
              <button
                key={c.id}
                onClick={() => openChannel(c.id)}
                className="group rounded-xl border border-border/70 bg-card p-4 text-left transition-colors hover:border-primary/40"
              >
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-muted-foreground">{meta.emoji} {meta.label}</span>
                  <Zap className="h-3.5 w-3.5 text-amber-500" />
                </div>
                <div className="mt-1 truncate text-sm font-semibold">{c.name}</div>
                <div className="mt-2 flex items-end justify-between">
                  <div>
                    <div className={`text-lg font-bold tnum ${c.expectancy >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}`}>
                      {fmtR(c.expectancy)}
                    </div>
                    <div className="text-[10px] text-muted-foreground">expectancy</div>
                  </div>
                  <div className="text-right">
                    <div className="text-sm font-semibold tnum">{fmtPct(c.winRate)}</div>
                    <div className="text-[10px] text-muted-foreground">{c.closedSignals} sig</div>
                  </div>
                </div>
              </button>
            )
          })}
      </div>

      <div className="flex items-center justify-center pt-2 text-xs text-muted-foreground">
        <Trophy className="mr-1.5 h-3.5 w-3.5 text-amber-500" />
        Auditing {fmtInt(data.metrics.totalSignals)} signals · {fmtCompact(data.channels.reduce((a, b) => a + 0, 0))} sources monitored
      </div>
      <div className="hidden">
        <button onClick={() => refetch()}>{isFetching ? 'fetching' : 'idle'}</button>
      </div>
    </div>
  )
}

function OverviewSkeleton() {
  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        <div className="h-[360px] animate-pulse rounded-xl bg-muted lg:col-span-2" />
        <div className="h-[360px] animate-pulse rounded-xl bg-muted" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    </div>
  )
}
