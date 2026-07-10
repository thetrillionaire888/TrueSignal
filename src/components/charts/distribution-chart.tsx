'use client'

import * as React from 'react'
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ChartTooltip } from './chart-card'

export type DistBucket = { label: string; count: number }

export function DistributionChart({ data, height = 220 }: { data: DistBucket[]; height?: number }) {
  const max = Math.max(...data.map((d) => d.count), 1)
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart data={data} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" vertical={false} opacity={0.5} />
        <XAxis
          dataKey="label"
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          tickLine={false}
          axisLine={false}
        />
        <YAxis
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          width={36}
          allowDecimals={false}
        />
        <Tooltip
          cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
          content={<ChartTooltip formatter={(_n, v) => `${v} trades`} />}
        />
        <Bar dataKey="count" name="Trades" radius={[3, 3, 0, 0]} isAnimationActive={false}>
          {data.map((d, i) => {
            const label = d.label
            const isNeg = label.includes('-') && !label.includes('+')
            const isPos = label.includes('+')
            const color = isNeg ? 'var(--negative)' : isPos ? 'var(--positive)' : 'var(--neutral)'
            return <Cell key={i} fill={color} fillOpacity={0.3 + 0.7 * (d.count / max)} stroke={color} strokeWidth={1} />
          })}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
