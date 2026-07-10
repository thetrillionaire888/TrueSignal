'use client'

import * as React from 'react'
import { useUI } from '@/lib/store'
import { NAV } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { useQuery } from '@tanstack/react-query'
import { Radar, Activity } from 'lucide-react'

function NavContent() {
  const { view, setView } = useUI()
  return (
    <nav className="flex flex-col gap-1 px-3">
      {NAV.map((item) => {
        const active = view === item.id
        const Icon = item.icon
        return (
          <button
            key={item.id}
            onClick={() => setView(item.id)}
            className={cn(
              'group flex items-center gap-3 rounded-lg px-3 py-2 text-left text-sm transition-colors',
              active
                ? 'bg-sidebar-accent text-sidebar-accent-foreground'
                : 'text-sidebar-foreground/70 hover:bg-sidebar-accent/60 hover:text-sidebar-accent-foreground'
            )}
          >
            <Icon
              className={cn(
                'h-4.5 w-4.5 shrink-0',
                active ? 'text-primary' : 'text-sidebar-foreground/50 group-hover:text-sidebar-foreground/80'
              )}
            />
            <div className="min-w-0">
              <div className="font-medium leading-tight">{item.label}</div>
              <div className="truncate text-[11px] text-sidebar-foreground/40">{item.desc}</div>
            </div>
            {active && <span className="ml-auto h-1.5 w-1.5 rounded-full bg-primary" />}
          </button>
        )
      })}
    </nav>
  )
}

function StatusCard() {
  const { data } = useQuery({
    queryKey: ['pipeline-summary'],
    queryFn: async () => {
      const r = await fetch('/api/pipeline')
      return (await r.json()) as {
        summary: { channels: number; totalSignals: number; parseRate: number }
      }
    },
    staleTime: 60_000,
  })
  return (
    <div className="mx-3 rounded-lg border border-sidebar-border/60 bg-sidebar-accent/40 p-3">
      <div className="flex items-center gap-2">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
        </span>
        <span className="text-xs font-medium text-sidebar-accent-foreground">Collector live</span>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-sidebar-foreground/60">
        <div>
          <div className="tnum text-sm font-semibold text-sidebar-accent-foreground">
            {data?.summary.channels ?? '—'}
          </div>
          <div>channels</div>
        </div>
        <div>
          <div className="tnum text-sm font-semibold text-sidebar-accent-foreground">
            {data ? data.summary.totalSignals.toLocaleString() : '—'}
          </div>
          <div>signals</div>
        </div>
      </div>
    </div>
  )
}

export function AppSidebar() {
  return (
    <aside className="flex h-full w-64 flex-col bg-sidebar text-sidebar-foreground">
      <div className="flex items-center gap-2.5 px-5 py-4">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/15 ring-1 ring-primary/30">
          <Radar className="h-5 w-5 text-primary" />
        </div>
        <div className="leading-tight">
          <div className="text-sm font-bold tracking-tight text-sidebar-accent-foreground">SignalAudit</div>
          <div className="text-[10px] uppercase tracking-wider text-sidebar-foreground/40">
            Telegram Signal Analytics
          </div>
        </div>
      </div>
      <div className="mt-2 flex-1 overflow-y-auto scroll-thin">
        <p className="px-5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wider text-sidebar-foreground/30">
          Audit
        </p>
        <NavContent />
      </div>
      <div className="space-y-3 py-3">
        <StatusCard />
        <div className="flex items-center gap-1.5 px-5 text-[10px] text-sidebar-foreground/30">
          <Activity className="h-3 w-3" />
          MTProto/TDLib · v1.4
        </div>
      </div>
    </aside>
  )
}
