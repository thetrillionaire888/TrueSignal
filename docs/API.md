# Collector API Reference

The Telegram Collector service (port 3001) exposes HTTP API endpoints and Socket.IO events for Telegram authentication, channel ingestion, signal evaluation, and data import/export.

All endpoints are accessed via the Caddy gateway (or Next.js rewrites) with `?XTransformPort=3001` appended to the URL.

## Authentication

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/status` | GET | Telegram session status (state, user info) |
| `/api/connect` | POST | Connect to Telegram MTProto |
| `/api/auth/request-code` | POST | Send login code to phone (`{ phone }`) |
| `/api/auth/submit-code` | POST | Verify login code (`{ code }`) |
| `/api/auth/submit-2fa` | POST | Submit 2FA cloud password (`{ password }`) |
| `/api/auth/logout` | POST | Logout and clear session |

### Two-layer authentication model

1. **App credentials** (API ID + API Hash) — stored in `.env`, identify *which application* is calling Telegram's API
2. **User credentials** (phone + code + optional 2FA) — entered interactively, prove *which user account* is authorizing the app

Both layers are required for MTProto access.

### Auth status in UI

Authentication status is visible in the **sidebar footer** on all views — not just the Ingest view. The sidebar polls `/api/status` every 30s and shows:
- **Authenticated**: green shield + user name + @username + Logout button
- **Authenticating**: amber pulsing icon + "Authenticating…"
- **Not authenticated**: "Go to Ingest to authenticate" link

## Channel resolution & ingestion

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/resolve-channel` | POST | Resolve channel by @username, title, or Peer ID (`{ query }`) |
| `/api/ingest` | POST | Start channel ingestion (`{ query, limit }` — `limit=0` for unlimited) |
| `/api/ingest/status` | GET | Get ingestion job state (running/paused/stopped/idle) |
| `/api/ingest/pause` | POST | Pause active ingestion |
| `/api/ingest/resume` | POST | Resume paused ingestion |
| `/api/ingest/stop` | POST | Stop ingestion (saves resume position) |
| `/api/ingest/clear-resume` | POST | Clear saved resume position (`{ channelId }`) |
| `/api/channel-stats/:id` | GET | Get channel message/signal counts + recent messages (paginated) |

### Channel resolution

Accepts `@username`, channel title, or numeric Peer ID (e.g. `2166348331` or `-1002166348331`). Uses `channels.GetFullChannel` to fetch the real participant count and channel description.

### Ingestion control

- **Pause** — halts at the next batch boundary (~500ms). Position is saved.
- **Resume** — continues from the saved position.
- **Stop** — halts and saves the resume position. Click "Ingest" again to resume.
- **Unlimited** — `limit=0` fetches all available history from channel establishment to now.
- **Spinner sync** — the Ingest button spinner syncs with pause/stop states (shows "Paused" or "Stopping…" accordingly).

## Signal evaluation

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/evaluate` | POST | Evaluate unevaluated signals against Dukascopy data (`{ channelId? }`) |
| `/api/eval-stats` | GET | Get evaluation counts (total/evaluated/pending) |

The evaluator runs **4 parallel workers** with batched transactional writes (25 per batch). For each signal:

1. Fetches 48h of 15-minute OHLC bars from Dukascopy (cached in `market.PriceBar` table)
2. Applies entry-type-aware fill logic:
   - **market**: fill immediately at entryPrice (bar 0)
   - **stop**: fill when price breaks through entry (long: high ≥ entry, short: low ≤ entry)
   - **limit**: fill when price touches entry (long: low ≤ entry, short: high ≥ entry)
   - **range**: fill when price touches range (conservative fill at edge closest to SL)
3. Walks through bars from fill point to find SL/TP hit
4. Computes R-multiple, MFE/MAE, and duration

If SL is hit before entry triggers → `invalid` (exit reason: `sl_before_entry`).
If entry never triggers within the evaluation window → `invalid` (exit reason: `stop_not_triggered`, `limit_not_touched`, or `range_not_touched`).

## Data fetch & export

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/import` | POST | Fetch price bars from Dukascopy/Binance/Yahoo/CSV |
| `/api/cache-summary` | GET | Get PriceBar cache summary (by source/instrument) |
| `/api/export-bars` | GET | Export cached price bars as CSV/JSON |

### Fetch sources

| Source | Auth | Instruments |
|--------|------|-------------|
| Dukascopy | Free, no auth | Forex, metals, crypto, indices |
| Binance | Free, no auth | Crypto spot (BTC, ETH, altcoins) |
| Yahoo Finance | Free, no auth | Stocks, ETFs, indices |
| CSV | N/A | Any — flexible OHLCV format |
| Darwinex | OAuth2 required | Redirects to CSV import |

**Terminology**: API sources use "Fetch" (data retrieved from a remote API). CSV upload uses "Import" (file uploaded from disk).

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
| `evaluate:progress` | Server → Client | Live evaluation progress (current signal, fetched/cached bar counts, phase) |
