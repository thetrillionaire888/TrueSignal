#!/usr/bin/env bash
#
# TrueSignal — 3-Service Dev Launcher
# Starts Next.js + Telegram Collector + Caddy gateway.
#
# Usage:
#   bash scripts/start-dev.sh             # background mode (default — works everywhere)
#   bash scripts/start-dev.sh --tmux      # tmux mode (interactive, switchable windows)
#   bash scripts/start-dev.sh --split     # OS-native split terminals
#   bash scripts/start-dev.sh --force     # kill any process on ports 3000/3001/81 first
#   bash scripts/start-dev.sh --force --tmux  # combine options
#
# Prerequisites:
#   - Bun (https://bun.sh/)
#   - Caddy (https://caddyserver.com/docs/install) — optional
#   - Telegram API credentials in mini-services/telegram-collector/.env
#
# After starting:
#   - With Caddy:    open http://localhost:81
#   - Without Caddy: open http://localhost:3000
#
# Stop all services:
#   bash scripts/stop-dev.sh
#   bash scripts/stop-dev.sh --force

set -euo pipefail

# ── Parse CLI flags ──────────────────────────────────────────────────────────
FORCE=false
MODE="--background"   # default — works on any system without extra deps
for arg in "$@"; do
  case "$arg" in
    --force|-f) FORCE=true ;;
    --split|-s) MODE="--split" ;;
    --tmux|-t)  MODE="--tmux" ;;
    --background|-b) MODE="--background" ;;
    --help|-h)
      echo "Usage: bash scripts/start-dev.sh [OPTIONS]"
      echo ""
      echo "Options:"
      echo "  --force, -f       Kill any process occupying ports 3000, 3001, 81 before starting"
      echo "  --background, -b  Start services in background with logs (default)"
      echo "  --tmux, -t        Start in tmux session with switchable windows (requires tmux)"
      echo "  --split, -s       Start in OS-native split terminals (requires gnome-terminal/xterm/osascript)"
      echo "  --help, -h        Show this help message"
      exit 0
      ;;
    *)
      echo "Unknown option: $arg (use --help for usage)"
      exit 1
      ;;
  esac
done

PROJECT_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_ROOT"

export DATABASE_URL="file:$PROJECT_ROOT/db/custom.db"
LOG_DIR="$PROJECT_ROOT/.dev-logs"
mkdir -p "$LOG_DIR"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

echo -e "${CYAN}╔══════════════════════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║  TrueSignal — 3-Service Dev Launcher                         ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════════════════════════╝${NC}"
echo ""

# ── Pre-flight checks ────────────────────────────────────────────────────────
echo -e "${YELLOW}Pre-flight checks:${NC}"

check_cmd() {
  if command -v "$1" &>/dev/null; then
    echo -e "  ${GREEN}✓${NC} $1 found"
    return 0
  else
    echo -e "  ${RED}✗${NC} $1 not found"
    return 1
  fi
}

HAS_BUN=$(check_cmd bun && echo yes || echo no)
HAS_CADDY=$(check_cmd caddy && echo yes || echo no)

if [ "$HAS_BUN" = "no" ]; then
  echo -e "\n${RED}Error: Bun is required. Install from https://bun.sh/${NC}"
  exit 1
fi

if [ "$HAS_CADDY" = "no" ]; then
  echo -e "\n${YELLOW}Warning: Caddy not found. Starting without Caddy gateway.${NC}"
  echo -e "${YELLOW}  The app will be available at http://localhost:3000 (Next.js rewrites handle proxying).${NC}"
  USE_CADDY=false
else
  USE_CADDY=true
fi

# Check .env files
if [ ! -f "$PROJECT_ROOT/mini-services/telegram-collector/.env" ]; then
  echo -e "  ${YELLOW}⚠${NC} mini-services/telegram-collector/.env not found"
  echo -e "     Create it with TELEGRAM_API_ID and TELEGRAM_API_HASH"
  echo -e "     Get credentials from https://my.telegram.org → API development tools"
