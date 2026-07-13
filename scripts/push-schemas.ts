// Push all 3 schemas to their respective SQLite databases.
import { Database } from 'bun:sqlite'
import { resolve } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'

const DB_DIR = resolve(import.meta.dir, '../db')
if (!existsSync(DB_DIR)) mkdirSync(DB_DIR, { recursive: true })

const AUDIT_DB = resolve(DB_DIR, 'audit.db')
const CATALOG_DB = resolve(DB_DIR, 'catalog.db')
const MARKET_DB = resolve(DB_DIR, 'market.db')

console.log('📦 Pushing schemas to 3 databases...')

function applyPragmas(db: Database) {
  db.exec('PRAGMA journal_mode = WAL;')
  db.exec('PRAGMA synchronous = NORMAL;')
  db.exec('PRAGMA cache_size = -65536;')
  db.exec('PRAGMA mmap_size = 268435456;')
  db.exec('PRAGMA temp_store = MEMORY;')
  db.exec('PRAGMA busy_timeout = 10000;')
}

// catalog.db
console.log('1/3 catalog.db')
const catalogDb = new Database(CATALOG_DB)
applyPragmas(catalogDb)
catalogDb.exec(`CREATE TABLE IF NOT EXISTS "Channel" (
  "id" text PRIMARY KEY NOT NULL, "telegramId" text NOT NULL, "peerId" integer,
  "name" text NOT NULL, "type" text NOT NULL, "category" text NOT NULL,
  "description" text NOT NULL, "avatarColor" text NOT NULL, "language" text DEFAULT 'en',
  "region" text DEFAULT 'global', "verified" integer DEFAULT 0,
  "monitoredSince" text DEFAULT (datetime('now')), "createdAt" text DEFAULT (datetime('now')));`)
catalogDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "Channel_telegramId_unique" ON "Channel" ("telegramId");`)
catalogDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "Channel_peerId_unique" ON "Channel" ("peerId");`)
catalogDb.exec(`CREATE TABLE IF NOT EXISTS "ChannelStats" (
  "channelId" text PRIMARY KEY NOT NULL, "subscriberCount" integer DEFAULT 0,
  "lastMessageAt" text, "messageCount" integer DEFAULT 0, "signalCount" integer DEFAULT 0,
  "status" text DEFAULT 'active', "updatedAt" text DEFAULT (datetime('now')));`)
catalogDb.exec(`CREATE TABLE IF NOT EXISTS "IngestState" (
  "channelId" text PRIMARY KEY NOT NULL, "offsetId" integer NOT NULL,
  "fetchedCount" integer DEFAULT 0, "updatedAt" text DEFAULT (datetime('now')));`)
catalogDb.close()
console.log('   ✓ catalog.db done')

// market.db
console.log('2/3 market.db')
const marketDb = new Database(MARKET_DB)
applyPragmas(marketDb)
marketDb.exec(`CREATE TABLE IF NOT EXISTS "PriceBar" (
  "source" text NOT NULL, "instrument" text NOT NULL, "timeframe" text NOT NULL,
  "timestamp" integer NOT NULL, "open" real NOT NULL, "high" real NOT NULL,
  "low" real NOT NULL, "close" real NOT NULL, "volume" real DEFAULT 0,
  "fetchedAt" text DEFAULT (datetime('now')),
  PRIMARY KEY ("source", "instrument", "timeframe", "timestamp"));`)
marketDb.close()
console.log('   ✓ market.db done')

// audit.db
console.log('3/3 audit.db')
const auditDb = new Database(AUDIT_DB)
applyPragmas(auditDb)
auditDb.exec(`CREATE TABLE IF NOT EXISTS "Message" (
  "id" text PRIMARY KEY NOT NULL, "channelId" text NOT NULL, "telegramMessageId" integer NOT NULL,
  "rawText" text NOT NULL, "rawJson" text DEFAULT '{}', "senderId" text, "senderName" text,
  "hasMedia" integer DEFAULT 0, "mediaType" text, "views" integer DEFAULT 0,
  "forwards" integer DEFAULT 0, "reactions" integer DEFAULT 0, "postedAt" text NOT NULL,
  "ingestedAt" text DEFAULT (datetime('now')), "parseStatus" text DEFAULT 'pending',
  "ingestSource" text DEFAULT 'mtproto-tdlib');`)
auditDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "Message_channelId_telegramMessageId_unique" ON "Message" ("channelId", "telegramMessageId");`)
auditDb.exec(`CREATE INDEX IF NOT EXISTS "Message_channelId_postedAt_idx" ON "Message" ("channelId", "postedAt");`)
auditDb.exec(`CREATE INDEX IF NOT EXISTS "Message_postedAt_idx" ON "Message" ("postedAt");`)
auditDb.exec(`CREATE INDEX IF NOT EXISTS "Message_ingestedAt_idx" ON "Message" ("ingestedAt");`)
auditDb.exec(`CREATE TABLE IF NOT EXISTS "Signal" (
  "id" text PRIMARY KEY NOT NULL, "messageId" text NOT NULL, "channelId" text NOT NULL,
  "instrument" text NOT NULL, "instrumentType" text NOT NULL, "action" text NOT NULL,
  "entryPrice" real NOT NULL, "entryLow" real, "entryHigh" real, "isRange" integer DEFAULT 0,
  "stopLoss" real NOT NULL, "takeProfits" text NOT NULL, "positionSize" text,
  "leverage" text, "timeframe" text, "confidence" real DEFAULT 0,
  "parserVersion" text DEFAULT 'regex-nlp-v1.4', "parsedAt" text DEFAULT (datetime('now')),
  "status" text DEFAULT 'evaluating', "notes" text, "dedupHash" text NOT NULL);`)
auditDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "Signal_dedupHash_unique" ON "Signal" ("dedupHash");`)
auditDb.exec(`CREATE INDEX IF NOT EXISTS "Signal_messageId_idx" ON "Signal" ("messageId");`)
auditDb.exec(`CREATE INDEX IF NOT EXISTS "Signal_channelId_parsedAt_idx" ON "Signal" ("channelId", "parsedAt");`)
auditDb.exec(`CREATE INDEX IF NOT EXISTS "Signal_channelId_status_idx" ON "Signal" ("channelId", "status");`)
auditDb.exec(`CREATE INDEX IF NOT EXISTS "Signal_status_idx" ON "Signal" ("status");`)
auditDb.exec(`CREATE INDEX IF NOT EXISTS "Signal_instrument_instrumentType_idx" ON "Signal" ("instrument", "instrumentType");`)
auditDb.exec(`CREATE TABLE IF NOT EXISTS "Evaluation" (
  "id" text PRIMARY KEY NOT NULL, "signalId" text NOT NULL, "outcome" text NOT NULL,
  "exitPrice" real, "exitReason" text, "hitTpLevel" integer, "maxFavorablePct" real,
  "maxAdversePct" real, "rMultiple" real NOT NULL, "pnlPercent" real NOT NULL,
  "durationMinutes" integer, "marketDataSource" text DEFAULT 'aggregated-feed',
  "evaluatedAt" text DEFAULT (datetime('now')));`)
auditDb.exec(`CREATE UNIQUE INDEX IF NOT EXISTS "Evaluation_signalId_unique" ON "Evaluation" ("signalId");`)
auditDb.exec(`CREATE INDEX IF NOT EXISTS "Evaluation_outcome_idx" ON "Evaluation" ("outcome");`)
auditDb.exec(`CREATE INDEX IF NOT EXISTS "Evaluation_evaluatedAt_idx" ON "Evaluation" ("evaluatedAt");`)
auditDb.close()
console.log('   ✓ audit.db done')
console.log('\n✅ All 3 schemas pushed.')
