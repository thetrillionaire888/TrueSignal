// Audit DB schema — Messages + Signals + Evaluations
// High-write during ingestion and evaluation. High-read from frontend.
import { sqliteTable, text, integer, real, uniqueIndex, index } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const messages = sqliteTable('Message', {
  id: text('id').primaryKey(),
  channelId: text('channelId').notNull(),
  telegramMessageId: integer('telegramMessageId').notNull(),
  rawText: text('rawText').notNull(),
  rawJson: text('rawJson').default('{}'),
  senderId: text('senderId'),
  senderName: text('senderName'),
  hasMedia: integer('hasMedia').default(0),
  mediaType: text('mediaType'),
  views: integer('views').default(0),
  forwards: integer('forwards').default(0),
  reactions: integer('reactions').default(0),
  postedAt: text('postedAt').notNull(),
  ingestedAt: text('ingestedAt').default(sql`(datetime('now'))`),
  parseStatus: text('parseStatus').default('pending'),
  ingestSource: text('ingestSource').default('mtproto-tdlib'),
}, (table) => ({
  channelMsgUnique: uniqueIndex('Message_channelId_telegramMessageId_unique').on(table.channelId, table.telegramMessageId),
  channelPostedIdx: index('Message_channelId_postedAt_idx').on(table.channelId, table.postedAt),
  postedIdx: index('Message_postedAt_idx').on(table.postedAt),
  ingestedIdx: index('Message_ingestedAt_idx').on(table.ingestedAt),
}))

export const signals = sqliteTable('Signal', {
  id: text('id').primaryKey(),
  messageId: text('messageId').notNull(),
  channelId: text('channelId').notNull(),
  instrument: text('instrument').notNull(),
  instrumentType: text('instrumentType').notNull(),
  action: text('action').notNull(),
  entryPrice: real('entryPrice').notNull(),
  entryLow: real('entryLow'),
  entryHigh: real('entryHigh'),
  isRange: integer('isRange').default(0),
  stopLoss: real('stopLoss').notNull(),
  takeProfits: text('takeProfits').notNull(),
  positionSize: text('positionSize'),
  leverage: text('leverage'),
  timeframe: text('timeframe'),
  confidence: real('confidence').default(0),
  parserVersion: text('parserVersion').default('regex-nlp-v1.4'),
  parsedAt: text('parsedAt').default(sql`(datetime('now'))`),
  status: text('status').default('evaluating'),
  notes: text('notes'),
  dedupHash: text('dedupHash').notNull().unique(),
}, (table) => ({
  messageIdx: index('Signal_messageId_idx').on(table.messageId),
  channelParsedIdx: index('Signal_channelId_parsedAt_idx').on(table.channelId, table.parsedAt),
  channelStatusIdx: index('Signal_channelId_status_idx').on(table.channelId, table.status),
  statusIdx: index('Signal_status_idx').on(table.status),
  instrumentIdx: index('Signal_instrument_instrumentType_idx').on(table.instrument, table.instrumentType),
}))

export const evaluations = sqliteTable('Evaluation', {
  id: text('id').primaryKey(),
  signalId: text('signalId').notNull().unique(),
  outcome: text('outcome').notNull(),
  exitPrice: real('exitPrice'),
  exitReason: text('exitReason'),
  hitTpLevel: integer('hitTpLevel'),
  maxFavorablePct: real('maxFavorablePct'),
  maxAdversePct: real('maxAdversePct'),
  rMultiple: real('rMultiple').notNull(),
  pnlPercent: real('pnlPercent').notNull(),
  durationMinutes: integer('durationMinutes'),
  marketDataSource: text('marketDataSource').default('aggregated-feed'),
  evaluatedAt: text('evaluatedAt').default(sql`(datetime('now'))`),
}, (table) => ({
  outcomeIdx: index('Evaluation_outcome_idx').on(table.outcome),
  evaluatedAtIdx: index('Evaluation_evaluatedAt_idx').on(table.evaluatedAt),
}))

export type Message = typeof messages.$inferSelect
export type NewMessage = typeof messages.$inferInsert
export type Signal = typeof signals.$inferSelect
export type NewSignal = typeof signals.$inferInsert
export type Evaluation = typeof evaluations.$inferSelect
export type NewEvaluation = typeof evaluations.$inferInsert