fi

# Check if DB exists
if [ ! -f "$PROJECT_ROOT/db/audit.db" ]; then
  echo -e "\n${YELLOW}Database not found. Setting up fresh databases...${NC}"
  bun scripts/push-schemas.ts
  echo -e "${GREEN}  ✓ Schemas pushed${NC}"
  echo -e "${YELLOW}  Run 'bun scripts/seed.ts' to populate with demo data${NC}"
fi

# Validate tmux mode if requested
if [ "$MODE" = "--tmux" ] && ! command -v tmux &>/dev/null; then
  echo -e "\n${YELLOW}tmux not found. Falling back to --background mode.${NC}"
  MODE="--background"
fi

# Validate split mode if requested
if [ "$MODE" = "--split" ]; then
  OS_TYPE=$(uname -s)
  if [ "$OS_TYPE" = "Darwin" ]; then
    : # macOS has osascript
  elif ! command -v gnome-terminal &>/dev/null && ! command -v xterm &>/dev/null; then
    echo -e "\n${YELLOW}No terminal emulator found (gnome-terminal/xterm). Falling back to --background mode.${NC}"
    MODE="--background"
  fi
fi

echo ""

# ── Kill any existing instances ──────────────────────────────────────────────
echo -e "${YELLOW}Stopping any existing services...${NC}"

pkill -f "next dev" 2>/dev/null || true
pkill -f "next-server" 2>/dev/null || true
pkill -f "bun.*index.ts" 2>/dev/null || true
if [ "$USE_CADDY" = true ]; then
  caddy stop --config "$PROJECT_ROOT/Caddyfile" 2>/dev/null || true
fi
sleep 1

# ── Force mode: kill ANY process on our ports ───────────────────────────────
if [ "$FORCE" = true ]; then
  echo -e "${YELLOW}Force mode: killing any process on ports 3000, 3001, 81...${NC}"

  kill_port() {
    local port=$1
    local pids=""
    if command -v lsof &>/dev/null; then
      pids=$(lsof -ti ":$port" 2>/dev/null || true)
    fi
    if [ -z "$pids" ] && command -v fuser &>/dev/null; then
      pids=$(fuser "$port/tcp" 2>/dev/null | tr -s ' ' '\n' | grep -v '^$' || true)
    fi
    if [ -z "$pids" ] && command -v ss &>/dev/null; then
      pids=$(ss -tlnp 2>/dev/null | grep ":$port " | grep -oP 'pid=\K\d+' || true)
    fi
    if [ -n "$pids" ]; then
      for pid in $pids; do
        echo -e "  ${RED}⚡ killing PID $pid on port $port${NC}"
        kill -9 "$pid" 2>/dev/null || true
      done
      sleep 1
    else
      echo -e "  ${GREEN}✓${NC} port $port is free"
    fi
  }

  kill_port 3000
  kill_port 3001
  if [ "$USE_CADDY" = true ]; then
    kill_port 81
  fi
  tmux kill-session -t truesignal 2>/dev/null || true
  echo -e "  ${GREEN}✓${NC} All ports cleared"
else
  echo -e "  ${GREEN}✓${NC} Clean slate"
  echo -e "  ${YELLOW}  Tip: use --force to kill any process occupying ports 3000/3001/81${NC}"
fi
echo ""

# ── Service startup commands ─────────────────────────────────────────────────
NEXTJS_CMD="cd '$PROJECT_ROOT' && export DATABASE_URL='file:$PROJECT_ROOT/db/custom.db' && exec bun x next dev -p 3000"
COLLECTOR_CMD="cd '$PROJECT_ROOT/mini-services/telegram-collector' && exec bun run dev"
CADDY_CMD="cd '$PROJECT_ROOT' && exec caddy run --config Caddyfile"

NUM_SERVICES=2
if [ "$USE_CADDY" = true ]; then NUM_SERVICES=3; fi

