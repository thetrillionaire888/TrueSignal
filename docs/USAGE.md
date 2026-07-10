# Usage Guide

## 1. Authenticate with Telegram

1. Go to the **Ingest** tab
2. Click **Connect to Telegram** (uses your API credentials from `.env`)
3. Enter your phone number → receive a code in your Telegram app → enter the code
4. If 2FA is enabled, enter your cloud password
5. Your session is saved — no re-login needed on restart

## 2. Ingest channel history

1. Enter a channel `@username`, title, or **Peer ID** (e.g. `2166348331`)
2. Click **Resolve** to find the channel
3. Set the message limit (slider up to 10,000) or check **All history** for unlimited ingestion
4. Click **Ingest**
5. Use **Pause** / **Resume** / **Stop** controls as needed — position is saved for resume

## 3. Evaluate signals against market data

1. In the **Ingest** tab, scroll to the **Signal Evaluation** panel
2. Click **Evaluate N signals**
3. The evaluator fetches historical OHLC bars from Dukascopy (cached in DB for reuse) and determines win/loss for each signal
4. Results appear in the **Signals** and **Overview** views

## 4. Import additional market data

Via the Data Manager API (`/api/import`):

| Source | Instruments | Auth |
|--------|------------|------|
| Dukascopy | Forex, metals, crypto, indices | Free, no auth |
| Binance | Crypto spot (BTC, ETH, altcoins) | Free, no auth |
| Yahoo Finance | Stocks, ETFs, indices | Free, no auth |
| CSV Upload | Any — flexible OHLCV format | N/A |
| Darwinex | Broker data | OAuth2 (use CSV export) |

## 5. Export data

- **Export tab** — download signals as CSV, JSON, or XLSX
- **Data Manager API** (`/api/export-bars`) — export cached price bars as CSV/JSON

## 6. View analytics

| View | What it shows |
|------|--------------|
| **Overview** | Equity curve, KPIs (win rate, expectancy, Sharpe, Calmar, max DD), channel leaderboard, drawdown |
| **Channels** | Per-channel performance cards with equity curves, top instruments, recent signals |
| **Signals** | Filterable table (channel, instrument, action, outcome) with signal detail drawer |
| **Analytics** | R-multiple distribution, monthly heatmap, MFE-vs-MAE scatter, instrument breakdown, long vs short |
| **Pipeline** | Ingestion architecture visualization, per-channel ingestion counts, live feed |

## Range signal backtesting

Channels like CallistoFx post signals as price ranges rather than single prices:

```
🔴XAUUSD🔴
SELL RANGE: 4110 - 4116
SL 4120
TP : 4050
```

TrueSignal uses a **conservative fill model** for range backtesting:

1. **Entry trigger** — walk forward through bars; entry is "filled" when price first touches the range
2. **Fill price** — the range edge closest to SL (worst-case fill), giving the lowest R-multiple
3. **SL/TP** — once filled, walk forward to find SL or TP hit
4. **Edge cases** — if SL hit before range touched → `invalid`; if range never touched → `invalid`

## Signal deduplication

TrueSignal prevents duplicate signals using a `dedupHash` — a composite key of `channelId + postedAt` (the message timestamp). Since each message has a unique timestamp, the combination uniquely identifies a signal. Re-ingesting the same messages will not create duplicates.
