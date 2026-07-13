// Catalog DB schema — Channel registry + IngestState
// Read-heavy (every API route joins to Channel), occasional writes (channel meta
// updates on ingest). Static identity fields are split from volatile counters
// (ChannelStats) to avoid row-level write contention.
import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'
import { sql } from 'drizzle-orm'

export const channels = sqliteTable('Channel', {
  id: text('id').primaryKey(),
  telegramId: text('telegramId').notNull().unique(),
  peerId: integer('peerId').unique(),
  name: text('name').notNull(),
  type: text('type').notNull(),
  category: text('category').notNull(),
  description: text('description').notNull(),
  avatarColor: text('avatarColor').notNull(),
  language: text('language').default('en'),
  region: text('region').default('global'),
  verified: integer('verified').default(0),
  monitoredSince: text('monitoredSince').default(sql`(datetime('now'))`),
  createdAt: text('createdAt').default(sql`(datetime('now'))`),
})

export const channelStats = sqliteTable('ChannelStats', {
  channelId: text('channelId').primaryKey(),
  subscriberCount: integer('subscriberCount').default(0),
  lastMessageAt: text('lastMessageAt'),
  messageCount: integer('messageCount').default(0),
  signalCount: integer('signalCount').default(0),
  status: text('status').default('active'),
  updatedAt: text('updatedAt').default(sql`(datetime('now'))`),
})

export const ingestState = sqliteTable('IngestState', {
  channelId: text('channelId').primaryKey(),
  offsetId: integer('offsetId').notNull(),
  fetchedCount: integer('fetchedCount').default(0),
  updatedAt: text('updatedAt').default(sql`(datetime('now'))`),
})

export type Channel = typeof channels.$inferSelect
export type NewChannel = typeof channels.$inferInsert
export type ChannelStats = typeof channelStats.$inferSelect
export type NewChannelStats = typeof channelStats.$inferInsert
export type IngestState = typeof ingestState.$inferSelect
export type NewIngestState = typeof ingestState.$inferInsert