# ── Background mode (default — works on any system) ─────────────────────────
if [ "$MODE" = "--background" ]; then
  echo -e "${CYAN}Starting $NUM_SERVICES service(s) in background...${NC}"
  echo ""

  nohup bash -c "$NEXTJS_CMD" > "$LOG_DIR/nextjs.log" 2>&1 &
  NEXTJS_PID=$!
  echo -e "  ${GREEN}▶${NC} Next.js       (PID $NEXTJS_PID, port 3000) → $LOG_DIR/nextjs.log"

  nohup bash -c "$COLLECTOR_CMD" > "$LOG_DIR/collector.log" 2>&1 &
  COLLECTOR_PID=$!
  echo -e "  ${GREEN}▶${NC} Collector     (PID $COLLECTOR_PID, port 3001) → $LOG_DIR/collector.log"

  if [ "$USE_CADDY" = true ]; then
    nohup bash -c "$CADDY_CMD" > "$LOG_DIR/caddy.log" 2>&1 &
    CADDY_PID=$!
    echo -e "  ${GREEN}▶${NC} Caddy Gateway (PID $CADDY_PID, port 81)   → $LOG_DIR/caddy.log"
  fi

  # Save PIDs for stop-dev.sh
  echo "$NEXTJS_PID" > "$LOG_DIR/nextjs.pid"
  echo "$COLLECTOR_PID" > "$LOG_DIR/collector.pid"
  if [ "$USE_CADDY" = true ]; then
    echo "$CADDY_PID" > "$LOG_DIR/caddy.pid"
  fi

  # Wait for services to be ready
  echo ""
  echo -e "${YELLOW}Waiting for services to start...${NC}"
  for i in $(seq 1 30); do
    NEXT_OK=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/ 2>/dev/null || echo "000")
    COL_OK=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/status 2>/dev/null || echo "000")
    if [ "$NEXT_OK" = "200" ] && [ "$COL_OK" = "200" ]; then
      echo -e "  ${GREEN}✓${NC} Both services are up (attempt $i)"
      break
    fi
    sleep 1
  done

  echo ""
  if [ "$USE_CADDY" = true ]; then
    echo -e "${GREEN}✅ All services running!${NC}"
    echo -e "   Open ${CYAN}http://localhost:81${NC} in your browser"
  else
    echo -e "${GREEN}✅ Next.js + Collector running!${NC}"
    echo -e "   Open ${CYAN}http://localhost:3000${NC} in your browser"
  fi
  echo ""
  echo -e "  Logs:     ${CYAN}tail -f $LOG_DIR/{nextjs,collector}.log${NC}"
  echo -e "  Stop:     ${CYAN}bash scripts/stop-dev.sh${NC}"
  echo -e "  Force stop: ${CYAN}bash scripts/stop-dev.sh --force${NC}"

# ── tmux mode ───────────────────────────────────────────────────────────────
elif [ "$MODE" = "--tmux" ]; then
  SESSION_NAME="truesignal"
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

  tmux new-session -d -s "$SESSION_NAME" -n "Next.js :3000" \
    "$NEXTJS_CMD 2>&1 | tee '$LOG_DIR/nextjs.log'; echo 'Next.js stopped. Press Enter to exit.'; read"

  tmux new-window -t "$SESSION_NAME" -n "Collector :3001" \
    "$COLLECTOR_CMD 2>&1 | tee '$LOG_DIR/collector.log'; echo 'Collector stopped. Press Enter to exit.'; read"

  if [ "$USE_CADDY" = true ]; then
    tmux new-window -t "$SESSION_NAME" -n "Caddy :81" \
      "$CADDY_CMD 2>&1 | tee '$LOG_DIR/caddy.log'; echo 'Caddy stopped. Press Enter to exit.'; read"
  fi

  tmux new-window -t "$SESSION_NAME" -n "Shell" \
    "cd '$PROJECT_ROOT' && echo 'TrueSignal dev shell. Run commands here.'; exec bash"

  echo -e "${GREEN}✅ tmux session '${SESSION_NAME}' created with $NUM_SERVICES + 1 windows:${NC}"
  echo ""
  echo -e "  ${CYAN}Window 1:${NC} Next.js       (port 3000)"
  echo -e "  ${CYAN}Window 2:${NC} Collector     (port 3001)"
  if [ "$USE_CADDY" = true ]; then
    echo -e "  ${CYAN}Window 3:${NC} Caddy Gateway (port 81)"
    echo -e "  ${CYAN}Window 4:${NC} Shell"
  else
    echo -e "  ${CYAN}Window 3:${NC} Shell"
  fi
  echo ""
  echo -e "  Switch windows: ${YELLOW}Ctrl+B${NC} then ${YELLOW}1/2/3/4${NC}"
  echo -e "  Detach:         ${YELLOW}Ctrl+B${NC} then ${YELLOW}D${NC}"
  echo -e "  Reattach:       ${YELLOW}tmux attach -t ${SESSION_NAME}${NC}"
  echo -e "  Stop all:       ${YELLOW}bash scripts/stop-dev.sh${NC}"
  echo ""
  if [ "$USE_CADDY" = true ]; then
    echo -e "  Open ${CYAN}http://localhost:81${NC} in your browser"
  else
    echo -e "  Open ${CYAN}http://localhost:3000${NC} in your browser"
  fi
  echo ""
  exec tmux attach -t "$SESSION_NAME"

