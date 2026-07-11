// Database query helpers — Drizzle ORM + raw SQL for cross-DB joins.
// Uses `?` positional placeholders for cross-runtime compatibility.

import { sqlite } from '@/lib/db'

function parseDbDate(v: string | number | null | undefined): Date {
  if (v == null) return new Date(0)
  if (typeof v === 'number') return new Date(v)
  if (/^\d{10,}$/.test(v)) return new Date(Number(v))
  return new Date(v)
}

export type EvalRowRaw = {
  signalId: string; messageId: string; channelId: string
  channelName: string; channelTelegramId: string; channelCategory: string
  instrument: string; instrumentType: string; action: string
  entryPrice: number; stopLoss: number; takeProfits: string
  leverage: string | null; timeframe: string | null; confidence: number
  outcome: string; exitPrice: number | null; exitReason: string | null
  hitTpLevel: number | null; maxFavorablePct: number | null; maxAdversePct: number | null
  rMultiple: number; pnlPercent: number; durationMinutes: number | null
  postedAt: Date; evaluatedAt: Date
}

export async function loadEvalRows(): Promise<EvalRowRaw[]> {
  const rows = sqlite.prepare(`
    SELECT s.id as signalId, s.messageId, s.channelId,
      c.name as channelName, c.telegramId as channelTelegramId, c.category as channelCategory,
      s.instrument, s.instrumentType, s.action, s.entryPrice, s.stopLoss, s.takeProfits,
      s.leverage, s.timeframe, s.confidence,
      e.outcome, e.exitPrice, e.exitReason, e.hitTpLevel,
      e.maxFavorablePct, e.maxAdversePct, e.rMultiple, e.pnlPercent, e.durationMinutes,
      m.postedAt, e.evaluatedAt
    FROM Signal s
    JOIN Message m ON s.messageId = m.id
    JOIN catalog.Channel c ON s.channelId = c.id
    JOIN Evaluation e ON e.signalId = s.id
    ORDER BY m.postedAt ASC
  `).all() as Array<any>
  return rows.map((r) => ({ ...r, postedAt: parseDbDate(r.postedAt), evaluatedAt: parseDbDate(r.evaluatedAt) }))
}

export async function loadChannelsWithMeta() {
  return sqlite.prepare(`
    SELECT c.id, c.telegramId, c.name, c.type, c.category, c.description,
      c.avatarColor, c.language, c.region, c.verified, c.monitoredSince, c.createdAt,
      cs.subscriberCount, cs.lastMessageAt, cs.messageCount, cs.signalCount, cs.status
    FROM catalog.Channel c
    LEFT JOIN catalog.ChannelStats cs ON cs.channelId = c.id
    ORDER BY cs.subscriberCount DESC
  `).all() as Array<any>
}

export async function countMessages(where?: { channelId?: string }): Promise<number> {
  if (where?.channelId) {
    return (sqlite.prepare('SELECT COUNT(*) as c FROM Message WHERE channelId = ?').get(where.channelId) as { c: number }).c
  }
  return (sqlite.prepare('SELECT COUNT(*) as c FROM Message').get() as { c: number }).c
}

export async function countSignals(where?: { channelId?: string }): Promise<number> {
  if (where?.channelId) {
    return (sqlite.prepare('SELECT COUNT(*) as c FROM Signal WHERE channelId = ?').get(where.channelId) as { c: number }).c
  }
  return (sqlite.prepare('SELECT COUNT(*) as c FROM Signal').get() as { c: number }).c
}

export async function countEvaluations(): Promise<number> {
  return (sqlite.prepare('SELECT COUNT(*) as c FROM Evaluation').get() as { c: number }).c
}

export async function countChannels(): Promise<number> {
  return (sqlite.prepare('SELECT COUNT(*) as c FROM catalog.Channel').get() as { c: number }).c
}

export async function countMessagesByParseStatus(status: string): Promise<number> {
  return (sqlite.prepare('SELECT COUNT(*) as c FROM Message WHERE parseStatus = ?').get(status) as { c: number }).c
}

