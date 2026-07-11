'use client'

import * as React from 'react'
import { useUI } from '@/lib/store'
import { NAV } from '@/lib/nav'
import { cn } from '@/lib/utils'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Radar, Activity, ShieldCheck, ShieldAlert, Loader2, LogOut, ArrowUpRight } from 'lucide-react'
import { collectorFetch, type SessionInfo } from '@/lib/collector-client'

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

function AuthStatusCard() {
  const qc = useQueryClient()
  const { setView } = useUI()
  const { data, isLoading } = useQuery<SessionInfo>({
    queryKey: ['collector-status'],
    queryFn: () => collectorFetch<SessionInfo>('/api/status'),
    refetchInterval: 30_000,
  })

  const state = data?.state ?? 'disconnected'
  const authenticating =
    state === 'connected' || state === 'code_sent' || state === 'awaiting_2fa' || isLoading
  const authenticated = state === 'authenticated'

  const handleLogout = async () => {
    try {
      await collectorFetch('/api/auth/logout', { method: 'POST', json: {} })
    } catch {
      // ignore — status will be re-fetched
    }
    qc.invalidateQueries({ queryKey: ['collector-status'] })
  }

  return (
    <div className="mx-3 rounded-lg border border-sidebar-border/60 bg-sidebar-accent/40 p-3">
      {authenticated && data?.me ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <ShieldCheck className="h-4 w-4 text-emerald-500" />
            <span className="text-xs font-medium text-sidebar-accent-foreground">
              {data.me.firstName} {data.me.lastName}
            </span>
          </div>
          {data.me.username && (
            <div className="text-[11px] text-sidebar-foreground/60">@{data.me.username}</div>
          )}
          <button
            onClick={handleLogout}
            className="flex items-center gap-1.5 rounded-md border border-sidebar-border/60 bg-sidebar/40 px-2 py-1 text-[11px] font-medium text-sidebar-foreground/70 hover:bg-sidebar/60 hover:text-sidebar-accent-foreground"
          >
            <LogOut className="h-3 w-3" />
            Logout
          </button>
        </div>
      ) : authenticating ? (
        <div className="flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin text-amber-500" />
          <span className="text-xs font-medium text-sidebar-accent-foreground">Authenticating…</span>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <ShieldAlert className="h-4 w-4 text-slate-400" />
            <span className="text-xs font-medium text-sidebar-foreground/70">Not authenticated</span>
          </div>
          <button
            onClick={() => setView('ingest')}
            className="flex items-center gap-1.5 rounded-md border border-primary/30 bg-primary/10 px-2 py-1 text-[11px] font-medium text-primary hover:bg-primary/20"
          >
            <ArrowUpRight className="h-3 w-3" />
            Go to Ingest
          </button>
        </div>
      )}
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
          <div className="text-sm font-bold tracking-tight text-sidebar-accent-foreground">TrueSignal</div>
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
        <AuthStatusCard />
        <div className="flex items-center gap-1.5 px-5 text-[10px] text-sidebar-foreground/30">
          <Activity className="h-3 w-3" />
          MTProto/TDLib · v1.4
        </div>
      </div>
    </aside>
  )
}
