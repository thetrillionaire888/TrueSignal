'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

export function ChartCard({
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
}: {
  title?: string
  description?: string
  actions?: React.ReactNode
  children: React.ReactNode
  className?: string
  bodyClassName?: string
}) {
  return (
    <div className={cn('rounded-xl border border-border/70 bg-card', className)}>
      {(title || actions) && (
        <div className="flex items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
          <div className="min-w-0">
            {title && <h3 className="text-sm font-semibold tracking-tight">{title}</h3>}
            {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
          </div>
          {actions && <div className="shrink-0">{actions}</div>}
        </div>
      )}
      <div className={cn('p-4', bodyClassName)}>{children}</div>
    </div>
  )
}

type TipPayload = Array<{
  name?: string
  value?: number
  color?: string
  dataKey?: string
  payload?: Record<string, unknown>
}>

export function ChartTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean
  payload?: TipPayload
  label?: string
  formatter?: (name: string, value: number, payload?: Record<string, unknown>) => React.ReactNode
}) {
  if (!active || !payload?.length) return null
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md">
      {label && <p className="mb-1 font-medium text-foreground">{label}</p>}
      <div className="space-y-0.5">
        {payload.map((p, i) => (
          <div key={i} className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ background: p.color }} />
            <span className="text-muted-foreground">{p.name}:</span>
            <span className="font-medium tnum text-foreground">
              {formatter ? formatter(p.name ?? '', p.value ?? 0, p.payload) : p.value}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
