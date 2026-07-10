'use client'

import * as React from 'react'
import {
  Bar,
  BarChart,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import { ChartTooltip } from './chart-card'
import { fmtR } from '@/lib/format'

export type ChannelBar = {
  name: string
  totalR: number
  winRate: number
  trades: number
}

export function ChannelBarChart({ data, height = 260 }: { data: ChannelBar[]; height?: number }) {
  return (
    <ResponsiveContainer width="100%" height={height}>
      <BarChart
        data={data}
        layout="vertical"
        margin={{ top: 4, right: 32, left: 8, bottom: 4 }}
        barCategoryGap={8}
      >
        <XAxis
          type="number"
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => `${v > 0 ? '+' : ''}${v.toFixed(0)}R`}
        />
        <YAxis
          type="category"
          dataKey="name"
          tick={{ fontSize: 11, fill: 'var(--foreground)' }}
          tickLine={false}
          axisLine={false}
          width={120}
        />
        <Tooltip
          cursor={{ fill: 'var(--muted)', opacity: 0.4 }}
          content={
            <ChartTooltip
              formatter={(_n, v, p) => `${fmtR(v)} · ${((p?.winRate ?? 0) * 100).toFixed(0)}% WR · ${p?.trades ?? 0} trades`}
            />
          }
        />
        <Bar dataKey="totalR" name="Total R" radius={[0, 4, 4, 0]} isAnimationActive={false}>
          {data.map((d, i) => (
            <Cell key={i} fill={d.totalR >= 0 ? 'var(--positive)' : 'var(--negative)'} fillOpacity={0.85} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
