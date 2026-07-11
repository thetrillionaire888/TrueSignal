'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { useUI } from '@/lib/store'
import { OutcomeBadge, ActionBadge, RMultiple } from '@/components/badges'
import { ChannelAvatar } from '@/components/channel-avatar'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { fmtPrice, fmtDate, parseTPs, fmtCompact, CATEGORY_META } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Search, SlidersHorizontal, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, X, ArrowUpDown, ArrowUp, ArrowDown } from 'lucide-react'

type SignalRow = {
  id: string
  instrument: string
  instrumentType: string
  action: string
  entryPrice: number
  entryLow: number | null
  entryHigh: number | null
  // SQLite stores isRange as 0/1 (INTEGER), so we type it as number.
  isRange: number
  stopLoss: number
  takeProfits: string
  leverage: string | null
  timeframe: string | null
  confidence: number
  status: string
  postedAt: string
  channel: { id: string; name: string; telegramId: string; category: string; avatarColor: string }
  evaluation: {
    outcome: string
    rMultiple: number
    pnlPercent: number
    exitPrice: number | null
    exitReason: string | null
    hitTpLevel: number | null
    durationMinutes: number | null
    maxFavorablePct: number | null
    maxAdversePct: number | null
    evaluatedAt: string
  } | null
}

type SignalsResp = { signals: SignalRow[]; total: number; page: number; pageSize: number; totalPages: number }

// Sortable column config — TPs is excluded because it's a variable-length
// JSON list and has no meaningful sort order.
type SortColumn = {
  key: string
  label: string
  align: 'left' | 'right'
  defaultDir: 'asc' | 'desc'
}

// Header layout: each entry is either a sortable column or a plain label.
// Order here matches the <td> order in the table body.
type HeaderCell =
  | { kind: 'sort'; col: SortColumn }
  | { kind: 'static'; label: string; align: 'left' | 'right' }

const HEADER_CELLS: HeaderCell[] = [
  { kind: 'sort', col: { key: 'instrument', label: 'Instrument', align: 'left', defaultDir: 'asc' } },
  { kind: 'sort', col: { key: 'channel', label: 'Channel', align: 'left', defaultDir: 'asc' } },
  { kind: 'sort', col: { key: 'action', label: 'Dir', align: 'left', defaultDir: 'asc' } },
  { kind: 'sort', col: { key: 'entryPrice', label: 'Entry', align: 'right', defaultDir: 'desc' } },
  { kind: 'sort', col: { key: 'stopLoss', label: 'SL', align: 'right', defaultDir: 'desc' } },
  { kind: 'static', label: 'TPs', align: 'right' },
  { kind: 'sort', col: { key: 'outcome', label: 'Outcome', align: 'left', defaultDir: 'asc' } },
  { kind: 'sort', col: { key: 'rMultiple', label: 'R', align: 'right', defaultDir: 'desc' } },
  { kind: 'sort', col: { key: 'postedAt', label: 'Posted', align: 'left', defaultDir: 'desc' } },
]

function SortableTh({ col }: { col: SortColumn }) {
  const { filters, setSort } = useUI()
  const isActive = filters.sort === col.key
  const dir = filters.sortDir
  const onClick = () => {
    if (isActive) {
      setSort(col.key, dir === 'asc' ? 'desc' : 'asc')
    } else {
      setSort(col.key, col.defaultDir)
    }
  }
  return (
    <th
      className={cn(
        'cursor-pointer select-none px-3 py-2.5 font-medium transition-colors hover:text-foreground',
        col.align === 'right' ? 'text-right' : 'text-left',
        isActive && 'text-foreground'
      )}
      onClick={onClick}
      title={`Sort by ${col.label}`}
    >
      <span
        className={cn(
          'inline-flex items-center gap-1',
          col.align === 'right' && 'flex-row-reverse'
        )}
      >
        {col.label}
        {isActive ? (
          dir === 'asc' ? (
            <ArrowUp className="h-3 w-3" />
          ) : (
            <ArrowDown className="h-3 w-3" />
          )
        ) : (
          <ArrowUpDown className="h-3 w-3 opacity-40" />
        )}
      </span>
    </th>
  )
}

