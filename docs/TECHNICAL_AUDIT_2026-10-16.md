# Rahasampo Radar / AI Trading Pro — technical audit

**Audit date:** 2026-10-16  
**Scope:** current `main` application code, public dashboard, trading engine, paper-trading workers, GitHub Actions workflows and the persisted `paper-data` reports.  
**Purpose:** reliability and research-quality review. This is not a profitability certification or approval for real-money trading.

## Findings from persisted data

The latest persisted two-hour report read from `paper-data/data/latest-report.json` was started at `2026-10-16T07:08:38Z`. It contains six USDT spot pairs and reports `WAIT` for the reviewed pairs. `paper-state.json` has 12 recorded cycles, 71 WAIT signals, zero BUY and SELL signals, one recorded cycle error, no positions and no completed simulated trades. The paper balance remains 1,000 USDT.

The latest persisted short-horizon sessions were approximately 210 seconds long:
- 5-second report: `2026-10-16T04:55:15Z`–`04:58:45Z`; 61,912 WebSocket messages, 588 REST quote updates, zero reported errors and zero session trades.
- 15-second report: `2026-10-16T04:48:26Z`–`04:51:56Z`; 60,965 WebSocket messages, 576 REST quote updates, zero reported errors and zero session trades.

These are historical snapshots, not live measurements at the time this document is read. The number of closed bars includes the seeded historical warm-up plus bars aggregated during the session. The zero-trade result is not evidence that the strategy is profitable or unprofitable; it only shows that the recorded sessions did not open positions.

## Issues corrected in this branch

1. **Stale data could be mistaken for a current fast-trading quote.** The fast worker now rejects missing, future-dated and older-than-five-second quotes before opening a paper position; tests cover these cases.
2. **The browser did not use a true push stream for its live price.** The dashboard now loads `public/live-market.js`, which connects directly to the Binance Spot combined `@trade` and `@bookTicker` streams. REST is used for candle history and the 24-hour change, not as a polling substitute for the live last price.
3. **Price and bid/ask freshness were conflated.** Separate receive timestamps are tracked. A price older than 5 seconds, a quote older than 3 seconds, or a disconnected/idle stream blocks the signal and displays `DATA STALE`. The client times out a stalled connection attempt, detects prolonged socket silence, and rotates through three public endpoints.
4. **The browser and paper/backtest could load different engine implementations.** `trading-engine.js` and `public/trading-engine.js` are byte-identical and a CI regression test enforces that. The two-hour paper collector and historical backtest call the shared `evaluateSignal()/makeSignal()` path. The separate 5s/15s experiment intentionally remains a different EMA-crossover strategy.
5. **Long-only spot could be confused with short selling.** The strategy exposes only `BUY` or `WAIT`; a bearish state is displayed as `VÄLTÄ UUSIA OSTOJA`. Existing paper positions may be closed according to exit rules, but no short position is opened.
6. **Higher-timeframe alignment and labels needed to be causal and explicit.** Historical 4h/1d (or the selected equivalent higher frames) are aligned to each main candle by `closeTime`, not merely matching array positions. Selected timeframe labels travel with the signal.
7. **Backtest sample size was too small and historical metrics could be hidden.** The dashboard now fetches up to 2,500 closed main-timeframe candles in batches of no more than 1,000, plus timestamp-aligned higher-timeframe history with warm-up bars. OOS win rate, net P/L, drawdown and profit factor are shown even for small samples with a low-sample warning.
8. **A zero or negative-looking metric could mislead.** Tiny spreads are displayed at useful precision; future/missing timestamps are rejected or clamped; missing numeric values render as unavailable instead of zero. RSI shows the required range, ADX shows ADX/DI+/DI−, and long trend is separated from MACD momentum.
9. **The paper-report and history views could stay stale.** Paper summaries refresh automatically and show their age. The browser live price updates from WebSocket events (coalesced to a UI cadence of 250 ms) and does not depend on the history-refresh selector.
10. **Risk sizing under-counted slippage in its per-unit risk estimate.** The backtest quantity estimate now includes estimated fee and slippage friction, while historical spread remains a documented estimate.

## Important limitations and remaining work

- The project is a deterministic, rule-based technical-analysis and paper-simulation tool. It is not a trained AI trading model and has no proven profitability.
- The inspected persisted data has no completed simulated trades. Do not optimize thresholds to force more trades; first acquire a meaningful sample and evaluate net results after realistic fees, spread, slippage and adverse fills.
- The 5-second/15-second sessions are short scheduled GitHub Actions jobs, not a permanently running trading process. GitHub scheduling can be delayed, and saved reports cannot be treated as real-time quotes.
- REST ticker fallback can advance zero-volume sampled-price bars. Such bars are not equivalent to genuine trade-by-trade candles and should be reported separately in analysis.
- The two-hour paper simulation checks stops/targets on newly observed closed hourly candles. It can miss intra-hour stop/target events.
- Historical tests approximate historical spread and cannot reproduce historical order-book depth, latency, partial fills, outages, changing fees/slippage or all market constraints. A holdout period alone is not enough; use out-of-sample and walk-forward evaluation.
- The browser dashboard never reads private exchange balances or submits real orders. Keep it that way until a separate, independently reviewed execution architecture and risk controls exist.
- The current code preview was reported as READY by Vercel for commit `6f3c371060fa806d973df24339b1cffd8c6f0cae`. The following documentation-only commit was correctly skipped by the project's ignored-build rule. Direct browser/HTTP inspection of the preview was not possible through the available authenticated inspection routes, so a live browser acceptance check remains outstanding.
- Vercel hosting for the static dashboard does not keep a 24/7 trading worker alive. GitHub Actions 5s/15s jobs are short scheduled sessions and can start late. Continuous collection requires an always-on managed worker, monitoring, durable storage and restart controls.
- No live market-data source can promise 100% zero latency or availability. This code reports observed client receive age and fails closed after its thresholds; it cannot remove provider, network or browser delays.
- The app still does not submit real exchange orders, read private balances, persist an exchange execution ledger, or run live capital at risk. These require a separate security, idempotency, reconciliation and risk-engine review before implementation.
- The open PR is `#12` on `fix/trading-audit-data-freshness`; it has not been merged to `main`. The older research PR `#1` is independent of this work.

## Validation status

The GitHub Actions suite passed on code commit `6f3c371060fa806d973df24339b1cffd8c6f0cae`, including the shared engine tests, market-proxy tests, market-feed tests, browser live-stream simulation (freshness and reconnect failover), dashboard inline-script/feature tests, and both scheduled fast-paper job test gates. The Vercel deployment for that same code commit was reported `READY`. The branch's newest commit after that was documentation-only; Vercel correctly skipped a redundant build for it.

Still outstanding: a browser acceptance test of the protected preview and an end-to-end live Binance WebSocket check from the user's actual browser/network. No claims are made about 100% uptime, zero latency, strategy profitability, or readiness for real-money execution.
