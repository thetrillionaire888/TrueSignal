# Collector API Reference

The Telegram Collector service (port 3001) exposes HTTP API endpoints and Socket.IO events for Telegram authentication, channel ingestion, signal evaluation, and data import/export.

All endpoints are accessed via the Caddy gateway with `?XTransformPort=3001` appended to the URL.

## Authentication

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Telegram session status |
| `/api/connect` | POST | Connect to Telegram MTProto |
| `/api/auth/request-code` | POST | Send login code to phone |
| `/api/auth/submit-code` | POST | Verify login code |
| `/api/auth/submit-2fa` | POST | Submit 2FA cloud password |
| `/api/auth/logout` | POST | Logout and clear session |

### Two-layer authentication model

1. **App credentials** (API ID + API Hash) — stored in `.env`, identify *which application* is calling Telegram's API
2. **User credentials** (phone + code + optional 2FA) — entered interactively, prove *which user account* is authorizing the app

Both layers are required for MTProto access.

## Channel resolution & ingestion

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/resolve-channel` | POST | Resolve channel by @username, title, or Peer ID |
| `/api/ingest` | POST | Start channel ingestion (`limit=0` for unlimited) |
| `/api/ingest/status` | GET | Get ingestion job state (running/paused/stopped/idle) |
| `/api/ingest/pause` | POST | Pause active ingestion |
| `/api/ingest/resume` | POST | Resume paused ingestion |
| `/api/ingest/stop` | POST | Stop ingestion (saves resume position) |
| `/api/ingest/clear-resume` | POST | Clear saved resume position |
| `/api/channel-stats/:id` | GET | Get channel message/signal counts + recent messages |

### Channel resolution

Accepts `@username`, channel title, or numeric Peer ID (e.g. `2166348331` or `-1002166348331`). Uses `channels.GetFullChannel` to fetch the real participant count and channel description.

### Ingestion control

- **Pause** — halts at the next batch boundary (~500ms). Position is saved.
- **Resume** — continues from the saved position.
- **Stop** — halts and saves the resume position. Click "Ingest" again to resume.
- **Unlimited** — `limit=0` fetches all available history from channel establishment to now.

## Signal evaluation

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/evaluate` | POST | Evaluate unevaluated signals against Dukascopy data |
| `/api/eval-stats` | GET | Get evaluation counts (total/evaluated/pending) |

The evaluator fetches 48h of 15-minute OHLC bars from Dukascopy (cached in `PriceBar` table) for each signal, walks through bars to determine SL/TP hit, and computes R-multiple, MFE/MAE, and duration.

## Data import & export

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/import` | POST | Import price bars from Dukascopy/Binance/Yahoo/CSV |
| `/api/cache-summary` | GET | Get PriceBar cache summary (by source/instrument) |
| `/api/export-bars` | GET | Export cached price bars as CSV/JSON |
| `/api/eval-stats` | GET | Get evaluation counts |

### Import sources

| Source | Auth | Instruments |
|--------|------|-------------|
| Dukascopy | Free, no auth | Forex, metals, crypto, indices |
| Binance | Free, no auth | Crypto spot (BTC, ETH, altcoins) |
| Yahoo Finance | Free, no auth | Stocks, ETFs, indices |
| CSV | N/A | Any — flexible OHLCV format |
| Darwinex | OAuth2 required | Redirects to CSV import |

## Socket.IO events

### Ingestion events

| Event | Direction | Description |
|-------|-----------|-------------|
| `ingest:progress` | Server → Client | Live ingestion progress (fetched count, phase, paused state) |
| `ingest:complete` | Server → Client | Ingestion finished (inserted count, signals detected, stopped flag) |
| `ingest:error` | Server → Client | Ingestion error |

### Evaluation events

| Event | Direction | Description |
|-------|-----------|-------------|
| `evaluate:progress` | Server → Client | Live evaluation progress (current signal, fetched/cached bar counts) |
