# Usage Guide

## 1. Authenticate with Telegram

Authentication status is visible in the **sidebar footer** on all views.

1. Go to the **Ingest** tab
2. Click **Connect to Telegram** (uses your API credentials from `.env`)
3. Enter your phone number, then receive a code in your Telegram app, then enter the code
4. If 2FA is enabled, enter your cloud password
5. Your session is saved — no re-login needed on restart
6. To logout: use the **Logout** button in the sidebar footer

## 2. Ingest channel history

1. Enter a channel `@username`, title, or **Peer ID** (e.g. `2166348331`)
2. Click **Resolve** to find the channel
3. Set the message limit (slider up to 10,000) or check **All history** for unlimited ingestion
4. Click **Ingest**
5. Use **Pause** / **Resume** / **Stop** controls as needed — position is saved for resume

## 3. Evaluate signals against market data

1. In the **Ingest** tab, scroll to the **Signal Evaluation** panel
2. Click **Evaluate N signals**
3. The evaluator runs 8 parallel workers and uses **M1-first** evaluation:
   - Tries M1 bars first (highest resolution, ~2,880 bars per 48h window)
   - Falls back to M15 if no M1 data available (~192 bars per 48h window)
4. Evaluation respects entry type:
   - **Market orders**: fill immediately at entry price
   - **Stop orders**: fill when price breaks through entry (breakout trigger)
   - **Limit orders**: fill when price touches entry (pullback trigger)
   - **Range orders**: fill when price touches range (conservative fill at edge closest to SL)
5. Results appear in the **Signals** and **Overview** views
6. The `marketDataSource` field in each evaluation records which source+timeframe was used (e.g. `dukascopy-m1`)

### Re-evaluating signals

- **Single signal**: Open any signal's detail drawer, then click **Re-evaluate** (uses `forceRefresh=true` to bypass cache)
- **No-data signals**: Signals with `no_data` outcome are automatically retried on the next batch evaluation
- **Bulk re-eval**: Run `bun scripts/reevaluate-no-data.ts` to re-evaluate all `no_data` signals

## 4. Import CSV data (Data Manager, Import tab)

The Import tab lets you upload high-quality OHLC bar data from CSV files — perfect for importing StrategyQuant/Dukascopy exports.

### Supported CSV formats (auto-detected)

| Format | Columns | Example |
|--------|---------|---------|
| StrategyQuant / Dukascopy | `Date,Time,Open,High,Low,Close,Volume` | `20240506,01:00:00,2304.655,2305.855,2303.055,2303.255,93470` |
| Combined datetime | `DateTime,Open,High,Low,Close,Volume` | `2024-05-06T01:00:00,2304.655,2305.855,2303.055,2303.255,93470` |
| Unix timestamp | `timestamp,open,high,low,close,volume` | `1714947600000,2304.655,2305.855,2303.055,2303.255,93470` |
| Bid/Ask (tick data) | `DateTime,Bid,Ask,Volume` | `2024-05-06 01:00:00,2304.6,2304.7,93470` |

### How to import

1. Go to **Data Manager**, then the **Import** tab
2. Set **Instrument** (e.g. `xauusd`), **Source label** (e.g. `dukascopy`), **Target timeframe** (M1 recommended)
3. Either **upload a file** (.csv, .txt, .tsv) or **paste CSV content** in the textarea
4. Click **Import CSV**
5. For large files (>10MB), a blue info banner appears; for 400MB+ files, the chunked upload system kicks in automatically

### Chunked upload (for 400MB+ files)

Large files are split into 5MB chunks on the frontend and sent as separate requests:

```
Uploading chunk 1/89 (5.0/441.0 MB) — 0 bars parsed
Uploading chunk 2/89 (10.0/441.0 MB) — 8,532 bars parsed
...
Uploading chunk 89/89 (441.0/441.0 MB) — 7,677,779 bars parsed
```

- Each request is ~5MB — well within any proxy/server limit
- Memory stays flat (~25MB) regardless of file size
- Live progress shows chunk number + bars parsed so far
- No connection resets (the main cause of large-file upload failures)

## 5. Fetch market data (Data Manager, Fetch tab)

| Source | Instruments | Auth |
|--------|------------|------|
| Dukascopy | Forex, metals, crypto, indices | Free, no auth |
| Binance | Crypto spot (BTC, ETH, altcoins) | Free, no auth |
| Yahoo Finance | Stocks, ETFs, indices | Free, no auth |
| CSV Upload | Any — flexible OHLCV format | N/A (use Import tab) |

### Multi-source priority

The fetcher automatically tries sources in priority order based on instrument type:

| Instrument Type | Priority Order |
|----------------|---------------|
| Crypto (BTC, ETH, SOL, ...) | Binance REST, Binance Vision, Dukascopy |
| Forex/Metals/Indices/Energy | Dukascopy, Yahoo Finance |

If a source fails (timeout, rate limit, error), the next source is tried automatically. Dukascopy has a 5-second timeout (fail fast) since it is chronically unreliable.

## 6. Export data

- **Export tab** — download signals as CSV, JSON, or XLSX
- **Data Manager**, then **Export** tab — export cached price bars as CSV/JSON

## 7. View analytics

