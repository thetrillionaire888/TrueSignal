#!/usr/bin/env bash
#
# TrueSignal — 3-Service Dev Launcher
# Starts Next.js + Telegram Collector + Caddy gateway in separate terminals.
#
# Usage:
#   bash scripts/start-dev.sh          # uses tmux (recommended)
#   bash scripts/start-dev.sh --split  # uses OS-native split terminals
#
# Prerequisites:
#   - Bun (https://bun.sh/)
#   - Caddy (https://caddyserver.com/docs/install)
#   - Telegram API credentials in mini-services/telegram-collector/.env
#
# After starting:
#   - With Caddy:    open http://localhost:81
#   - Without Caddy: open http://localhost:3000
#
# Stop all services:
#   bash scripts/stop-dev.sh
#   (or pkill -f "next dev"; pkill -f "bun.*index.ts"; caddy stop)

set -euo pipefail

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
NC='\033[0m' # No Color

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
HAS_TMUX=$(check_cmd tmux && echo yes || echo no)

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
echo -e "  ${GREEN}✓${NC} Clean slate"
echo ""

# ── Start services ───────────────────────────────────────────────────────────

# Service 1: Next.js (port 3000)
start_nextjs() {
  echo -e "${GREEN}▶ Starting Next.js (port 3000)...${NC}"
  cd "$PROJECT_ROOT"
  bun x next dev -p 3000 2>&1 | tee "$LOG_DIR/nextjs.log"
}

# Service 2: Telegram Collector (port 3001)
start_collector() {
  echo -e "${GREEN}▶ Starting Telegram Collector (port 3001)...${NC}"
  cd "$PROJECT_ROOT/mini-services/telegram-collector"
  bun run dev 2>&1 | tee "$LOG_DIR/collector.log"
}

# Service 3: Caddy Gateway (port 81)
start_caddy() {
  echo -e "${GREEN}▶ Starting Caddy Gateway (port 81)...${NC}"
  cd "$PROJECT_ROOT"
  caddy run --config "$PROJECT_ROOT/Caddyfile" 2>&1 | tee "$LOG_DIR/caddy.log"
}

# ── Launch method ────────────────────────────────────────────────────────────
MODE="${1:---tmux}"

if [ "$MODE" = "--split" ]; then
  # ── OS-native split terminals ─────────────────────────────────────────────
  echo -e "${CYAN}Launching 3 split terminals...${NC}"
  echo ""

  # Detect OS and use the appropriate terminal command
  OS_TYPE=$(uname -s)
  if [ "$OS_TYPE" = "Darwin" ]; then
    # macOS — use osascript to open Terminal.app tabs
    osascript -e "tell application \"Terminal\" to do script \"cd '$PROJECT_ROOT' && export DATABASE_URL='file:$PROJECT_ROOT/db/custom.db' && bun x next dev -p 3000 2>&1 | tee '$LOG_DIR/nextjs.log'\""
    osascript -e "tell application \"Terminal\" to do script \"cd '$PROJECT_ROOT/mini-services/telegram-collector' && bun run dev 2>&1 | tee '$LOG_DIR/collector.log'\""
    if [ "$USE_CADDY" = true ]; then
      osascript -e "tell application \"Terminal\" to do script \"cd '$PROJECT_ROOT' && caddy run --config Caddyfile 2>&1 | tee '$LOG_DIR/caddy.log'\""
    fi
    echo -e "  ${GREEN}✓${NC} Opened Terminal tabs for each service"
  else
    # Linux — try gnome-terminal, then xterm, then fall back to background
    if command -v gnome-terminal &>/dev/null; then
      gnome-terminal --tab --title="Next.js :3000" -- bash -c "cd '$PROJECT_ROOT' && export DATABASE_URL='file:$PROJECT_ROOT/db/custom.db' && bun x next dev -p 3000 2>&1 | tee '$LOG_DIR/nextjs.log'; exec bash"
      gnome-terminal --tab --title="Collector :3001" -- bash -c "cd '$PROJECT_ROOT/mini-services/telegram-collector' && bun run dev 2>&1 | tee '$LOG_DIR/collector.log'; exec bash"
      if [ "$USE_CADDY" = true ]; then
        gnome-terminal --tab --title="Caddy :81" -- bash -c "cd '$PROJECT_ROOT' && caddy run --config Caddyfile 2>&1 | tee '$LOG_DIR/caddy.log'; exec bash"
      fi
      echo -e "  ${GREEN}✓${NC} Opened gnome-terminal tabs for each service"
    elif command -v xterm &>/dev/null; then
      xterm -title "Next.js :3000" -e "cd '$PROJECT_ROOT' && export DATABASE_URL='file:$PROJECT_ROOT/db/custom.db' && bun x next dev -p 3000 2>&1 | tee '$LOG_DIR/nextjs.log'" &
      xterm -title "Collector :3001" -e "cd '$PROJECT_ROOT/mini-services/telegram-collector' && bun run dev 2>&1 | tee '$LOG_DIR/collector.log'" &
      if [ "$USE_CADDY" = true ]; then
        xterm -title "Caddy :81" -e "cd '$PROJECT_ROOT' && caddy run --config Caddyfile 2>&1 | tee '$LOG_DIR/caddy.log'" &
      fi
      echo -e "  ${GREEN}✓${NC} Opened xterm windows for each service"
    else
      echo -e "  ${YELLOW}No terminal emulator found. Starting in background...${NC}"
      nohup bash -c "cd '$PROJECT_ROOT' && export DATABASE_URL='file:$PROJECT_ROOT/db/custom.db' && bun x next dev -p 3000" > "$LOG_DIR/nextjs.log" 2>&1 &
      nohup bash -c "cd '$PROJECT_ROOT/mini-services/telegram-collector' && bun run dev" > "$LOG_DIR/collector.log" 2>&1 &
      if [ "$USE_CADDY" = true ]; then
        nohup bash -c "cd '$PROJECT_ROOT' && caddy run --config Caddyfile" > "$LOG_DIR/caddy.log" 2>&1 &
      fi
      echo -e "  ${GREEN}✓${NC} Services started in background"
      echo -e "  Logs: $LOG_DIR/{nextjs,collector,caddy}.log"
    fi
  fi

  echo ""
  if [ "$USE_CADDY" = true ]; then
    echo -e "${GREEN}✅ All services starting!${NC}"
    echo -e "   Open ${CYAN}http://localhost:81${NC} in your browser"
  else
    echo -e "${GREEN}✅ Next.js + Collector starting!${NC}"
    echo -e "   Open ${CYAN}http://localhost:3000${NC} in your browser"
  fi

