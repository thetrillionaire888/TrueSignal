# TrueSignal

**Integrity in trading signals — shining light on the truth.**

TrueSignal is a signal audit platform that scrutinizes trading signals — starting with Telegram — and evaluates them against historical market data to reveal their true performance and reliability.

Born from the SignalAudit engine, TrueSignal serves as a beacon of transparency in a world where trading signal claims often go unchecked. By connecting directly to Telegram via MTProto, parsing signals into structured data, and backtesting them against real OHLC bars from Dukascopy, Binance, and Yahoo Finance, TrueSignal exposes whether signals actually work — not just whether they sound good.

---

## Vision

To protect traders by exposing unreliable signals and guiding them toward systematic, quant-driven solutions.

## Mission

- **Audit** Telegram trading channels with integrity and transparency
- **Parse** signals into structured data — single-price entries, range entries, multi-target TPs
- **Evaluate** each signal against real historical market data using a conservative fill model
- **Reveal** clear analytics that show the truth behind trading claims — win rate, R-multiple, Sharpe, Calmar, drawdown

## Disclaimer

TrueSignal is for **educational purposes only**. It does not provide financial advice. Use at your own discretion.

---

## Key capabilities

- **MTProto ingestion** — full audit access to Telegram channels, groups, and supergroups via [teleproto](https://github.com/sanyok123456/teleproto) (not the Bot API)
- **Range signal support** — handles "SELL RANGE: 4110 - 4116" format with a conservative fill model for honest backtesting
- **Historical evaluation** — fetches real OHLC bars from Dukascopy (with DB caching for speed) to determine win/loss, R-multiple, MFE/MAE
- **Multi-source data import** — Dukascopy, Binance, Yahoo Finance, CSV upload
- **Analytics dashboard** — equity curves, win/loss donuts, R-multiple distributions, monthly heatmaps, MFE-vs-MAE scatter, Sharpe/Sortino/Calmar ratios
- **Export** — CSV, JSON, XLSX for signals and cached price bars
- **Pause/Resume/Stop** — full control over ingestion with resume-from-position support
- **Signal deduplication** — prevents duplicate signals via `channelId + postedAt` unique constraint
- **Unlimited ingestion** — fetch all channel history from establishment to now

---

## Quick start

### Prerequisites

- [Bun](https://bun.sh/) runtime
- [Caddy](https://caddyserver.com/) (recommended) — or use Next.js rewrites (see [Deployment](docs/DEPLOYMENT.md))
- Telegram API credentials from [my.telegram.org](https://my.telegram.org)

### Install & configure

```bash
git clone <your-repo-url> truesignal
cd truesignal
bun install
cd mini-services/telegram-collector && bun install && cd ../..

# Configure Telegram credentials
echo 'TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash' > mini-services/telegram-collector/.env

# Set up the database
bun run db:push
```

### Run (3 terminals)

```bash
bun run dev                                          # Terminal 1 — Next.js on :3000
cd mini-services/telegram-collector && bun run dev   # Terminal 2 — collector on :3001
caddy run --config Caddyfile                         # Terminal 3 — gateway on :81
```

Open `http://localhost:81`.

> **No Caddy?** See [Running without Caddy](docs/DEPLOYMENT.md#running-without-caddy) for the Next.js rewrites alternative.

---

## Documentation

| Document | Description |
|----------|-------------|
| [Architecture](docs/ARCHITECTURE.md) | Service architecture, data flow, database schema, technology stack |
| [Usage Guide](docs/USAGE.md) | How to authenticate, ingest, evaluate, import, export, and view analytics |
| [API Reference](docs/API.md) | Collector HTTP endpoints and Socket.IO events |
| [Deployment Guide](docs/DEPLOYMENT.md) | Caddy setup, production build, PM2/systemd, HTTPS/TLS |

---

## Project structure

```
src/
├── app/
│   ├── api/                    # Next.js API routes (overview, channels, signals, analytics, export)
│   ├── layout.tsx              # Root layout with theme provider
│   └── page.tsx                # Main page (view router + drawers)
├── components/
│   ├── charts/                 # Recharts components (equity, donut, distribution, heatmap, scatter)
│   ├── views/                  # Main views (overview, channels, signals, analytics, ingest, pipeline, export)
│   ├── app-sidebar.tsx         # Navigation sidebar
│   └── signal-detail-drawer.tsx
├── lib/
│   ├── metrics.ts              # Performance metrics engine (Sharpe, Calmar, drawdown, equity curves)
│   ├── collector-client.ts     # Collector API + Socket.IO client
│   └── store.ts                # Zustand UI state
mini-services/telegram-collector/
├── index.ts                    # HTTP API + Socket.IO server
├── telegram.ts                 # MTProto client (auth, channel resolution, history iteration)
├── parser.ts                   # Signal parser (single-price + range detection)
├── evaluator.ts                # Signal evaluator (conservative fill model for ranges)
├── bar-cache.ts                # Read-through OHLC bar cache (PriceBar table)
├── importers.ts                # Binance, Yahoo Finance, CSV importers
├── ingestion-state.ts          # Pause/Resume/Stop state manager
└── db.ts                       # Direct SQLite access (shared DB)
prisma/
├── schema.prisma               # Database schema
└── seed.ts                     # Demo data seeder
docs/
├── ARCHITECTURE.md             # Service architecture & data flow
├── USAGE.md                    # How-to guide
├── API.md                      # Collector API reference
└── DEPLOYMENT.md               # Caddy, production, PM2/systemd, HTTPS
```

---

## Development

```bash
bun run dev          # Next.js dev mode (hot reloading)
bun run build        # Production build (creates .next/standalone/)
bun run start        # Run production server
bun run lint         # ESLint
bun run db:push      # Push schema changes
bun run db:generate  # Regenerate Prisma client
```

## License

MIT
