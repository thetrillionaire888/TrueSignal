'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChannelAvatar, VerifiedTick } from '@/components/channel-avatar'
import { OutcomeBadge } from '@/components/badges'
import { useUI } from '@/lib/store'
import { fmtPct, fmtInt, fmtCompact, fmtR, CATEGORY_META, timeAgo } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Users, WifiCog, TrendingUp, ArrowRight, ChevronRight } from 'lucide-react'

type ChannelRow = {
  id: string
  telegramId: string
  name: string
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
  totalSignals: number
  metrics: {
    winRate: number
    expectancy: number
    profitFactor: number
    totalR: number
    sharpe: number
    calmar: number
    maxDrawdown: number
    closedSignals: number
    wins: number
    losses: number
  }
}

export function ChannelsView() {
  const { openChannel } = useUI()
  const { data, isLoading } = useQuery<{ channels: ChannelRow[] }>({
    queryKey: ['channels'],
    queryFn: async () => (await fetch('/api/channels')).json(),
  })

  const [sort, setSort] = React.useState<'totalR' | 'winRate' | 'expectancy' | 'subscriberCount' | 'sharpe'>('totalR')

  const channels = React.useMemo(() => {
    if (!data) return []
    return [...data.channels].sort((a, b) => {
      if (sort === 'subscriberCount') return b.subscriberCount - a.subscriberCount
      if (sort === 'winRate') return b.metrics.winRate - a.metrics.winRate
      if (sort === 'expectancy') return b.metrics.expectancy - a.metrics.expectancy
      if (sort === 'sharpe') return b.metrics.sharpe - a.metrics.sharpe
      return b.metrics.totalR - a.metrics.totalR
    })
  }, [data, sort])

  if (isLoading || !data) {
    return (
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-56 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    )
  }

  const sortOptions = [
    { id: 'totalR', label: 'Total R' },
    { id: 'winRate', label: 'Win Rate' },
    { id: 'expectancy', label: 'Expectancy' },
    { id: 'sharpe', label: 'Sharpe' },
    { id: 'subscriberCount', label: 'Subscribers' },
  ] as const

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">Sort by</span>
        <div className="inline-flex flex-wrap rounded-lg border border-border bg-muted/50 p-0.5">
          {sortOptions.map((o) => (
            <button
              key={o.id}
              onClick={() => setSort(o.id)}
              className={cn(
                'rounded-md px-2.5 py-1 text-xs font-medium transition-colors',
                sort === o.id ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {channels.map((c) => {
          const meta = CATEGORY_META[c.category] ?? { label: c.category, emoji: '◈' }
          const m = c.metrics
          const positive = m.totalR >= 0
          return (
            <button
              key={c.id}
              onClick={() => openChannel(c.id)}
              className="group flex flex-col rounded-xl border border-border/70 bg-card p-4 text-left transition-all hover:border-primary/40 hover:shadow-sm"
            >
              <div className="flex items-start gap-3">
                <ChannelAvatar name={c.name} color={c.avatarColor} size="md" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="truncate text-sm font-semibold">{c.name}</span>
                    {c.verified && <VerifiedTick />}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">{c.telegramId}</div>
                  <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground">
                    <span className="rounded bg-muted px-1.5 py-0.5 font-medium">{meta.emoji} {meta.label}</span>
                    <span className="capitalize">{c.type}</span>
                    <span>· {c.region}</span>
                  </div>
                </div>
              </div>

              <p className="mt-3 line-clamp-2 text-xs text-muted-foreground">{c.description}</p>

              <div className="mt-3 grid grid-cols-3 gap-2 text-center">
                <div className="rounded-lg bg-muted/50 py-1.5">
                  <div className="text-sm font-bold tnum">{fmtPct(m.winRate)}</div>
                  <div className="text-[9px] uppercase text-muted-foreground">Win</div>
                </div>
                <div className={cn('rounded-lg py-1.5', positive ? 'bg-emerald-500/10' : 'bg-rose-500/10')}>
                  <div className={cn('text-sm font-bold tnum', positive ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400')}>
                    {fmtR(m.totalR)}
                  </div>
                  <div className="text-[9px] uppercase text-muted-foreground">Total R</div>
                </div>
                <div className="rounded-lg bg-muted/50 py-1.5">
                  <div className="text-sm font-bold tnum">{m.expectancy >= 0 ? '+' : ''}{m.expectancy.toFixed(2)}</div>
                  <div className="text-[9px] uppercase text-muted-foreground">Exp R</div>
                </div>
              </div>

              <div className="mt-3 flex items-center justify-between border-t border-border/50 pt-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Users className="h-3 w-3" />
                  {fmtCompact(c.subscriberCount)}
                </span>
                <span className="flex items-center gap-1">
                  <WifiCog className="h-3 w-3" />
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-semibold text-primary">
                    {fmtInt(c.totalSignals)} sig
                  </span>
                </span>
                <span className="flex items-center gap-1">
                  <TrendingUp className="h-3 w-3" />
                  PF {m.profitFactor.toFixed(2)}
                </span>
                <span className="flex items-center gap-0.5 font-medium text-primary opacity-0 transition-opacity group-hover:opacity-100">
                  Open <ChevronRight className="h-3 w-3" />
                </span>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
