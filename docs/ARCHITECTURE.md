# Architecture

## Overview

TrueSignal uses a two-service architecture with a 3-database SQLite backend, fronted by an optional Caddy reverse-proxy gateway.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         Browser                                      │
│                                                                      │
│  Next.js App (port 3000)  ←── Caddy (port 81, optional) ──→  Collector (3001)│
│                                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────────┐ │
│  │  Dashboard  │  │  Ingest UI   │  │  Data Manager               │ │
│  │  (charts)   │  │  (auth+ctrl) │  │  (fetch/export/analyze)     │ │
│  └──────┬──────┘  └──────┬───────┘  └───────────┬─────────────────┘ │
│         │                │ Socket.IO             │                   │
│         ▼                ▼                       ▼                   │
│  ┌─────────────────────────────────────────────────────────────────┐│
│  │              3 SQLite Databases (ATTACH'd)                      ││
│  │  audit.db:   Message · Signal · Evaluation                     ││
│  │  catalog.db: Channel · ChannelStats · IngestState              ││
│  │  market.db:  PriceBar                                          ││
│  └─────────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────────┘
```

## Services

### 1. Next.js App (port 3000)

The user-facing web application built with Next.js 16 (App Router). Provides:

- **Dashboard views** — Overview, Channels, Signals, Analytics, Pipeline
- **Ingest view** — Telegram authentication, channel resolution, ingestion with pause/resume/stop
- **Data Manager** — Fetch from multiple sources, export in multiple formats, browse cached data
- **API routes** — `/api/overview`, `/api/channels`, `/api/signals`, `/api/analytics`, `/api/export`, `/api/pipeline`
- **Sidebar auth status** — Telegram auth state visible on all views (not just Ingest)

### 2. Telegram Collector (port 3001)

A standalone Bun mini-service at `mini-services/telegram-collector/`. Provides:

- **MTProto authentication** — interactive phone/code/2FA login via teleproto
- **Channel ingestion** — fetch message history via `messages.GetHistory`, serialize to JSON, insert to SQLite
- **Multi-stage signal parsing** — 3-stage cascade: keyword-structured → action-anchored → price-proximity
- **Entry-type-aware evaluation** — market/stop/limit/range fill logic with 4-worker parallel evaluation
- **Multi-source data fetching** — Dukascopy, Binance, Yahoo Finance, CSV
- **Real-time progress** — Socket.IO events for ingestion and evaluation progress

### 3. Caddy Gateway (port 81, optional)

A reverse proxy that exposes a single port externally and routes to both services based on the `XTransformPort` query parameter. If Caddy is not installed, Next.js rewrites handle the proxying automatically.

## Database architecture

TrueSignal uses **3 SQLite databases** — each with independent WAL locks for concurrent read/write. All 3 are `ATTACH`'d to a single connection.

### Why 3 databases?

| Problem | Solution |
|---------|----------|
| Single writer lock blocks all writes | 3 independent WAL files = 3 independent writer locks |
| PriceBar bloat contaminates transactional DB | market.db is separate, can be opened read-only |
| Channel row-level write contention | Split into Channel (static) + ChannelStats (volatile) |

### Database layout

```
db/
├── audit.db      ← Primary connection (no prefix in SQL)
├── catalog.db    ← ATTACH'd as "catalog" (use catalog.Channel in SQL)
├── market.db     ← ATTACH'd as "market" (use market.PriceBar in SQL)
└── custom.db     ← Old single DB (backup only, not used)
```

### Connection layer (`src/lib/db.ts`)

Runtime-aware driver selection:
- **Bun** (collector process) → `bun:sqlite` (native, faster)
- **Node.js** (Next.js dev server) → `better-sqlite3` (Node-compatible)

Both share the same connection with ATTACH. PRAGMAs: WAL, synchronous=NORMAL, cache_size=64MB, mmap_size=256MB, temp_store=MEMORY, busy_timeout=10s.

### Schema overview

#### audit.db

| Table | Description | Key Indexes |
|-------|-------------|-------------|
| `Message` | Raw Telegram message with full JSON serialization | `(channelId, telegramMessageId)` unique, `(channelId, postedAt)`, `(postedAt)`, `(ingestedAt)` |
| `Signal` | Parsed trading signal — instrument, action, entry, SL, TPs, entryType | `dedupHash` unique, `(messageId)`, `(channelId, parsedAt)`, `(channelId, status)`, `(status)`, `(instrument, instrumentType)` |
| `Evaluation` | Outcome evaluation — win/loss, R-multiple, MFE/MAE, duration | `signalId` unique, `(outcome)`, `(evaluatedAt)` |

#### catalog.db

| Table | Description |
|-------|-------------|
| `Channel` | Static identity — telegramId, name, type, category, description, avatarColor |
| `ChannelStats` | Volatile counters — subscriberCount, lastMessageAt, messageCount, signalCount, status |
| `IngestState` | Resume position per channel — offsetId, fetchedCount |

**Channel/ChannelStats split**: Static identity fields (rarely updated) are separated from volatile counters (updated on every ingest) to avoid row-level write contention.

#### market.db

| Table | Description |
|-------|-------------|
| `PriceBar` | Cached OHLC bars — composite PK `(source, instrument, timeframe, timestamp)` for clustered range scans. No redundant `id` column. |

## Multi-stage parser

The parser uses a 3-stage cascade pipeline — short-circuits on first success:

```
parseSignal(text)
  ├─ Stage 1: Keyword-structured    → "Entry: X | SL: Y | TP: Z"        (confidence ≥0.8)
  ├─ Stage 2: Action-anchored       → "BUY @ X", "SELL NOW @ X-Y"       (confidence ≥0.6)
  ├─ Stage 3: Price-proximity       → SL keyword + nearby prices         (confidence ≥0.4)
  └─ return first success, or null
```

**Entry types detected**: `market`, `stop`, `limit`, `range` — stored in the `notes` field as `entryType:market|stop|limit|range`.

## Entry-type-aware evaluator

The evaluator applies different fill logic based on `entryType`:

| Entry Type | Fill Condition (Long) | Fill Condition (Short) |
|------------|----------------------|----------------------|
| market | Immediate (bar 0) | Immediate (bar 0) |
| stop | `bar.high ≥ entry` (breakout up) | `bar.low ≤ entry` (breakout down) |
| limit | `bar.low ≤ entry` (pullback down) | `bar.high ≥ entry` (pullback up) |
| range | Price touches range (conservative fill at edge closest to SL) | Same |

Runs 4 workers in parallel with batched transactional writes (25 per batch).

## Metrics engine

- **winRate**: `wins / (wins + losses)` — excludes breakevens from denominator
- **maxDrawdown**: Per-trade calculation (captures intra-day peaks, not daily aggregation)
- **Equity curve**: Uses `postedAt` (not `evaluatedAt`), gap-fills with continuous daily range
- **Sharpe/Sortino**: Daily-aggregated R series, annualized by √252

## Data flow

```
Telegram → Collector (MTProto) → Message table (audit.db) → Parser → Signal table (audit.db)
                                                                    ↓
                                         Dukascopy API → PriceBar cache (market.db)
                                                                    ↓
                                              Evaluator (4-worker parallel) → Evaluation table (audit.db)
                                                                    ↓
                                         Next.js API → Metrics engine → Dashboard charts
```

1. **Ingest**: Collector fetches messages via MTProto, stores raw JSON in `Message` table
2. **Parse**: Multi-stage parser extracts signal data (instrument, entry, SL, TPs, entryType) from message text, stores in `Signal` table
3. **Evaluate**: Evaluator fetches historical OHLC bars from Dukascopy (cached in `PriceBar`), applies entry-type-aware fill logic, walks through bars to determine SL/TP hit, stores result in `Evaluation` table
4. **Analyze**: Next.js API reads from all tables via cross-DB joins, computes metrics (win rate, Sharpe, Calmar, per-trade drawdown, equity curves), serves to dashboard

## Technology stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 |
| Styling | Tailwind CSS 4 + shadcn/ui (New York) |
| Database | SQLite (3 databases, Drizzle ORM) |
| DB Driver | bun:sqlite (Bun) / better-sqlite3 (Node.js) — runtime-aware |
| State | Zustand (client) + TanStack Query (server) |
| Charts | Recharts |
| Telegram | teleproto (MTProto client) |
| Market data | dukascopy-node, Binance REST API, Yahoo Finance API |
| Real-time | Socket.IO |
| Export | SheetJS (xlsx) |
