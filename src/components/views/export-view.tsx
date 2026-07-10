'use client'

import * as React from 'react'
import { useQuery } from '@tanstack/react-query'
import { ChartCard } from '@/components/charts/chart-card'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useUI } from '@/lib/store'
import { fmtInt } from '@/lib/format'
import { FileJson, FileSpreadsheet, Download, Database, CheckCircle2 } from 'lucide-react'

export function ExportView() {
  const { filters, setFilter } = useUI()
  const channelId = filters.channelId
  const [format, setFormat] = React.useState<'csv' | 'json'>('csv')
  const [preview, setPreview] = React.useState<string>('')
  const [previewing, setPreviewing] = React.useState(false)

  const channelsQuery = useQuery<{ channels: Array<{ id: string; name: string }> }>({
    queryKey: ['channels-list'],
    queryFn: async () => (await fetch('/api/channels')).json(),
    staleTime: 120_000,
  })

  const overviewQuery = useQuery<{ metrics: { closedSignals: number; totalSignals: number } }>({
    queryKey: ['overview'],
    queryFn: async () => (await fetch('/api/overview')).json(),
    staleTime: 60_000,
  })

  const buildUrl = (fmt: 'csv' | 'json') => {
    const params = new URLSearchParams({ format: fmt })
    if (channelId) params.set('channelId', channelId)
    return `/api/export?${params}`
  }

  const loadPreview = async () => {
    setPreviewing(true)
    try {
      const res = await fetch(buildUrl('json'))
      const data = await res.json()
      setPreview(JSON.stringify(data.signals?.slice(0, 3) ?? [], null, 2))
    } catch {
      setPreview('// preview unavailable')
    }
    setPreviewing(false)
  }

  React.useEffect(() => {
    loadPreview()
  }, [channelId])

  const totalSignals = overviewQuery.data?.metrics.totalSignals ?? 0
  const exportCount = channelId ? 'filtered' : fmtInt(totalSignals)

  return (
    <div className="space-y-5">
      <ChartCard
        title="Export Audited Signals"
        description="Download the full signal + evaluation dataset for external research (Python, R, Excel, BI tools)."
      >
        <div className="grid gap-5 lg:grid-cols-2">
          {/* Config */}
          <div className="space-y-4">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Scope</label>
              <Select
                value={channelId ?? 'all'}
                onValueChange={(v) => setFilter('channelId', v === 'all' ? null : v)}
              >
                <SelectTrigger className="text-sm">
                  <SelectValue placeholder="All channels" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All channels (full dataset)</SelectItem>
                  {channelsQuery.data?.channels.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted-foreground">Format</label>
              <div className="grid grid-cols-2 gap-2">
                <button
                  onClick={() => setFormat('csv')}
                  className={`flex items-center gap-2 rounded-lg border p-3 text-left transition-colors ${
                    format === 'csv' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                  }`}
                >
                  <FileSpreadsheet className={`h-5 w-5 ${format === 'csv' ? 'text-primary' : 'text-muted-foreground'}`} />
                  <div>
                    <div className="text-sm font-semibold">CSV</div>
                    <div className="text-[10px] text-muted-foreground">Excel / Sheets</div>
                  </div>
                </button>
                <button
                  onClick={() => setFormat('json')}
                  className={`flex items-center gap-2 rounded-lg border p-3 text-left transition-colors ${
                    format === 'json' ? 'border-primary bg-primary/5' : 'border-border hover:border-primary/40'
                  }`}
                >
                  <FileJson className={`h-5 w-5 ${format === 'json' ? 'text-primary' : 'text-muted-foreground'}`} />
                  <div>
                    <div className="text-sm font-semibold">JSON</div>
                    <div className="text-[10px] text-muted-foreground">Python / R / API</div>
                  </div>
                </button>
              </div>
            </div>

            <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs">
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <Database className="h-3.5 w-3.5 text-primary" />
                Export summary
              </div>
              <dl className="mt-2 space-y-1 text-muted-foreground">
                <div className="flex justify-between">
                  <dt>Records</dt>
                  <dd className="tnum font-medium text-foreground">{exportCount}</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Fields per record</dt>
                  <dd className="tnum font-medium text-foreground">25</dd>
                </div>
                <div className="flex justify-between">
                  <dt>Schema</dt>
                  <dd className="font-medium text-foreground">Standardized JSON</dd>
                </div>
              </dl>
            </div>

            <Button asChild className="w-full gap-2">
              <a href={buildUrl(format)} download>
                <Download className="h-4 w-4" />
                Download {format.toUpperCase()}
              </a>
            </Button>
            <p className="flex items-center justify-center gap-1 text-[11px] text-muted-foreground">
              <CheckCircle2 className="h-3 w-3 text-emerald-500" />
              Includes raw fields, parsed signal & evaluation outcome
            </p>
          </div>

          {/* Preview */}
          <div>
            <div className="mb-1.5 flex items-center justify-between">
              <label className="text-xs font-medium text-muted-foreground">Preview (first 3 records)</label>
              <Button variant="ghost" size="sm" onClick={loadPreview} disabled={previewing} className="h-7 text-xs">
                {previewing ? 'Loading…' : 'Refresh'}
              </Button>
            </div>
            <pre className="h-[420px] overflow-auto scroll-thin rounded-lg border border-border/60 bg-muted/30 p-3 font-mono text-[11px] leading-relaxed text-foreground/80">
              {previewing ? 'Loading preview…' : preview}
            </pre>
          </div>
        </div>
      </ChartCard>

      {/* Schema reference */}
      <ChartCard title="Export Schema" description="Standardized JSON schema for portability">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {[
            ['signalId', 'unique signal ID'],
            ['channel', 'telegram handle'],
            ['category', 'asset class'],
            ['instrument', 'trading pair'],
            ['action', 'long / short'],
            ['entryPrice', 'entry level'],
            ['stopLoss', 'invalidation'],
            ['takeProfits', 'TP array'],
            ['leverage', 'position leverage'],
            ['confidence', 'parser confidence'],
            ['outcome', 'win/loss/breakeven'],
            ['rMultiple', 'realized R'],
            ['pnlPercent', 'account %'],
            ['maxFavorablePct', 'MFE'],
            ['maxAdversePct', 'MAE'],
            ['durationMinutes', 'hold time'],
            ['postedAt', 'signal timestamp'],
            ['evaluatedAt', 'exit timestamp'],
          ].map(([field, desc]) => (
            <div key={field} className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-1.5">
              <code className="text-xs font-semibold text-primary">{field}</code>
              <span className="text-[11px] text-muted-foreground">{desc}</span>
            </div>
          ))}
        </div>
      </ChartCard>
    </div>
  )
}
