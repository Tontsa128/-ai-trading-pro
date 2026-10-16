# Rahasampo Radar / AI Trading Pro

Trading dashboard and deterministic indicator engine for research and education. The original Streamlit application (`app.py`) is preserved. The browser dashboard is served from `public/` on Vercel.

## Browser dashboard

- Binance Spot market data: closed OHLCV candles and 24-hour change are loaded through the REST proxy; last-trade price and bid/ask for the dashboard come directly from the public Binance Spot WebSocket stream. Public market data does not require a user API key.
- Supported pairs: BTC, ETH, SOL, BNB, XRP and DOGE against USDT.
- Indicators: EMA 9/21/50/200, Wilder RSI, ATR, MACD, ADX and relative volume.
- Conservative long-only spot signal gates require trend/momentum agreement plus two genuinely higher timeframes, fresh trade and bid/ask updates, acceptable spread and non-extreme volatility. When the stream is stale/disconnected or a required check fails, the UI blocks a usable signal and displays `DATA STALE` or `ODOTA`.
- The strategy is long-only spot. A bearish trend is shown as `VÄLTÄ UUSIA OSTOJA`; it never creates a short position. Position sizing includes configurable risk, exposure cap, estimated fees and slippage.
- Historical test: up to 500 closed candles for the selected analysis interval plus up to 300 candles for each corresponding higher timeframe. The browser, 2-hour paper collector and backtest load the same `trading-engine.js` source and use the shared `evaluateSignal()`/`makeSignal()` decision path; the separate 5s/15s EMA experiment deliberately uses a different strategy. Historical spread is estimated because past order-book quotes are not fetched. OOS net P/L, win rate, drawdown and profit factor are displayed even for small samples, with an explicit warning when the sample is too small to be reliable.

Signal diagnostics include RSI requirement ranges, ADX/DI+/DI−, separate long-trend and short-momentum descriptions, timestamps, spread precision and stale-data state. The analysis timeframe determines which two higher timeframes confirm it; the default 1h strategy uses 4h and 1d. The volume threshold is 0.5x the prior 20-candle average; support/resistance use the prior 30 candles excluding the current candle. These are testable hypotheses, not proven improvements.

## Live market-data behavior

`public/live-market.js` connects the browser directly to Binance Spot combined `@trade` and `@bookTicker` streams for the six supported pairs. It publishes coalesced UI updates four times per second; that is a display cadence, not a 250 ms exchange delay. It tracks trade-price receive age separately from bid/ask receive age, flags prices older than 5 seconds or quotes older than 3 seconds, detects a WebSocket idle period, times out a stalled connection attempt, and rotates across public endpoints. When data is stale, the dashboard blocks the signal instead of silently treating a cached price as live. REST is used for candle history and the 24-hour percentage change, not as a polling substitute for the live price.

**No Internet-connected market feed can guarantee 100% zero-latency availability.** Network, exchange, browser scheduling and provider outages can cause delay or interruptions. The application reports observed local receive age and fails closed when it exceeds configured thresholds. Keep API keys out of browser code; the UI remains paper/research-only and does not submit real orders.

## Run tests

Requires Node.js 20 or newer:

```bash
npm test
```

GitHub Actions runs this suite on pushes to `main` and `fix/**` branches and on pull requests to `main`.

## Vercel setup

The Vercel project should use **Framework Preset: Other**, no build command, and **Output Directory: `public`**. These values are also represented in `vercel.json`. Connect this repository's `main` branch to Vercel to publish changes automatically. `vercel.json` uses `scripts/vercel-ignore-build.js` to skip telemetry-only paper-report commits and the dedicated `paper-data` branch, preventing scheduled reporting from consuming production build quota. Check build logs and the resulting URL after code changes; a commit being present in GitHub does not itself prove that a deployment succeeded.

## Important limitations

