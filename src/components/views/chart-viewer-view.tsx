'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  createChart,
  CandlestickSeries,
  LineSeries,
  LineStyle,
  type IChartApi,
  type Time,
} from 'lightweight-charts'
import { useUI } from '@/lib/store'
import { collectorFetch } from '@/lib/collector-client'
import { fmtPrice, fmtR, fmtDateTime, parseTPs, fmtInt, CATEGORY_META } from '@/lib/format'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { ActionBadge, OutcomeBadge, RMultiple } from '@/components/badges'
import { ChannelAvatar } from '@/components/channel-avatar'
import {
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertCircle,
  TrendingUp,
  TrendingDown,
} from 'lucide-react'

type Bar = { timestamp: number; open: number; high: number; low: number; close: number }

type SignalSummary = {
  id: string
  instrument: string
  action: string
  entryPrice: number
  postedAt: string
  outcome: string | null
  rMultiple: number | null
}

type SignalDetail = {
  id: string
  instrument: string
  instrumentType: string
  action: string
  entryPrice: number
  entryLow: number | null
  entryHigh: number | null
  isRange: boolean
  stopLoss: number
  takeProfits: string
  leverage: string | null
  timeframe: string | null
  channel: { id: string; name: string; avatarColor: string; category: string }
  message: { postedAt: string }
  evaluation: {
    outcome: string
    exitPrice: number | null
    exitReason: string | null
    hitTpLevel: number | null
    rMultiple: number
    durationMinutes: number | null
    marketDataSource: string
  } | null
}

