'use client'

import * as React from 'react'
import { cn } from '@/lib/utils'

export type MonthCell = {
  month: string // yyyy-mm
  totalR: number
  pnl: number
  trades: number
  winRate: number
}

export function MonthlyHeatmap({ data }: { data: MonthCell[] }) {
  if (!data.length) return <p className="py-8 text-center text-sm text-muted-foreground">No data</p>

  const maxAbs = Math.max(...data.map((d) => Math.abs(d.totalR)), 1)

  return (
    <div className="space-y-2">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {data.map((m) => {
          const intensity = Math.abs(m.totalR) / maxAbs
          const positive = m.totalR >= 0
          const bg = positive
            ? `oklch(0.68 0.15 162 / ${0.1 + intensity * 0.5})`
            : `oklch(0.62 0.21 16 / ${0.1 + intensity * 0.5})`
          const [y, mo] = m.month.split('-')
          const monthName = new Date(Number(y), Number(mo) - 1, 1).toLocaleDateString('en-US', {
            month: 'short',
            year: '2-digit',
          })
          return (
            <div
              key={m.month}
              className="relative overflow-hidden rounded-lg border border-border/60 p-3"
              style={{ background: bg }}
            >
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-wide text-foreground/80">
                  {monthName}
                </span>
                <span
                  className={cn(
                    'text-sm font-bold tnum',
                    positive ? 'text-emerald-600 dark:text-emerald-300' : 'text-rose-600 dark:text-rose-300'
                  )}
                >
                  {m.totalR > 0 ? '+' : ''}
                  {m.totalR.toFixed(1)}R
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
                <span>{m.trades} trades</span>
                <span className="tnum font-medium">{(m.winRate * 100).toFixed(0)}% WR</span>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
