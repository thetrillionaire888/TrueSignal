'use client'

import * as React from 'react'
import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from 'recharts'
import { ChartTooltip } from './chart-card'

export function WinLossDonut({
  wins,
  losses,
  breakevens,
  size = 160,
}: {
  wins: number
  losses: number
  breakevens: number
  size?: number
}) {
  const total = wins + losses + breakevens
  const data = [
    { name: 'Wins', value: wins, color: 'var(--positive)' },
    { name: 'Losses', value: losses, color: 'var(--negative)' },
    { name: 'Breakeven', value: breakevens, color: 'var(--neutral)' },
  ].filter((d) => d.value > 0)

  return (
    <div className="relative" style={{ width: size, height: size }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie
            data={data}
            dataKey="value"
            nameKey="name"
            innerRadius={size * 0.32}
            outerRadius={size * 0.46}
            paddingAngle={2}
            stroke="none"
            isAnimationActive={false}
          >
            {data.map((d, i) => (
              <Cell key={i} fill={d.color} />
            ))}
          </Pie>
          <Tooltip content={<ChartTooltip formatter={(_n, v, p) => `${v} · ${total ? ((v / total) * 100).toFixed(1) : 0}%`} />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-2xl font-semibold tnum">
          {total ? ((wins / total) * 100).toFixed(1) : '0.0'}%
        </span>
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Win rate</span>
      </div>
    </div>
  )
}
