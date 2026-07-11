// Unified database connection layer — used by BOTH the Next.js frontend AND
// the telegram-collector mini-service.
//
// Architecture: 2 SQLite databases (audit + catalog) on this connection,
// plus per-asset market DBs managed by @/lib/market-db.
//   - audit.db   : Messages + Signals + Evaluations (high-write + high-read)
//   - catalog.db : Channels + ChannelStats + IngestState (read-heavy, rare writes)
//   - market/    : Per-asset PriceBar DBs (db/market/{instrument}_{timeframe}.db)
//                  Managed separately by @/lib/market-db — NOT ATTACH'd here
//                  (avoids SQLite's 10-attached-DB limit when many instruments)
//
// audit.db + catalog.db are ATTACH'd to a single SQLite connection so cross-DB
// queries like `SELECT * FROM catalog.Channel` work natively. Each DB has its
// own WAL file → independent writer locks → ingestion can write Messages while
// the evaluator writes Evaluations with zero contention.
//
// Runtime-aware driver selection:
//   - Bun (collector process)     → bun:sqlite (native, faster)
//   - Node.js (Next.js dev server) → better-sqlite3 (Node-compatible)

import { resolve, dirname } from 'node:path'
import { existsSync, mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import * as auditSchema from './schema/audit'
import * as catalogSchema from './schema/catalog'
import * as marketSchema from './schema/market'

// ── Runtime detection ───────────────────────────────────────────────────────
const isBun = typeof (globalThis as any).Bun !== 'undefined'

// Cross-runtime __dirname (import.meta.dir is Bun-only)
const __dirname = isBun
  ? (import.meta as any).dir
  : dirname(fileURLToPath(import.meta.url))

// ── DB path resolution ──────────────────────────────────────────────────────
const DB_DIR = process.env.DB_DIR
  ? resolve(process.env.DB_DIR)
  : resolve(__dirname, '../../db')

if (!existsSync(DB_DIR)) {
  mkdirSync(DB_DIR, { recursive: true })
}

export const AUDIT_DB_PATH = resolve(DB_DIR, 'audit.db')
export const CATALOG_DB_PATH = resolve(DB_DIR, 'catalog.db')
export const MARKET_DB_PATH = resolve(DB_DIR, 'market.db')

// ── Runtime-aware driver loading ────────────────────────────────────────────
type SQLiteConnection = {
  exec(sql: string): void
  prepare(sql: string): any
  transaction<T>(fn: () => T): () => T
  close(): void
}

let sqlite: SQLiteConnection
let db: any

if (isBun) {
  const { Database } = await import('bun:sqlite')
  const { drizzle } = await import('drizzle-orm/bun-sqlite')
  sqlite = new Database(AUDIT_DB_PATH) as unknown as SQLiteConnection
  db = drizzle(sqlite as any, {
    schema: { ...auditSchema, ...catalogSchema, ...marketSchema },
  })
} else {
  const Database = (await import('better-sqlite3')).default
  const { drizzle } = await import('drizzle-orm/better-sqlite3')
  sqlite = new Database(AUDIT_DB_PATH) as unknown as SQLiteConnection
  db = drizzle(sqlite as any, {
    schema: { ...auditSchema, ...catalogSchema, ...marketSchema },
  })
}

// ── PRAGMAs (applied once; ATTACH'd DBs inherit them) ──────────────────────
sqlite.exec('PRAGMA journal_mode = WAL;')
sqlite.exec('PRAGMA synchronous = NORMAL;')
sqlite.exec('PRAGMA cache_size = -65536;')
sqlite.exec('PRAGMA mmap_size = 268435456;')
sqlite.exec('PRAGMA temp_store = MEMORY;')
sqlite.exec('PRAGMA busy_timeout = 10000;')

// ATTACH catalog.db (market data is now in per-asset DBs — see @/lib/market-db)
sqlite.exec(`ATTACH '${CATALOG_DB_PATH}' AS catalog;`)

export { sqlite, db }

// Re-export schema tables + types
export { messages, signals, evaluations } from './schema/audit'
export { channels, channelStats, ingestState } from './schema/catalog'
export { priceBars } from './schema/market'

export type { Message, NewMessage, Signal, NewSignal, Evaluation, NewEvaluation } from './schema/audit'
export type { Channel, NewChannel, ChannelStats, NewChannelStats, IngestState, NewIngestState } from './schema/catalog'
export type { PriceBar, NewPriceBar } from './schema/market'
