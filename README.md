# TrueSignal

**Integrity in trading signals — shining light on the truth.**

TrueSignal is a signal audit platform that scrutinizes trading signals — starting with Telegram — and evaluates them against historical market data to reveal their true performance and reliability.

Born from the TrueSignal engine, TrueSignal serves as a beacon of transparency in a world where trading signal claims often go unchecked. By connecting directly to Telegram via MTProto, parsing signals into structured data, and backtesting them against real OHLC bars from Dukascopy, Binance, and Yahoo Finance, TrueSignal exposes whether signals actually work — not just whether they sound good.

---

## Vision

To protect traders by exposing unreliable signals and guiding them toward systematic, quant-driven solutions.

## Mission

- **Audit** Telegram trading channels with integrity and transparency
- **Parse** signals into structured data — single-price entries, range entries, multi-target TPs, market/stop/limit order types
- **Evaluate** each signal against real historical market data using an entry-type-aware conservative fill model
- **Reveal** clear analytics that show the truth behind trading claims — win rate, R-multiple, Sharpe, Calmar, drawdown

## Disclaimer

TrueSignal is for **educational purposes only**. It does not provide financial advice. Use at your own discretion.

---

## Key capabilities

- **MTProto ingestion** — full audit access to Telegram channels, groups, and supergroups via [teleproto](https://github.com/sanyok123456/teleproto) (not the Bot API)
- **Multi-stage signal parser** — 3-stage cascade pipeline (keyword-structured → action-anchored → price-proximity) handles BUY STOP, BUY LIMIT, SELL STOP, SELL LIMIT, BUY RANGE, SELL RANGE, and compact formats
- **Entry-type-aware evaluation** — market orders fill immediately, stop orders fill on breakout, limit orders fill on pullback, range orders fill at conservative edge
- **3-database architecture** — audit.db (signals/evaluations), catalog.db (channels/stats), market.db (price bars) — each with independent WAL locks for concurrent read/write
- **Historical evaluation** — fetches real OHLC bars from Dukascopy (with DB caching for speed) to determine win/loss, R-multiple, MFE/MAE
- **Multi-source data fetching** — Dukascopy, Binance, Yahoo Finance, CSV upload
- **Parallel evaluation** — 4-worker concurrent evaluation with batched transactional writes
- **Analytics dashboard** — equity curves, win/loss donuts, R-multiple distributions, monthly heatmaps, MFE-vs-MAE scatter, Sharpe/Sortino/Calmar ratios
- **Per-trade drawdown** — max drawdown computed per-trade (captures intra-day peaks), not from daily aggregation
- **Export** — CSV, JSON, XLSX for signals and cached price bars
- **Pause/Resume/Stop** — full control over ingestion with resume-from-position support
- **Signal deduplication** — prevents duplicate signals via `channelId + postedAt` unique constraint
- **Unlimited ingestion** — fetch all channel history from establishment to now

---

## Quick start

### Prerequisites

- [Bun](https://bun.sh/) runtime
- [Caddy](https://caddyserver.com/) (optional) — or use Next.js rewrites (no Caddy needed)
- Telegram API credentials from [my.telegram.org](https://my.telegram.org)

### Install & configure

```bash
git clone https://github.com/thetrillionaire888/TrueSignal.git truesignal
cd truesignal
bun install
cd mini-services/telegram-collector && bun install && cd ../..

# Configure Telegram credentials
echo 'TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash' > mini-services/telegram-collector/.env

# Set up the 3 databases
bun run db:push        # Creates audit.db, catalog.db, market.db with schemas + indexes

# (Optional) Seed with demo data
bun run db:seed        # Populates 8 channels, ~1700 messages, ~1150 signals
```

### Run

#### Option A — One command (recommended)

```bash
bash scripts/start-dev.sh              # Starts Next.js + Collector in background
bash scripts/start-dev.sh --force      # Force-kill any process on ports 3000/3001 first
bash scripts/start-dev.sh --tmux       # Interactive tmux windows (requires tmux)
```

Open `http://localhost:3000`.

#### Option B — Manual (3 terminals)

```bash
bun run dev                                          # Terminal 1 — Next.js on :3000
cd mini-services/telegram-collector && bun run dev   # Terminal 2 — collector on :3001
caddy run --config Caddyfile                         # Terminal 3 — gateway on :81 (optional)
```

- **With Caddy**: open `http://localhost:81`
- **Without Caddy**: open `http://localhost:3000` (Next.js rewrites handle proxying)

#### Stop

```bash
bash scripts/stop-dev.sh              # Stop all services
bash scripts/stop-dev.sh --force      # Also kill any process on ports 3000/3001/81
```

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/ARCHITECTURE.md) | Service architecture, 3-database design, data flow, technology stack |
| [Usage Guide](docs/USAGE.md) | How to authenticate, ingest, evaluate, fetch, export, and view analytics |
| [API Reference](docs/API.md) | Collector HTTP endpoints and Socket.IO events |
| [Deployment Guide](docs/DEPLOYMENT.md) | Dev launcher, Caddy setup, production build, PM2/systemd, HTTPS/TLS |

---

## Project structure

```
src/
├── app/
│   ├── api/                    # Next.js API routes (overview, channels, signals, analytics, export, pipeline)
│   ├── layout.tsx              # Root layout with theme provider
│   └── page.tsx                # Main page (view router + drawers)
├── components/
│   ├── charts/                 # Recharts components (equity, donut, distribution, heatmap, scatter)
│   ├── views/                  # Main views (overview, channels, signals, analytics, ingest, pipeline, data-manager, export)
│   ├── app-sidebar.tsx         # Navigation sidebar + auth status card
│   ├── signal-detail-drawer.tsx
│   └── channel-detail-drawer.tsx
├── lib/
│   ├── db.ts                   # Unified database connection (runtime-aware: bun:sqlite / better-sqlite3)
│   ├── schema/                 # Drizzle ORM schemas (3 files)
│   │   ├── audit.ts            # Message, Signal, Evaluation
│   │   ├── catalog.ts          # Channel, ChannelStats, IngestState
│   │   └── market.ts           # PriceBar (composite PK)
│   ├── metrics.ts              # Performance metrics engine (Sharpe, Calmar, per-trade drawdown, equity curves)
│   ├── queries.ts              # Database query helpers (positional params, cross-DB joins)
│   ├── collector-client.ts     # Collector API + Socket.IO client
│   └── store.ts                # Zustand UI state
mini-services/telegram-collector/
├── index.ts                    # HTTP API + Socket.IO server
├── telegram.ts                 # MTProto client (auth, channel resolution, history iteration)
├── parser.ts                   # Multi-stage signal parser (3-stage cascade)
├── evaluator.ts                # Entry-type-aware evaluator (market/stop/limit/range fill logic)
├── bar-cache.ts                # Read-through OHLC bar cache (market.PriceBar)
├── importers.ts                # Binance, Yahoo Finance, CSV importers
├── ingestion-state.ts          # Pause/Resume/Stop state manager
└── db.ts                       # Collector DB operations (uses shared @/lib/db connection)
scripts/
├── push-schemas.ts             # Push 3-DB schemas (creates tables + indexes)
├── migrate-to-split-db.ts      # Migrate from old single custom.db to 3 new DBs
├── seed.ts                     # Demo data seeder (batched transactions)
├── parser-test.ts              # Parser test suite (28 test cases)
├── start-dev.sh                # 3-service dev launcher (background/tmux/split modes)
└── stop-dev.sh                 # Stop all services (+ optional --force)
docs/
├── ARCHITECTURE.md             # Service architecture & 3-database design
├── USAGE.md                    # How-to guide
├── API.md                      # Collector API reference
└── DEPLOYMENT.md               # Dev launcher, Caddy, production, PM2/systemd, HTTPS
```

---

## Database architecture

TrueSignal uses **3 SQLite databases** — each tuned for its access pattern, with independent WAL locks for concurrent read/write:

```
db/
├── audit.db      ← Messages + Signals + Evaluations (high-write + high-read)
├── catalog.db    ← Channels (static) + ChannelStats (volatile) + IngestState (read-heavy)
├── market.db     ← PriceBars (write-once, read-many, composite PK)
└── custom.db     ← Old single DB (kept as backup after migration)
```

All 3 are `ATTACH`'d to a single connection — cross-DB queries like `SELECT * FROM catalog.Channel` work natively. No `.env` configuration needed — databases are auto-discovered in the `db/` directory.

| Database | Tables | Key Indexes |
|----------|--------|-------------|
| audit.db | Message, Signal, Evaluation | Signal.messageId, Message.postedAt, Signal.channelId+status, Evaluation.outcome |
| catalog.db | Channel, ChannelStats, IngestState | Channel.telegramId (unique), ChannelStats.channelId (PK) |
| market.db | PriceBar | Composite PK (source, instrument, timeframe, timestamp) — clustered for range scans |

**Runtime-aware driver**: Uses `bun:sqlite` under Bun (collector), `better-sqlite3` under Node.js (Next.js dev server). Both share the same `@/lib/db` connection layer.

---

## Development

```bash
bun run dev          # Next.js dev mode (hot reloading, port 3000)
bun run build        # Production build (creates .next/standalone/)
bun run start        # Run production server
bun run lint         # ESLint
bun run db:push      # Push schemas to all 3 databases
bun run db:migrate   # Migrate from old single custom.db to 3 new DBs
bun run db:seed      # Seed demo data
bun scripts/parser-test.ts  # Run parser test suite (28 tests)
```

## License

MIT
