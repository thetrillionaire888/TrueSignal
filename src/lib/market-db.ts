// Per-asset database connection manager for market data.
//
// Architecture: instead of a single monolithic market.db, each instrument+timeframe
// combination gets its own SQLite file under db/market/{instrument}_{timeframe}.db.
// This keeps individual files small (e.g., xauusd_m15.db is 8MB, not 100MB+ when
// M1 data is added for all instruments), enables per-instrument backup/restore,
// and avoids SQLite's 10-attached-DB limit.
//
// Each per-asset DB has a single `PriceBar` table with the same schema as before.
// The `source` column distinguishes which data source (dukascopy, binance, yahoo)
// each bar came from — all sources for one instrument+timeframe live in one file.
//
// Connections are cached per (instrument, timeframe) — opening a DB is expensive,
// so once opened, the connection stays in the cache for the process lifetime.
//
// Runtime-aware: uses bun:sqlite under Bun, better-sqlite3 under Node.js.

import { resolve, dirname, join } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const isBun = typeof (globalThis as any).Bun !== "undefined";

const __dirname = isBun
  ? (import.meta as any).dir
  : dirname(fileURLToPath(import.meta.url));

const DB_DIR = process.env.DB_DIR
  ? resolve(process.env.DB_DIR)
  : resolve(__dirname, "../../db");

export const MARKET_DIR = resolve(DB_DIR, "market");

// Ensure the market directory exists
if (!existsSync(MARKET_DIR)) {
  mkdirSync(MARKET_DIR, { recursive: true });
}

// ── Schema ──────────────────────────────────────────────────────────────────
export const PRICEBAR_SCHEMA = `
  CREATE TABLE IF NOT EXISTS PriceBar (
    source TEXT NOT NULL,
    instrument TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL DEFAULT 0,
    fetchedAt TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (source, instrument, timeframe, timestamp)
  )
`;

const PRICEBAR_INDEX = `
  CREATE INDEX IF NOT EXISTS idx_pricebar_timestamp
  ON PriceBar (timestamp)
`;

// ── Connection type ──────────────────────────────────────────────────────────
type SQLiteConnection = {
  exec(sql: string): void;
  prepare(sql: string): any;
  transaction<T>(fn: () => T): () => T;
  close(): void;
  readonly: boolean;
};

// ── Connection cache ─────────────────────────────────────────────────────────
const connectionCache = new Map<string, SQLiteConnection>();

function sanitizeFilename(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function dbKey(instrument: string, timeframe: string): string {
  return `${sanitizeFilename(instrument)}_${sanitizeFilename(timeframe)}`;
}

function dbPath(instrument: string, timeframe: string): string {
  return join(MARKET_DIR, `${dbKey(instrument, timeframe)}.db`);
}

async function createConnection(dbPath: string): Promise<SQLiteConnection> {
  let conn: SQLiteConnection;
  if (isBun) {
    const { Database } = await import("bun:sqlite");
    conn = new Database(dbPath) as unknown as SQLiteConnection;
  } else {
    const Database = (await import("better-sqlite3")).default;
    conn = new Database(dbPath) as unknown as SQLiteConnection;
  }

  // Apply PRAGMAs for performance
  conn.exec("PRAGMA journal_mode = WAL;");
  conn.exec("PRAGMA synchronous = NORMAL;");
  conn.exec("PRAGMA cache_size = -65536;");
  conn.exec("PRAGMA mmap_size = 268435456;");
  conn.exec("PRAGMA temp_store = MEMORY;");
  conn.exec("PRAGMA busy_timeout = 10000;");

  // Ensure schema exists
  conn.exec(PRICEBAR_SCHEMA);
  conn.exec(PRICEBAR_INDEX);

  return conn;
}

/**
 * Get a cached (or create a new) SQLite connection for a specific
 * instrument + timeframe. Connections are cached for the process lifetime.
 */
export async function getMarketDb(
  instrument: string,
  timeframe: string
): Promise<SQLiteConnection> {
  const key = dbKey(instrument, timeframe);
  if (!connectionCache.has(key)) {
    const path = dbPath(instrument, timeframe);
    const conn = await createConnection(path);
    connectionCache.set(key, conn);
  }
  return connectionCache.get(key)!;
}

/**
 * Get a synchronous connection — for Bun only (bun:sqlite is sync).
 * Under Node.js/better-sqlite3, this also works synchronously.
 * Use this in prepared-statement initialization where async is impractical.
 */
export function getMarketDbSync(instrument: string, timeframe: string): SQLiteConnection {
  const key = dbKey(instrument, timeframe);
  if (!connectionCache.has(key)) {
    const path = dbPath(instrument, timeframe);
    // Synchronous creation — both bun:sqlite and better-sqlite3 support sync
    let conn: SQLiteConnection;
    if (isBun) {
      const { Database } = require("bun:sqlite");
      conn = new Database(path) as unknown as SQLiteConnection;
    } else {
      const Database = require("better-sqlite3").default;
      conn = new Database(path) as unknown as SQLiteConnection;
    }
    conn.exec("PRAGMA journal_mode = WAL;");
    conn.exec("PRAGMA synchronous = NORMAL;");
    conn.exec("PRAGMA cache_size = -65536;");
    conn.exec("PRAGMA mmap_size = 268435456;");
    conn.exec("PRAGMA temp_store = MEMORY;");
    conn.exec("PRAGMA busy_timeout = 10000;");
    conn.exec(PRICEBAR_SCHEMA);
    conn.exec(PRICEBAR_INDEX);
    connectionCache.set(key, conn);
  }
  return connectionCache.get(key)!;
}

/**
 * List all per-asset DB files in the market directory.
 * Returns array of { instrument, timeframe, filename, path }.
 */
export function listMarketDbs(): Array<{
  instrument: string;
  timeframe: string;
  filename: string;
  path: string;
}> {
  if (!existsSync(MARKET_DIR)) return [];
  return readdirSync(MARKET_DIR)
    .filter((f) => f.endsWith(".db"))
    .map((f) => {
      // Parse filename: {instrument}_{timeframe}.db
      const base = f.slice(0, -3); // strip .db
      const lastUnderscore = base.lastIndexOf("_");
      if (lastUnderscore === -1) return null;
      const instrument = base.slice(0, lastUnderscore);
      const timeframe = base.slice(lastUnderscore + 1);
      return { instrument, timeframe, filename: f, path: join(MARKET_DIR, f) };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);
}

/**
 * Close all cached connections. Called on process exit.
 */
export function closeAllMarketDbs(): void {
  for (const [, conn] of connectionCache) {
    try {
      conn.close();
    } catch {
      // ignore close errors
    }
  }
  connectionCache.clear();
}

// ── Synchronous driver loading for getMarketDbSync ─────────────────────────
// Pre-load the driver so getMarketDbSync doesn't need async require
if (isBun) {
  // bun:sqlite is built-in
} else {
  // Pre-cache better-sqlite3
  try {
    require("better-sqlite3");
  } catch {
    // will error on first use if not installed
  }
}
