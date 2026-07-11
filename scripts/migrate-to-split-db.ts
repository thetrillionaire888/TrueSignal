// Migration script: copy data from old custom.db into 3 new databases.
import { Database } from 'bun:sqlite'
import { resolve } from 'node:path'
import { existsSync } from 'node:fs'

const DB_DIR = resolve(import.meta.dir, '../db')
const OLD_DB = resolve(DB_DIR, 'custom.db')
const AUDIT_DB = resolve(DB_DIR, 'audit.db')
const CATALOG_DB = resolve(DB_DIR, 'catalog.db')
const MARKET_DB = resolve(DB_DIR, 'market.db')

if (!existsSync(OLD_DB)) { console.error(`❌ Old DB not found: ${OLD_DB}`); process.exit(1); }

console.log('🔄 Migrating custom.db → 3 new databases')

const audit = new Database(AUDIT_DB)
audit.exec('PRAGMA journal_mode = WAL;')
audit.exec('PRAGMA synchronous = NORMAL;')
audit.exec('PRAGMA busy_timeout = 10000;')
audit.exec(`ATTACH '${CATALOG_DB}' AS catalog;`)
audit.exec(`ATTACH '${MARKET_DB}' AS market;`)
audit.exec(`ATTACH '${OLD_DB}' AS old;`)

function count(schema: string, table: string): number {
  return (audit.prepare(`SELECT COUNT(*) as c FROM ${schema}.${table}`).get() as { c: number }).c
}

// 1. Channel → catalog.Channel + catalog.ChannelStats
console.log('1/6 Channel (split static + volatile)...')
console.log(`   source: ${count('old', 'Channel')} rows`)
audit.exec(`INSERT OR IGNORE INTO catalog.Channel
  (id, telegramId, name, type, category, description, avatarColor, language, region, verified, monitoredSince, createdAt)
  SELECT id, telegramId, name, type, category, description, avatarColor, language, region, verified, monitoredSince, createdAt
  FROM old.Channel`)
audit.exec(`INSERT OR IGNORE INTO catalog.ChannelStats
  (channelId, subscriberCount, lastMessageAt, messageCount, signalCount, status, updatedAt)
  SELECT id, subscriberCount, lastMessageAt, 0, 0, status, datetime('now') FROM old.Channel`)
console.log(`   catalog.Channel: ${count('catalog', 'Channel')}, catalog.ChannelStats: ${count('catalog', 'ChannelStats')}`)

// 2. Message → audit.Message
console.log('2/6 Message...')
console.log(`   source: ${count('old', 'Message')} rows`)
audit.exec(`INSERT OR IGNORE INTO Message
  (id, channelId, telegramMessageId, rawText, rawJson, senderId, senderName, hasMedia, mediaType, views, forwards, reactions, postedAt, ingestedAt, parseStatus, ingestSource)
  SELECT id, channelId, telegramMessageId, rawText, rawJson, senderId, senderName, hasMedia, mediaType, views, forwards, reactions, postedAt, ingestedAt, parseStatus, ingestSource
  FROM old.Message`)
console.log(`   audit.Message: ${count('main', 'Message')}`)

// 3. Signal → audit.Signal (regenerate dedupHash as channelId|postedAt)
console.log('3/6 Signal (regenerating dedupHash)...')
console.log(`   source: ${count('old', 'Signal')} rows`)
audit.exec(`INSERT OR IGNORE INTO Signal
  (id, messageId, channelId, instrument, instrumentType, action, entryPrice, entryLow, entryHigh, isRange, stopLoss, takeProfits, positionSize, leverage, timeframe, confidence, parserVersion, parsedAt, status, notes, dedupHash)
  SELECT s.id, s.messageId, s.channelId, s.instrument, s.instrumentType, s.action, s.entryPrice,
    s.entryLow, s.entryHigh, s.isRange, s.stopLoss, s.takeProfits, s.positionSize, s.leverage,
    s.timeframe, s.confidence, s.parserVersion, s.parsedAt, s.status, s.notes,
    s.channelId || '|' || m.postedAt
  FROM old.Signal s JOIN old.Message m ON s.messageId = m.id`)
console.log(`   audit.Signal: ${count('main', 'Signal')}`)

// 4. Evaluation → audit.Evaluation
console.log('4/6 Evaluation...')
console.log(`   source: ${count('old', 'Evaluation')} rows`)
audit.exec(`INSERT OR IGNORE INTO Evaluation
  (id, signalId, outcome, exitPrice, exitReason, hitTpLevel, maxFavorablePct, maxAdversePct, rMultiple, pnlPercent, durationMinutes, marketDataSource, evaluatedAt)
  SELECT id, signalId, outcome, exitPrice, exitReason, hitTpLevel, maxFavorablePct, maxAdversePct, rMultiple, pnlPercent, durationMinutes, marketDataSource, evaluatedAt
  FROM old.Evaluation`)
console.log(`   audit.Evaluation: ${count('main', 'Evaluation')}`)

// 5. PriceBar → market.PriceBar
console.log('5/6 PriceBar...')
console.log(`   source: ${count('old', 'PriceBar')} rows`)
audit.exec(`INSERT OR IGNORE INTO market.PriceBar
  (source, instrument, timeframe, timestamp, open, high, low, close, volume, fetchedAt)
  SELECT source, instrument, timeframe, timestamp, open, high, low, close, volume, fetchedAt
  FROM old.PriceBar`)
console.log(`   market.PriceBar: ${count('market', 'PriceBar')}`)

// 6. IngestState → catalog.IngestState
console.log('6/6 IngestState...')
const oldTables = audit.prepare(`SELECT name FROM old.sqlite_master WHERE type='table' AND name='IngestState'`).all() as { name: string }[]
if (oldTables.length > 0) {
  console.log(`   source: ${count('old', 'IngestState')} rows`)
  audit.exec(`INSERT OR IGNORE INTO catalog.IngestState (channelId, offsetId, fetchedCount, updatedAt)
    SELECT channelId, offsetId, fetchedCount, updatedAt FROM old.IngestState`)
  console.log(`   catalog.IngestState: ${count('catalog', 'IngestState')}`)
} else { console.log('   (no IngestState table in old DB — skipping)') }

// Backfill materialized counters
console.log('\n📝 Backfilling materialized counters...')
audit.exec(`UPDATE catalog.ChannelStats SET messageCount = (SELECT COUNT(*) FROM main.Message WHERE main.Message.channelId = catalog.ChannelStats.channelId)`)
audit.exec(`UPDATE catalog.ChannelStats SET signalCount = (SELECT COUNT(*) FROM main.Signal WHERE main.Signal.channelId = catalog.ChannelStats.channelId)`)
console.log('   ✓ counters backfilled')

console.log('\n✅ Migration complete:')
console.log(`   catalog.Channel: ${count('catalog', 'Channel')}, catalog.ChannelStats: ${count('catalog', 'ChannelStats')}`)
console.log(`   audit.Message: ${count('main', 'Message')}, audit.Signal: ${count('main', 'Signal')}, audit.Evaluation: ${count('main', 'Evaluation')}`)
console.log(`   market.PriceBar: ${count('market', 'PriceBar')}`)
audit.close()
