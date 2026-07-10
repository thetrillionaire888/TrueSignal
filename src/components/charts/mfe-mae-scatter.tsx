'use client'

import * as React from 'react'
import {
  CartesianGrid,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from 'recharts'
import { ChartTooltip } from './chart-card'

export type MfeMaePoint = {
  mfe: number
  mae: number
  outcome: string
  r: number
}

const colorFor = (o: string) =>
  o === 'win' ? 'var(--positive)' : o === 'loss' ? 'var(--negative)' : 'var(--neutral)'

export function MfeMaeScatter({ data, height = 280 }: { data: MfeMaePoint[]; height?: number }) {
  const wins = data.filter((d) => d.outcome === 'win')
  const losses = data.filter((d) => d.outcome === 'loss')
  const bes = data.filter((d) => d.outcome === 'breakeven')

  return (
    <ResponsiveContainer width="100%" height={height}>
      <ScatterChart margin={{ top: 12, right: 16, left: -8, bottom: 8 }}>
        <CartesianGrid stroke="var(--border)" strokeDasharray="3 3" opacity={0.5} />
        <XAxis
          type="number"
          dataKey="mae"
          name="Max Adverse"
          unit="%"
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          tickFormatter={(v) => `${v.toFixed(0)}%`}
        />
        <YAxis
          type="number"
          dataKey="mfe"
          name="Max Favorable"
          unit="%"
          tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
          tickLine={false}
          axisLine={false}
          width={44}
          tickFormatter={(v) => `${v.toFixed(0)}%`}
        />
        <ZAxis range={[28, 28]} />
        <Tooltip
          cursor={{ strokeDasharray: '3 3', stroke: 'var(--border)' }}
          content={
            <ChartTooltip
              formatter={(_n, _v, p) =>
                `MFE ${(p?.mfe ?? 0).toFixed(1)}% · MAE ${(p?.mae ?? 0).toFixed(1)}% · ${(p?.r ?? 0).toFixed(2)}R`
              }
            />
          }
        />
        <Scatter name="Wins" data={wins} fill={colorFor('win')} fillOpacity={0.55} isAnimationActive={false} />
        <Scatter name="Losses" data={losses} fill={colorFor('loss')} fillOpacity={0.55} isAnimationActive={false} />
        <Scatter name="Breakeven" data={bes} fill={colorFor('breakeven')} fillOpacity={0.55} isAnimationActive={false} />
      </ScatterChart>
    </ResponsiveContainer>
  )
}
