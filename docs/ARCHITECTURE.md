# Architecture

## Overview

TrueSignal uses a two-service architecture with a per-asset SQLite database backend, fronted by an optional Caddy reverse-proxy gateway.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Browser                                      │
│                                                                      │
│  Next.js App (port 3000)  ←── Caddy (port 81, optional) ──→  Collector (3001)│
│                                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────────┐ │
│  │  Dashboard  │  │  Ingest UI   │  │  Data Manager               │ │
│  │  (charts)   │  │  (auth+ctrl) │  │  (fetch/import/export/analyze)│ │
│  └──────┬──────┘  └──────┬───────┘  └───────────┬─────────────────┘ │
│         │                │ Socket.IO             │                   │
│         ▼                ▼                       ▼                   │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │              SQLite Databases                                   ││
│  │  audit.db:   Message · Signal · Evaluation (ATTACH'd)          ││
│  │  catalog.db: Channel · ChannelStats · IngestState (ATTACH'd)   ││
│  │  market/     Per-asset DBs (xauusd_m1.db, btcusd_m15.db, ...)   ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

## Services

### 1. Next.js App (port 3000)

The user-facing web application built with Next.js 16 (App Router). Provides:

- **Dashboard views** — Overview, Channels, Signals (sortable), Analytics, Pipeline
- **Ingest view** — Telegram authentication, channel resolution, ingestion with pause/resume/stop
- **Data Manager** — 5 tabs: Fetch, Import (CSV upload), Browse, Export, Analyze
- **API routes** — `/api/overview`, `/api/channels`, `/api/signals`, `/api/analytics`, `/api/export`, `/api/pipeline`, `/api/import-csv-stream`
- **Sidebar auth status** — Telegram auth state visible on all views

### 2. Telegram Collector (port 3001)

A standalone Bun mini-service at `mini-services/telegram-collector/`. Provides:

- **MTProto authentication** — interactive phone/code/2FA login via teleproto
- **Channel ingestion** — fetch message history via `messages.GetHistory`, serialize to JSON, insert to SQLite
- **Multi-stage signal parsing** — 3-stage cascade: keyword-structured, action-anchored, price-proximity (punctuation-tolerant)
- **M1-first evaluation** — uses M1 bars (highest resolution) when available, M15 fallback; 8-worker parallel evaluation
- **Multi-source data fetching** — priority-based: Crypto (Binance, Dukascopy), Non-crypto (Dukascopy, Yahoo)
- **Chunked CSV import** — handles 400MB+ files via 5MB chunked upload with streaming parser
- **Real-time progress** — Socket.IO events for ingestion, evaluation, and import progress

### 3. Caddy Gateway (port 81, optional)

A reverse proxy that exposes a single port externally and routes to both services based on the `XTransformPort` query parameter. Configured with 30-minute timeouts and streaming flush for large file uploads. If Caddy is not installed, Next.js rewrites handle the proxying automatically.

## Database architecture

TrueSignal uses **2 ATTACH'd SQLite databases** plus **per-asset market databases** — each with independent WAL locks for concurrent read/write.

### Why per-asset databases?

| Problem | Solution |
|---------|----------|
| Single market.db grows to 400MB+ with M1 data | Split into per-asset files (e.g. `xauusd_m1.db` = 117 MB) |
| SQLite ATTACH limit (10 DBs) | Each market connection is independent — no limit |
| Want to backup/restore one instrument | Per-asset files can be copied individually |
| Want to inspect one instrument in SQLite Browser | Open the specific .db file directly |

### Database layout

```
db/
├── audit.db          ← Primary connection (no prefix in SQL)
├── catalog.db        ← ATTACH'd as "catalog" (use catalog.Channel in SQL)
├── market.db         ← Old single DB (backup only, not used)
└── market/           ← Per-asset databases (managed by @/lib/market-db.ts)
    ├── xauusd_m1.db      (M1 bars for XAUUSD — all sources merged)
    ├── xauusd_m15.db     (M15 bars for XAUUSD)
    ├── btcusd_m15.db     (M15 bars for BTCUSD)
    └── ... (one per instrument+timeframe)
```

### Connection layer

**`src/lib/db.ts`** — runtime-aware driver for audit.db + catalog.db:
- **Bun** (collector process) -> `bun:sqlite` (native, faster)
- **Node.js** (Next.js dev server) -> `better-sqlite3` (Node-compatible)
- Both share the same connection with ATTACH. PRAGMAs: WAL, synchronous=NORMAL, cache_size=64MB, mmap_size=256MB, temp_store=MEMORY, busy_timeout=10s.

**`src/lib/market-db.ts`** — per-asset connection manager:
- `getMarketDbSync(instrument, timeframe)` — opens and caches a connection to `db/market/{instrument}_{timeframe}.db`
- `listMarketDbs()` — enumerates all per-asset DB files
- Each DB has the same `PriceBar` table schema with composite PK `(source, instrument, timeframe, timestamp)`
- The `source` column tracks provenance (dukascopy, binance, yahoo) — all sources for one instrument+timeframe live in one file

### Schema overview

#### audit.db

| Table | Description | Key Indexes |
|-------|-------------|-------------|
| `Message` | Raw Telegram message with full JSON serialization | `(channelId, telegramMessageId)` unique, `(channelId, postedAt)`, `(postedAt)`, `(ingestedAt)` |
| `Signal` | Parsed trading signal — instrument, action, entry, SL, TPs, entryType | `dedupHash` unique, `(messageId)`, `(channelId, parsedAt)`, `(channelId, status)`, `(status)`, `(instrument, instrumentType)` |
| `Evaluation` | Outcome evaluation — win/loss, R-multiple, MFE/MAE, duration, marketDataSource | `signalId` unique, `(outcome)`, `(evaluatedAt)` |

#### catalog.db

| Table | Description |
|-------|-------------|
| `Channel` | Static identity — telegramId, name, type, category, description, avatarColor |
| `ChannelStats` | Volatile counters — subscriberCount, lastMessageAt, messageCount, signalCount, status |
| `IngestState` | Resume position per channel — offsetId, fetchedCount |

#### market/{instrument}_{timeframe}.db

| Table | Description |
|-------|-------------|
| `PriceBar` | Cached OHLC bars — composite PK `(source, instrument, timeframe, timestamp)` for clustered range scans. The `source` column distinguishes data provenance (dukascopy, binance, yahoo). |

## Multi-stage parser

The parser uses a 3-stage cascade pipeline — short-circuits on first success:

```
parseSignal(text)
  ├─ Stage 1: Keyword-structured    → "Entry: X | SL: Y | TP: Z"        (confidence >=0.8)
  ├─ Stage 2: Action-anchored       → "BUY @ X", "SELL NOW @ X-Y", "BUY 4099 4095" (confidence >=0.6)
  ├─ Stage 3: Price-proximity       → SL keyword + nearby prices         (confidence >=0.4)
  └─ return first success, or null
```

**Entry types detected**: `market`, `stop`, `limit`, `range` — stored in the `notes` field as `entryType:market|stop|limit|range`.

**Punctuation tolerance**: The action-price regex tolerates `!`, `@`, `:`, `.`, spaces, and dashes between the action keyword and the price number (e.g. "Sell now ! 4095" works).

**Range detection**: Supports dash-separated ranges ("BUY 4095 - 4099"), "to" keyword ("BUY 4095 to 4099"), and space-separated two-number ranges ("BUY 4099 4095").

**TP extraction**: Handles multi-line TP format ("TP 4105\nTP 4110\nTP 4115"), TP level numbers ("TP1: 4105"), and "TP: Open" (derives 1R/2R only if no explicit TPs are found).

## M1-first evaluator

The evaluator applies different fill logic based on `entryType`:

| Entry Type | Fill Condition (Long) | Fill Condition (Short) |
|------------|----------------------|----------------------|
| market | Immediate (bar 0) | Immediate (bar 0) |
| stop | `bar.high >= entry` (breakout up) | `bar.low <= entry` (breakout down) |
| limit | `bar.low <= entry` (pullback down) | `bar.high >= entry` (pullback up) |
| range | Price touches range (conservative fill at edge closest to SL) | Same |

### Timeframe strategy (M1-first with M15 fallback)

1. **Try M1 first** — highest resolution (~2,880 bars per 48h window). Used when high-quality M1 data has been imported (e.g. Dukascopy CSV via the Import tab).
2. **Fall back to M15** — ~192 bars per 48h window. Used when only API-fetched data is available (backward compatible with existing cache).

The `marketDataSource` field in the Evaluation table records which source+timeframe was used (e.g. `dukascopy-m1`, `binance-m15`, `yahoo-m15`).

Runs 8 workers in parallel with batched transactional writes (25 per batch). Signals with `no_data` outcome are automatically retried on subsequent batch evaluations.

## Multi-source data fetching

Source priority is determined by instrument category:

| Instrument Type | 1st Source | 2nd Source | 3rd Source |
|----------------|-----------|-----------|-----------|
| Crypto (BTC, ETH, ...) | Binance REST (3 retries) | Binance Vision archive | Dukascopy (5s timeout) |
| Forex/Metals/Indices/Energy | Dukascopy (5s timeout) | Yahoo Finance (2 retries) | — |

Each source has its own timeout and retry logic. Bars are stored with the correct `source` label in `PriceBar.source`.

## Metrics engine

- **winRate**: `wins / (wins + losses)` — excludes breakevens from denominator
- **maxDrawdown**: Per-trade calculation (captures intra-day peaks, not daily aggregation)
- **Equity curve**: Uses `postedAt` (not `evaluatedAt`), gap-fills with continuous daily range
- **Sharpe**: Per-trade R-multiple ratio = `mean(R) / std(R)` — NOT annualized (R-multiples are normalized risk units, not percentage returns)
- **Sortino**: `mean(R) / downside_deviation` where `downside_deviation = sqrt(mean(min(0, R)^2))` over ALL trades
- **Calmar**: `totalR / maxDrawdown` — not annualized

## Chunked CSV import

For large CSV files (400MB+), the Import tab uses a chunked upload system:

```
Frontend:                              Backend:
file.slice(0, 5MB)   → POST chunk 1/89 → create session + feed to StreamingCsvParser
file.slice(5MB, 10MB) → POST chunk 2/89 → feed to parser (batch-insert 5K bars)
...                                              ...
file.slice(440MB, 441MB) → POST chunk 89/89 (isLast) → finish + return results
```

- Each request is ~5MB — well within any proxy/server limit
- The `StreamingCsvParser` maintains state across chunks (only current line + 5K-bar batch in memory)
- Memory stays flat (~25MB) regardless of file size
- Auto-detects CSV format (StrategyQuant, ISO 8601, Unix epoch, Bid/Ask) and timeframe

## Data flow

```
Telegram → Collector (MTProto) → Message table (audit.db) → Parser → Signal table (audit.db)
                                                                    ↓
                      Multi-source fetch (Binance/Dukascopy/Yahoo) → Per-asset market DBs
                                                                    ↓
                                          Evaluator (8-worker parallel, M1-first) → Evaluation table (audit.db)
                                                                    ↓
                                          Next.js API → Metrics engine → Dashboard charts
```

1. **Ingest**: Collector fetches messages via MTProto, stores raw JSON in `Message` table
2. **Parse**: Multi-stage parser extracts signal data (instrument, entry, SL, TPs, entryType) from message text, stores in `Signal` table
3. **Import/Fetch**: Market data is fetched from multiple sources (Binance, Dukascopy, Yahoo) or imported from CSV files, stored in per-asset market DBs
4. **Evaluate**: Evaluator fetches historical OHLC bars (M1 first, M15 fallback), applies entry-type-aware fill logic, walks through bars to determine SL/TP hit, stores result in `Evaluation` table
5. **Analyze**: Next.js API reads from all tables via cross-DB joins, computes metrics (win rate, Sharpe, Sortino, Calmar, per-trade drawdown, equity curves), serves to dashboard

## Technology stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 |
| Styling | Tailwind CSS 4 + shadcn/ui (New York) |
| Database | SQLite (2 ATTACH'd + per-asset market DBs, Drizzle ORM) |
| DB Driver | bun:sqlite (Bun) / better-sqlite3 (Node.js) — runtime-aware |
| State | Zustand (client) + TanStack Query (server) |
| Charts | Recharts |
| Telegram | teleproto (MTProto client) |
| Market data | dukascopy-node, Binance REST API, Binance Vision archive, Yahoo Finance API |
| Real-time | Socket.IO |
| Export | SheetJS (xlsx) |
| CSV parsing | Custom StreamingCsvParser (line-by-line, auto-format-detection) |
