'use client'

import * as React from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetDescription } from '@/components/ui/sheet'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ActionBadge, OutcomeBadge, RMultiple } from '@/components/badges'
import { ChannelAvatar, VerifiedTick } from '@/components/channel-avatar'
import { useUI } from '@/lib/store'
import { collectorFetch } from '@/lib/collector-client'
import { fmtPrice, fmtPct, fmtDuration, fmtDateTime, parseTPs, fmtInt, CATEGORY_META } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  MessageSquare,
  Eye,
  Repeat2,
  Heart,
  ScanText,
  Target,
  Activity,
  Clock,
  Database,
  CheckCircle2,
  XCircle,
  ArrowDownRight,
  ArrowUpRight,
  RefreshCw,
  Loader2,
  AlertCircle,
  Copy,
  Check,
} from 'lucide-react'

type Detail = {
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
  positionSize: string | null
  leverage: string | null
  timeframe: string | null
  confidence: number
  parserVersion: string
  status: string
  notes: string | null
  parsedAt: string
  channel: {
    id: string
    name: string
    telegramId: string
    category: string
    type: string
    avatarColor: string
    subscriberCount: number
    verified: boolean
  }
  message: {
    id: string
    telegramMessageId: number
    rawText: string
    hasMedia: boolean
    mediaType: string | null
    views: number
    forwards: number
    reactions: number
    postedAt: string
    ingestedAt: string
    parseStatus: string
    ingestSource: string
  }
  evaluation: {
    outcome: string
    exitPrice: number | null
    exitReason: string | null
    hitTpLevel: number | null
    maxFavorablePct: number | null
    maxAdversePct: number | null
    rMultiple: number
    pnlPercent: number
    durationMinutes: number | null
    marketDataSource: string
    evaluatedAt: string
  } | null
}