export function ChartViewerView() {
  const { filters, setFilter } = useUI()
  const channelId = filters.channelId
  const [selectedSignalId, setSelectedSignalId] = React.useState<string | null>(null)
  const [signalIndex, setSignalIndex] = React.useState(0)

  // Fetch the list of channels for the scope selector
  const channelsQuery = useQuery<{ channels: Array<{ id: string; name: string }> }>({
    queryKey: ['channels-list'],
    queryFn: async () => (await fetch('/api/channels')).json(),
    staleTime: 120_000,
  })

  // Fetch the list of signals for navigation (filtered by channel scope)
  const signalsListQuery = useQuery<{ signals: SignalSummary[]; total: number }>({
    queryKey: ['signals-list-chart', channelId ?? 'all'],
    queryFn: async () => {
      const params = new URLSearchParams({ page: '1', pageSize: '100', sort: 'postedAt', sortDir: 'desc' })
      if (channelId) params.set('channelId', channelId)
      return (await fetch(`/api/signals?${params}`)).json()
    },
    staleTime: 60_000,
  })

  const signals = signalsListQuery.data?.signals ?? []

  // Reset selection when scope changes or when signals load
  React.useEffect(() => {
    if (signals.length > 0) {
      setSelectedSignalId(signals[0].id)
      setSignalIndex(0)
    } else {
      setSelectedSignalId(null)
    }
  }, [channelId])  // only reset on scope change, not on every signals update

  // Fetch the selected signal's detail
  const detailQuery = useQuery<SignalDetail>({
    queryKey: ['signal-chart', selectedSignalId],
    queryFn: async () => (await fetch(`/api/signals/${selectedSignalId}`)).json(),
    enabled: !!selectedSignalId,
  })

  // Navigation handlers
  const goToSignal = (index: number) => {
    if (index >= 0 && index < signals.length) {
      setSignalIndex(index)
      setSelectedSignalId(signals[index].id)
    }
  }

  // Keyboard navigation
  React.useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        goToSignal(signalIndex - 1)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        goToSignal(signalIndex + 1)
      }
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [signalIndex, signals.length])

  if (signalsListQuery.isLoading) {
    return (
      <div className="flex items-center justify-center py-20">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    )
  }

  if (signals.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 py-20 text-center">
        <AlertCircle className="h-8 w-8 text-muted-foreground" />
        <p className="text-sm text-muted-foreground">No signals found. Ingest and parse messages first.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Scope selector + navigation bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-border/70 bg-card p-3">
        <span className="text-xs font-medium text-muted-foreground">Scope</span>
        <Select
          value={channelId ?? 'all'}
          onValueChange={(v) => setFilter('channelId', v === 'all' ? null : v)}
        >
          <SelectTrigger className="h-9 w-48 text-xs">
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

        <div className="mx-2 h-6 w-px bg-border/50" />

        <Select
          value={selectedSignalId ?? ''}
          onValueChange={(id) => {
            const idx = signals.findIndex((s) => s.id === id)
            if (idx >= 0) {
              setSignalIndex(idx)
              setSelectedSignalId(id)
            }
          }}
        >
          <SelectTrigger className="h-9 min-w-[200px] flex-1 text-xs">
            <SelectValue placeholder="Select a signal..." />
          </SelectTrigger>
          <SelectContent>
            {signals.map((s, i) => (
              <SelectItem key={s.id} value={s.id}>
                {i + 1}. {s.instrument} · {s.action} · {s.postedAt.slice(0, 10)}
                {s.outcome ? ` · ${s.outcome}` : ''}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            disabled={signalIndex <= 0}
            onClick={() => goToSignal(signalIndex - 1)}
            className="gap-1.5"
            title="Previous signal (←)"
          >
            <ChevronLeft className="h-4 w-4" />
            Prev
          </Button>
          <span className="tnum text-xs text-muted-foreground">
            {signalIndex + 1} / {signals.length}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={signalIndex >= signals.length - 1}
            onClick={() => goToSignal(signalIndex + 1)}
            className="gap-1.5"
            title="Next signal (→)"
          >
            Next
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Signal info + chart */}
      {detailQuery.data && <SignalChart detail={detailQuery.data} />}

      {/* Keyboard hint */}
      <div className="text-center text-[10px] text-muted-foreground">
        Use ← → arrow keys to navigate between signals
      </div>
    </div>
  )
}

// ── Signal Chart Component ───────────────────────────────────────────────────

function SignalChart({ detail: data }: { detail: SignalDetail }) {
  const containerRef = React.useRef<HTMLDivElement>(null)
  const chartRef = React.useRef<IChartApi | null>(null)
  const [bars, setBars] = React.useState<Bar[]>([])
  const [loading, setLoading] = React.useState(true)
  const [error, setError] = React.useState<string | null>(null)

  const tps = parseTPs(data.takeProfits)
  const eval_ = data.evaluation

  // Fetch bars
  React.useEffect(() => {
    let cancelled = false
    const fetchBars = async () => {
      setLoading(true)
      setError(null)
      try {
        const fromMs = new Date(data.message.postedAt).getTime()
        const toMs = fromMs + 48 * 3600000
        const params = new URLSearchParams({
          XTransformPort: '3001',
          instrument: data.instrument,
          from: new Date(fromMs).toISOString(),
          to: new Date(toMs).toISOString(),
          pageSize: '500',
        })
        const res = await fetch(`/api/browse-bars?${params}`)
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const result = await res.json()
        if (!cancelled && result.bars) {
          setBars(result.bars.map((b: any) => ({
            timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close,
          })))
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    fetchBars()
    return () => { cancelled = true }
  }, [data.id, data.instrument, data.message.postedAt])

  // Render chart
  React.useEffect(() => {
    if (!containerRef.current || bars.length === 0) return

    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 400,
      layout: {
        background: { color: 'transparent' },
        textColor: 'rgb(150, 150, 150)',
        fontSize: 11,
      },
      grid: {
        vertLines: { color: 'rgba(150, 150, 150, 0.08)' },
        horzLines: { color: 'rgba(150, 150, 150, 0.08)' },
      },
      rightPriceScale: {
        borderColor: 'rgba(150, 150, 150, 0.2)',
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: {
        borderColor: 'rgba(150, 150, 150, 0.2)',
        timeVisible: true,
        secondsVisible: false,
      },
      crosshair: { mode: 1 },
    })
    chartRef.current = chart

    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#ef4444',
      borderUpColor: '#10b981',
      borderDownColor: '#ef4444',
      wickUpColor: '#10b981',
      wickDownColor: '#ef4444',
    })

    // Sort ASC by timestamp and deduplicate (multiple sources can have
    // bars at the same timestamp — lightweight-charts requires unique,
    // ascending timestamps)
    const candleData = bars
      .slice()
      .sort((a, b) => a.timestamp - b.timestamp)
      .filter((b, i, arr) => i === 0 || b.timestamp !== arr[i - 1].timestamp)
      .map(b => ({
        time: Math.floor(b.timestamp / 1000) as Time,
        open: b.open, high: b.high, low: b.low, close: b.close,
      }))
    candleSeries.setData(candleData)

    // Vertical line at the signal's posted time
    // Use a LineSeries with a single vertical segment to mark when the
    // signal was posted. The line spans from the lowest to highest price
    // at the postedAt timestamp.
    const postedTime = Math.floor(new Date(data.message.postedAt).getTime() / 1000) as Time
    const allHighs = bars.map(b => b.high)
    const allLows = bars.map(b => b.low)
    const chartMax = Math.max(...allHighs, data.entryPrice, data.stopLoss, ...tps)
    const chartMin = Math.min(...allLows, data.entryPrice, data.stopLoss, ...tps)

    const vLineSeries = chart.addSeries(LineSeries, {
      color: 'rgba(168, 85, 247, 0.6)',
      lineWidth: 2,
      lineStyle: LineStyle.Dashed,
      crosshairMarkerVisible: false,
      lastValueVisible: false,
      priceLineVisible: false,
    })
    vLineSeries.setData([
      { time: postedTime, value: chartMin },
      { time: postedTime, value: chartMax },
    ])

    // Price lines
    candleSeries.createPriceLine({
      price: data.entryPrice, color: '#3b82f6', lineWidth: 2,
      lineStyle: LineStyle.Solid, axisLabelVisible: true, title: 'Entry',
    })
    if (data.isRange && data.entryLow != null) {
      candleSeries.createPriceLine({
        price: data.entryLow, color: '#3b82f6', lineWidth: 1,
        lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Range L',
      })
    }
    if (data.isRange && data.entryHigh != null) {
      candleSeries.createPriceLine({
        price: data.entryHigh, color: '#3b82f6', lineWidth: 1,
        lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'Range H',
      })
    }
    candleSeries.createPriceLine({
      price: data.stopLoss, color: '#ef4444', lineWidth: 2,
      lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: 'SL',
    })
    tps.forEach((tp, i) => {
      candleSeries.createPriceLine({
        price: tp, color: '#10b981', lineWidth: 1,
        lineStyle: LineStyle.Dashed, axisLabelVisible: true, title: `TP${i + 1}`,
      })
    })
    if (eval_?.exitPrice != null) {
      const exitColor = eval_.outcome === 'win' ? '#10b981' : eval_.outcome === 'loss' ? '#ef4444' : '#f59e0b'
      candleSeries.createPriceLine({
        price: eval_.exitPrice, color: exitColor, lineWidth: 2,
        lineStyle: LineStyle.Solid, axisLabelVisible: true,
        title: `Exit (${eval_.exitReason ?? eval_.outcome})`,
      })
    }

    chart.timeScale().fitContent()

    const resizeObserver = new ResizeObserver(() => {
      if (containerRef.current && chartRef.current) {
        chartRef.current.applyOptions({ width: containerRef.current.clientWidth })
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      chart.remove()
      chartRef.current = null
    }
  }, [bars, data.entryPrice, data.entryLow, data.entryHigh, data.isRange,
      data.stopLoss, data.id, eval_?.exitPrice, eval_?.exitReason, eval_?.outcome])

  return (
    <div className="space-y-3">
      {/* Signal info bar */}
      <div className="flex flex-wrap items-center gap-4 rounded-xl border border-border/70 bg-card p-4">
        <div className="flex items-center gap-2">
          <ChannelAvatar name={data.channel.name} color={data.channel.avatarColor} size="sm" />
          <div>
            <div className="flex items-center gap-2">
              <span className="text-lg font-bold">{data.instrument}</span>
              <ActionBadge action={data.action} />
              {eval_ && <OutcomeBadge outcome={eval_.outcome} />}
            </div>
            <div className="text-xs text-muted-foreground">{data.channel.name}</div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-4 text-xs">
          <div>
            <span className="text-muted-foreground">Entry: </span>
            <span className="font-semibold tnum">
              {data.isRange && data.entryLow != null && data.entryHigh != null
                ? `${fmtPrice(data.entryLow)} – ${fmtPrice(data.entryHigh)}`
                : fmtPrice(data.entryPrice)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">SL: </span>
            <span className="font-semibold tnum text-rose-500">{fmtPrice(data.stopLoss)}</span>
          </div>
          <div>
            <span className="text-muted-foreground">TPs: </span>
            <span className="font-semibold tnum text-emerald-500">
              {tps.map(fmtPrice).join(', ')}
            </span>
          </div>
          {eval_ && (
            <>
              <div>
                <span className="text-muted-foreground">R: </span>
                <RMultiple value={eval_.rMultiple} />
              </div>
              <div>
                <span className="text-muted-foreground">Exit: </span>
                <span className="font-semibold">{eval_.exitReason ?? '—'}</span>
              </div>
              <div>
                <span className="text-muted-foreground">TF: </span>
                <span className="font-semibold">{eval_.marketDataSource.split('-').pop()?.toUpperCase()}</span>
              </div>
            </>
          )}
          <div>
            <span className="text-muted-foreground">Posted: </span>
            <span className="font-semibold">{fmtDateTime(data.message.postedAt)}</span>
          </div>
        </div>
      </div>

      {/* Chart container */}
      <div className="rounded-xl border border-border/70 bg-card p-3">
        {loading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            <span className="ml-2 text-sm text-muted-foreground">Loading candlestick data...</span>
          </div>
        ) : error || bars.length === 0 ? (
          <div className="flex items-center justify-center py-16 text-sm text-muted-foreground">
            <AlertCircle className="mr-2 h-5 w-5" />
            {error ? `Failed to load: ${error}` : 'No bar data available for this signal\'s evaluation window'}
          </div>
        ) : (
          <>
            <div className="mb-2 flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">
                {data.instrument.toUpperCase()} · {bars.length} bars · 48h window
              </span>
              <div className="flex items-center gap-3 text-[10px] text-muted-foreground">
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-blue-500" /> Entry</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-rose-500" /> SL</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-emerald-500" /> TP</span>
                <span className="flex items-center gap-1"><span className="h-2 w-2 rounded bg-purple-500" /> Signal Posted</span>
                {eval_?.exitPrice != null && (
                  <span className="flex items-center gap-1">
                    <span className="h-2 w-2 rounded-full" style={{ background: eval_.outcome === 'win' ? '#10b981' : eval_.outcome === 'loss' ? '#ef4444' : '#f59e0b' }} />
                    Exit
                  </span>
                )}
              </div>
            </div>
            <div ref={containerRef} className="w-full" />
          </>
        )}
      </div>
    </div>
  )
}
