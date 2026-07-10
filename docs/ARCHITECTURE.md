# Architecture

## Overview

TrueSignal uses a two-service architecture with a shared SQLite database, fronted by a Caddy reverse-proxy gateway.

```
┌─────────────────────────────────────────────────────────────────┐
│                         Browser (port 81)                        │
│  Next.js App (port 3000)  ←── Caddy Gateway ──→  Collector (3001)│
│                                                                   │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────────────┐ │
│  │  Dashboard  │  │  Ingest UI   │  │  Data Manager           │ │
│  │  (charts)   │  │  (auth+ctrl) │  │  (import/export/analyze)│ │
│  └──────┬──────┘  └──────┬───────┘  └───────────┬─────────────┘ │
│         │                │ Socket.IO             │               │
│         ▼                ▼                       ▼               │
│  ┌─────────────────────────────────────────────────────────────┐│
│  │              SQLite Database (shared)                        ││
│  │  Channel · Message · Signal · Evaluation · PriceBar         ││
│  └─────────────────────────────────────────────────────────────┘│
└─────────────────────────────────────────────────────────────────┘
```

## Services

### 1. Next.js App (port 3000)

The user-facing web application built with Next.js 16 (App Router). Provides:

- **Dashboard views** — Overview, Channels, Signals, Analytics, Pipeline
- **Ingest view** — Telegram authentication, channel resolution, ingestion with pause/resume/stop
- **Data Manager** — Import from multiple sources, export in multiple formats, browse cached data
- **API routes** — `/api/overview`, `/api/channels`, `/api/signals`, `/api/analytics`, `/api/export`, `/api/pipeline`

### 2. Telegram Collector (port 3001)

A standalone Bun mini-service at `mini-services/telegram-collector/`. Provides:

- **MTProto authentication** — interactive phone/code/2FA login via teleproto
- **Channel ingestion** — fetch message history via `messages.GetHistory`, serialize to JSON, insert to SQLite
- **Signal parsing** — regex/NLP extraction of instrument, action, entry (single or range), SL, TPs
- **Signal evaluation** — fetch historical OHLC bars from Dukascopy, determine win/loss, R-multiple, MFE/MAE
- **Multi-source data import** — Dukascopy, Binance, Yahoo Finance, CSV
- **Real-time progress** — Socket.IO events for ingestion and evaluation progress

### 3. Caddy Gateway (port 81)

A reverse proxy that exposes a single port externally and routes to both services based on the `XTransformPort` query parameter. See [Deployment Guide](./DEPLOYMENT.md) for details.

## Database

All services share a single SQLite database file at `db/custom.db`. The schema is defined in `prisma/schema.prisma` and managed by Prisma ORM.

| Model | Description |
|-------|-------------|
| `Channel` | Telegram channel/group/supergroup under audit |
| `Message` | Raw Telegram message with full JSON serialization (sender, timestamp, text, media, views, reactions) |
| `Signal` | Parsed trading signal — instrument, action, entry (single or range), SL, TPs, leverage, timeframe. `dedupHash` (channelId + postedAt) prevents duplicates |
| `Evaluation` | Outcome evaluation against historical bars — win/loss, R-multiple, MFE/MAE, duration, exit reason |
| `PriceBar` | Cached OHLC bars from any source (Dukascopy, Binance, Yahoo, CSV) with `source` tracking |

## Data flow

```
Telegram → Collector (MTProto) → Message table → Parser → Signal table
                                                              ↓
                                         Dukascopy API → PriceBar cache
                                                              ↓
                                                    Evaluator → Evaluation table
                                                              ↓
                                         Next.js API → Dashboard charts
```

1. **Ingest**: Collector fetches messages via MTProto, stores raw JSON in `Message` table
2. **Parse**: Parser extracts signal data (instrument, entry, SL, TPs) from message text, stores in `Signal` table
3. **Evaluate**: Evaluator fetches historical OHLC bars from Dukascopy (cached in `PriceBar`), walks through bars to determine SL/TP hit, stores result in `Evaluation` table
4. **Analyze**: Next.js API reads from all tables, computes metrics (win rate, Sharpe, Calmar, equity curves), serves to dashboard

## Technology stack

| Layer | Technology |
|-------|-----------|
| Framework | Next.js 16 (App Router) |
| Language | TypeScript 5 |
| Styling | Tailwind CSS 4 + shadcn/ui (New York) |
| Database | SQLite (Prisma ORM) |
| State | Zustand (client) + TanStack Query (server) |
| Charts | Recharts |
| Telegram | teleproto (MTProto client) |
| Market data | dukascopy-node, Binance REST API, Yahoo Finance API |
| Real-time | Socket.IO |
| Export | SheetJS (xlsx) |
