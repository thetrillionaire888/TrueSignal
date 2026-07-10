'use client'

import { cn } from '@/lib/utils'
import { CheckCircle2, XCircle, MinusCircle, Clock } from 'lucide-react'

export function OutcomeBadge({
  outcome,
  className,
  withIcon = true,
}: {
  outcome: string
  className?: string
  withIcon?: boolean
}) {
  const map: Record<string, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
    win: {
      label: 'Win',
      cls: 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 ring-emerald-500/25',
      Icon: CheckCircle2,
    },
    loss: {
      label: 'Loss',
      cls: 'bg-rose-500/12 text-rose-600 dark:text-rose-400 ring-rose-500/25',
      Icon: XCircle,
    },
    breakeven: {
      label: 'B/E',
      cls: 'bg-amber-500/12 text-amber-600 dark:text-amber-400 ring-amber-500/25',
      Icon: MinusCircle,
    },
    invalid: {
      label: 'Invalid',
      cls: 'bg-slate-500/12 text-slate-500 dark:text-slate-400 ring-slate-500/25',
      Icon: XCircle,
    },
    no_data: {
      label: 'No Data',
      cls: 'bg-slate-500/12 text-slate-500 dark:text-slate-400 ring-slate-500/25',
      Icon: Clock,
    },
    pending: {
      label: 'Pending',
      cls: 'bg-slate-500/12 text-slate-600 dark:text-slate-300 ring-slate-500/25',
      Icon: Clock,
    },
  }
  const m = map[outcome] ?? map.pending
  const { Icon } = m
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold ring-1 ring-inset',
        m.cls,
        className
      )}
    >
      {withIcon && <Icon className="h-3 w-3" />}
      {m.label}
    </span>
  )
}

export function ActionBadge({ action, className }: { action: string; className?: string }) {
  const isLong = action === 'long'
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-bold ring-1 ring-inset',
        isLong
          ? 'bg-emerald-500/12 text-emerald-600 dark:text-emerald-400 ring-emerald-500/25'
          : 'bg-rose-500/12 text-rose-600 dark:text-rose-400 ring-rose-500/25',
        className
      )}
    >
      {isLong ? '▲ LONG' : '▼ SHORT'}
    </span>
  )
}

export function RMultiple({ value, className }: { value: number; className?: string }) {
  const tone =
    value > 0
      ? 'text-emerald-600 dark:text-emerald-400'
      : value < 0
        ? 'text-rose-600 dark:text-rose-400'
        : 'text-muted-foreground'
  return <span className={cn('tnum font-semibold', tone, className)}>{value > 0 ? '+' : ''}{value.toFixed(2)}R</span>
}