export type SignalListFilters = {
  channelId?: string; instrument?: string; outcome?: string
  action?: string; category?: string; q?: string
  page: number; pageSize: number; sort: string
  sortDir?: 'asc' | 'desc'
}

// Whitelist of sortable columns → SQL expression. Prevents SQL injection
// (the sort param never gets interpolated raw — only the direction does,
// and that is constrained to the literal strings 'ASC' / 'DESC').
const SORT_COLUMN_MAP: Record<string, string> = {
  instrument: 's.instrument',
  channel: 'c.name',
  action: 's.action',
  entryPrice: 's.entryPrice',
  stopLoss: 's.stopLoss',
  outcome: 'e.outcome',
  rMultiple: 'e.rMultiple',
  confidence: 's.confidence',
  postedAt: 'm.postedAt',
}

// Columns that may be NULL (unevaluated signals have no Evaluation row).
// Push NULLs to the end regardless of sort direction so evaluated rows
// always appear first — more useful than having all the dashes clustered
// at the top when sorting ascending.
const NULLABLE_SORT_COLUMNS = new Set(['e.outcome', 'e.rMultiple'])

function buildOrderBy(sort: string, sortDir: 'asc' | 'desc' | undefined): string {
  const dir = sortDir === 'asc' ? 'ASC' : 'DESC'
  const col = SORT_COLUMN_MAP[sort] ?? 'm.postedAt'
  if (NULLABLE_SORT_COLUMNS.has(col)) {
    return `${col} IS NULL, ${col} ${dir}`
  }
  return `${col} ${dir}`
}

export type SignalListItem = {
  id: string; instrument: string; instrumentType: string; action: string
  entryPrice: number; entryLow: number | null; entryHigh: number | null
  isRange: number; stopLoss: number; takeProfits: string
  leverage: string | null; timeframe: string | null; confidence: number; status: string
  postedAt: string
  channel: { id: string; name: string; telegramId: string; category: string; avatarColor: string }
  evaluation: {
    outcome: string; rMultiple: number; pnlPercent: number
    exitPrice: number | null; exitReason: string | null; hitTpLevel: number | null
    durationMinutes: number | null; maxFavorablePct: number | null; maxAdversePct: number | null
    evaluatedAt: string
  } | null
}

