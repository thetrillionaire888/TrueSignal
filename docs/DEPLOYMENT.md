# Deployment Guide

## Prerequisites

- [Bun](https://bun.sh/) runtime
- [Caddy](https://caddyserver.com/) (optional — Next.js rewrites handle proxying without it)
- Telegram API credentials (from [my.telegram.org](https://my.telegram.org))

## Installation

```bash
git clone https://github.com/thetrillionaire888/TrueSignal.git truesignal
cd truesignal

# Install main app dependencies
bun install

# Install collector service dependencies
cd mini-services/telegram-collector && bun install && cd ../..
```

## Configuration

### Telegram credentials

Create `mini-services/telegram-collector/.env`:

```env
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
```

### Database

No `.env` configuration needed for databases. The databases are auto-discovered in the `db/` directory:
- `audit.db` — Messages, Signals, Evaluations
- `catalog.db` — Channels, ChannelStats, IngestState
- `db/market/` — Per-asset market DBs (one file per instrument+timeframe)

To use a custom location, set `DB_DIR` in root `.env`:

```env
DB_DIR=/path/to/custom/db/location
```

```bash
# Create the databases with schemas + indexes
bun run db:push

# (Optional) Migrate from old single custom.db to split DBs
bun run db:migrate

# (Optional) Migrate market.db to per-asset DBs
bun scripts/migrate-to-per-asset-db.ts

# (Optional) Seed with demo data
bun run db:seed
```

## Dev launcher script

The easiest way to start all services:

```bash
bash scripts/start-dev.sh              # Background mode (default — works everywhere)
bash scripts/start-dev.sh --force      # Kill any process on ports 3000/3001/81 first
bash scripts/start-dev.sh --tmux       # Interactive tmux windows (requires tmux)
bash scripts/start-dev.sh --split      # OS-native split terminals
bash scripts/start-dev.sh --force --tmux  # Combine options
```

### Options

| Flag | Description |
|------|-------------|
| `--force`, `-f` | Kill any process occupying ports 3000, 3001, 81 before starting |
| `--background`, `-b` | Start in background with nohup (default) |
| `--tmux`, `-t` | Start in tmux session with switchable windows |
| `--split`, `-s` | Start in OS-native split terminals |
| `--help`, `-h` | Show help |

### Stop all services

```bash
bash scripts/stop-dev.sh              # Graceful stop
bash scripts/stop-dev.sh --force      # Also kill any process on the ports
```

## Caddy gateway (optional)

TrueSignal can use Caddy as a reverse-proxy gateway to expose a single port (81). If Caddy is not installed, Next.js rewrites handle the proxying automatically (app available on port 3000).

### How the Caddyfile works

The Caddyfile is configured with 30-minute timeouts and streaming flush to support large CSV file uploads (400MB+):

```caddyfile
:81 {
    @transform_port_query {
        query XTransformPort=*
    }
    handle @transform_port_query {
        reverse_proxy localhost:{query.XTransformPort} {
            header_up Host {host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP {remote_host}
            # Flush immediately - don't buffer responses (important for streaming)
            flush_interval -1
            # Long timeouts for large file imports (can take 10-15 minutes)
            transport http {
                read_timeout 30m
                write_timeout 30m
                dial_timeout 30s
            }
        }
    }
    handle {
        reverse_proxy localhost:3000 {
            header_up Host {host}
            header_up X-Forwarded-For {remote_host}
            header_up X-Forwarded-Proto {scheme}
            header_up X-Real-IP {remote_host}
            flush_interval -1
            transport http {
                read_timeout 30m
                write_timeout 30m
                dial_timeout 30s
            }
        }
    }
}
```

| Request URL | Routed to |
|-------------|-----------|
| `http://localhost:81/` | `localhost:3000` (Next.js) |
| `http://localhost:81/api/signals` | `localhost:3000` (Next.js) |
| `http://localhost:81/api/status?XTransformPort=3001` | `localhost:3001` (collector) |
| `http://localhost:81/socket.io/?XTransformPort=3001` | `localhost:3001` (collector WebSocket) |
| `http://localhost:81/api/import-csv-chunk?XTransformPort=3001` | `localhost:3001` (collector — chunked upload) |

### Why the long timeouts?

Large CSV imports (400MB+) can take 5-15 minutes to parse and insert into SQLite. The default Caddy/HTTP timeouts (2 minutes) would kill the connection before the import completes. The 30-minute timeouts ensure long-running imports can finish.

The `flush_interval -1` setting ensures responses are streamed immediately rather than buffered — important for the Socket.IO progress events that report import progress in real-time.

### Installing Caddy

**macOS:**
```bash
brew install caddy
```

**Linux (Ubuntu/Debian):**
```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update && sudo apt install caddy
```

**Or download** the single binary from [GitHub Releases](https://github.com/caddyserver/caddy/releases).

### Running without Caddy

Next.js rewrites are already configured in `next.config.ts` — no changes needed. Simply start Next.js + collector (no Caddy). Open `http://localhost:3000`.

**Note**: For large CSV uploads (400MB+), Caddy is recommended. The Next.js rewrite proxy buffers the entire request body, which can cause `ERR_CONNECTION_RESET` on very large uploads. If you encounter this, either use Caddy or use the chunked upload endpoint (`/api/import-csv-chunk`) which splits files into 5MB pieces.

## Manual startup (3 terminals)

```bash
bun run dev                                          # Terminal 1 — Next.js on :3000
cd mini-services/telegram-collector && bun run dev   # Terminal 2 — collector on :3001
caddy run --config Caddyfile                         # Terminal 3 — gateway on :81 (optional)
```

## Development

```bash
bun run dev          # Next.js dev mode (hot reloading, port 3000)
bun run lint         # ESLint
bun run db:push      # Push schemas to all databases
bun run db:migrate   # Migrate from old single custom.db to split DBs
bun run db:seed      # Seed demo data
```

## Production

### Build and start

```bash
bun run build        # Creates .next/standalone/ (output: "standalone" in next.config.ts)
bun run start        # Runs the production server on port 3000
```

### Full production startup

```bash
bun run build && bun run start       # Terminal 1 — Next.js production
cd mini-services/telegram-collector && bun run start   # Terminal 2 — collector
caddy run --config Caddyfile         # Terminal 3 — gateway (optional)
```

### Process manager (PM2)

```bash
npm install -g pm2

pm2 start "bun run start" --name truesignal-web
pm2 start "bun run start" --name truesignal-collector --cwd mini-services/telegram-collector
pm2 start "caddy run --config Caddyfile" --name truesignal-gateway

pm2 save && pm2 startup
```

### Systemd (Linux)

Create `/etc/systemd/system/truesignal-web.service`:
```ini
[Unit]
Description=TrueSignal Web (Next.js)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/truesignal
ExecStart=/usr/local/bin/bun run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Create `/etc/systemd/system/truesignal-collector.service`:
```ini
[Unit]
Description=TrueSignal Telegram Collector
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/truesignal/mini-services/telegram-collector
EnvironmentFile=/opt/truesignal/mini-services/telegram-collector/.env
ExecStart=/usr/local/bin/bun run start
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable truesignal-web truesignal-collector
sudo systemctl start truesignal-web truesignal-collector
```

### HTTPS with automatic TLS

Update the Caddyfile with a real domain:

```caddyfile
truesignal.example.com {
    @transform_port_query {
        query XTransformPort=*
    }
    handle @transform_port_query {
        reverse_proxy localhost:{query.XTransformPort} {
            flush_interval -1
            transport http {
                read_timeout 30m
                write_timeout 30m
            }
        }
    }
    handle {
        reverse_proxy localhost:3000 {
            flush_interval -1
            transport http {
                read_timeout 30m
                write_timeout 30m
            }
        }
    }
}
```

Caddy automatically provisions and renews Let's Encrypt TLS certificates.

## Large file upload troubleshooting

If you encounter `ERR_CONNECTION_RESET` when uploading large CSV files:

1. **Use Caddy** (not Next.js rewrites) — Caddy streams the request body without buffering
2. **Restart Caddy** after changing the Caddyfile
3. **The chunked upload endpoint** (`/api/import-csv-chunk`) splits files into 5MB pieces — this is used automatically by the Import tab for all file uploads and works regardless of proxy configuration
4. **Collector timeouts** are disabled (`httpServer.timeout = 0`) to allow long-running imports

### Upload size limits

| Layer | Limit | Configuration |
|-------|-------|---------------|
| Caddy | No limit | `transport http { read_timeout 30m }` in Caddyfile |
| Next.js rewrite | ~1MB (buffered) | Use Caddy or chunked upload for large files |
| Collector | No limit | `httpServer.timeout = 0`, `requestTimeout = 0` |
| Chunked upload | ~5MB per chunk | Each chunk is a separate small JSON request |
