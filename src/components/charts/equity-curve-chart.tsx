'use client'

import * as React from 'react'
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ChartTooltip } from './chart-card'
import { fmtDate } from '@/lib/format'

export type EquityPoint = {
  date: string
  cumulativeR: number
  cumulativePnl: number
  drawdown: number
  trades: number
}

export function EquityCurveChart({ data, height = 280 }: { data: EquityPoint[]; height?: number }) {
  const gradId = React.useId()
  const [mode, setMode] = React.useState<'R' | 'pct'>('R')
  const dataKey = mode === 'R' ? 'cumulativeR' : 'cumulativePnl'

  return (
    <div>
      <div className="mb-2 flex items-center justify-end">
        <div className="inline-flex rounded-md border border-border bg-muted/50 p-0.5 text-xs">
          <button
            onClick={() => setMode('R')}
            className={`rounded px-2 py-0.5 font-medium transition-colors ${
              mode === 'R' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
            }`}
          >
            Cumulative R
          </button>
          <button
            onClick={() => setMode('pct')}
            className={`rounded px-2 py-0.5 font-medium transition-colors ${
              mode === 'pct' ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
            }`}
          >
            Account %
          </button>
        </div>
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
          <defs>
            <linearGradient id={`eq-${gradId}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--positive)" stopOpacity={0.32} />
              <stop offset="100%" stopColor="var(--positive)" stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} opacity={0.6} />
          <XAxis
            dataKey="date"
            tickFormatter={(v) => fmtDate(v)}
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            minTickGap={32}
          />
          <YAxis
            tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            tickLine={false}
            axisLine={false}
            width={48}
            tickFormatter={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}`}
          />
          <ReferenceLine y={0} stroke="var(--border)" />
          <Tooltip
            content={
              <ChartTooltip
                formatter={(_n, v, p) =>
                  `${v > 0 ? '+' : ''}${v.toFixed(2)}${mode === 'R' ? 'R' : '%'} · ${p?.trades ?? 0} trades`
                }
              />
            }
            labelFormatter={(l) => fmtDate(l as string, { month: 'short', day: 'numeric', year: 'numeric' })}
          />
          <Area
            type="monotone"
            dataKey={dataKey}
            name={mode === 'R' ? 'Cumulative R' : 'Account %'}
            stroke="var(--positive)"
            strokeWidth={2}
            fill={`url(#eq-${gradId})`}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  )
}

export function DrawdownChart({ data, height = 120 }: { data: EquityPoint[]; height?: number }) {
  const gradId = React.useId()
  return (
    <ResponsiveContainer width="100%" height={height}>
      <AreaChart data={data} margin={{ top: 4, right: 8, left: -12, bottom: 0 }}>
        <defs>
          <linearGradient id={`dd-${gradId}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--negative)" stopOpacity={0.04} />
            <stop offset="100%" stopColor="var(--negative)" stopOpacity={0.3} />
          </linearGradient>
        </defs>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} opacity={0.5} />
        <XAxis
          dataKey="date"
          tickFormatter={(v) => fmtDate(v)}
          tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          minTickGap={32}
        />
        <YAxis
          tick={{ fontSize: 10, fill: 'var(--muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          width={40}
          tickFormatter={(v) => `${v.toFixed(0)}R`}
        />
        <Tooltip
          content={<ChartTooltip formatter={(_n, v) => `${v.toFixed(2)}R drawdown`} />}
          labelFormatter={(l) => fmtDate(l as string, { month: 'short', day: 'numeric', year: 'numeric' })}
        />
        <Area
          type="monotone"
          dataKey="drawdown"
          name="Drawdown"
          stroke="var(--negative)"
          strokeWidth={1.5}
          fill={`url(#dd-${gradId})`}
          isAnimationActive={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