export function SignalsView() {
  const { filters, setFilter, resetFilters, openSignal } = useUI()
  const [showFilters, setShowFilters] = React.useState(true)
  const [searchInput, setSearchInput] = React.useState(filters.q ?? '')

  React.useEffect(() => {
    const t = setTimeout(() => {
      if ((filters.q ?? '') !== searchInput) {
        setFilter('q', searchInput)
      }
    }, 300)
    return () => clearTimeout(t)
  }, [searchInput])

  const params = new URLSearchParams({
    page: String(filters.page),
    pageSize: String(filters.pageSize),
    sort: filters.sort,
    sortDir: filters.sortDir,
  })
  if (filters.channelId) params.set('channelId', filters.channelId)
  if (filters.instrument) params.set('instrument', filters.instrument)
  if (filters.outcome) params.set('outcome', filters.outcome)
  if (filters.action) params.set('action', filters.action)
  if (filters.category) params.set('category', filters.category)
  if (filters.q) params.set('q', filters.q)

  const { data, isLoading, isFetching } = useQuery<SignalsResp>({
    queryKey: ['signals', params.toString()],
    queryFn: async () => (await fetch(`/api/signals?${params}`)).json(),
    placeholderData: (prev) => prev,
  })

  const channelsQuery = useQuery<{ channels: Array<{ id: string; name: string; category: string }> }>({
    queryKey: ['channels-list'],
    queryFn: async () => (await fetch('/api/channels')).json(),
    staleTime: 120_000,
  })

  const activeFilters = [filters.channelId, filters.outcome, filters.action, filters.category, filters.q].filter(
    Boolean
  ).length

  return (
    <div className="space-y-4">
      {/* Filter bar */}
      <div className="rounded-xl border border-border/70 bg-card p-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative min-w-[200px] flex-1">
            <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="Search instrument or message…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              className="pl-9"
            />
          </div>
          <Button
            variant={showFilters ? 'default' : 'outline'}
            size="sm"
            onClick={() => setShowFilters((s) => !s)}
            className="gap-1.5"
          >
            <SlidersHorizontal className="h-3.5 w-3.5" />
            Filters
            {activeFilters > 0 && (
              <span className="ml-0.5 rounded-full bg-primary-foreground/20 px-1.5 text-[10px] font-bold">
                {activeFilters}
              </span>
            )}
          </Button>
          {activeFilters > 0 && (
            <Button variant="ghost" size="sm" onClick={resetFilters} className="gap-1.5 text-muted-foreground">
              <X className="h-3.5 w-3.5" /> Clear
            </Button>
          )}
        </div>

        {showFilters && (
          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Select
              value={filters.channelId ?? 'all'}
              onValueChange={(v) => setFilter('channelId', v === 'all' ? null : v)}
            >
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="All channels" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All channels</SelectItem>
                {channelsQuery.data?.channels.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={filters.category ?? 'all'}
              onValueChange={(v) => setFilter('category', v === 'all' ? null : v)}
            >
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="Asset class" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All asset classes</SelectItem>
                {Object.entries(CATEGORY_META).map(([k, v]) => (
                  <SelectItem key={k} value={k}>
                    {v.emoji} {v.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Select
              value={filters.action ?? 'all'}
              onValueChange={(v) => setFilter('action', v === 'all' ? null : v)}
            >
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="Direction" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All directions</SelectItem>
                <SelectItem value="long">▲ Long</SelectItem>
                <SelectItem value="short">▼ Short</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={filters.outcome ?? 'all'}
              onValueChange={(v) => setFilter('outcome', v === 'all' ? null : v)}
            >
              <SelectTrigger className="h-9 text-xs">
                <SelectValue placeholder="Outcome" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All outcomes</SelectItem>
                <SelectItem value="win">Win</SelectItem>
                <SelectItem value="loss">Loss</SelectItem>
                <SelectItem value="breakeven">Breakeven</SelectItem>
              </SelectContent>
            </Select>
          </div>
        )}
      </div>

      {/* Table */}
      <div className="overflow-hidden rounded-xl border border-border/70 bg-card">
        <div className="overflow-x-auto scroll-thin">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border/60 bg-muted/30 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                {HEADER_CELLS.map((cell, i) =>
                  cell.kind === 'sort' ? (
                    <SortableTh key={cell.col.key} col={cell.col} />
                  ) : (
                    <th
                      key={`static-${i}`}
                      className={cn(
                        'px-3 py-2.5 font-medium',
                        cell.align === 'right' ? 'text-right' : 'text-left'
                      )}
                    >
                      {cell.label}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {isLoading
                ? Array.from({ length: 10 }).map((_, i) => (
                    <tr key={i} className="border-b border-border/40">
                      {Array.from({ length: 9 }).map((__, j) => (
                        <td key={j} className="px-3 py-3">
                          <div className="h-4 animate-pulse rounded bg-muted" />
                        </td>
                      ))}
                    </tr>
                  ))
                : data && data.signals.length === 0 ? (
                  <tr className="border-b border-border/40">
                    <td colSpan={9} className="px-3 py-10 text-center">
                      <div className="flex flex-col items-center gap-2 text-sm text-muted-foreground">
                        <Search className="h-6 w-6 opacity-40" />
                        <span>No signals found.</span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={resetFilters}
                          className="mt-1 gap-1.5"
                        >
                          <X className="h-3.5 w-3.5" />
                          Clear all filters
                        </Button>
                      </div>
                    </td>
                  </tr>
                )
                : data?.signals.map((s) => (
                    <tr
                      key={s.id}
                      onClick={() => openSignal(s.id)}
                      className="cursor-pointer border-b border-border/40 transition-colors hover:bg-muted/40"
                    >
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{s.instrument}</span>
                          {s.leverage && (
                            <span className="rounded bg-muted px-1 text-[10px] font-medium text-muted-foreground">
                              {s.leverage}
                            </span>
                          )}
                        </div>
                        {s.timeframe && (
                          <span className="text-[10px] text-muted-foreground">{s.timeframe}</span>
                        )}
                      </td>
                      <td className="px-3 py-2.5">
                        <div className="flex items-center gap-2">
                          <ChannelAvatar name={s.channel.name} color={s.channel.avatarColor} size="sm" />
                          <span className="hidden max-w-[140px] truncate text-xs text-muted-foreground lg:inline">
                            {s.channel.name}
                          </span>
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        <ActionBadge action={s.action} />
                      </td>
                      <td className="px-3 py-2.5 text-right tnum text-muted-foreground">
                        {s.isRange ? (
                          <span className="inline-flex flex-col items-end leading-tight">
                            <span>{s.entryLow != null && s.entryHigh != null ? `${fmtPrice(s.entryLow)} – ${fmtPrice(s.entryHigh)}` : fmtPrice(s.entryPrice)}</span>
                            <span className="text-[9px] uppercase text-amber-500">range</span>
                          </span>
                        ) : (
                          fmtPrice(s.entryPrice)
                        )}
                      </td>
                      <td className="px-3 py-2.5 text-right tnum text-muted-foreground">{fmtPrice(s.stopLoss)}</td>
                      <td className="px-3 py-2.5 text-right">
                        <div className="flex flex-col items-end gap-0.5 text-[11px] tnum text-muted-foreground">
                          {parseTPs(s.takeProfits).map((tp, i) => (
                            <span key={i}>
                              <span className="text-emerald-600 dark:text-emerald-400">
                                {s.evaluation?.hitTpLevel === i + 1 ? '●' : '○'}
                              </span>{' '}
                              {fmtPrice(tp)}
                            </span>
                          ))}
                        </div>
                      </td>
                      <td className="px-3 py-2.5">
                        {s.evaluation ? <OutcomeBadge outcome={s.evaluation.outcome} /> : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-right">
                        {s.evaluation ? <RMultiple value={s.evaluation.rMultiple} /> : <span className="text-xs text-muted-foreground">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-muted-foreground">{fmtDate(s.postedAt)}</td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 px-3 py-2.5 text-xs text-muted-foreground">
          <span>
            {isFetching ? 'Loading…' : `${data ? (data.page - 1) * data.pageSize + 1 : 0}–${data ? Math.min(data.page * data.pageSize, data.total) : 0} of ${fmtCompact(data?.total ?? 0)} signals`}
          </span>
          <div className="flex items-center gap-1.5">
            <Button
              variant="outline"
              size="sm"
              disabled={!data || data.page <= 1}
              onClick={() => setFilter('page', 1)}
              className="h-7 w-7 p-0"
              title="First page"
            >
              <ChevronsLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!data || data.page <= 1}
              onClick={() => setFilter('page', (useUI.getState().filters.page) - 1)}
              className="h-7 w-7 p-0"
              title="Previous page"
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span className="tnum">
              {data?.page ?? 1} / {data?.totalPages ?? 1}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={!data || data.page >= (data?.totalPages ?? 1)}
              onClick={() => setFilter('page', (useUI.getState().filters.page) + 1)}
              className="h-7 w-7 p-0"
              title="Next page"
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!data || data.page >= (data?.totalPages ?? 1)}
              onClick={() => setFilter('page', data?.totalPages ?? 1)}
              className="h-7 w-7 p-0"
              title="Last page"
            >
              <ChevronsRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
