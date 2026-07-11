# Usage Guide

## 1. Authenticate with Telegram

Authentication status is visible in the **sidebar footer** on all views.

1. Go to the **Ingest** tab
2. Click **Connect to Telegram** (uses your API credentials from `.env`)
3. Enter your phone number → receive a code in your Telegram app → enter the code
4. If 2FA is enabled, enter your cloud password
5. Your session is saved — no re-login needed on restart
6. To logout: use the **Logout** button in the sidebar footer

## 2. Ingest channel history

1. Enter a channel `@username`, title, or **Peer ID** (e.g. `2166348331`)
2. Click **Resolve** to find the channel
3. Set the message limit (slider up to 10,000) or check **All history** for unlimited ingestion
4. Click **Ingest**
5. Use **Pause** / **Resume** / **Stop** controls as needed — position is saved for resume
6. The Ingest button spinner syncs with pause/stop states (shows "Paused" or "Stopping…" accordingly)

## 3. Evaluate signals against market data

1. In the **Ingest** tab, scroll to the **Signal Evaluation** panel
2. Click **Evaluate N signals**
3. The evaluator runs 4 parallel workers, fetches historical OHLC bars from Dukascopy (cached in DB for reuse), and determines win/loss for each signal
4. Evaluation respects entry type:
   - **Market orders**: fill immediately at entry price
   - **Stop orders**: fill when price breaks through entry (breakout trigger)
   - **Limit orders**: fill when price touches entry (pullback trigger)
   - **Range orders**: fill when price touches range (conservative fill at edge closest to SL)
5. Results appear in the **Signals** and **Overview** views

## 4. Fetch market data

Via the **Data Manager** tab → **Fetch** tab:

| Source | Instruments | Auth |
|--------|------------|------|
| Dukascopy | Forex, metals, crypto, indices | Free, no auth |
| Binance | Crypto spot (BTC, ETH, altcoins) | Free, no auth |
| Yahoo Finance | Stocks, ETFs, indices | Free, no auth |
| CSV Upload | Any — flexible OHLCV format | N/A |
| Darwinex | Broker data | OAuth2 (use CSV export) |

**Terminology**: API sources use "Fetch" (data retrieved from a remote API). CSV upload uses "Import" (file uploaded from disk).

## 5. Export data

- **Export tab** — download signals as CSV, JSON, or XLSX
- **Data Manager** → **Export** tab — export cached price bars as CSV/JSON

## 6. View analytics

| View | What it shows |
|------|--------------|
| **Overview** | Equity curve (continuous daily range, uses postedAt), KPIs (win rate, expectancy, Sharpe, Calmar, per-trade max DD), channel leaderboard, drawdown |
| **Channels** | Per-channel performance cards with WifiCog signal-counter pills, sortable by Total R / Win Rate / Expectancy / Sharpe / Subscribers |
| **Signals** | Filterable table (channel, instrument, action, outcome) with debounced search, empty state, signal detail drawer with price ladder |
| **Analytics** | R-multiple distribution, monthly heatmap, MFE-vs-MAE scatter, instrument breakdown, long vs short (win rate excludes breakevens) |
| **Pipeline** | Ingestion architecture visualization, per-channel ingestion counts, live feed |
| **Data Manager** | Fetch from Dukascopy/Binance/Yahoo/CSV, export bars, view cache summary |

## Multi-stage signal parsing

TrueSignal uses a 3-stage cascade parser that handles various Telegram signal formats:

### Stage 1: Keyword-structured (confidence ≥0.8)
Handles explicit keywords: "Entry: X | SL: Y | TP: Z"
```
SIGNAL PANDAI BARU! - XAUUSDz Sell Limit 📉
Entry Sell Limit: 4113.00 | SL: 4134.00 | TP: 4081.00
```

### Stage 2: Action-anchored (confidence ≥0.6)
Handles entry anchored to action verb: "BUY @ X", "SELL NOW @ X-Y"
```
GOLD / XAUUSD SELL | SELL NOW @ 4172-4179 | SL : 4182 | TP : OPEN
```

### Stage 3: Price-proximity (confidence ≥0.4)
Last-resort: SL keyword required, entry extracted from nearby prices. Rejects post-trade reports and recaps.

### Entry types
The parser detects 4 entry types from the action keyword:
- **market** — BUY, SELL, LONG, SHORT (immediate fill)
- **stop** — BUY STOP, SELL STOP (breakout trigger)
- **limit** — BUY LIMIT, SELL LIMIT (pullback trigger)
- **range** — BUY RANGE, SELL RANGE, BUY ZONE, SELL ZONE (zone entry)

### TP: OPEN support
When a channel says "TP: OPEN" (no explicit take-profit), the parser derives 1R and 2R targets from entry/SL.

## Signal deduplication

TrueSignal prevents duplicate signals using a `dedupHash` — a composite key of `channelId + postedAt` (the message timestamp). Since each message has a unique timestamp, the combination uniquely identifies a signal. Re-ingesting the same messages will not create duplicates.

## Metrics notes

- **Win rate** excludes breakevens from the denominator: `wins / (wins + losses)`
- **Max drawdown** is computed per-trade (captures intra-day peaks), not from daily aggregation
- **Equity curve** uses `postedAt` (when the signal was posted to Telegram), not `evaluatedAt` (when our system processed it), and fills calendar gaps with flat lines for a continuous timeline
- **bestTrade/worstTrade** show the actual max/min R values (not clamped to 0)
