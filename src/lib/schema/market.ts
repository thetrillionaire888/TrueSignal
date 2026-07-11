// Market DB schema — Historical OHLC bar cache
// Write-once on first fetch, then read-only forever. Composite PK clusters
// rows by instrument+timeframe+timestamp for fast range scans.
import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const priceBars = sqliteTable('PriceBar', {
  source: text('source').notNull(),
  instrument: text('instrument').notNull(),
  timeframe: text('timeframe').notNull(),
  timestamp: integer('timestamp').notNull(),
  open: real('open').notNull(),
  high: real('high').notNull(),
  low: real('low').notNull(),
  close: real('close').notNull(),
  volume: real('volume').default(0),
  fetchedAt: text('fetchedAt').default(sql`(datetime('now'))`),
}, (table) => ({
  pk: primaryKey({ columns: [table.source, table.instrument, table.timeframe, table.timestamp] }),
}))

export type PriceBar = typeof priceBars.$inferSelect
export type NewPriceBar = typeof priceBars.$inferInsert
