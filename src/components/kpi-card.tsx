'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'
import { ArrowDownRight, ArrowUpRight } from 'lucide-react'

type Tone = 'positive' | 'negative' | 'neutral' | 'primary' | 'muted'

const toneClasses: Record<Tone, string> = {
  positive: 'text-emerald-600 dark:text-emerald-400',
  negative: 'text-rose-600 dark:text-rose-400',
  neutral: 'text-amber-600 dark:text-amber-400',
  primary: 'text-primary',
  muted: 'text-muted-foreground',
}

export function KpiCard({
  label,
  value,
  sub,
  delta,
  deltaTone = 'neutral',
  icon: Icon,
  tone = 'muted',
  className,
}: {
  label: string
  value: React.ReactNode
  sub?: React.ReactNode
  delta?: string
  deltaTone?: Tone
  icon?: React.ComponentType<{ className?: string }>
  tone?: Tone
  className?: string
}) {
  return (
    <div
      className={cn(
        'group relative overflow-hidden rounded-xl border border-border/70 bg-card p-4 transition-colors hover:border-border',
        className
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            {label}
          </p>
          <p className={cn('mt-1.5 text-2xl font-semibold tnum tracking-tight', toneClasses[tone])}>
            {value}
          </p>
          {sub && <p className="mt-1 text-xs text-muted-foreground">{sub}</p>}
        </div>
        {Icon && (
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted/60 text-muted-foreground">
            <Icon className="h-4.5 w-4.5" />
          </div>
        )}
      </div>
      {delta && (
        <div
          className={cn(
            'mt-3 inline-flex items-center gap-1 text-xs font-medium tnum',
            toneClasses[deltaTone]
          )}
        >
          {deltaTone === 'positive' ? (
            <ArrowUpRight className="h-3.5 w-3.5" />
          ) : deltaTone === 'negative' ? (
            <ArrowDownRight className="h-3.5 w-3.5" />
          ) : null}
          {delta}
        </div>
      )}
    </div>
  )
}