else
  # ── tmux mode (default, recommended) ──────────────────────────────────────
  if [ "$HAS_TMUX" = "no" ]; then
    echo -e "${YELLOW}tmux not found. Falling back to --split mode.${NC}"
    exec "$0" --split
  fi

  SESSION_NAME="truesignal"

  # Kill existing tmux session if present
  tmux kill-session -t "$SESSION_NAME" 2>/dev/null || true

  # Create new tmux session with Next.js in the first window
  tmux new-session -d -s "$SESSION_NAME" -n "Next.js :3000" \
    "cd '$PROJECT_ROOT' && export DATABASE_URL='file:$PROJECT_ROOT/db/custom.db' && bun x next dev -p 3000 2>&1 | tee '$LOG_DIR/nextjs.log'; echo 'Next.js stopped. Press Enter to exit.'; read"

  # Second window: Collector
  tmux new-window -t "$SESSION_NAME" -n "Collector :3001" \
    "cd '$PROJECT_ROOT/mini-services/telegram-collector' && bun run dev 2>&1 | tee '$LOG_DIR/collector.log'; echo 'Collector stopped. Press Enter to exit.'; read"

  # Third window: Caddy (if available)
  if [ "$USE_CADDY" = true ]; then
    tmux new-window -t "$SESSION_NAME" -n "Caddy :81" \
      "cd '$PROJECT_ROOT' && caddy run --config Caddyfile 2>&1 | tee '$LOG_DIR/caddy.log'; echo 'Caddy stopped. Press Enter to exit.'; read"
  fi

  # Fourth window: shell for commands
  tmux new-window -t "$SESSION_NAME" -n "Shell" \
    "cd '$PROJECT_ROOT' && echo 'TrueSignal dev shell. Run commands here.'; exec bash"

  echo -e "${GREEN}✅ tmux session '${SESSION_NAME}' created with $(if [ "$USE_CADDY" = true ]; then echo "4"; else echo "3"; fi) windows:${NC}"
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
  echo -e "  Stop all:       ${YELLOW}tmux kill-session -t ${SESSION_NAME}${NC}"
  echo ""
  if [ "$USE_CADDY" = true ]; then
    echo -e "  Open ${CYAN}http://localhost:81${NC} in your browser"
  else
    echo -e "  Open ${CYAN}http://localhost:3000${NC} in your browser"
  fi
  echo ""

  # Attach to the session
  exec tmux attach -t "$SESSION_NAME"
fi
