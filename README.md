# Rahasampo Radar / AI Trading Pro

Trading dashboard and deterministic indicator engine for research and education. The original Streamlit application (`app.py`) is preserved. The browser dashboard is served from `public/` on Vercel. The user-facing dashboard contains no demo/paper-trading report panels. No synthetic demo candles are generated: if live market data fails, signal calculation stops rather than presenting fabricated or stale prices.

## Browser dashboard

- Public Binance Spot market data: closed OHLCV candles, 24-hour ticker, and bid/ask book ticker. Public market-data endpoints do not require a user API key.
- Supported pairs: BTC, ETH, SOL, BNB, XRP and DOGE against USDT.
- Indicators: EMA 9/21/50/200, Wilder RSI, ATR, MACD, ADX and relative volume.
- Conservative signal gates: requires a trend/momentum setup plus confirmation from two higher timeframes, recent price data, a sufficiently narrow spread and non-extreme volatility. If a required check fails or data cannot be validated, it returns `ODOTA`.
- Spot risk calculator estimates position sizing for a BUY using account value, a configurable risk fraction, a maximum exposure cap, estimated exchange fees, slippage and half the quoted spread per side. SELL signals do not invent a sell quantity because the app does not know the user's holdings.
- Historical test: paginated 1h history (up to 2,500 closed candles per pair, fetched in batches of at most 1,000), plus aligned 4h/1d history for BTC, ETH, SOL and the selected pair. Live, backtest and paper trading call the same `evaluateSignal()` function. The backtest remains long-only spot; historical spread is an estimate because past order-book quotes are not fetched. If fewer than 100 trades exist, return, win-rate, drawdown and profit-factor metrics are shown as `—` with a warning rather than treated as evidence.

Signal diagnostics: the checklist chooses BUY/SELL context from the EMA trend bias before falling back to score counts, so a bearish trend is not accidentally shown with the bullish checklist while direction is WAIT. Higher-timeframe trend bias is separated from MACD histogram sign; MACD is labelled by what is actually measured (histogram positive/negative). The volume threshold is 0.5x the prior 20-candle average, and support/resistance are calculated from the prior 30 candles excluding the current candle. The support/resistance clearance guard is 0.5 ATR. These are hypotheses to validate, not proven improvements; compare results and drawdown over a larger sample.

## Run tests

Requires Node.js 20 or newer:

```bash
npm test
```

GitHub Actions runs this test on pushes and pull requests to `main`.

## Vercel setup

The Vercel project should use **Framework Preset: Other**, no build command, and **Output Directory: `public`**. These values are also represented in `vercel.json`. Connect this repository's `main` branch to Vercel to publish changes automatically. `vercel.json` uses `scripts/vercel-ignore-build.js` to skip telemetry-only paper-report commits and the dedicated `paper-data` branch, preventing scheduled reporting from consuming production build quota. Check build logs and the resulting URL after code changes; a commit being present in GitHub does not itself prove that a deployment succeeded.

## Important limitations

- This is a rule-based technical-analysis tool, not a machine-learning model and not a proven profitable strategy.
- A signal is not a probability of success and cannot be a "safe" guarantee. Crypto prices can gap or move quickly; stop orders may fill materially away from the estimated level.
- `OSTA` is only a research signal for a spot purchase. `MYY / KEVENNÄ` means consider reducing an existing spot holding or avoiding a new purchase; it does not initiate a short position.
- The historical test includes time-aligned 4h/1d confirmation, but it does not simulate funding costs, taxes, changing historical spreads, order-book depth, outages, or realistic partial fills. Stop gaps are modeled at the candle open rather than the idealized stop price, and ambiguous same-candle stop/target hits resolve stop-first; the true intrabar path remains unknown. Historical performance is not a prediction.
- The web dashboard does not read account balances, hold exchange secrets, or submit orders. Do not put exchange API keys in browser code or Git.
- Live signal results must be independently reviewed and paper-tested before any real-money use.


## Scheduled paper trading (two-hour cycles)