export function SignalDetailDrawer() {
  const { detailOpen, selectedSignalId, closeSignal, openChannel } = useUI()
  const qc = useQueryClient()
  const { data, isLoading } = useQuery<Detail>({
    queryKey: ['signal', selectedSignalId],
    queryFn: async () => (await fetch(`/api/signals/${selectedSignalId}`)).json(),
    enabled: !!selectedSignalId && detailOpen,
  })

  // Re-evaluate state
  const [reevalStatus, setReevalStatus] = React.useState<{ loading: boolean; result?: any; error?: string }>({})

  const handleReevaluate = async () => {
    if (!selectedSignalId) return
    setReevalStatus({ loading: true })
    try {
      const result = await collectorFetch<any>('/api/evaluate-signal', {
        method: 'POST', json: { signalId: selectedSignalId },
      })
      setReevalStatus({ loading: false, result })
      // Invalidate to refresh the signal detail
      qc.invalidateQueries({ queryKey: ['signal', selectedSignalId] })
      qc.invalidateQueries({ queryKey: ['signals'] })
      qc.invalidateQueries({ queryKey: ['overview'] })
    } catch (e) {
      setReevalStatus({ loading: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  return (
    <Sheet open={detailOpen} onOpenChange={(o) => !o && closeSignal()}>
      <SheetContent className="w-full overflow-y-auto scroll-thin sm:max-w-2xl">
        <SheetHeader className="space-y-2 pr-2">
          <SheetTitle className="flex items-center gap-2">
            {isLoading ? (
              <div className="h-6 w-40 animate-pulse rounded bg-muted" />
            ) : (
              <>
                <span className="text-lg">{data?.instrument}</span>
                {data && <ActionBadge action={data.action} />}
                {data?.evaluation && <OutcomeBadge outcome={data.evaluation.outcome} />}
              </>
            )}
          </SheetTitle>
          <SheetDescription className="sr-only">Signal audit detail</SheetDescription>
        </SheetHeader>

        {isLoading || !data ? (
          <div className="space-y-3 p-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-32 animate-pulse rounded-xl bg-muted" />
            ))}
          </div>
        ) : (
          <div className="space-y-4 pr-2 pb-6">
            {/* Channel header */}
            <button
              onClick={() => {
                closeSignal()
                openChannel(data.channel.id)
              }}
              className="flex w-full items-center gap-3 rounded-xl border border-border/70 bg-card p-3 text-left transition-colors hover:border-primary/40"
            >
              <ChannelAvatar name={data.channel.name} color={data.channel.avatarColor} size="md" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-sm font-semibold">{data.channel.name}</span>
                  {data.channel.verified && <VerifiedTick />}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {data.channel.telegramId} · {fmtInt(data.channel.subscriberCount)} subs
                </div>
              </div>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                {(CATEGORY_META[data.channel.category] ?? { label: data.channel.category }).label}
              </span>
            </button>

            {/* Raw message */}
            <Section
              icon={MessageSquare}
              label="Raw Telegram Message"
              tag={`#${data.message.telegramMessageId} · ${data.message.ingestSource}`}
              tone="slate"
            >
              <div className="group/raw relative">
                <pre className="whitespace-pre-wrap break-words rounded-lg bg-muted/50 p-3 pr-10 font-mono text-xs leading-relaxed text-foreground/90">
                  {data.message.rawText}
                </pre>
                <CopyButton text={data.message.rawText} />
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
                <span className="flex items-center gap-1">
                  <Clock className="h-3 w-3" /> {fmtDateTime(data.message.postedAt)}
                </span>
                <span className="flex items-center gap-1">
                  <Eye className="h-3 w-3" /> {fmtInt(data.message.views)}
                </span>
                <span className="flex items-center gap-1">
                  <Repeat2 className="h-3 w-3" /> {data.message.forwards}
                </span>
                <span className="flex items-center gap-1">
                  <Heart className="h-3 w-3" /> {data.message.reactions}
                </span>
                {data.message.hasMedia && (
                  <Badge variant="secondary" className="text-[10px]">
                    {data.message.mediaType ?? 'media'}
                  </Badge>
                )}
              </div>
            </Section>

            {/* Parser output */}
            <Section
              icon={ScanText}
              label="Parsed Signal"
              tag={`${data.parserVersion} · ${(data.confidence * 100).toFixed(0)}% confidence`}
              tone="teal"
            >
              <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <Field label="Instrument" value={data.instrument} />
                <Field label="Type" value={data.instrumentType} />
                <Field label="Action" value={<ActionBadge action={data.action} />} />
                {/* Signal TF = the trader's stated timeframe from the signal message
                    (e.g. "15m", "scalping", "positional"). May be null if the parser
                    couldn't extract it. Only shown when present. */}
                {data.timeframe && <Field label="Signal TF" value={data.timeframe} />}
                {/* Eval TF = the actual bar timeframe used by the evaluator (M1 or M15).
                    Extracted from marketDataSource (e.g. "dukascopy-m1" → "M1").
                    More meaningful than the signal's stated timeframe since it
                    reflects the actual data resolution used for evaluation. */}
                {data.evaluation?.marketDataSource && (
                  <Field
                    label="Eval TF"
                    value={data.evaluation.marketDataSource.split('-').pop()?.toUpperCase() ?? '—'}
                  />
                )}
                <Field
                  label="Entry"
                  value={data.isRange && data.entryLow != null && data.entryHigh != null
                    ? `${fmtPrice(data.entryLow)} – ${fmtPrice(data.entryHigh)}`
                    : fmtPrice(data.entryPrice)}
                  mono
                />
                <Field label="Stop Loss" value={fmtPrice(data.stopLoss)} mono tone="negative" />
                {/* Leverage & Position — only shown when the parser extracted them.
                    ~5% of signals don't have these fields; showing empty "—" cells
                    for every signal made the Parsed Signal grid look incomplete. */}
                {data.leverage && <Field label="Leverage" value={data.leverage} />}
                {data.positionSize && <Field label="Position" value={data.positionSize} />}
              </div>

              {/* Price ladder visualization */}
              <PriceLadder
                action={data.action}
                entry={data.entryPrice}
                sl={data.stopLoss}
                tps={parseTPs(data.takeProfits)}
                exit={data.evaluation?.exitPrice ?? null}
                hitTp={data.evaluation?.hitTpLevel ?? null}
                outcome={data.evaluation?.outcome ?? 'pending'}
              />
            </Section>

            {/* Evaluation */}
            {data.evaluation ? (
              <Section
                icon={Target}
                label="Evaluation Outcome"
                tag={data.evaluation.marketDataSource}
                tone={data.evaluation.outcome === 'win' ? 'positive' : data.evaluation.outcome === 'loss' ? 'negative' : 'neutral'}
              >
                {/* Re-evaluate button — always visible, especially useful for no_data */}
                <div className="mb-3 flex flex-wrap items-center gap-2">
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
                  {data.evaluation.outcome === 'no_data' && (
                    <span className="text-[10px] text-amber-600 dark:text-amber-400">
                      Dukascopy returned no data — try re-evaluating
                    </span>
                  )}
                </div>

                {/* Re-evaluate result */}
                {reevalStatus.result && (
                  <div className="mb-3 flex items-start gap-2 rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-400">
                    <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
                    <div>
                      <span className="font-medium">Re-evaluated:</span> {reevalStatus.result.outcome} (R={reevalStatus.result.rMultiple}, {reevalStatus.result.barsAnalyzed} bars)
                    </div>
                  </div>
                )}
                {reevalStatus.error && (
                  <div className="mb-3 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-600 dark:text-rose-400">
                    <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                    <span className="break-words">{reevalStatus.error}</span>
                  </div>
                )}

                <div className="mb-3 flex items-center justify-between rounded-lg border border-border/60 p-3">
                  <div className="flex items-center gap-3">
                    {data.evaluation.outcome === 'win' ? (
                      <CheckCircle2 className="h-8 w-8 text-emerald-500" />
                    ) : data.evaluation.outcome === 'loss' ? (
                      <XCircle className="h-8 w-8 text-rose-500" />
                    ) : (
                      <Activity className="h-8 w-8 text-amber-500" />
                    )}
                    <div>
                      <div className="text-sm font-semibold capitalize">{data.evaluation.outcome}</div>
                      <div className="text-xs text-muted-foreground">
                        via {data.evaluation.exitReason} · {fmtDuration(data.evaluation.durationMinutes)}
                      </div>
                    </div>
                  </div>
                  <div className="text-right">
                    <RMultiple value={data.evaluation.rMultiple} className="text-xl" />
                    <div className="text-[11px] text-muted-foreground">
                      {data.evaluation.pnlPercent > 0 ? '+' : ''}
                      {data.evaluation.pnlPercent.toFixed(2)}% acct
                    </div>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-3">
                  <Field label="Exit Price" value={data.evaluation.exitPrice != null ? fmtPrice(data.evaluation.exitPrice) : '—'} mono />
                  <Field label="Exit Reason" value={data.evaluation.exitReason ?? '—'} />
                  <Field label="TP Hit" value={data.evaluation.hitTpLevel ? `TP${data.evaluation.hitTpLevel}` : '—'} />
                  <Field
                    label="Max Favorable"
                    value={data.evaluation.maxFavorablePct != null ? `+${data.evaluation.maxFavorablePct.toFixed(1)}%` : '—'}
                    mono
                    tone="positive"
                  />
                  <Field
                    label="Max Adverse"
                    value={data.evaluation.maxAdversePct != null ? `${data.evaluation.maxAdversePct.toFixed(1)}%` : '—'}
                    mono
                    tone="negative"
                  />
                  <Field label="Duration" value={fmtDuration(data.evaluation.durationMinutes)} />
                </div>

                <div className="mt-3 flex items-center gap-1.5 text-[10px] text-muted-foreground">
                  <Database className="h-3 w-3" />
                  Evaluated {fmtDateTime(data.evaluation.evaluatedAt)} · {data.evaluation.marketDataSource}
                </div>
              </Section>
            ) : (
              <Section icon={Clock} label="Evaluation" tag="pending" tone="slate">
                <p className="py-4 text-center text-sm text-muted-foreground">
                  This signal is still being evaluated against market data.
                </p>
                <div className="flex justify-center pb-2">
                  <a
                    href="/?view=ingest"
                    className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card px-3 py-1.5 text-xs font-medium hover:bg-muted"
                  >
                    <ArrowUpRight className="h-3.5 w-3.5" />
                    Go to Ingest to trigger evaluation
                  </a>
                </div>
              </Section>
            )}
          </div>
        )}
      </SheetContent>
    </Sheet>
  )
}

// Copy-to-clipboard button — shows Copy icon, switches to Check on success
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = React.useState(false)
  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback for older browsers
      const textarea = document.createElement('textarea')
      textarea.value = text
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    }
  }
  return (
    <button
      onClick={handleCopy}
      className="absolute right-2 top-2 rounded-md border border-border/50 bg-card/80 p-1.5 text-muted-foreground opacity-0 backdrop-blur transition-all hover:bg-card hover:text-foreground group-hover/raw:opacity-100"
      title={copied ? 'Copied!' : 'Copy raw message'}
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-emerald-500" />
      ) : (
        <Copy className="h-3.5 w-3.5" />
      )}
    </button>
  )
}