| View | What it shows |
|------|--------------|
| **Overview** | Equity curve (continuous daily range, uses postedAt), KPIs (win rate, expectancy, per-trade Sharpe/Sortino/Calmar, max DD), channel leaderboard, drawdown |
| **Channels** | Per-channel performance cards, sortable by Total R / Win Rate / Expectancy / Sharpe / Subscribers |
| **Signals** | Sortable table (click any column header to sort asc/desc) with filters (channel, instrument, action, outcome), debounced search, signal detail drawer with price ladder |
| **Analytics** | R-multiple distribution, monthly heatmap, MFE-vs-MAE scatter, instrument breakdown, long vs short (win rate excludes breakevens) |
| **Pipeline** | Ingestion architecture visualization, per-channel ingestion counts, live feed |
| **Data Manager** | 5 tabs: Fetch (API sources), Import (CSV upload), Browse (paginated data viewer), Export (bars download), Analyze (cache summary + charts) |

### Sortable signals table

Click any column header in the Signals table to sort:
- **First click**: sorts by that column using its default direction (asc for text, desc for numbers/dates)
- **Second click**: toggles direction asc/desc
- **Active column**: shows arrow up or arrow down icon; inactive columns show a faint arrows icon
- Sorting is server-side (SQL ORDER BY) — works correctly with pagination
- For evaluation columns (Outcome, R), NULLs are pushed to the end

### Signal detail drawer

Click any signal row to open the detail drawer. The **Parsed Signal** section shows:
- Instrument, Type, Action
- **Signal TF** — the trader's stated timeframe from the signal message (e.g. "15m", "scalping")
- **Eval TF** — the actual bar timeframe used by the evaluator (M1 or M15, extracted from `marketDataSource`)
- Entry, Stop Loss
- Leverage, Position (only shown when the parser extracted them — no empty dash cells)

### First/last page navigation

All paginated tables include first page (`|<`) and last page (`>|`) buttons alongside the prev/next buttons, allowing quick navigation to the start or end of large datasets.

## Multi-stage signal parsing

TrueSignal uses a 3-stage cascade parser that handles various Telegram signal formats:

### Stage 1: Keyword-structured (confidence >= 0.8)
Handles explicit keywords: "Entry: X | SL: Y | TP: Z"
```
SIGNAL PANDAI BARU! - XAUUSDz Sell Limit
Entry Sell Limit: 4113.00 | SL: 4134.00 | TP: 4081.00
```

### Stage 2: Action-anchored (confidence >= 0.6)
Handles entry anchored to action verb: "BUY @ X", "SELL NOW @ X-Y", "BUY 4099 4095"
```
GOLD / XAUUSD SELL | SELL NOW @ 4172-4179 | SL : 4182 | TP : OPEN
XAUUSD BUY 4099 4095
SL 4080
TP 4105
TP 4110
```

Punctuation-tolerant: handles `!`, `@`, `:`, `.` between action keyword and price (e.g. "Sell now ! 4095").

### Stage 3: Price-proximity (confidence >= 0.4)
Last-resort: SL keyword required, entry extracted from nearby prices. Rejects post-trade reports and recaps.

### Entry types
The parser detects 4 entry types from the action keyword:
- **market** — BUY, SELL, LONG, SHORT (immediate fill)
- **stop** — BUY STOP, SELL STOP (breakout trigger)
- **limit** — BUY LIMIT, SELL LIMIT (pullback trigger)
- **range** — BUY RANGE, SELL RANGE, BUY ZONE, SELL ZONE, "BUY 4099 4095" (zone entry)

### TP extraction
- Multi-line format: `TP 4105\nTP 4110\nTP 4115` produces `[4105, 4110, 4115]`
- Level numbers: `TP1: 4105\nTP2: 4110` produces `[4105, 4110]`
- "TP: Open" — derives 1R/2R from entry/SL **only if no explicit TPs are found**

## Signal deduplication

TrueSignal prevents duplicate signals using a `dedupHash` — a composite key of `channelId + postedAt` (the message timestamp). Since each message has a unique timestamp, the combination uniquely identifies a signal. Re-ingesting the same messages will not create duplicates.

## Metrics notes

- **Win rate** excludes breakevens from the denominator: `wins / (wins + losses)`
- **Max drawdown** is computed per-trade (captures intra-day peaks), not from daily aggregation
- **Equity curve** uses `postedAt` (when the signal was posted to Telegram), not `evaluatedAt` (when our system processed it), and fills calendar gaps with flat lines for a continuous timeline
- **Sharpe ratio** is per-trade (not annualized): `mean(R) / std(R)` — R-multiples are normalized risk units, not percentage returns, so annualization with sqrt(252) would produce unrealistic values
- **Sortino ratio** uses downside deviation: `mean(R) / sqrt(mean(min(0, R)^2))` over ALL trades (not just losers)
- **Calmar ratio** = `totalR / maxDrawdown` (not annualized)
- **bestTrade/worstTrade** show the actual max/min R values (not clamped to 0)

### Sharpe interpretation guide

| Sharpe | Signal quality |
|--------|---------------|
| < 0.5 | Poor |
| 0.5 – 1.0 | Decent |
| 1.0 – 1.5 | Good |
| 1.5 – 2.0 | Excellent |
| > 2.0 | Exceptional (rare in practice) |
