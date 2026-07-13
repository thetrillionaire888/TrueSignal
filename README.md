# TrueSignal

**Integrity in trading signals — shining light on the truth.**

TrueSignal is a signal audit platform that scrutinizes trading signals — starting with Telegram — and evaluates them against historical market data to reveal their true performance and reliability.

By connecting directly to Telegram via MTProto, parsing signals into structured data, and backtesting them against real OHLC bars from Dukascopy, Binance, and Yahoo Finance, TrueSignal exposes whether signals actually work — not just whether they sound good.

---

## Vision

To protect traders by exposing unreliable signals and guiding them toward systematic, quant-driven solutions.

## Mission

- **Audit** Telegram trading channels with integrity and transparency
- **Parse** signals into structured data — single-price entries, range entries, multi-target TPs, market/stop/limit order types
- **Evaluate** each signal against real historical market data using an entry-type-aware conservative fill model
- **Reveal** clear analytics that show the truth behind trading claims — win rate, R-multiple, Sharpe, Sortino, Calmar, drawdown

## Disclaimer

TrueSignal is for **educational purposes only**. It does not provide financial advice. Use at your own discretion.

---

## Key capabilities

- **MTProto ingestion** — full audit access to Telegram channels, groups, and supergroups via [teleproto](https://github.com/sanyok123456/teleproto) (not the Bot API)
- **Multi-stage signal parser** — 3-stage cascade pipeline with punctuation tolerance, range detection ("BUY 4099 4095"), and multi-line TP extraction
- **Entry-type-aware evaluation** — market orders fill immediately, stop orders fill on breakout, limit orders fill on pullback, range orders fill at conservative edge
- **Per-asset database architecture** — audit.db + catalog.db (ATTACH'd) plus per-asset market DBs (`db/market/{instrument}_{timeframe}.db`) for scalable price bar storage
- **M1-first evaluation** — evaluator uses M1 bars (highest resolution) when available, with M15 fallback for backward compatibility
- **Multi-source data fetching with priority** — Crypto: Binance REST, Binance Vision, Dukascopy; Forex/Metals/Indices/Energy: Dukascopy, Yahoo Finance
- **Chunked CSV import** — handles 400MB+ CSV files via 5MB chunked upload with live progress (no OOM, no connection resets)
- **Flexible CSV parser** — auto-detects StrategyQuant, ISO 8601, Unix epoch, and Bid/Ask formats with automatic timeframe detection and aggregation
- **Parallel evaluation** — 8-worker concurrent evaluation with batched transactional writes
- **Analytics dashboard** — equity curves, win/loss donuts, R-multiple distributions, monthly heatmaps (uses `postedAt`), MFE-vs-MAE scatter, per-trade Sharpe/Sortino/Calmar ratios
- **Chart Viewer** — full-page TradingView Lightweight Charts (v5.2.0) candlestick view with entry/SL/TP/exit price-line overlays, vertical signal-posted marker, 12h pre-context + 48h eval window, Prev/Next + keyboard navigation, channel scope selector, merged Parsed Signal + Evaluation metrics info bar
- **Multi-TP evaluation** — two-phase model: SL at original stop until TP1, then SL moves to breakeven; tracks highest TP reached; R = (highest_tp - entry) / risk
- **Sortable signals table** — click any column header to sort ascending/descending (server-side SQL ORDER BY), with top + bottom pagination bars and Invalid/No data outcome filters
- **Validation coverage** — progress bars in Channel Cards, Channel Drawer, and Analytics showing evaluated/total signals percentage
- **Missing Data tab** — Data Manager tab collecting all `no_data` signals grouped by instrument, with market data availability check and Fetch Data + Re-evaluate buttons
- **Force re-evaluation** — Channel Drawer Re-evaluate button re-evaluates ALL signals for that channel (not just no_data)
- **No-data retry** — signals with `no_data` outcome are automatically retried on subsequent batch evaluations
- **Pause/Resume/Stop** — full control over ingestion with resume-from-position support
- **Signal deduplication** — prevents duplicate signals via `channelId + postedAt` unique constraint
- **Export** — CSV, JSON, XLSX for signals and cached price bars

---

## Quick start

### Prerequisites

- [Bun](https://bun.sh/) runtime
- [Caddy](https://caddyserver.com/) (optional) — or use Next.js rewrites (no Caddy needed)
- Telegram API credentials from [my.telegram.org](https://my.telegram.org)

### Install and configure

```bash
git clone https://github.com/thetrillionaire888/TrueSignal.git truesignal
cd truesignal
bun install
cd mini-services/telegram-collector && bun install && cd ../..

# Configure Telegram credentials
echo 'TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash' > mini-services/telegram-collector/.env

# Set up the databases
bun run db:push

# (Optional) Seed with demo data
bun run db:seed
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
| [Architecture](docs/ARCHITECTURE.md) | Service architecture, per-asset database design, data flow, technology stack |
| [Usage Guide](docs/USAGE.md) | How to authenticate, ingest, evaluate, import, fetch, export, view analytics, and use Chart Viewer + Missing Data tab |
| [API Reference](docs/API.md) | Collector HTTP endpoints, Socket.IO events, multi-TP evaluation, forceReevaluate |
| [Deployment Guide](docs/DEPLOYMENT.md) | Dev launcher, Caddy setup, production build, PM2/systemd, HTTPS/TLS |

---

## Project structure

```
src/
├── app/
│   ├── api/                    # Next.js API routes (overview, channels, signals, analytics, export, pipeline, import-csv-stream)
│   ├── layout.tsx              # Root layout with theme provider
│   └── page.tsx                # Main page (view router + drawers)
├── components/
│   ├── charts/                 # Recharts components (equity, donut, distribution, heatmap, scatter)
│   ├── views/                  # Main views (overview, channels, signals, analytics, chart-viewer, ingest, pipeline, data-manager, export)
│   ├── app-sidebar.tsx         # Navigation sidebar + auth status card
│   ├── signal-detail-drawer.tsx
│   └── channel-detail-drawer.tsx
├── lib/
│   ├── db.ts                   # Unified database connection (audit.db + catalog.db ATTACH'd)
│   ├── market-db.ts            # Per-asset market DB connection manager (cached connections)
│   ├── schema/                 # Drizzle ORM schemas (3 files)
│   ├── metrics.ts              # Performance metrics engine (per-trade Sharpe, Sortino, Calmar, equity curves)
│   ├── queries.ts              # Database query helpers (sortable columns, cross-DB joins)
│   ├── collector-client.ts     # Collector API + Socket.IO client (ingest, eval, import progress)
│   └── store.ts                # Zustand UI state (sortable signals, filters)
mini-services/telegram-collector/
├── index.ts                    # HTTP API + Socket.IO server (streaming + chunked upload endpoints)
├── telegram.ts                 # MTProto client (auth, channel resolution, history iteration)
├── parser.ts                   # Multi-stage signal parser (punctuation-tolerant, range detection)
├── evaluator.ts                # M1-first evaluator (market/stop/limit/range fill logic, 8-worker parallel)
├── bar-cache.ts                # Multi-source OHLC bar cache (Binance -> Dukascopy -> Yahoo fallback)
├── csv-parser.ts               # Flexible streaming CSV parser (auto-detects format + timeframe)
├── importers.ts                # Binance, Yahoo Finance, CSV importers
├── ingestion-state.ts          # Pause/Resume/Stop state manager
└── db.ts                       # Collector DB operations (uses shared @/lib/db connection)
scripts/
├── push-schemas.ts             # Push DB schemas (creates tables + indexes)
├── migrate-to-split-db.ts      # Migrate from old single custom.db to split DBs
├── migrate-to-per-asset-db.ts  # Migrate market.db -> per-asset DBs
├── import-xauusd-csv.ts        # Import StrategyQuant XAUUSD CSV (M1 default)
├── reevaluate-no-data.ts       # Re-evaluate signals with 'no_data' outcome
├── seed.ts                     # Demo data seeder (batched transactions)
├── start-dev.sh                # 3-service dev launcher (background/tmux/split modes)
└── stop-dev.sh                 # Stop all services (+ optional --force)
docs/
├── ARCHITECTURE.md             # Service architecture and per-asset database design
├── USAGE.md                    # How-to guide (includes Import Tab + chunked upload)
├── API.md                      # Collector API reference (includes streaming + chunked endpoints)
└── DEPLOYMENT.md               # Dev launcher, Caddy (large file config), production, PM2/systemd, HTTPS
```

---

## Database architecture

TrueSignal uses **2 ATTACH'd SQLite databases** plus **per-asset market databases** — each tuned for its access pattern, with independent WAL locks for concurrent read/write:

```
db/
├── audit.db          ← Messages + Signals + Evaluations (high-write + high-read)
├── catalog.db        ← Channels (static) + ChannelStats (volatile) + IngestState (read-heavy)
├── market.db         ← Old single market DB (kept as backup after migration)
└── market/           ← Per-asset databases (one file per instrument+timeframe)
    ├── xauusd_m1.db      (e.g. 767K M1 bars)
    ├── xauusd_m15.db     (e.g. 52K M15 bars)
    ├── btcusd_m15.db
    ├── eurusd_m15.db
    └── ... (one per instrument+timeframe combination)
```

`audit.db` and `catalog.db` are `ATTACH`'d to a single connection — cross-DB queries like `SELECT * FROM catalog.Channel` work natively. Market data is accessed via `@/lib/market-db.ts` which opens and caches per-asset connections on demand.

| Database | Tables | Key Indexes |
|----------|--------|-------------|
| audit.db | Message, Signal, Evaluation | Signal.messageId, Message.postedAt, Signal.channelId+status, Evaluation.outcome |
| catalog.db | Channel, ChannelStats, IngestState | Channel.telegramId (unique), ChannelStats.channelId (PK) |
| market/*.db | PriceBar (one table per file) | Composite PK (source, instrument, timeframe, timestamp) — clustered for range scans |

**Why per-asset databases?**
- Each file stays small (e.g. `xauusd_m1.db` = 117 MB, not 400 MB in a single file)
- Per-instrument backup/restore without touching others
- No SQLite ATTACH limit (10 DBs) — each connection is independent
- Direct SQLite Browser access to one instrument's data
- The `source` column inside each DB still tracks provenance (dukascopy, binance, yahoo)

**Runtime-aware driver**: Uses `bun:sqlite` under Bun (collector), `better-sqlite3` under Node.js (Next.js dev server). Both share the same `@/lib/db` connection layer.

---

## Development

```bash
bun run dev          # Next.js dev mode (hot reloading, port 3000)
bun run build        # Production build (creates .next/standalone/)
bun run start        # Run production server
bun run lint         # ESLint
bun run db:push      # Push schemas to all databases
bun run db:migrate   # Migrate from old single custom.db to split DBs
bun run db:seed      # Seed demo data
```

## License

MIT