export async function listSignals(filters: SignalListFilters): Promise<{ signals: SignalListItem[]; total: number }> {
  const conditions: string[] = []
  const params: unknown[] = []
  if (filters.channelId) { conditions.push('s.channelId = ?'); params.push(filters.channelId) }
  if (filters.instrument) { conditions.push('s.instrument = ?'); params.push(filters.instrument) }
  if (filters.action) { conditions.push('s.action = ?'); params.push(filters.action) }
  if (filters.category) { conditions.push('c.category = ?'); params.push(filters.category) }
  if (filters.outcome) { conditions.push('e.outcome = ?'); params.push(filters.outcome) }
  if (filters.q) {
    conditions.push('(LOWER(s.instrument) LIKE ? OR LOWER(m.rawText) LIKE ?)')
    params.push(`%${filters.q}%`, `%${filters.q}%`)
  }
  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''
  const orderBy = buildOrderBy(filters.sort, filters.sortDir)

  const totalRow = sqlite.prepare(`SELECT COUNT(*) as c FROM Signal s JOIN catalog.Channel c ON s.channelId = c.id LEFT JOIN Message m ON s.messageId = m.id LEFT JOIN Evaluation e ON e.signalId = s.id ${whereClause}`).get(...params) as { c: number }

  const pageSql = `SELECT s.id, s.instrument, s.instrumentType, s.action, s.entryPrice, s.entryLow, s.entryHigh, s.isRange, s.stopLoss, s.takeProfits, s.leverage, s.timeframe, s.confidence, s.status, m.postedAt, c.id as channelId, c.name as channelName, c.telegramId, c.category as channelCategory, c.avatarColor, e.outcome, e.rMultiple, e.pnlPercent, e.exitPrice, e.exitReason, e.hitTpLevel, e.durationMinutes, e.maxFavorablePct, e.maxAdversePct, e.evaluatedAt FROM Signal s JOIN catalog.Channel c ON s.channelId = c.id LEFT JOIN Message m ON s.messageId = m.id LEFT JOIN Evaluation e ON e.signalId = s.id ${whereClause} ORDER BY ${orderBy} LIMIT ? OFFSET ?`
  const pageParams = [...params, filters.pageSize, (filters.page - 1) * filters.pageSize]
  const rows = sqlite.prepare(pageSql).all(...pageParams) as Array<any>

  const signalsList: SignalListItem[] = rows.map((r) => ({
    id: r.id, instrument: r.instrument, instrumentType: r.instrumentType, action: r.action,
    entryPrice: r.entryPrice, entryLow: r.entryLow, entryHigh: r.entryHigh, isRange: r.isRange,
    stopLoss: r.stopLoss, takeProfits: r.takeProfits, leverage: r.leverage, timeframe: r.timeframe,
    confidence: r.confidence, status: r.status, postedAt: r.postedAt,
    channel: { id: r.channelId, name: r.channelName, telegramId: r.telegramId, category: r.channelCategory, avatarColor: r.avatarColor },
    evaluation: r.outcome ? { outcome: r.outcome, rMultiple: r.rMultiple, pnlPercent: r.pnlPercent, exitPrice: r.exitPrice, exitReason: r.exitReason, hitTpLevel: r.hitTpLevel, durationMinutes: r.durationMinutes, maxFavorablePct: r.maxFavorablePct, maxAdversePct: r.maxAdversePct, evaluatedAt: r.evaluatedAt } : null,
  }))
  return { signals: signalsList, total: totalRow.c }
}

export async function getSignalById(id: string) {
  return sqlite.prepare(`
    SELECT s.id, s.instrument, s.instrumentType, s.action, s.entryPrice, s.entryLow, s.entryHigh, s.isRange, s.stopLoss, s.takeProfits, s.positionSize, s.leverage, s.timeframe, s.confidence, s.parserVersion, s.status, s.notes, s.parsedAt, c.id as channelId, c.name as channelName, c.telegramId, c.category, c.type as channelType, c.avatarColor, cs.subscriberCount, c.verified, m.id as messageId, m.telegramMessageId, m.rawText, m.hasMedia, m.mediaType, m.views, m.forwards, m.reactions, m.postedAt, m.ingestedAt, m.parseStatus, m.ingestSource, e.outcome, e.exitPrice, e.exitReason, e.hitTpLevel, e.maxFavorablePct, e.maxAdversePct, e.rMultiple, e.pnlPercent, e.durationMinutes, e.marketDataSource, e.evaluatedAt
    FROM Signal s JOIN catalog.Channel c ON s.channelId = c.id
    LEFT JOIN catalog.ChannelStats cs ON cs.channelId = c.id
    LEFT JOIN Message m ON s.messageId = m.id
    LEFT JOIN Evaluation e ON e.signalId = s.id
    WHERE s.id = ?
  `).get(id) as any | null
}

export async function getRecentMessages(limit = 12) {
  return sqlite.prepare(`SELECT m.id, m.parseStatus, m.postedAt, m.ingestedAt, m.views, m.rawText, c.name as channelName, c.telegramId FROM Message m JOIN catalog.Channel c ON m.channelId = c.id ORDER BY m.ingestedAt DESC LIMIT ?`).all(limit) as Array<any>
}

export async function getMessageCountsPerChannel() {
  return sqlite.prepare(`SELECT c.name, c.telegramId, c.category, cs.status, COUNT(m.id) as messages FROM catalog.Channel c LEFT JOIN catalog.ChannelStats cs ON cs.channelId = c.id LEFT JOIN Message m ON m.channelId = c.id GROUP BY c.id ORDER BY messages DESC`).all() as Array<any>
}
