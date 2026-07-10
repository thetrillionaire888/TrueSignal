'use client'

import * as React from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ChartCard } from '@/components/charts/chart-card'
import { KpiCard } from '@/components/kpi-card'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  collectorFetch,
  useCollectorSocket,
  type SessionInfo,
  type ResolvedChannel,
  type IngestProgress,
  type EvalProgress,
} from '@/lib/collector-client'
import { fmtDateTime, fmtInt } from '@/lib/format'
import { cn } from '@/lib/utils'
import {
  Phone,
  ShieldCheck,
  KeyRound,
  Lock,
  LogOut,
  Search,
  Download,
  CheckCircle2,
  AlertCircle,
  Loader2,
  Radio,
  MessageSquare,
  ListChecks,
  RefreshCw,
  Database,
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Target,
  Play,
  Pause,
  Square,
} from 'lucide-react'

export function IngestView() {
  const qc = useQueryClient()
  const [progress, setProgress] = React.useState<IngestProgress | null>(null)
  const [evalProgress, setEvalProgress] = React.useState<EvalProgress | null>(null)
  useCollectorSocket(
    (p) => {
      setProgress(p)
      if (p.phase === 'complete') {
        qc.invalidateQueries({ queryKey: ['ingest-recent'] })
        qc.invalidateQueries({ queryKey: ['eval-stats'] })
        // Invalidate the main app's channels + overview queries so the
        // Channels view and Overview dashboard pick up the new data.
        qc.invalidateQueries({ queryKey: ['channels'] })
        qc.invalidateQueries({ queryKey: ['overview'] })
      }
    },
    (p) => {
      setEvalProgress(p)
      if (p.phase === 'complete') {
        qc.invalidateQueries({ queryKey: ['eval-stats'] })
        qc.invalidateQueries({ queryKey: ['overview'] })
        qc.invalidateQueries({ queryKey: ['analytics'] })
      }
    }
  )

  const statusQuery = useQuery<SessionInfo>({
    queryKey: ['collector-status'],
    queryFn: () => collectorFetch<SessionInfo>('/api/status'),
    refetchInterval: (q) => {
      const s = q.state.data
      // poll while not in a terminal auth state
      if (s && (s.state === 'authenticated' || s.state === 'disconnected')) return false
      return 3000
    },
  })

  const info = statusQuery.data

  return (
    <div className="space-y-5">
      {/* Status banner */}
      <div
        className={cn(
          'flex flex-wrap items-center gap-3 rounded-xl border p-4',
          info?.state === 'authenticated'
            ? 'border-emerald-500/30 bg-emerald-500/5'
            : info?.state === 'error'
              ? 'border-rose-500/30 bg-rose-500/5'
              : 'border-border/70 bg-card'
        )}
      >
        <div
          className={cn(
            'flex h-10 w-10 items-center justify-center rounded-lg',
            info?.state === 'authenticated'
              ? 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400'
              : 'bg-muted text-muted-foreground'
          )}
        >
          {info?.state === 'authenticated' ? (
            <ShieldCheck className="h-5 w-5" />
          ) : info?.state === 'error' ? (
            <AlertCircle className="h-5 w-5 text-rose-500" />
          ) : (
            <Radio className="h-5 w-5 animate-pulse" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold">Telegram MTProto Collector</span>
            <StateBadge state={info?.state ?? 'disconnected'} />
          </div>
          <p className="text-xs text-muted-foreground">
            {info?.me
              ? `Authenticated as ${info.me.firstName} ${info.me.lastName} (${info.me.phone || info.me.username || info.me.id})`
              : info?.state === 'connected'
                ? 'Connected to Telegram. Awaiting authentication.'
                : info?.state === 'error'
                  ? info.error
                  : 'teleproto MTProto client · full audit access to channels, groups & supergroups'}
          </p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => statusQuery.refetch()} className="gap-1.5">
          <RefreshCw className={cn('h-3.5 w-3.5', statusQuery.isFetching && 'animate-spin')} />
          Refresh
        </Button>
      </div>

      {/* Auth wizard OR ingestion panel */}
      {info?.state !== 'authenticated' ? (
        <AuthWizard info={info} onMutate={() => statusQuery.refetch()} />
      ) : (
        <IngestionPanel
          progress={progress}
          onClearProgress={() => setProgress(null)}
          evalProgress={evalProgress}
          onClearEvalProgress={() => setEvalProgress(null)}
        />
      )}
    </div>
  )
}

function StateBadge({ state }: { state: string }) {
  const map: Record<string, { label: string; cls: string }> = {
    authenticated: { label: 'Authenticated', cls: 'bg-emerald-500/15 text-emerald-600 dark:text-emerald-400' },
    connected: { label: 'Connected', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
    code_sent: { label: 'Code sent', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
    awaiting_2fa: { label: '2FA needed', cls: 'bg-amber-500/15 text-amber-600 dark:text-amber-400' },
    disconnected: { label: 'Disconnected', cls: 'bg-slate-500/15 text-slate-500' },
    error: { label: 'Error', cls: 'bg-rose-500/15 text-rose-600 dark:text-rose-400' },
  }
  const m = map[state] ?? map.disconnected
  return <span className={cn('rounded-md px-2 py-0.5 text-[11px] font-semibold', m.cls)}>{m.label}</span>
}

// ── Auth wizard ─────────────────────────────────────────────────────────────

function AuthWizard({ info, onMutate }: { info: SessionInfo | undefined; onMutate: () => void }) {
  const [phone, setPhone] = React.useState('')
  const [code, setCode] = React.useState('')
  const [password, setPassword] = React.useState('')
  const [error, setError] = React.useState<string | null>(null)

  const connectMut = useMutation({
    mutationFn: () => collectorFetch<SessionInfo>('/api/connect', { method: 'POST', json: {} }),
    onSuccess: onMutate,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  })

  const codeMut = useMutation({
    mutationFn: (p: string) =>
      collectorFetch<SessionInfo>('/api/auth/request-code', { method: 'POST', json: { phone: p } }),
    onSuccess: onMutate,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  })

  const signInMut = useMutation({
    mutationFn: (c: string) =>
      collectorFetch<SessionInfo>('/api/auth/submit-code', { method: 'POST', json: { code: c } }),
    onSuccess: onMutate,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  })

  const twoFaMut = useMutation({
    mutationFn: (pw: string) =>
      collectorFetch<SessionInfo>('/api/auth/submit-2fa', { method: 'POST', json: { password: pw } }),
    onSuccess: onMutate,
    onError: (e) => setError(e instanceof Error ? e.message : String(e)),
  })

  const state = info?.state ?? 'disconnected'
  const busy = connectMut.isPending || codeMut.isPending || signInMut.isPending || twoFaMut.isPending

  React.useEffect(() => setError(info?.error ?? null), [info?.error])

  // Step 1: connect
  if (state === 'disconnected' || state === 'error') {
    return (
      <ChartCard title="Step 1 — Connect to Telegram" description="Establish MTProto connection">
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-600 dark:text-rose-400">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}
        <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
          <p className="font-medium text-foreground">Two-layer authentication model</p>
          <p className="mt-1.5">
            <span className="font-medium text-foreground">App credentials</span> (API ID + API Hash) — loaded from
            <code className="mx-1 rounded bg-muted px-1 py-0.5 font-mono text-[10px]">.env</code>
            identify <em>which application</em> is calling Telegram's MTProto API. Required for every MTProto client (teleproto, Telethon, etc.). Not user login.
          </p>
          <p className="mt-1.5">
            <span className="font-medium text-foreground">User credentials</span> (phone + verification code + optional 2FA) —
            entered in Step 2 below — prove <em>which user account</em> is authorizing the app. This is the same login
            you use in the Telegram app.
          </p>
          <p className="mt-1.5">
            Both layers are required: the app credentials are already configured server-side. Click connect to reach
            Telegram's data centers, then proceed to phone authentication.
          </p>
        </div>
        <Button className="mt-4 gap-2" onClick={() => connectMut.mutate()} disabled={busy}>
          {connectMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Radio className="h-4 w-4" />}
          Connect to Telegram
        </Button>
      </ChartCard>
    )
  }

  // Step 2: phone + code
  if (state === 'connected' || state === 'code_sent') {
    return (
      <ChartCard title="Step 2 — Phone Authentication" description="Enter your Telegram account phone number to receive a login code">
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-600 dark:text-rose-400">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}
        <div className="space-y-3">
          <div>
            <Label className="mb-1.5 block text-xs">Phone number (international format)</Label>
            <div className="relative">
              <Phone className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="+1 555 123 4567"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                disabled={state === 'code_sent'}
              />
            </div>
          </div>
          {state === 'connected' && (
            <Button
              className="gap-2"
              onClick={() => codeMut.mutate(phone)}
              disabled={busy || !phone.trim()}
            >
              {codeMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Send login code
            </Button>
          )}
          {state === 'code_sent' && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-700 dark:text-amber-400">
              <CheckCircle2 className="mr-1.5 inline h-3.5 w-3.5" />
              Code sent to your Telegram app. Enter it below.
            </div>
          )}
          {state === 'code_sent' && (
            <div>
              <Label className="mb-1.5 block text-xs">Verification code</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <KeyRound className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9 tnum"
                    placeholder="12345"
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && code.length >= 4) signInMut.mutate(code)
                    }}
                  />
                </div>
                <Button onClick={() => signInMut.mutate(code)} disabled={busy || code.length < 4}>
                  {signInMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ArrowRight className="h-4 w-4" />}
                  Verify
                </Button>
              </div>
            </div>
          )}
        </div>
      </ChartCard>
    )
  }

  // Step 3: 2FA
  if (state === 'awaiting_2fa') {
    return (
      <ChartCard title="Step 3 — Two-Factor Authentication" description="Your account has 2FA enabled. Enter your cloud password.">
        {error && (
          <div className="mb-3 flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-600 dark:text-rose-400">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
            <span className="break-words">{error}</span>
          </div>
        )}
        <div>
          <Label className="mb-1.5 block text-xs">Cloud password</Label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Lock className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="password"
                className="pl-9"
                placeholder="••••••••"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && password) twoFaMut.mutate(password)
                }}
              />
            </div>
            <Button onClick={() => twoFaMut.mutate(password)} disabled={busy || !password}>
              {twoFaMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />}
              Unlock
            </Button>
          </div>
        </div>
      </ChartCard>
    )
  }

  return null
}