# ── Split terminal mode ─────────────────────────────────────────────────────
elif [ "$MODE" = "--split" ]; then
  echo -e "${CYAN}Launching split terminals...${NC}"
  echo ""

  OS_TYPE=$(uname -s)
  if [ "$OS_TYPE" = "Darwin" ]; then
    osascript -e "tell application \"Terminal\" to do script \"$NEXTJS_CMD 2>&1 | tee '$LOG_DIR/nextjs.log'\""
    osascript -e "tell application \"Terminal\" to do script \"$COLLECTOR_CMD 2>&1 | tee '$LOG_DIR/collector.log'\""
    if [ "$USE_CADDY" = true ]; then
      osascript -e "tell application \"Terminal\" to do script \"$CADDY_CMD 2>&1 | tee '$LOG_DIR/caddy.log'\""
    fi
    echo -e "  ${GREEN}✓${NC} Opened Terminal tabs"
  elif command -v gnome-terminal &>/dev/null; then
    gnome-terminal --tab --title="Next.js :3000" -- bash -c "$NEXTJS_CMD 2>&1 | tee '$LOG_DIR/nextjs.log'; exec bash"
    gnome-terminal --tab --title="Collector :3001" -- bash -c "$COLLECTOR_CMD 2>&1 | tee '$LOG_DIR/collector.log'; exec bash"
    if [ "$USE_CADDY" = true ]; then
      gnome-terminal --tab --title="Caddy :81" -- bash -c "$CADDY_CMD 2>&1 | tee '$LOG_DIR/caddy.log'; exec bash"
    fi
    echo -e "  ${GREEN}✓${NC} Opened gnome-terminal tabs"
  elif command -v xterm &>/dev/null; then
    xterm -title "Next.js :3000" -e "$NEXTJS_CMD 2>&1 | tee '$LOG_DIR/nextjs.log'" &
    xterm -title "Collector :3001" -e "$COLLECTOR_CMD 2>&1 | tee '$LOG_DIR/collector.log'" &
    if [ "$USE_CADDY" = true ]; then
      xterm -title "Caddy :81" -e "$CADDY_CMD 2>&1 | tee '$LOG_DIR/caddy.log'" &
    fi
    echo -e "  ${GREEN}✓${NC} Opened xterm windows"
  fi

  echo ""
  if [ "$USE_CADDY" = true ]; then
    echo -e "${GREEN}✅ All services starting!${NC}"
    echo -e "   Open ${CYAN}http://localhost:81${NC} in your browser"
  else
    echo -e "${GREEN}✅ Next.js + Collector starting!${NC}"
    echo -e "   Open ${CYAN}http://localhost:3000${NC} in your browser"
  fi
fi
