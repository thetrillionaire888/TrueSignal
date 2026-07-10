import { NextResponse } from 'next/server'
import { loadEvalRows } from '@/lib/queries'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const format = searchParams.get('format') || 'csv'
  const channelId = searchParams.get('channelId')

  let rows = await loadEvalRows()
  if (channelId) rows = rows.filter((r) => r.channelId === channelId)

  const data = rows.map((r) => ({
    signalId: r.signalId,
    channel: r.channelTelegramId,
    channelName: r.channelName,
    category: r.channelCategory,
    instrument: r.instrument,
    instrumentType: r.instrumentType,
    action: r.action,
    entryPrice: r.entryPrice,
    stopLoss: r.stopLoss,
    takeProfits: r.takeProfits,
    leverage: r.leverage ?? '',
    timeframe: r.timeframe ?? '',
    confidence: r.confidence,
    outcome: r.outcome,
    exitPrice: r.exitPrice ?? '',
    exitReason: r.exitReason ?? '',
    hitTpLevel: r.hitTpLevel ?? '',
    rMultiple: r.rMultiple,
    pnlPercent: r.pnlPercent,
    maxFavorablePct: r.maxFavorablePct ?? '',
    maxAdversePct: r.maxAdversePct ?? '',
    durationMinutes: r.durationMinutes ?? '',
    postedAt: r.postedAt.toISOString(),
    evaluatedAt: r.evaluatedAt.toISOString(),
  }))

  if (format === 'json') {
    return new NextResponse(JSON.stringify({ exportedAt: new Date().toISOString(), count: data.length, signals: data }, null, 2), {
      headers: {
        'Content-Type': 'application/json',
        'Content-Disposition': `attachment; filename="signals-${Date.now()}.json"`,
      },
    })
  }

  if (format === 'xlsx') {
    const XLSX = await import('xlsx')
    const headers = Object.keys(data[0] ?? { empty: '' })
    const aoa = [headers, ...data.map((row) => headers.map((h) => (row as Record<string, unknown>)[h] ?? ''))]
    const ws = XLSX.utils.aoa_to_sheet(aoa)
    const wb = XLSX.utils.book_new()
    XLSX.utils.book_append_sheet(wb, ws, 'Signals')
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' })
    return new NextResponse(buf, {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="signals-${Date.now()}.xlsx"`,
      },
    })
  }

  // CSV
  const headers = Object.keys(data[0] ?? { empty: '' })
  const escape = (v: unknown) => {
    const s = String(v ?? '')
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`
    return s
  }
  const csv = [
    headers.join(','),
    ...data.map((row) => headers.map((h) => escape((row as Record<string, unknown>)[h])).join(',')),
  ].join('\n')

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv',
      'Content-Disposition': `attachment; filename="signals-${Date.now()}.csv"`,
    },
  })
}