- This is a rule-based technical-analysis tool, not a machine-learning model and not a proven profitable strategy.
- A signal is not a probability of success and cannot be a "safe" guarantee. Crypto prices can gap or move quickly; stop orders may fill materially away from the estimated level.
- `OSTA` is only a research signal for a spot purchase. `MYY / KEVENNÄ` means consider reducing an existing spot holding or avoiding a new purchase; it does not initiate a short position.
- The historical test does not include multi-timeframe confirmation, funding costs, taxes, spread variability beyond the configured slippage estimate, order-book depth, outages, or realistic partial fills. Historical performance is not a prediction.
- The web dashboard does not read account balances, hold exchange secrets, or submit orders. Do not put exchange API keys in browser code or Git.
- Live signal results must be independently reviewed and paper-tested before any real-money use.


## Scheduled paper trading (two-hour cycles)

A GitHub Actions workflow (\`.github/workflows/paper-trading-cycle.yml\`) runs every two hours and can also be started manually from **Actions → Paper trading data collection (2-hour cycle) → Run workflow**. It fetches public Binance Spot candles for BTC, ETH, SOL, BNB, XRP and DOGE, calculates the 1h signal with 4h and 1d confirmations, then records a simulated portfolio, trades, data errors and a JSON/Markdown report under \`data/\`.

- All trades are virtual; no exchange orders or API keys are used.
- The virtual portfolio starts at 1,000 USDT and is persisted in \`data/paper-state.json\`.
- Latest report: \`data/latest-report.json\`; cycle history: \`data/reports/\`.
- GitHub Actions must be enabled and the repository's workflow token must be allowed to write to the repository for cycle reports to persist. If there is no run in the workflow history, start it manually at https://github.com/Tontsa128/-ai-trading-pro/actions/workflows/paper-trading-cycle.yml using **Run workflow**. A missing run is not evidence of a Binance error; inspect the first actual run's logs before diagnosing HTTP 451 or permissions.
- GitHub scheduled jobs are best-effort and can run late. This is a decision every two hours, not a continuous execution engine. Stops/targets are checked against the latest closed hourly candle at each run, so intraperiod moves may be missed.
- Review report errors, realized/unrealized P&L, drawdown and costs before changing the strategy. Do not auto-tune parameters from a small sample.


## Fast paper trading (5-second / 15-second research)

The separate workflow fast-paper-trading.yml prefers Binance public Spot WebSocket trade and bookTicker events for BTC, ETH, SOL, BNB, XRP and DOGE. It uses port 443, stops retrying after three consecutive connection failures, and keeps requesting public REST ticker prices and bid/ask quotes every two seconds. If WebSocket trade events are blocked, the report records that REST-sampled prices were used and creates zero-volume sampled bars; these are **not equivalent to true trade-by-trade 5-second/15-second candles**, so results must be evaluated with that limitation in mind. The 5-second job runs every five minutes and the independent 15-second job every 15 minutes, subject to GitHub Actions scheduling delays and usage limits.

- Separate virtual portfolios: \`data/fast-paper-state-5s.json\` and \`data/fast-paper-state-15s.json\`.
- Latest session reports: \`data/fast-paper-latest-5s.json\` and \`data/fast-paper-latest-15s.json\`; detailed history is stored under \`data/fast-reports/\`.
- The initial strategy is a deliberately simple long-only EMA(9)/EMA(21) cross with momentum, spread, position-size, stop and target guards. It is a test harness, **not a trained or proven profitable strategy**.
- The simulator estimates 0.10% fee and 0.05% slippage per side. Those costs alone can overwhelm many 5-second/15-second moves. Reports must be evaluated over a meaningful sample, including net P/L, drawdown, win/loss distribution and no-trade sessions.
- A GitHub Actions schedule is best-effort, not a permanently connected trading server. Vercel hosts the static dashboard; it does not keep this WebSocket worker running continuously. For truly uninterrupted 24/7 streaming, run the worker on an always-on host with monitoring and durable storage.
- The latest JSON state and report history for all three paper workflows are saved on the dedicated paper-data branch, not main. A retry-safe writer handles concurrent pushes; Vercel's Git configuration disables deployments from the paper-data branch, while its ignored-build script skips report-only and documentation/test/workflow commits. The public dashboard can read report JSON from that branch without producing a Vercel deployment for each refresh.
- Paper only: no private API keys, account balances, or real orders are used. Do not enable real-money execution based on these results.
