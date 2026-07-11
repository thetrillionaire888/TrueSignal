'use client'

import * as React from 'react'
import { useQuery, useMutation } from '@tanstack/react-query'
import { ChartCard } from '@/components/charts/chart-card'
import { KpiCard } from '@/components/kpi-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { collectorFetch } from '@/lib/collector-client'
import { fmtInt, fmtDateTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  Download,
  Upload,
  CloudDownload,
  Database,
  FileJson,
  FileSpreadsheet,
  FileText,
  TrendingUp,
  CheckCircle2,
  AlertCircle,
  Loader2,
  BarChart3,
  LineChart,
  ListChecks,
} from 'lucide-react'

type CacheSummary = {
  totalBars: number
  groups: Array<{
    source: string
    instrument: string
    count: number
    earliest: number
    latest: number
  }>
}

const SOURCES = [
  {
    id: 'dukascopy',
    label: 'Dukascopy',
    desc: 'Forex, metals, crypto, indices — 15+ years of tick data',
    icon: CloudDownload,
    color: 'text-teal-500',
    note: 'Free public API · no auth required',
  },
  {
    id: 'binance',
    label: 'Binance',
    desc: 'Crypto spot klines (BTC, ETH, altcoins)',
    icon: CloudDownload,
    color: 'text-amber-500',
    note: 'Free public API · no auth required',
  },
  {
    id: 'yahoo',
    label: 'Yahoo Finance',
    desc: 'Stocks, ETFs, indices (AAPL, TSLA, SPY…)',
    icon: CloudDownload,
    color: 'text-violet-500',
    note: 'Free public API · no auth required',
  },
  {
    id: 'darwinex',
    label: 'Darwinex',
    desc: 'Darwinex broker — requires OAuth2 auth',
    icon: CloudDownload,
    color: 'text-rose-500',
    note: 'Requires auth — export as CSV from Darwinex and use CSV import',
  },
  {
    id: 'csv',
    label: 'CSV Upload',
    desc: 'Import OHLCV bars from a CSV file',
    icon: Upload,
    color: 'text-cyan-500',
    note: 'Flexible delimiter · header auto-detected',
  },
] as const

const TIMEFRAMES = [
  { id: 'm1', label: '1 minute' },
  { id: 'm5', label: '5 minutes' },
  { id: 'm15', label: '15 minutes' },
  { id: 'm30', label: '30 minutes' },
  { id: 'h1', label: '1 hour' },
  { id: 'h4', label: '4 hours' },
  { id: 'd1', label: '1 day' },
]

