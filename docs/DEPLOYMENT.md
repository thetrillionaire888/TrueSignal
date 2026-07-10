# Deployment Guide

## Prerequisites

- [Bun](https://bun.sh/) runtime
- [Caddy](https://caddyserver.com/) (or use Next.js rewrites as an alternative)
- Telegram API credentials (from [my.telegram.org](https://my.telegram.org))

## Installation

```bash
# Clone the repository
git clone <your-repo-url> truesignal
cd truesignal

# Install main app dependencies
bun install

# Install collector service dependencies
cd mini-services/telegram-collector
bun install
cd ../..
```

## Configuration

Create `mini-services/telegram-collector/.env`:

```env
TELEGRAM_API_ID=your_api_id
TELEGRAM_API_HASH=your_api_hash
```

## Database setup

```bash
# Push schema to SQLite
bun run db:push

# (Optional) Seed with demo data
bun prisma/seed.ts
```

## Caddy gateway

TrueSignal uses Caddy as a reverse-proxy gateway to expose a single port (81) that routes to both services.

### How the Caddyfile works

```caddyfile
:81 {
    # Route 1: requests with ?XTransformPort=NNNN → proxy to localhost:NNNN
    @transform_port_query {
        query XTransformPort=*
    }
    handle @transform_port_query {
        reverse_proxy localhost:{query.XTransformPort}
    }

    # Route 2: everything else → proxy to Next.js (localhost:3000)
    handle {
        reverse_proxy localhost:3000
    }
}
```

| Request URL | Routed to |
|-------------|-----------|
| `http://localhost:81/` | `localhost:3000` (Next.js) |
| `http://localhost:81/api/signals` | `localhost:3000` (Next.js) |
| `http://localhost:81/api/status?XTransformPort=3001` | `localhost:3001` (collector) |
| `http://localhost:81/socket.io/?XTransformPort=3001` | `localhost:3001` (collector WebSocket) |

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

### Running Caddy

Caddy must be started **after** the app services:

```bash
# Terminal 1 — Next.js app
bun run dev

# Terminal 2 — Collector service
cd mini-services/telegram-collector && bun run dev

# Terminal 3 — Caddy gateway
caddy run --config Caddyfile          # foreground (shows logs)
# OR
caddy start --config Caddyfile        # background daemon
```

Open `http://localhost:81`.

### Stopping Caddy

```bash
# Foreground: press Ctrl+C
# Background: caddy stop
# Unresponsive: lsof -ti :81 | xargs kill
```

### Running without Caddy

Add rewrites to `next.config.ts`:

```typescript
async rewrites() {
  return [
    {
      source: "/api/:path*",
      has: [{ type: "query", key: "XTransformPort", value: "3001" }],
      destination: "http://localhost:3001/api/:path*",
    },
    {
      source: "/socket.io/:path*",
      has: [{ type: "query", key: "XTransformPort", value: "3001" }],
      destination: "http://localhost:3001/socket.io/:path*",
    },
  ];
}
```

Then run only Next.js + collector (no Caddy needed). Open `http://localhost:3000`.

## Development

```bash
bun run dev          # Next.js dev mode (hot reloading, port 3000)
bun run lint         # ESLint
bun run db:push      # Push schema changes
bun run db:generate  # Regenerate Prisma client
bun run db:reset     # Reset database (destructive)
```

## Production

### Build & start

```bash
bun run build        # Creates .next/standalone/ (output: "standalone" in next.config.ts)
bun run start        # Runs the production server on port 3000
```

### Full production startup

```bash
bun run build && bun run start       # Terminal 1 — Next.js production
cd mini-services/telegram-collector && bun run dev   # Terminal 2 — collector
caddy run --config Caddyfile         # Terminal 3 — gateway
```

### Process manager (PM2)

```bash
npm install -g pm2

pm2 start "bun run start" --name truesignal-web
pm2 start "bun run dev" --name truesignal-collector --cwd mini-services/telegram-collector
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
ExecStart=/usr/local/bin/bun run dev
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
        reverse_proxy localhost:{query.XTransformPort}
    }
    handle {
        reverse_proxy localhost:3000
    }
}
```

Caddy automatically provisions and renews Let's Encrypt TLS certificates.
