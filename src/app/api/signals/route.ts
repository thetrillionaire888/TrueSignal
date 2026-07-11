import { NextResponse } from 'next/server'
import { listSignals } from '@/lib/queries'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url)
  const channelId = searchParams.get('channelId') || undefined
  const instrument = searchParams.get('instrument') || undefined
  const outcome = searchParams.get('outcome') || undefined
  const action = searchParams.get('action') || undefined
  const category = searchParams.get('category') || undefined
  const q = searchParams.get('q')?.toLowerCase() || undefined
  const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10))
  const pageSize = Math.min(100, Math.max(10, parseInt(searchParams.get('pageSize') || '25', 10)))
  const sort = searchParams.get('sort') || 'postedAt'

  const { signals, total } = await listSignals({
    channelId,
    instrument,
    outcome,
    action,
    category,
    q,
    page,
    pageSize,
    sort,
  })

  return NextResponse.json({
    signals,
    total,
    page,
    pageSize,
    totalPages: Math.ceil(total / pageSize),
  })
}
