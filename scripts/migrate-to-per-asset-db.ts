/**
 * Migrate market.db → per-asset databases (db/market/{instrument}_{timeframe}.db)
 *
 * Reads all rows from the existing market.db.PriceBar table, groups them by
 * (instrument, timeframe), and creates a separate SQLite database for each
 * group with the same PriceBar schema.
 *
 * The old market.db is NOT deleted — it's kept as a backup.
 *
 * Usage:  bun scripts/migrate-to-per-asset-db.ts
 */
import { Database } from "bun:sqlite";
import { resolve, dirname } from "node:path";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = (import.meta as any).dir ?? dirname(fileURLToPath(import.meta.url));
const DB_DIR = resolve(__dirname, "../db");
const OLD_MARKET_DB = resolve(DB_DIR, "market.db");
const NEW_MARKET_DIR = resolve(DB_DIR, "market");

const PRICEBAR_SCHEMA = `
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

function sanitizeFilename(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
}

function main() {
  if (!existsSync(OLD_MARKET_DB)) {
    console.error(`Error: ${OLD_MARKET_DB} not found`);
    process.exit(1);
  }

  // Create the new market directory
  if (!existsSync(NEW_MARKET_DIR)) {
    mkdirSync(NEW_MARKET_DIR, { recursive: true });
  }

  // Check if market dir already has DBs (migration already run?)
  const existingFiles = readdirSync(NEW_MARKET_DIR).filter(f => f.endsWith(".db"));
  if (existingFiles.length > 0) {
    console.warn(`Warning: ${NEW_MARKET_DIR} already contains ${existingFiles.length} .db file(s):`);
    existingFiles.forEach(f => console.warn(`  - ${f}`));
    console.warn("Delete them first if you want to re-run the migration.\n");
  }

  // Open old market.db
  const oldDb = new Database(OLD_MARKET_DB, { readonly: true });
  oldDb.exec("PRAGMA journal_mode = WAL;");

  // Get all groups
  const groups = oldDb.prepare(`
    SELECT instrument, timeframe, COUNT(*) as cnt,
           MIN(timestamp) as earliest, MAX(timestamp) as latest
    FROM PriceBar
    GROUP BY instrument, timeframe
    ORDER BY instrument, timeframe
  `).all() as Array<{
    instrument: string; timeframe: string; cnt: number;
    earliest: number; latest: number;
  }>;

  const totalBars = groups.reduce((sum, g) => sum + g.cnt, 0);
  console.log(`\nMigrating ${totalBars} bars from ${OLD_MARKET_DB}`);
  console.log(`  into ${groups.length} per-asset databases in ${NEW_MARKET_DIR}/\n`);

  let migratedBars = 0;

  for (const g of groups) {
    const filename = `${sanitizeFilename(g.instrument)}_${sanitizeFilename(g.timeframe)}.db`;
    const dbPath = resolve(NEW_MARKET_DIR, filename);

    // Create the new per-asset DB
    const newDb = new Database(dbPath);
    newDb.exec("PRAGMA journal_mode = WAL;");
    newDb.exec("PRAGMA synchronous = NORMAL;");
    newDb.exec(PRICEBAR_SCHEMA);
    newDb.exec(PRICEBAR_INDEX);

    // Insert all rows for this group
    const insertStmt = newDb.prepare(`
      INSERT OR IGNORE INTO PriceBar
        (source, instrument, timeframe, timestamp, open, high, low, close, volume, fetchedAt)
      VALUES ($source, $instrument, $timeframe, $timestamp, $open, $high, $low, $close, $volume, $fetchedAt)
    `);

    const rows = oldDb.prepare(`
      SELECT source, instrument, timeframe, timestamp, open, high, low, close, volume, fetchedAt
      FROM PriceBar
      WHERE instrument = ? AND timeframe = ?
      ORDER BY timestamp ASC
    `).all(g.instrument, g.timeframe) as Array<any>;

    const insertMany = newDb.transaction(() => {
      let inserted = 0;
      for (const r of rows) {
        const result = insertStmt.run({
          $source: r.source,
          $instrument: r.instrument,
          $timeframe: r.timeframe,
          $timestamp: r.timestamp,
          $open: r.open,
          $high: r.high,
          $low: r.low,
          $close: r.close,
          $volume: r.volume,
          $fetchedAt: r.fetchedAt,
        });
        if (result.changes > 0) inserted++;
      }
      return inserted;
    });

    const inserted = insertMany();
    migratedBars += inserted;

    // Verify count
    const verifyCount = newDb.prepare("SELECT COUNT(*) as c FROM PriceBar").get() as { c: number };

    newDb.close();

    const pct = ((g.cnt / totalBars) * 100).toFixed(1);
    console.log(`  ${filename.padEnd(25)}  ${verifyCount.c > 0 ? "✓" : "✗"}  ${String(g.cnt).padStart(6)} bars  (${pct}%)  inserted=${inserted}`);
  }

  oldDb.close();

  console.log(`\n${"─".repeat(60)}`);
  console.log(`Migration complete!`);
  console.log(`  Total bars migrated: ${migratedBars} / ${totalBars}`);
  console.log(`  Per-asset DBs created: ${groups.length}`);
  console.log(`  Location: ${NEW_MARKET_DIR}/`);
  console.log(`\n  Old market.db kept as backup: ${OLD_MARKET_DB}`);
  console.log(`  (Delete it manually after verifying everything works.)`);

  // List final files
  console.log(`\nFiles in ${NEW_MARKET_DIR}/:`);
  for (const f of readdirSync(NEW_MARKET_DIR).filter(f => f.endsWith(".db")).sort()) {
    const stat = new Database(resolve(NEW_MARKET_DIR, f), { readonly: true });
    const count = (stat.prepare("SELECT COUNT(*) as c FROM PriceBar").get() as { c: number }).c;
    stat.close();
    console.log(`  ${f.padEnd(25)}  ${count} bars`);
  }
}

main();