A GitHub Actions workflow (\`.github/workflows/paper-trading-cycle.yml\`) runs every two hours and can also be started manually from **Actions → Paper trading data collection (2-hour cycle) → Run workflow**. It fetches public Binance Spot candles for BTC, ETH, SOL, BNB, XRP and DOGE, calculates the 1h signal with 4h and 1d confirmations, then records a simulated portfolio, trades, data errors and a JSON/Markdown report under \`data/\`.

- All trades are virtual; no exchange orders or API keys are used.
- The virtual portfolio starts at 1,000 USDT and is persisted in \`data/paper-state.json\`.
- Latest report: \`data/latest-report.json\`; cycle history: \`data/reports/\`.
- Each 2-hour report's `newTrades` lists both new virtual entries and newly closed positions in event-time order; `closedTrades` contains only closures. This keeps an entry visible in the report while the virtual position remains open.
- GitHub Actions must be enabled and the repository's workflow token must be allowed to write to the repository for cycle reports to persist. If there is no run in the workflow history, start it manually at https://github.com/Tontsa128/-ai-trading-pro/actions/workflows/paper-trading-cycle.yml using **Run workflow**. A missing run is not evidence of a Binance error; inspect the first actual run's logs before diagnosing HTTP 451 or permissions.
- GitHub scheduled jobs are best-effort and can run late. This is a decision every two hours, not a continuous execution engine. Stops/targets are checked against the latest closed hourly candle at each run, so intraperiod moves may be missed.
- Review report errors, realized/unrealized P&L, drawdown and costs before changing the strategy. Do not auto-tune parameters from a small sample.


## Fast paper trading (5-second / 15-second research)

The separate workflow fast-paper-trading.yml prefers Binance public Spot WebSocket trade and bookTicker events for BTC, ETH, SOL, BNB, XRP and DOGE. It uses port 443, stops retrying after three consecutive connection failures, and keeps requesting public REST ticker prices and bid/ask quotes every two seconds. If WebSocket trade events are blocked, the report records that REST-sampled prices were used and creates zero-volume sampled bars; these are **not equivalent to true trade-by-trade 5-second/15-second candles**, so results must be evaluated with that limitation in mind. The 5-second job runs every five minutes and the independent 15-second job every 15 minutes, subject to GitHub Actions scheduling delays and usage limits.

- Separate virtual portfolios: \`data/fast-paper-state-5s.json\` and \`data/fast-paper-state-15s.json\`.
- Latest session reports: \`data/fast-paper-latest-5s.json\` and \`data/fast-paper-latest-15s.json\`; detailed history is stored under \`data/fast-reports/\`.
- The initial strategy is a deliberately simple long-only EMA(9)/EMA(21) cross with momentum, spread, position-size, stop and target guards. It is a test harness, **not a trained or proven profitable strategy**.
- The simulator estimates 0.10% fee and 0.05% slippage per side. Those costs alone can overwhelm many 5-second/15-second moves. Reports must be evaluated over a meaningful sample, including net P/L, drawdown, win/loss distribution and no-trade sessions. The final `websocketConnectedAtEnd` flag snapshots connection state just before orderly shutdown, rather than reporting the expected closed socket after shutdown.
- New entries are blocked if any candle in the most recent 81-candle indicator/momentum lookback is a sampled REST quote, mixed-source bar, zero-volume bar, or invalid data. Historical exchange OHLCV bars may warm up the indicators; sampled quotes cannot create a trade signal.
- A GitHub Actions schedule is best-effort, not a permanently connected trading server. Vercel hosts the static dashboard; it does not keep this WebSocket worker running continuously. For truly uninterrupted 24/7 streaming, run the worker on an always-on host with monitoring and durable storage.
- The latest JSON state and report history for all three paper workflows are saved on the dedicated paper-data branch, not main. A retry-safe writer handles concurrent pushes; Vercel's Git configuration disables deployments from the paper-data branch, while its ignored-build script skips report-only and documentation/test/workflow commits. The public dashboard can read report JSON from that branch without producing a Vercel deployment for each refresh.
- Paper only: no private API keys, account balances, or real orders are used. Do not enable real-money execution based on these results.


## Binance historical candle archive (point-in-time data)

The **Binance historical candle archive** workflow backfills six Binance Spot USDT pairs (BTC, ETH, SOL, BNB, XRP, DOGE) for 1h, 4h and 1d intervals. The target window is 600 days by default (manual runs can select 600/730/900 days), leaving more than 365 days after the 220-day daily EMA warm-up; subsequent hourly runs append newly closed candles and repair missing older prefixes/internal gaps. This gives the daily EMA 200 confirmation its required 220+ closed-candle warm-up. CSV files and a manifest are stored on the dedicated `paper-data` branch under `historical-data/binance/<SYMBOL>/<interval>.csv`. The same workflow validates all 18 files for at least 220 rows, strict interval continuity, unique/sorted timestamps and point-in-time availability fields, then runs `scripts/historical-strategy-diagnostics.js` with the canonical engine and writes `historical-data/diagnostics/latest.json`. This branch is not a production deployment source.

Each row includes Binance open/close timestamps, OHLCV, quote volume, trade count and taker-buy volume. `available_at_utc` is the derived earliest availability boundary (Binance's inclusive close timestamp + 1 ms), **not** a measured exchange publication timestamp. `collected_at_utc` records when the collector actually retrieved the API page. Evaluation code must use `available_at_utc` to prevent look-ahead and must not treat the collection timestamp as the candle's market event time. The archive contains closed candles only; API failures fail the workflow rather than silently presenting incomplete coverage.


## Forward signal evaluation (signal value, not trade P/L)

The separate **Forward signal quality evaluation** workflow records one decision for every unique closed 1h candle and each of the six supported pairs, including BUY, SELL and WAIT. It records the observation timestamp and price, candle availability time, checklist pass percentage, trend direction, blocking reasons and WAIT near-misses. A WAIT near-miss is an analysis-only category: directional bias is present and no more than two checklist gates failed. It does not relax any decision gate.

As subsequent closed 1h candles become available, the evaluator measures directional price movement after 1h, 4h and 24h. Net directional returns deduct a 0.10% fee on entry and 0.10% on exit. It compares the same observation windows with fee-adjusted buy-and-hold and a deterministic 100-seed random-direction baseline. SELL outcomes are theoretical direction-quality measurements only; they are not short trades or executable spot P/L. Checklist pass percentage is diagnostic completeness, not a calibrated probability of success.

Signals, matured outcomes and summaries are stored separately from paper trades under `paper-data/forward-test/`. The existing paper portfolios and 5s/15s research workflow remain separate and unchanged. No production thresholds are loosened. Keep this forward-evaluation stream untouched: do not tune parameters against these observations and then report the same sample as validation. Use the extended archive for exploratory development; if parameters are changed, freeze them before starting a new forward-evaluation version. Compare results by symbol, horizon and signal group, and require a meaningful sample before drawing conclusions.


## Historical strategy diagnostics (research only)

The archive workflow evaluates the canonical 1h signal engine against the last closed 4h and 1d candles available at each 1h close. It reports BUY/SELL/WAIT and WAIT-near-miss counts, long/short core setup counts, every failed checklist gate, the unchanged long-only Spot backtest, and fee-adjusted buy-and-hold / deterministic 100-seed random-direction reference returns. It requires at least 220 candles on all three timeframes and fails if any archived interval contains a gap. The report is saved to `paper-data/historical-data/diagnostics/latest.json`. The backtest's trade count is long-only executable Spot simulation; SELL signal counts are directional research observations, not short trades. Historical spread is assumed at 0.10% because historical order-book snapshots are not archived. No thresholds, strategy rules or production behavior are changed by this diagnostics workflow.


## eToro read-only market research (isolated integration)

The eToro adapter in `scripts/etoro-market-feed.js` supports read-only instrument search, bid/ask rates, candle validation, instrument/user social feeds, public profiles, investor search, paginated investor rankings, and public Pro Investor copier-count/AUM-tier statistics. The rankings and portfolio copier-statistics methods use the documented `/api/v2/portfolios` endpoints. Every method is GET-only. It also includes a separate local-only paper ledger with restart-safe persistence; it does not submit orders or call trading execution endpoints.

Configure `ETORO_API_KEY` and `ETORO_USER_KEY` only in server-side secret storage. Use an eToro API key with **Read** permission and only the read scopes needed for the enabled features: `market-data:read`, `feed:read`, `user-info:read`, and/or `pi-data:read`. Never grant Write permission for this integration. Social and ranking endpoints share rate limits; respect 429 / `Retry-After` and cache slower-changing profile data. Do not redistribute or republish eToro licensed content outside the permitted use.

Run adapter regression tests with `npm test`. Tests use injected responses and do not represent a live eToro account connection or validate your account's granted scopes. See the [official eToro API authentication and scopes](https://api-portal.etoro.com/getting-started/authentication), [Social & Discovery guide](https://builders.etoro.com/learn/social-trading-and-copy-trading), and [API reference](https://api-portal.etoro.com/).

### Managed eToro WebSocket stream

`scripts/etoro-websocket-stream.js` provides an injectable WebSocket transport for public instrument topics. It parses the documented batched `messages` envelope and nested JSON-string rate content, normalizes bid/ask/last execution timestamps, rejects stale/future/invalid or unsubscribed-instrument messages, blocks duplicate/older updates, and reconnects with bounded exponential backoff. It never subscribes to the private topic and has no order methods. A live eToro read-only session is still required to verify account permissions and actual provider delivery.
