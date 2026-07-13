# Collector API Reference

The Telegram Collector service (port 3001) exposes HTTP API endpoints and Socket.IO events for Telegram authentication, channel ingestion, signal evaluation, data import/export, and chunked CSV upload.

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

Authentication status is visible in the **sidebar footer** on all views. The sidebar polls `/api/status` every 30s and shows:
- **Authenticated**: green shield + user name + @username + Logout button
- **Authenticating**: amber pulsing icon + "Authenticating..."
- **Not authenticated**: "Go to Ingest to authenticate" link

## Channel resolution and ingestion

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

## Signal evaluation

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/evaluate` | POST | Evaluate unevaluated + `no_data` signals (`{ channelId?, forceReevaluate? }`) |
| `/api/evaluate-signal` | POST | Re-evaluate a single signal by ID (`{ signalId }`) — uses forceRefresh |
| `/api/eval-stats` | GET | Get evaluation counts (total/evaluated/pending) |

### M1-first evaluation

The evaluator runs **8 parallel workers** with batched transactional writes (25 per batch). For each signal:

1. **Try M1 first** — fetches 48h of M1 OHLC bars (~2,880 bars) from the per-asset market DB
2. **Fall back to M15** — if no M1 bars available, uses M15 (~192 bars)
3. Applies entry-type-aware fill logic:
   - **market**: fill immediately at entryPrice (bar 0)
   - **stop**: fill when price breaks through entry (long: high >= entry, short: low <= entry)
   - **limit**: fill when price touches entry (long: low <= entry, short: high >= entry)
   - **range**: fill when price touches range (conservative fill at edge closest to SL)
4. Walks through bars from fill point to find SL/TP hit
5. Computes R-multiple, MFE/MAE, and duration
6. Records `marketDataSource` (e.g. `dukascopy-m1`, `binance-m15`, `yahoo-m15`)

If SL is hit before entry triggers, the outcome is `invalid` (exit reason: `sl_before_entry`).
If entry never triggers within the evaluation window, the outcome is `invalid` (exit reason: `stop_not_triggered`, `limit_not_touched`, or `range_not_touched`).

### No-data retry

Signals with `outcome = 'no_data'` are automatically included in subsequent batch evaluations (the `getUnevaluatedSignals` query uses `WHERE e.signalId IS NULL OR e.outcome = 'no_data'`). This ensures signals that failed due to temporary API issues are retried when data becomes available.

### Re-evaluate single signal

`POST /api/evaluate-signal` with `{ signalId }`:
- Uses `forceRefresh=true` to bypass the cache-hit optimization
- Always tries to fetch fresh bars from the data sources
- Deletes the old evaluation and replaces it
- Derives `marketDataSource` from the fetch stats (e.g. `dukascopy-m1`)

## CSV import

### `/api/import-csv` (JSON body — for small pasted CSV)

| Parameter | Type | Description |
|-----------|------|-------------|
| `instrument` | string | Instrument name (e.g. `xauusd`) |
| `source` | string | Source label (e.g. `dukascopy`, `binance`, `yahoo`) |
| `timeframe` | string | Target timeframe (e.g. `m1`, `m15`) |
| `csvText` | string | CSV content as a string |
| `aggregate` | `"auto"` or `true` or `false` | Aggregation mode (default: `auto`) |

**Auto-detects CSV format:**
- StrategyQuant: `Date,Time,Open,High,Low,Close,Volume` (YYYYMMDD HH:MM:SS)
- Combined: `DateTime,Open,High,Low,Close,Volume` (ISO 8601)
- Unix: `timestamp,open,high,low,close,volume` (epoch seconds or millis)
- Bid/Ask: `DateTime,Bid,Ask,Volume` (mid-price derived)

**Auto-detects timeframe** from median bar gap, and aggregates if source timeframe differs from target timeframe.

Returns: `{ parsedBars, storedBars, inserted, skipped, aggregated, sourceTimeframe, dateRange, sampleRows }`

### `/api/import-csv-stream` (multipart — for large files, async)

Receives multipart/form-data with a file upload. Returns 202 Accepted immediately and processes the file in the background. Progress and final results are sent via Socket.IO `import:progress` events.

**Note**: This endpoint is handled BEFORE `readBody()` to avoid buffering the full body in memory.

### `/api/import-csv-chunk` (JSON body — for 400MB+ files)

Chunked upload endpoint for very large CSV files. The frontend splits the file into 5MB chunks and sends each as a separate request.

| Parameter | Type | Description |
|-----------|------|-------------|
| `uploadId` | string | Unique session ID (generated by frontend) |
| `instrument` | string | Instrument name |
| `source` | string | Source label |
| `timeframe` | string | Target timeframe |
| `chunkIndex` | number | 0-based chunk index |
| `totalChunks` | number | Total number of chunks |
| `data` | string | 5MB chunk of CSV text |
| `isLast` | boolean | `true` on the final chunk |

**How it works:**
1. First chunk creates a `ChunkUploadSession` with a `StreamingCsvParser`
2. Each chunk's CSV text is fed to the parser incrementally
3. Parser emits bars which are batch-inserted every 5,000 bars
4. Last chunk (`isLast=true`) calls `parser.end()`, flushes final batch, returns results

**Memory**: stays flat (~25MB) regardless of file size — only current line + 5K-bar batch in memory.

**Auto-cleanup**: sessions are deleted after 30 minutes if the client disconnects mid-upload.

## Data fetch and export

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/import` | POST | Fetch price bars from Dukascopy/Binance/Yahoo/CSV (legacy) |
| `/api/browse-bars` | GET | Browse cached price bars (paginated, filtered by instrument/source/timeframe/date) |
| `/api/cache-summary` | GET | Get PriceBar cache summary (aggregated across all per-asset DBs) |
| `/api/no-data-signals` | GET | Get all no_data signals grouped by instrument with market data availability |
| `/api/export-bars` | GET | Export cached price bars as CSV/JSON |