function Section({
  icon: Icon,
  label,
  tag,
  tone = 'slate',
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  label: string
  tag?: string
  tone?: 'slate' | 'teal' | 'positive' | 'negative' | 'neutral'
  children: React.ReactNode
}) {
  const toneCls = {
    slate: 'text-muted-foreground',
    teal: 'text-teal-500',
    positive: 'text-emerald-500',
    negative: 'text-rose-500',
    neutral: 'text-amber-500',
  }[tone]
  return (
    <div className="rounded-xl border border-border/70 bg-card">
      <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
        <div className="flex items-center gap-1.5">
          <Icon className={cn('h-3.5 w-3.5', toneCls)} />
          <span className="text-xs font-semibold uppercase tracking-wider">{label}</span>
        </div>
        {tag && <span className="text-[10px] text-muted-foreground">{tag}</span>}
      </div>
      <div className="p-3">{children}</div>
    </div>
  )
}

function Field({
  label,
  value,
  mono,
  tone,
}: {
  label: string
  value: React.ReactNode
  mono?: boolean
  tone?: 'positive' | 'negative' | 'neutral'
}) {
  const toneCls = tone === 'positive' ? 'text-emerald-600 dark:text-emerald-400' : tone === 'negative' ? 'text-rose-600 dark:text-rose-400' : tone === 'neutral' ? 'text-amber-600 dark:text-amber-400' : ''
  return (
    <div className="rounded-lg bg-muted/40 px-2.5 py-1.5">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn('mt-0.5 font-semibold', mono && 'tnum', toneCls)}>{value}</div>
    </div>
  )
}