// ── Ingestion panel ──────────────────────────────────────────────────────────

function IngestionPanel({
  progress,
  onClearProgress,
  evalProgress,
  onClearEvalProgress,
}: {
  progress: IngestProgress | null
  onClearProgress: () => void
  evalProgress: EvalProgress | null
  onClearEvalProgress: () => void
}) {
  const qc = useQueryClient()
  const [query, setQuery] = React.useState('🚀 CallistoFx Premium Channel 🚀')
  const [limit, setLimit] = React.useState(200)
  const [resolved, setResolved] = React.useState<ResolvedChannel | null>(null)
  const [resolveError, setResolveError] = React.useState<string | null>(null)
  // Page state for the paginated recent-messages list
  const [msgPage, setMsgPage] = React.useState(1)
  const [msgPageSize, setMsgPageSize] = React.useState(20)

  const resolveMut = useMutation({
    mutationFn: (q: string) =>
      collectorFetch<{ channel: ResolvedChannel }>('/api/resolve-channel', { method: 'POST', json: { query: q } }),
    onSuccess: (d) => {
      setResolved(d.channel)
      setResolveError(null)
      // Invalidate the main app's channels query so the Channels view
      // picks up the updated subscriber count on next visit.
      qc.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: (e) => {
      setResolved(null)
      setResolveError(e instanceof Error ? e.message : String(e))
    },
  })

  const ingestMut = useMutation({
    mutationFn: (vars: { q: string; lim: number }) =>
      collectorFetch<{ jobId: string }>('/api/ingest', { method: 'POST', json: { query: vars.q, limit: vars.lim } }),
    onSuccess: () => {
      setMsgPage(1) // reset to first page on new ingestion
      qc.invalidateQueries({ queryKey: ['channels'] })
    },
    onError: (e) => setResolveError(e instanceof Error ? e.message : String(e)),
  })

  // ── Single source of truth for "is ingestion live": progress.phase ───────
  // No separate boolean state — derived directly from the socket event stream.
  // The HTTP /api/ingest call returns instantly; the socket events drive the UI.
  const isLive = !!progress && !['complete', 'error'].includes(progress.phase)
  const ingesting = isLive || ingestMut.isPending

  // Reset to page 1 when a new channel is ingested
  React.useEffect(() => {
    setMsgPage(1)
  }, [progress?.channelId])

  const recentQuery = useQuery({
    queryKey: ['ingest-recent', progress?.channelId, msgPage, msgPageSize],
    queryFn: async () => {
      if (!progress?.channelId) return null
      return collectorFetch<{
        stats: { messages: number; signals: number }
        recent: Array<{
          id: string
          telegramMessageId: number
          rawText: string
          senderName: string | null
          postedAt: string
          parseStatus: string
          hasMedia: number
        }>
        page: number
        pageSize: number
        total: number
        totalPages: number
      }>(`/api/channel-stats/${progress.channelId}?page=${msgPage}&pageSize=${msgPageSize}`)
    },
    enabled: !!progress?.channelId,
  })

  return (
    <div className="space-y-5">
      <div className="grid gap-5 lg:grid-cols-3">
        {/* Resolve + ingest */}
        <ChartCard
          className="lg:col-span-2"
          title="Channel Ingestion"
          description="Resolve a channel by @username or title, then fetch its message history via MTProto."
          actions={
            <LogoutButton
              onLogout={async () => {
                await collectorFetch('/api/auth/logout', { method: 'POST', json: {} })
                qc.invalidateQueries({ queryKey: ['collector-status'] })
                setResolved(null)
                setProgress(null)
              }}
            />
          }
        >
          <div className="space-y-3">
            <div>
              <Label className="mb-1.5 block text-xs">Channel (@username, title, or Peer ID)</Label>
              <div className="flex gap-2">
                <div className="relative flex-1">
                  <Search className="absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    className="pl-9"
                    placeholder="@username, channel title, or Peer ID (e.g. 2166348331)…"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    disabled={ingesting}
                  />
                </div>
                <Button
                  variant="outline"
                  onClick={() => resolveMut.mutate(query)}
                  disabled={ingesting || !query.trim() || resolveMut.isPending}
                  className="gap-1.5"
                >
                  {resolveMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                  Resolve
                </Button>
              </div>
            </div>

            {resolveError && (
              <div className="flex items-start gap-2 rounded-lg border border-rose-500/30 bg-rose-500/5 p-3 text-xs text-rose-600 dark:text-rose-400">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <span className="break-words">{resolveError}</span>
              </div>
            )}

            {resolved && (
              <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-3">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold">{resolved.title}</span>
                      {resolved.verified && <ShieldCheck className="h-3.5 w-3.5 text-primary" />}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {resolved.username ? `@${resolved.username} · ` : ''}
                      {resolved.type} · {fmtInt(resolved.participantCount)} members
                    </div>
                  </div>
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                </div>
              </div>
            )}

            <div>
              <div className="mb-1.5 flex items-center justify-between">
                <Label className="text-xs">Message limit</Label>
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={limit === 0}
                    onChange={(e) => setLimit(e.target.checked ? 0 : 200)}
                    disabled={ingesting}
                    className="accent-primary"
                  />
                  All history
                </label>
              </div>
              {limit !== 0 ? (
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={50}
                    max={10000}
                    step={50}
                    value={limit}
                    onChange={(e) => setLimit(Number(e.target.value))}
                    disabled={ingesting}
                    className="flex-1 accent-primary"
                  />
                  <span className="w-20 text-right text-sm font-semibold tnum">{fmtInt(limit)}</span>
                </div>
              ) : (
                <div className="rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-primary">
                  Fetching <strong>all available history</strong> from the channel's establishment to now. This may take several minutes for large channels.
                </div>
              )}
            </div>

            <Button
              className="w-full gap-2"
              disabled={!resolved || ingesting}
              onClick={() => {
                onClearProgress()
                ingestMut.mutate({ q: query, lim: limit })
              }}
            >
              {ingesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Download className="h-4 w-4" />}
              {ingesting ? 'Ingesting…' : limit === 0 ? 'Ingest all messages' : `Ingest ${fmtInt(limit)} messages`}
            </Button>
          </div>
        </ChartCard>

        {/* Live progress */}
        <ChartCard title="Live Progress" description="Real-time MTProto ingestion feed">
          {!progress ? (
            <div className="flex h-full min-h-[200px] flex-col items-center justify-center text-center text-sm text-muted-foreground">
              <Radio className="mb-2 h-8 w-8 opacity-30" />
              No active ingestion.
              <span className="mt-1 text-xs">Resolve a channel and start ingesting to see live updates.</span>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                {progress.phase === 'complete' ? (
                  <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                ) : progress.phase === 'error' ? (
                  <AlertCircle className="h-5 w-5 text-rose-500" />
                ) : progress.paused ? (
                  <Pause className="h-5 w-5 text-amber-500" />
                ) : (
                  <Loader2 className="h-5 w-5 animate-spin text-primary" />
                )}
                <span className="text-sm font-medium capitalize">
                  {progress.paused ? 'Paused' : (progress.phase ?? 'progress').replace('_', ' ')}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">{progress.message}</p>
              {(progress.fetched != null || progress.inserted != null) && (
                <div className="space-y-1.5">
                  <div className="flex items-center justify-between text-xs">
                    <span className="text-muted-foreground">Progress</span>
                    <span className="tnum font-medium">
                      {progress.fetched ?? progress.inserted}
                      {progress.limit && progress.limit > 0 ? ` / ${progress.limit}` : ' messages'}
                    </span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-muted">
                    {progress.limit && progress.limit > 0 ? (
                      <div
                        className="h-full rounded-full bg-primary transition-all"
                        style={{
                          width: `${Math.min(100, ((progress.fetched ?? progress.inserted ?? 0) / progress.limit) * 100)}%`,
                        }}
                      />
                    ) : (
                      <div className="h-full w-full animate-pulse rounded-full bg-primary/40" />
                    )}
                  </div>
                </div>
              )}
              {progress.signals != null && (
                <div className="grid grid-cols-2 gap-2 text-center text-xs">
                  <div className="rounded-lg bg-muted/50 py-1.5">
                    <div className="tnum text-sm font-bold">{progress.fetched ?? progress.inserted ?? 0}</div>
                    <div className="text-[10px] uppercase text-muted-foreground">Messages</div>
                  </div>
                  <div className="rounded-lg bg-emerald-500/10 py-1.5">
                    <div className="tnum text-sm font-bold text-emerald-600 dark:text-emerald-400">{progress.signals}</div>
                    <div className="text-[10px] uppercase text-muted-foreground">Signals</div>
                  </div>
                </div>
              )}
              {/* Pause / Resume / Stop controls — shown while ingestion is active */}
              {isLive && (
                <div className="flex items-center gap-2 border-t border-border/60 pt-3">
                  {progress.paused ? (
                    <Button
                      variant="default"
                      size="sm"
                      className="gap-1.5 flex-1"
                      onClick={() => collectorFetch('/api/ingest/resume', { method: 'POST', json: {} })}
                    >
                      <Play className="h-3.5 w-3.5" />
                      Resume
                    </Button>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      className="gap-1.5 flex-1"
                      onClick={() => collectorFetch('/api/ingest/pause', { method: 'POST', json: {} })}
                    >
                      <Pause className="h-3.5 w-3.5" />
                      Pause
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5 flex-1 border-rose-500/30 text-rose-600 hover:bg-rose-500/10 dark:text-rose-400"
                    onClick={() => collectorFetch('/api/ingest/stop', { method: 'POST', json: {} })}
                  >
                    <Square className="h-3.5 w-3.5" />
                    Stop
                  </Button>
                </div>
              )}
              {progress.phase === 'complete' && (
                <div className={cn(
                  'rounded-lg border p-3 text-xs',
                  progress.stopped
                    ? 'border-amber-500/30 bg-amber-500/5'
                    : 'border-emerald-500/30 bg-emerald-500/5'
                )}>
                  <div className={cn(
                    'flex items-center gap-1.5 font-medium',
                    progress.stopped
                      ? 'text-amber-700 dark:text-amber-400'
                      : 'text-emerald-700 dark:text-emerald-400'
                  )}>
                    {progress.stopped ? <Square className="h-3.5 w-3.5" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                    {progress.stopped ? 'Ingestion stopped' : 'Ingestion complete'}
                  </div>
                  <div className="mt-1.5 space-y-0.5 text-muted-foreground">
                    <div>Inserted: {progress.inserted} messages</div>
                    <div>Signals detected: {progress.signalsParsed}</div>
                    <div>Channel total: {progress.totalMessages} messages · {progress.totalSignals} signals</div>
                    {progress.stopped && progress.canResume && (
                      <div className="mt-2 border-t border-amber-500/20 pt-2 text-amber-600 dark:text-amber-400">
                        Position saved. Click "Ingest all messages" again to resume from where you left off.
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          )}
        </ChartCard>
      </div>

      {/* Recent ingested messages — paginated */}
      {progress?.channelId && (
        <ChartCard
          title="Ingested Messages"
          description="Raw messages written to SQLite with full JSON metadata"
          actions={
            <div className="flex items-center gap-2">
              <Select
                value={String(msgPageSize)}
                onValueChange={(v) => {
                  setMsgPageSize(Number(v))
                  setMsgPage(1)
                }}
              >
                <SelectTrigger className="h-7 w-[88px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {[20, 50, 100].map((n) => (
                    <SelectItem key={n} value={String(n)}>
                      {n} / page
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button variant="ghost" size="sm" onClick={() => recentQuery.refetch()} className="gap-1.5">
                <RefreshCw className={cn('h-3.5 w-3.5', recentQuery.isFetching && 'animate-spin')} />
                Refresh
              </Button>
            </div>
          }
        >
          {recentQuery.isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-muted" />
              ))}
            </div>
          ) : recentQuery.data?.recent?.length ? (
            <>
              <div className="max-h-[28rem] space-y-1.5 overflow-y-auto scroll-thin">
                {recentQuery.data.recent.map((m) => (
                  <MessageRow key={m.id} msg={m} />
                ))}
              </div>
              {/* Pagination footer */}
              <div className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-border/60 pt-3 text-xs text-muted-foreground">
                <span>
                  {recentQuery.data.total > 0
                    ? `Showing ${(recentQuery.data.page - 1) * recentQuery.data.pageSize + 1}–${Math.min(recentQuery.data.page * recentQuery.data.pageSize, recentQuery.data.total)} of ${fmtInt(recentQuery.data.total)} messages`
                    : 'No messages'}
                </span>
                <div className="flex items-center gap-1.5">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={recentQuery.data.page <= 1}
                    onClick={() => setMsgPage((p) => Math.max(1, p - 1))}
                    className="h-7 gap-1"
                  >
                    <ChevronLeft className="h-3.5 w-3.5" />
                    Prev
                  </Button>
                  <span className="tnum">
                    {recentQuery.data.page} / {recentQuery.data.totalPages}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={recentQuery.data.page >= recentQuery.data.totalPages}
                    onClick={() => setMsgPage((p) => p + 1)}
                    className="h-7 gap-1"
                  >
                    Next
                    <ChevronRight className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            </>
          ) : (
            <p className="py-6 text-center text-sm text-muted-foreground">No messages yet.</p>
          )}
        </ChartCard>
      )}

      {/* DB summary */}
      {recentQuery.data && (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <KpiCard label="Total Messages" value={fmtInt(recentQuery.data.stats.messages)} icon={MessageSquare} tone="muted" />
          <KpiCard label="Parsed Signals" value={fmtInt(recentQuery.data.stats.signals)} icon={ListChecks} tone="primary" />
          <KpiCard
            label="Storage"
            value="SQLite"
            sub="shared audit DB"
            icon={Database}
            tone="muted"
          />
          <KpiCard label="Source" value="MTProto" sub="teleproto v1.227" icon={Radio} tone="muted" />
        </div>
      )}

      {/* ── Signal Evaluation Panel ─────────────────────────────────────────── */}
      <EvaluationPanel
        evalProgress={evalProgress}
        channelId={progress?.channelId ?? null}
      />
    </div>
  )
}

// ── Evaluation Panel ──────────────────────────────────────────────────────────

function EvaluationPanel({
  evalProgress,
  channelId,
}: {
  evalProgress: EvalProgress | null
  channelId: string | null
}) {
  const qc = useQueryClient()
  const [evaluating, setEvaluating] = React.useState(false)

  const evalStatsQuery = useQuery({
    queryKey: ['eval-stats', channelId],
    queryFn: async () => {
      const params = channelId ? `?channelId=${channelId}` : ''
      return collectorFetch<{ total: number; evaluated: number; pending: number }>(`/api/eval-stats${params}`)
    },
    refetchInterval: evaluating ? 2000 : false,
  })

  React.useEffect(() => {
    if (evalProgress?.phase === 'complete' || evalProgress?.phase === 'error') {
      setEvaluating(false)
    }
  }, [evalProgress?.phase])

  const stats = evalStatsQuery.data
  const evalLive = evaluating || (evalProgress && !['complete', 'error'].includes(evalProgress.phase))
  const summary = evalProgress?.summary

  return (
    <ChartCard
      title="Signal Evaluation — Dukascopy Historical Data"
      description="Evaluate parsed signals against real market price data from Dukascopy (m15 bars). Determines win/loss, R-multiple, MFE/MAE."
      actions={
        <div className="flex items-center gap-2">
          {stats && (
            <span className="text-xs text-muted-foreground">
              <span className="tnum font-semibold text-foreground">{stats.evaluated}</span>
              {' / '}
              <span className="tnum">{stats.total}</span> evaluated
            </span>
          )}
        </div>
      }
    >
      <div className="space-y-4">
        {/* Explanation */}
        <div className="rounded-lg border border-border/60 bg-muted/30 p-3 text-xs leading-relaxed text-muted-foreground">
          <p>
            <span className="font-medium text-foreground">How it works:</span> For each parsed signal, the evaluator
            fetches 48 hours of 15-minute OHLC bars from Dukascopy starting at the signal's post time. It walks
            through each bar to determine whether the <span className="text-rose-500">Stop Loss</span> or{' '}
            <span className="text-emerald-500">Take Profit</span> was hit first, then computes the R-multiple,
            maximum favorable/adverse excursion, and hold duration.
          </p>
          <p className="mt-1.5">
            <span className="font-medium text-foreground">Data source:</span>{' '}
            <a href="https://github.com/Leo4815162342/dukascopy-node" target="_blank" rel="noreferrer" className="text-primary hover:underline">
              dukascopy-node
            </a>{' '}
            · Spot gold (XAUUSD), forex, crypto, indices · 15-minute bid bars
          </p>
        </div>

        {/* Scope + trigger */}
        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-2 text-xs">
            <span className="text-muted-foreground">Scope:</span>
            <span className="rounded-md border border-border bg-muted/50 px-2 py-1 font-medium">
              {channelId ? 'Current channel' : 'All channels'}
            </span>
          </div>
          {stats && stats.pending > 0 && (
            <span className="rounded-md bg-amber-500/10 px-2 py-1 text-xs font-medium text-amber-600 dark:text-amber-400">
              {stats.pending} signal{stats.pending !== 1 ? 's' : ''} pending evaluation
            </span>
          )}
          <Button
            onClick={() => {
              setEvaluating(true)
              collectorFetch('/api/evaluate', {
                method: 'POST',
                json: channelId ? { channelId } : {},
              })
            }}
            disabled={evalLive || (stats?.pending === 0 && !evalProgress)}
            className="gap-2"
          >
            {evalLive ? <Loader2 className="h-4 w-4 animate-spin" /> : <Target className="h-4 w-4" />}
            {evalLive ? 'Evaluating…' : `Evaluate ${stats?.pending ?? 0} signals`}
          </Button>
        </div>

        {/* Live progress */}
        {evalProgress && (
          <div className="rounded-lg border border-border/60 bg-card p-4">
            <div className="flex items-center gap-2">
              {evalProgress.phase === 'complete' ? (
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
              ) : evalProgress.phase === 'error' ? (
                <AlertCircle className="h-5 w-5 text-rose-500" />
              ) : (
                <Loader2 className="h-5 w-5 animate-spin text-primary" />
              )}
              <span className="text-sm font-medium capitalize">{evalProgress.phase}</span>
              {evalProgress.instrument && (
                <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                  {evalProgress.instrument}
                </span>
              )}
            </div>
            <p className="mt-1.5 text-xs text-muted-foreground">{evalProgress.message}</p>

            {/* Progress bar */}
            {evalProgress.total != null && evalProgress.current != null && evalProgress.phase !== 'complete' && (
              <div className="mt-3 space-y-1.5">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-muted-foreground">Progress</span>
                  <span className="tnum font-medium">
                    {evalProgress.current} / {evalProgress.total}
                  </span>
                </div>
                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full bg-primary transition-all"
                    style={{
                      width: `${Math.min(100, (evalProgress.current / Math.max(1, evalProgress.total)) * 100)}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {/* Summary on complete */}
            {summary && evalProgress.phase === 'complete' && (
              <div className="mt-3 space-y-3">
                <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
                  <SummaryStat label="Wins" value={summary.wins} tone="positive" />
                  <SummaryStat label="Losses" value={summary.losses} tone="negative" />
                  <SummaryStat label="B/E" value={summary.breakeven} tone="neutral" />
                  <SummaryStat label="Invalid" value={summary.invalid} tone="muted" />
                  <SummaryStat label="No Data" value={summary.noData} tone="muted" />
                  <SummaryStat label="Win Rate" value={`${(summary.winRate * 100).toFixed(0)}%`} tone="primary" />
                </div>
                <div className="flex items-center justify-between rounded-lg bg-muted/40 px-3 py-2">
                  <span className="text-xs text-muted-foreground">Total R (realized)</span>
                  <span
                    className={cn(
                      'text-lg font-bold tnum',
                      summary.totalR >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'
                    )}
                  >
                    {summary.totalR > 0 ? '+' : ''}{summary.totalR.toFixed(2)}R
                  </span>
                </div>
                {(summary.barsCached != null || summary.barsFetched != null) && (
                  <div className="flex items-center justify-between rounded-lg bg-muted/20 px-3 py-2 text-xs">
                    <span className="flex items-center gap-1.5 text-muted-foreground">
                      <Database className="h-3.5 w-3.5" />
                      Dukascopy bars
                    </span>
                    <span className="tnum font-medium">
                      <span className="text-emerald-600 dark:text-emerald-400">{summary.barsCached ?? 0}</span>
                      <span className="text-muted-foreground"> cached / </span>
                      <span className="text-amber-600 dark:text-amber-400">{summary.barsFetched ?? 0}</span>
                      <span className="text-muted-foreground"> fetched</span>
                    </span>
                  </div>
                )}

                {/* Per-signal results */}
                {evalProgress.results && evalProgress.results.length > 0 && (
                  <div className="max-h-48 overflow-y-auto scroll-thin rounded-lg border border-border/40">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 bg-muted/60 text-left text-[10px] uppercase tracking-wider text-muted-foreground">
                        <tr>
                          <th className="px-3 py-1.5 font-medium">Instrument</th>
                          <th className="px-3 py-1.5 font-medium">Outcome</th>
                          <th className="px-3 py-1.5 text-right font-medium">R</th>
                        </tr>
                      </thead>
                      <tbody>
                        {evalProgress.results.map((r) => (
                          <tr key={r.signalId} className="border-t border-border/30">
                            <td className="px-3 py-1.5 font-medium">{r.instrument}</td>
                            <td className="px-3 py-1.5">
                              <span
                                className={cn(
                                  'rounded px-1.5 py-0.5 text-[10px] font-semibold',
                                  r.outcome === 'win'
                                    ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
                                    : r.outcome === 'loss'
                                      ? 'bg-rose-500/12 text-rose-600 dark:text-rose-400'
                                      : r.outcome === 'breakeven'
                                        ? 'bg-amber-500/12 text-amber-600 dark:text-amber-400'
                                        : 'bg-muted text-muted-foreground'
                                )}
                              >
                                {r.outcome}
                              </span>
                            </td>
                            <td
                              className={cn(
                                'px-3 py-1.5 text-right tnum font-semibold',
                                r.rMultiple > 0
                                  ? 'text-emerald-600 dark:text-emerald-400'
                                  : r.rMultiple < 0
                                    ? 'text-rose-600 dark:text-rose-400'
                                    : 'text-muted-foreground'
                              )}
                            >
                              {r.rMultiple > 0 ? '+' : ''}{r.rMultiple.toFixed(2)}R
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Hint when no progress yet */}
        {!evalProgress && stats && stats.pending > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-border/40 bg-muted/20 p-3 text-xs text-muted-foreground">
            <Target className="h-4 w-4 text-primary" />
            Click "Evaluate" to fetch historical price data from Dukascopy and determine win/loss outcomes for{' '}
            {stats.pending} parsed signal{stats.pending !== 1 ? 's' : ''}.
          </div>
        )}
        {!evalProgress && stats && stats.pending === 0 && stats.evaluated > 0 && (
          <div className="flex items-center gap-2 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3 text-xs text-emerald-700 dark:text-emerald-400">
            <CheckCircle2 className="h-4 w-4" />
            All {stats.evaluated} signals have been evaluated. Results are visible in the Overview, Signals, and Analytics views.
          </div>
        )}
      </div>
    </ChartCard>
  )
}

function SummaryStat({
  label,
  value,
  tone,
}: {
  label: string
  value: string | number
  tone: 'positive' | 'negative' | 'neutral' | 'muted' | 'primary'
}) {
  const toneCls = {
    positive: 'text-emerald-600 dark:text-emerald-400',
    negative: 'text-rose-600 dark:text-rose-400',
    neutral: 'text-amber-600 dark:text-amber-400',
    muted: 'text-muted-foreground',
    primary: 'text-primary',
  }[tone]
  return (
    <div className="rounded-lg bg-muted/40 px-2 py-1.5 text-center">
      <div className={cn('text-sm font-bold tnum', toneCls)}>{value}</div>
      <div className="text-[9px] uppercase tracking-wider text-muted-foreground">{label}</div>
    </div>
  )
}

function MessageRow({
  msg,
}: {
  msg: {
    id: string
    telegramMessageId: number
    rawText: string
    senderName: string | null
    postedAt: string
    parseStatus: string
    hasMedia: number
  }
}) {
  const [expanded, setExpanded] = React.useState(false)
  const isSignal = msg.parseStatus === 'parsed'
  const statusCls = isSignal
    ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400'
    : msg.parseStatus === 'no_signal'
      ? 'bg-muted text-muted-foreground'
      : 'bg-amber-500/12 text-amber-600 dark:text-amber-400'
  return (
    <button
      onClick={() => setExpanded((e) => !e)}
      className="w-full rounded-lg border border-border/50 bg-muted/20 px-3 py-2 text-left transition-colors hover:border-primary/40"
    >
      <div className="flex items-center gap-2">
        <span className={cn('rounded px-1.5 py-0.5 text-[10px] font-medium uppercase', statusCls)}>
          {msg.parseStatus.replace('_', ' ')}
        </span>
        {msg.hasMedia ? <MessageSquare className="h-3 w-3 text-muted-foreground" /> : null}
        <span className="text-xs font-medium text-muted-foreground">#{msg.telegramMessageId}</span>
        {msg.senderName && <span className="truncate text-xs text-muted-foreground">· {msg.senderName}</span>}
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">{fmtDateTime(msg.postedAt)}</span>
      </div>
      <p className={cn('mt-1 text-xs', expanded ? 'whitespace-pre-wrap break-words' : 'truncate')}>
        {msg.rawText || <span className="italic text-muted-foreground">(no text — media only)</span>}
      </p>
    </button>
  )
}

function LogoutButton({ onLogout }: { onLogout: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onLogout} className="gap-1.5 text-muted-foreground">
      <LogOut className="h-3.5 w-3.5" />
      Logout
    </Button>
  )
}
