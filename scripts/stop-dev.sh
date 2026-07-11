#!/usr/bin/env bash
#
# TrueSignal — Stop All Dev Services
# Kills Next.js, Telegram Collector, Caddy, and the tmux session.
#
# Usage:
#   bash scripts/stop-dev.sh            # graceful stop (pkill by process name)
#   bash scripts/stop-dev.sh --force    # also kill any process on ports 3000/3001/81

set -uo pipefail

FORCE=false
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=true ;;
    --help|-h)
      echo "Usage: bash scripts/stop-dev.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --force, -f    Also kill any process occupying ports 3000, 3001, 81"
      echo "  --help,  -h    Show this help message"
      exit 0
      ;;
  esac
done

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

# Force mode: kill any process still holding the ports
if [ "$FORCE" = true ]; then
  echo "Force mode: checking ports 3000, 3001, 81..."
  for port in 3000 3001 81; do
    pids=""
    if command -v lsof &>/dev/null; then
      pids=$(lsof -ti ":$port" 2>/dev/null || true)
    elif command -v fuser &>/dev/null; then
      pids=$(fuser "$port/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -v '^$' || true)
    elif command -v ss &>/dev/null; then
      pids=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K\d+' || true)
    fi
    if [ -n "$pids" ]; then
      for pid in $pids; do
        echo "  ⚡ killing PID $pid on port $port"
        kill -9 "$pid" 2>/dev/null || true
      done
    fi
  done
fi

sleep 1
echo ""
echo "✅ All services stopped."