function PriceLadder({
  action,
  entry,
  sl,
  tps,
  exit,
  hitTp,
  outcome,
}: {
  action: string
  entry: number
  sl: number
  tps: number[]
  exit: number | null
  hitTp: number | null
  outcome: string
}) {
  // De-duplicate take-profit levels — parsers occasionally emit the same TP twice.
  const uniqueTps = tps.filter((tp, i) => tps.indexOf(tp) === i)

  // Guard: if SL equals entry price, the signal has zero risk and the ladder
  // math (range, position offsets) breaks down with divide-by-zero / NaN.
  if (sl === entry) {
    return (
      <div className="mt-3 rounded-lg border border-rose-500/40 bg-rose-500/5 p-3 text-xs text-rose-600 dark:text-rose-400">
        <strong>Invalid signal:</strong> Stop loss equals entry price (zero risk).
        The price ladder cannot be rendered. This signal will be flagged as
        invalid during evaluation.
      </div>
    )
  }

  const isLong = action === 'long'
  const allLevels = [sl, entry, ...uniqueTps, ...(exit != null ? [exit] : [])]
  const min = Math.min(...allLevels)
  const max = Math.max(...allLevels)
  const range = max - min || 1
  const pad = range * 0.08
  const lo = min - pad
  const hi = max + pad
  const total = hi - lo
  const pos = (v: number) => ((v - lo) / total) * 100

  return (
    <div className="mt-3">
      <div className="relative h-40 rounded-lg border border-border/60 bg-muted/20 p-3">
        {/* entry zone line */}
        <div
          className="absolute inset-y-3 w-px bg-foreground/30"
          style={{ left: `${pos(entry)}%` }}
        />
        {/* SL zone */}
        <div
          className="absolute inset-y-3 w-px bg-rose-500/60"
          style={{ left: `${pos(sl)}%` }}
        />
        {/* favorable region shading */}
        <div
          className={cn('absolute inset-y-3', isLong ? 'bg-emerald-500/10' : 'bg-emerald-500/10')}
          style={{
            left: `${Math.min(pos(entry), pos(uniqueTps[uniqueTps.length - 1] ?? entry))}%`,
            width: `${Math.abs(pos(uniqueTps[uniqueTps.length - 1] ?? entry) - pos(entry))}%`,
          }}
        />
        {/* adverse region */}
        <div
          className="absolute inset-y-3 bg-rose-500/10"
          style={{
            left: `${Math.min(pos(entry), pos(sl))}%`,
            width: `${Math.abs(pos(sl) - pos(entry))}%`,
          }}
        />
        {/* TP markers */}
        {uniqueTps.map((tp, i) => (
          <div
            key={i}
            className="absolute inset-y-3 w-px bg-emerald-500/70"
            style={{ left: `${pos(tp)}%` }}
          />
        ))}
        {/* exit marker */}
        {exit != null && (
          <div
            className="absolute inset-y-3 w-0.5"
            style={{
              left: `${pos(exit)}%`,
              background: outcome === 'win' ? '#10b981' : outcome === 'loss' ? '#f43f5e' : '#f59e0b',
            }}
          />
        )}
        {/* labels */}
        <LadderLabel x={pos(sl)} align="left" color="text-rose-500">
          SL {fmtPrice(sl)}
        </LadderLabel>
        <LadderLabel x={pos(entry)} align="center" color="text-foreground">
          Entry {fmtPrice(entry)}
        </LadderLabel>
        {uniqueTps.map((tp, i) => (
          <LadderLabel key={i} x={pos(tp)} align="right" color={hitTp === i + 1 ? 'text-emerald-600 dark:text-emerald-400' : 'text-emerald-500/80'}>
            TP{i + 1} {fmtPrice(tp)}
          </LadderLabel>
        ))}
        {exit != null && (
          <LadderLabel x={pos(exit)} align="right" color={outcome === 'win' ? 'text-emerald-600' : 'text-rose-600'}>
            Exit {fmtPrice(exit)}
          </LadderLabel>
        )}
      </div>
      <div className="mt-1.5 flex items-center justify-center gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          {isLong ? <ArrowUpRight className="h-3 w-3 text-emerald-500" /> : <ArrowDownRight className="h-3 w-3 text-emerald-500" />}
          Favorable
        </span>
        <span className="flex items-center gap-1">
          <ArrowDownRight className="h-3 w-3 text-rose-500" /> Adverse (stop)
        </span>
      </div>
    </div>
  )
}

function LadderLabel({
  x,
  align,
  color,
  children,
}: {
  x: number
  align: 'left' | 'center' | 'right'
  color: string
  children: React.ReactNode
}) {
  const offset =
    align === 'left' ? 'translateX(4px)' : align === 'right' ? 'translateX(-100%) translateX(-4px)' : 'translateX(-50%)'
  return (
    <div
      className={`absolute top-2 text-[10px] font-medium tnum ${color}`}
      style={{ left: `${x}%`, transform: offset }}
    >
      {children}
    </div>
  )
}