export function DataManagerView() {
  const [tab, setTab] = React.useState('import')

  return (
    <div className="space-y-5">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList className="grid w-full grid-cols-3 max-w-md">
          <TabsTrigger value="import" className="gap-1.5">
            <CloudDownload className="h-3.5 w-3.5" />
            Fetch
          </TabsTrigger>
          <TabsTrigger value="export" className="gap-1.5">
            <Download className="h-3.5 w-3.5" />
            Export
          </TabsTrigger>
          <TabsTrigger value="analyze" className="gap-1.5">
            <BarChart3 className="h-3.5 w-3.5" />
            View & Analyze
          </TabsTrigger>
        </TabsList>

        <TabsContent value="import" className="mt-5">
          <ImportTab />
        </TabsContent>
        <TabsContent value="export" className="mt-5">
          <ExportTab />
        </TabsContent>
        <TabsContent value="analyze" className="mt-5">
          <AnalyzeTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

// ── Import Tab ───────────────────────────────────────────────────────────────

function ImportTab() {
  const [selectedSource, setSelectedSource] = React.useState<string>('dukascopy')
  const [instrument, setInstrument] = React.useState('xauusd')
  const [timeframe, setTimeframe] = React.useState('m15')
  const [startDate, setStartDate] = React.useState(() => {
    const d = new Date()
    d.setDate(d.getDate() - 7)
    return d.toISOString().slice(0, 10)
  })
  const [endDate, setEndDate] = React.useState(() => new Date().toISOString().slice(0, 10))
  const [csvText, setCsvText] = React.useState('')
  const [csvFile, setCsvFile] = React.useState<File | null>(null)
  const [result, setResult] = React.useState<{ inserted: number; skipped: number; barsFetched: number; dateRange: { from: string | null; to: string | null } } | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const sourceMeta = SOURCES.find((s) => s.id === selectedSource)!

  const importMut = useMutation({
    mutationFn: async () => {
      let csvContent: string | undefined
      if (selectedSource === 'csv') {
        if (csvFile) {
          csvContent = await csvFile.text()
        } else {
          csvContent = csvText
        }
      }
      return collectorFetch<{
        source: string
        instrument: string
        timeframe: string
        barsFetched: number
        inserted: number
        skipped: number
        dateRange: { from: string | null; to: string | null }
      }>('/api/import', {
        method: 'POST',
        json: {
          source: selectedSource,
          instrument,
          timeframe,
          startDate: selectedSource === 'csv' ? undefined : new Date(startDate).toISOString(),
          endDate: selectedSource === 'csv' ? undefined : new Date(endDate).toISOString(),
          csvText: csvContent,
        },
      })
    },
    onSuccess: (data) => {
      setResult(data)
      setError(null)
    },
    onError: (e) => {
      setError(e instanceof Error ? e.message : String(e))
      setResult(null)
    },
  })

  const isDarwinex = selectedSource === 'darwinex'
  const isCsv = selectedSource === 'csv'

  return (
    <div className="space-y-5">
      {/* Source selection */}
      <div>
        <Label className="mb-2 block text-xs">Data Source</Label>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {SOURCES.map((src) => {
            const Icon = src.icon
            const active = selectedSource === src.id
            return (
              <button
                key={src.id}
                onClick={() => { setSelectedSource(src.id); setResult(null); setError(null) }}
                className={cn(
                  'flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-all',
                  active ? 'border-primary bg-primary/5 ring-1 ring-primary/20' : 'border-border/70 hover:border-primary/40'
                )}
              >
                <Icon className={cn('h-5 w-5', active ? 'text-primary' : src.color)} />
                <span className="text-sm font-semibold">{src.label}</span>
                <span className="text-[10px] leading-tight text-muted-foreground">{src.desc}</span>
              </button>
            )
          })}
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className={cn('h-1.5 w-1.5 rounded-full', sourceMeta.note.includes('no auth') ? 'bg-emerald-500' : 'bg-amber-500')} />
          {sourceMeta.note}
        </div>
      </div>

      {/* Import form */}
      <ChartCard
        title={isCsv ? `Import from ${sourceMeta.label}` : `Fetch from ${sourceMeta.label}`}
        description={sourceMeta.desc}
      >
        {isDarwinex ? (
          <div className="flex items-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-4 text-sm text-amber-700 dark:text-amber-400">
            <AlertCircle className="h-5 w-5 shrink-0" />
            <div>
              <p className="font-medium">Darwinex requires OAuth2 authentication</p>
              <p className="mt-1 text-xs">Export your Darwinex data as CSV from their platform, then use the <strong>CSV Upload</strong> option to import it.</p>
            </div>
          </div>
        ) : (
          <div className="space-y-4">
            {selectedSource !== 'csv' && (
              <>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="mb-1.5 block text-xs">Instrument / Symbol</Label>
                    <Input
                      value={instrument}
                      onChange={(e) => setInstrument(e.target.value)}
                      placeholder={selectedSource === 'binance' ? 'BTCUSDT' : selectedSource === 'yahoo' ? 'AAPL' : 'xauusd'}
                      disabled={importMut.isPending}
                    />
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {selectedSource === 'binance' ? 'e.g. BTCUSDT, ETHUSDT, SOLUSDT' : selectedSource === 'yahoo' ? 'e.g. AAPL, TSLA, SPY, EURUSD=X' : 'e.g. xauusd, eurusd, btcusd'}
                    </p>
                  </div>
                  <div>
                    <Label className="mb-1.5 block text-xs">Timeframe</Label>
                    <Select value={timeframe} onValueChange={setTimeframe} disabled={importMut.isPending}>
                      <SelectTrigger><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {TIMEFRAMES.map((tf) => (
                          <SelectItem key={tf.id} value={tf.id}>{tf.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <Label className="mb-1.5 block text-xs">Start Date</Label>
                    <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} disabled={importMut.isPending} />
                  </div>
                  <div>
                    <Label className="mb-1.5 block text-xs">End Date</Label>
                    <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} disabled={importMut.isPending} />
                  </div>
                </div>
              </>
            )}

            {selectedSource === 'csv' && (
              <div className="space-y-3">
                <div>
                  <Label className="mb-1.5 block text-xs">Instrument name (for labeling)</Label>
                  <Input value={instrument} onChange={(e) => setInstrument(e.target.value)} placeholder="e.g. BTCUSDT" disabled={importMut.isPending} />
                </div>
                <div>
                  <Label className="mb-1.5 block text-xs">Timeframe</Label>
                  <Select value={timeframe} onValueChange={setTimeframe} disabled={importMut.isPending}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {TIMEFRAMES.map((tf) => (
                        <SelectItem key={tf.id} value={tf.id}>{tf.label}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <Label className="mb-1.5 block text-xs">Upload CSV file (optional)</Label>
                  <Input
                    type="file"
                    accept=".csv,.txt"
                    onChange={(e) => setCsvFile(e.target.files?.[0] ?? null)}
                    disabled={importMut.isPending}
                  />
                  <p className="mt-1 text-[10px] text-muted-foreground">Expected columns: timestamp/date, open, high, low, close, volume (optional). Comma, semicolon, or tab delimited.</p>
                </div>
                <div>
                  <Label className="mb-1.5 block text-xs">Or paste CSV data</Label>
                  <Textarea
                    value={csvText}
                    onChange={(e) => setCsvText(e.target.value)}
                    placeholder="timestamp,open,high,low,close,volume&#10;1700000000000,42000,42500,41800,42300,100"
                    className="font-mono text-xs"
                    rows={4}
                    disabled={importMut.isPending}
                  />
                </div>
              </div>
            )}

            {error && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-600 dark:text-rose-400">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="break-words">{error}</span>
              </div>
            )}

            {result && (
              <div className={cn(
                'rounded-lg border p-4 text-sm',
                result.barsFetched === 0 && result.inserted === 0
                  ? 'border-amber-500/30 bg-amber-500/5'
                  : 'border-emerald-500/30 bg-emerald-500/5'
              )}>
                <div className={cn(
                  'flex items-center gap-1.5 font-medium',
                  result.barsFetched === 0 && result.inserted === 0
                    ? 'text-amber-700 dark:text-amber-400'
                    : 'text-emerald-700 dark:text-emerald-400'
                )}>
                  {result.barsFetched === 0 && result.inserted === 0 ? (
                    <AlertCircle className="h-4 w-4" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4" />
                  )}
                  {isCsv
                    ? 'Import successful'
                    : result.barsFetched === 0 && result.inserted === 0
                      ? 'Fetch returned no new data'
                      : 'Fetch successful'}
                </div>
                {result.barsFetched === 0 && result.inserted === 0 && (
                  <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">
                    No bars were fetched from the API. The data source may be unavailable
                    or the date range has no data. Try a different date range or data source.
                  </p>
                )}
                <div className="mt-2 grid grid-cols-3 gap-3 text-xs">
                  <div>
                    <div className="text-lg font-bold tnum text-foreground">{fmtInt(result.barsFetched)}</div>
                    <div className="text-muted-foreground">bars fetched</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold tnum text-emerald-600 dark:text-emerald-400">{fmtInt(result.inserted)}</div>
                    <div className="text-muted-foreground">new bars stored</div>
                  </div>
                  <div>
                    <div className="text-lg font-bold tnum text-muted-foreground">{fmtInt(result.skipped)}</div>
                    <div className="text-muted-foreground">duplicates skipped</div>
                  </div>
                </div>
                {result.dateRange.from && (
                  <p className="mt-2 text-[11px] text-muted-foreground">
                    Date range: {fmtDateTime(result.dateRange.from)} → {fmtDateTime(result.dateRange.to)}
                  </p>
                )}
              </div>
            )}

            <Button
              className="w-full gap-2"
              onClick={() => importMut.mutate()}
              disabled={importMut.isPending || (selectedSource === 'csv' && !csvText && !csvFile) || !instrument}
            >
              {importMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : isCsv ? <Upload className="h-4 w-4" /> : <CloudDownload className="h-4 w-4" />}
              {importMut.isPending
                ? (isCsv ? 'Importing…' : 'Fetching…')
                : (isCsv ? `Import ${sourceMeta.label} data` : `Fetch ${sourceMeta.label} data`)}
            </Button>
          </div>
        )}
      </ChartCard>
    </div>
  )
}

// ── Export Tab ───────────────────────────────────────────────────────────────

function ExportTab() {
  const [dataType, setDataType] = React.useState<'signals' | 'bars'>('signals')
  const [format, setFormat] = React.useState<'csv' | 'json' | 'xlsx'>('csv')
  const [barSource, setBarSource] = React.useState<string>('all')
  const [barInstrument, setBarInstrument] = React.useState<string>('all')

  const cacheQuery = useQuery<CacheSummary>({
    queryKey: ['cache-summary'],
    queryFn: () => collectorFetch<CacheSummary>('/api/cache-summary'),
    staleTime: 30_000,
  })

  const instruments = React.useMemo(() => {
    if (!cacheQuery.data) return []
    return Array.from(new Set(cacheQuery.data.groups.map((g) => g.instrument))).sort()
  }, [cacheQuery.data])

  const sources = React.useMemo(() => {
    if (!cacheQuery.data) return []
    return Array.from(new Set(cacheQuery.data.groups.map((g) => g.source))).sort()
  }, [cacheQuery.data])

  const buildUrl = () => {
    if (dataType === 'signals') {
      const params = new URLSearchParams({ format })
      return `/api/export?${params.toString()}`
    }
    const params = new URLSearchParams({ format })
    if (barSource !== 'all') params.set('source', barSource)
    if (barInstrument !== 'all') params.set('instrument', barInstrument)
    return `/api/export-bars?${params.toString()}&XTransformPort=3001`
  }

  const formatMeta: Record<string, { icon: React.ComponentType<{ className?: string }>; label: string; desc: string }> = {
    csv: { icon: FileSpreadsheet, label: 'CSV', desc: 'Excel / Sheets' },
    json: { icon: FileJson, label: 'JSON', desc: 'Python / R / API' },
    xlsx: { icon: FileText, label: 'XLSX', desc: 'Excel workbook' },
  }

  return (
    <div className="space-y-5">
      <ChartCard
        title="Export Data"
        description="Download signals or cached price bars in your preferred format"
      >
        <div className="space-y-4">
          {/* Data type */}
          <div>
            <Label className="mb-1.5 block text-xs">Data to export</Label>
            <div className="grid grid-cols-2 gap-2">
              <button
                onClick={() => setDataType('signals')}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg border p-3 text-left transition-colors',
                  dataType === 'signals' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                )}
              >
                <ListChecks className={cn('h-5 w-5', dataType === 'signals' ? 'text-primary' : 'text-muted-foreground')} />
                <div>
                  <div className="text-sm font-semibold">Signals</div>
                  <div className="text-[10px] text-muted-foreground">Parsed + evaluated signal data</div>
                </div>
              </button>
              <button
                onClick={() => setDataType('bars')}
                className={cn(
                  'flex items-center gap-2.5 rounded-lg border p-3 text-left transition-colors',
                  dataType === 'bars' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                )}
              >
                <Database className={cn('h-5 w-5', dataType === 'bars' ? 'text-primary' : 'text-muted-foreground')} />
                <div>
                  <div className="text-sm font-semibold">Price Bars</div>
                  <div className="text-[10px] text-muted-foreground">Cached OHLCV bar data</div>
                </div>
              </button>
            </div>
          </div>

          {/* Bar filters */}
          {dataType === 'bars' && cacheQuery.data && (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label className="mb-1.5 block text-xs">Source filter</Label>
                <Select value={barSource} onValueChange={setBarSource}>
                  <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All sources</SelectItem>
                    {sources.map((s) => (
                      <SelectItem key={s} value={s} className="capitalize">{s}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label className="mb-1.5 block text-xs">Instrument filter</Label>
                <Select value={barInstrument} onValueChange={setBarInstrument}>
                  <SelectTrigger className="text-sm"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All instruments</SelectItem>
                    {instruments.map((i) => (
                      <SelectItem key={i} value={i}>{i.toUpperCase()}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          {/* Format */}
          <div>
            <Label className="mb-1.5 block text-xs">Format</Label>
            <div className="grid grid-cols-3 gap-2">
              {(['csv', 'json', 'xlsx'] as const).map((fmt) => {
                const meta = formatMeta[fmt]
                const Icon = meta.icon
                const active = format === fmt
                return (
                  <button
                    key={fmt}
                    onClick={() => setFormat(fmt)}
                    className={cn(
                      'flex items-center gap-2 rounded-lg border p-3 text-left transition-colors',
                      active ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                    )}
                  >
                    <Icon className={cn('h-5 w-5', active ? 'text-primary' : 'text-muted-foreground')} />
                    <div>
                      <div className="text-sm font-semibold">{meta.label}</div>
                      <div className="text-[10px] text-muted-foreground">{meta.desc}</div>
                    </div>
                  </button>
                )
              })}
            </div>
          </div>

          {/* Summary + download */}
          <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs">
            {dataType === 'signals' ? (
              <p>Exports all evaluated signals with full metadata (instrument, action, entry, SL, TPs, outcome, R-multiple, MFE/MAE, duration).</p>
            ) : (
              <p>Exports cached OHLCV price bars. {cacheQuery.data && <span>{fmtInt(cacheQuery.data.totalBars)} bars total across {cacheQuery.data.groups.length} instrument/source combinations.</span>}</p>
            )}
          </div>

          <Button asChild className="w-full gap-2">
            <a href={buildUrl()} download>
              <Download className="h-4 w-4" />
              Download {dataType === 'signals' ? 'Signals' : 'Bars'} as {format.toUpperCase()}
            </a>
          </Button>
        </div>
      </ChartCard>
    </div>
  )
}

// ── View & Analyze Tab ───────────────────────────────────────────────────────

function AnalyzeTab() {
  const cacheQuery = useQuery<CacheSummary>({
    queryKey: ['cache-summary'],
    queryFn: () => collectorFetch<CacheSummary>('/api/cache-summary'),
    refetchInterval: 10_000,
  })

  if (cacheQuery.isLoading || !cacheQuery.data) {
    return (
      <div className="grid gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-24 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    )
  }

  const data = cacheQuery.data
  const sourceCounts = data.groups.reduce((acc, g) => {
    acc[g.source] = (acc[g.source] ?? 0) + g.count
    return acc
  }, {} as Record<string, number>)

  return (
    <div className="space-y-5">
      {/* Summary KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <KpiCard label="Total Bars" value={fmtInt(data.totalBars)} icon={Database} tone="muted" />
        <KpiCard label="Instruments" value={fmtInt(data.groups.length)} icon={LineChart} tone="primary" />
        <KpiCard label="Data Sources" value={fmtInt(Object.keys(sourceCounts).length)} icon={TrendingUp} tone="muted" />
        <KpiCard label="Storage" value="SQLite" sub="PriceBar table" icon={Database} tone="muted" />
      </div>

      {/* Source breakdown */}
      <ChartCard title="Data Sources" description="Cached price bars grouped by source">
        <div className="space-y-3">
          {Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]).map(([source, count]) => {
            const pct = (count / data.totalBars) * 100
            return (
              <div key={source}>
                <div className="mb-1 flex items-center justify-between text-xs">
                  <span className="flex items-center gap-1.5 font-medium capitalize">
                    <span className={cn(
                      'h-2 w-2 rounded-full',
                      source === 'dukascopy' ? 'bg-teal-500' :
                      source === 'binance' ? 'bg-amber-500' :
                      source === 'yahoo' ? 'bg-violet-500' :
                      source === 'csv' ? 'bg-cyan-500' : 'bg-slate-500'
                    )} />
                    {source}
                  </span>
                  <span className="tnum font-semibold">{fmtInt(count)} bars</span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className={cn(
                      'h-full rounded-full',
                      source === 'dukascopy' ? 'bg-teal-500' :
                      source === 'binance' ? 'bg-amber-500' :
                      source === 'yahoo' ? 'bg-violet-500' :
                      source === 'csv' ? 'bg-cyan-500' : 'bg-slate-500'
                    )}
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </ChartCard>

      {/* Instrument detail table */}
      <ChartCard title="Cached Instruments" description="All instrument/source combinations in the database">
        <div className="max-h-96 overflow-y-auto scroll-thin">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-card text-left text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="px-3 py-2 font-medium">Source</th>
                <th className="px-3 py-2 font-medium">Instrument</th>
                <th className="px-3 py-2 text-right font-medium">Bars</th>
                <th className="px-3 py-2 font-medium">Earliest</th>
                <th className="px-3 py-2 font-medium">Latest</th>
              </tr>
            </thead>
            <tbody>
              {data.groups
                .sort((a, b) => b.count - a.count)
                .map((g) => (
                  <tr key={`${g.source}-${g.instrument}`} className="border-b border-border/40 hover:bg-muted/30">
                    <td className="px-3 py-2">
                      <span className={cn(
                        'rounded px-1.5 py-0.5 text-[10px] font-medium capitalize',
                        g.source === 'dukascopy' ? 'bg-teal-500/12 text-teal-600 dark:text-teal-400' :
                        g.source === 'binance' ? 'bg-amber-500/12 text-amber-600 dark:text-amber-400' :
                        g.source === 'yahoo' ? 'bg-violet-500/12 text-violet-600 dark:text-violet-400' :
                        g.source === 'csv' ? 'bg-cyan-500/12 text-cyan-600 dark:text-cyan-400' :
                        'bg-slate-500/12 text-slate-600 dark:text-slate-400'
                      )}>
                        {g.source}
                      </span>
                    </td>
                    <td className="px-3 py-2 font-semibold">{g.instrument.toUpperCase()}</td>
                    <td className="px-3 py-2 text-right tnum">{fmtInt(g.count)}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDateTime(g.earliest)}</td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">{fmtDateTime(g.latest)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </ChartCard>
    </div>
  )
}
