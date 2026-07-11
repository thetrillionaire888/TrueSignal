#!/usr/bin/env bash
#
# TrueSignal — Stop All Dev Services
# Kills Next.js, Telegram Collector, Caddy, and the tmux session.
#
# Usage: bash scripts/stop-dev.sh

set -uo pipefail

echo "Stopping TrueSignal dev services..."

# Stop tmux session (if exists)
if tmux has-session -t truesignal 2>/dev/null; then
  tmux kill-session -t truesignal
  echo "  ✓ tmux session 'truesignal' killed"
fi

# Stop Next.js
pkill -f "next dev" 2>/dev/null && echo "  ✓ Next.js stopped" || true
pkill -f "next-server" 2>/dev/null || true

# Stop Collector
pkill -f "bun.*index.ts" 2>/dev/null && echo "  ✓ Collector stopped" || true

# Stop Caddy (if running)
if command -v caddy &>/dev/null; then
  caddy stop 2>/dev/null && echo "  ✓ Caddy stopped" || true
fi

sleep 1
echo ""
echo "✅ All services stopped."
