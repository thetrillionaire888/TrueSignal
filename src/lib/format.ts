// Formatting helpers for the analytics dashboard.

export function fmtPct(x: number, dp = 1): string {
  return `${(x * 100).toFixed(dp)}%`
}

export function fmtNum(x: number, dp = 2): string {
  return x.toLocaleString('en-US', { maximumFractionDigits: dp, minimumFractionDigits: dp })
}

export function fmtInt(x: number): string {
  return x.toLocaleString('en-US')
}

export function fmtCompact(x: number): string {
  if (Math.abs(x) >= 1_000_000) return `${(x / 1_000_000).toFixed(1)}M`
  if (Math.abs(x) >= 1_000) return `${(x / 1_000).toFixed(1)}K`
  return x.toFixed(0)
}

export function fmtR(x: number): string {
  const sign = x > 0 ? '+' : ''
  return `${sign}${x.toFixed(2)}R`
}

export function fmtSigned(x: number, dp = 2): string {
  const sign = x > 0 ? '+' : ''
  return `${sign}${x.toFixed(dp)}`
}

export function fmtPrice(p: number | null | undefined): string {
  if (p == null) return '—'
  if (Math.abs(p) < 1) return p.toFixed(4)
  if (Math.abs(p) < 100) return p.toFixed(2)
  return p.toLocaleString('en-US', { maximumFractionDigits: 2 })
}

export function fmtDuration(minutes: number | null | undefined): string {
  if (minutes == null) return '—'
  if (minutes < 60) return `${minutes}m`
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  if (h < 24) return m ? `${h}h ${m}m` : `${h}h`
  const d = Math.floor(h / 24)
  const rh = h % 24
  return rh ? `${d}d ${rh}h` : `${d}d`
}

type DateInput = string | Date | number | null | undefined

function toDate(iso: DateInput): Date | null {
  if (iso == null) return null
  if (typeof iso === 'number') return new Date(iso)
  return typeof iso === 'string' ? new Date(iso) : iso
}

export function fmtDate(iso: DateInput, opts?: Intl.DateTimeFormatOptions): string {
  const d = toDate(iso)
  if (!d) return '—'
  return d.toLocaleDateString('en-US', opts ?? { month: 'short', day: 'numeric' })
}

export function fmtDateTime(iso: DateInput): string {
  const d = toDate(iso)
  if (!d) return '—'
  return d.toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export function timeAgo(iso: DateInput): string {
  const d = toDate(iso)
  if (!d) return '—'
  const diff = Date.now() - d.getTime()
  const min = Math.floor(diff / 60000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const h = Math.floor(min / 60)
  if (h < 24) return `${h}h ago`
  const days = Math.floor(h / 24)
  if (days < 30) return `${days}d ago`
  return fmtDate(d)
}

// Parse the takeProfits JSON string into a number[]
export function parseTPs(tps: string | null | undefined): number[] {
  if (!tps) return []
  try {
    const arr = JSON.parse(tps)
    return Array.isArray(arr) ? arr.map(Number) : []
  } catch {
    // fallback: comma split
    return tps
      .replace(/[\[\]"]/g, '')
      .split(',')
      .map((s) => Number(s.trim()))
      .filter(Boolean)
  }
}

export const CATEGORY_META: Record<string, { label: string; color: string; emoji: string }> = {
  crypto: { label: 'Crypto', color: 'amber', emoji: '₿' },
  forex: { label: 'Forex', color: 'teal', emoji: '€' },
  stocks: { label: 'Stocks', color: 'emerald', emoji: '📈' },
  commodities: { label: 'Commodities', color: 'yellow', emoji: '🥇' },
  index: { label: 'Index', color: 'slate', emoji: '🗺' },
  mixed: { label: 'Mixed', color: 'violet', emoji: '◈' },
}

export const AVATAR_GRADIENTS: Record<string, string> = {
  emerald: 'from-emerald-500 to-teal-600',
  teal: 'from-teal-500 to-cyan-600',
  amber: 'from-amber-500 to-orange-600',
  yellow: 'from-yellow-400 to-amber-600',
  rose: 'from-rose-500 to-pink-600',
  cyan: 'from-cyan-500 to-sky-600',
  violet: 'from-violet-500 to-purple-600',
  fuchsia: 'from-fuchsia-500 to-pink-600',
  slate: 'from-slate-500 to-slate-700',
}