### Multi-source data fetching priority

| Instrument Type | 1st Source | 2nd Source | 3rd Source |
|----------------|-----------|-----------|-----------|
| Crypto (BTC, ETH, SOL, ...) | Binance REST (3 retries) | Binance Vision archive | Dukascopy (5s timeout) |
| Forex/Metals/Indices/Energy | Dukascopy (5s timeout) | Yahoo Finance (2 retries) | — |

Each source's bars are stored with the correct `source` label in `PriceBar.source`. The `fetchBarsCached()` function handles the priority chain and falls back to the next source on failure.

## Socket.IO events

### Ingestion events

| Event | Direction | Description |
|-------|-----------|-------------|
| `ingest:progress` | Server -> Client | Live ingestion progress (fetched count, phase, paused state) |
| `ingest:complete` | Server -> Client | Ingestion finished (inserted count, signals detected, stopped flag) |
| `ingest:error` | Server -> Client | Ingestion error |

### Evaluation events

| Event | Direction | Description |
|-------|-----------|-------------|
| `evaluate:progress` | Server -> Client | Live evaluation progress (current signal, fetched/cached bar counts, phase, summary on completion) |

### Import events

| Event | Direction | Description |
|-------|-----------|-------------|
| `import:progress` | Server -> Client | Live CSV import progress (parsed/inserted/skipped counts, chunk index, phase) |

**Import phases:**
- `importing` — chunks are being received and parsed
- `complete` — final chunk processed, includes `sourceTimeframe` and `dateRange`
- `error` — import failed, includes error message

**Payload fields:**
- `jobId` — unique upload session ID
- `phase` — `importing` | `complete` | `error`
- `message` — human-readable progress message
- `parsed` — total bars parsed so far
- `inserted` — total bars inserted so far
- `skipped` — total bars skipped (duplicates) so far
- `instrument` — instrument name
- `timeframe` — target timeframe
- `chunkIndex` / `totalChunks` — (during `importing` phase) current chunk progress
- `sourceTimeframe` / `dateRange` — (on `complete` phase) final results
