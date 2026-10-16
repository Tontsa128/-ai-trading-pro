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
11. **Missing live market timestamps were rendered like age zero.** The common evaluator now returns an unavailable age (`null`) when the timestamp is missing, while the decision remains `WAIT`; a regression test covers it.
12. **Paper-cycle trade reporting omitted entry records from `newTrades`.** Cycle reports now include newly opened and newly closed virtual trades separately, so the dashboard's per-cycle report is not silently missing new entries.
11. **The legacy Streamlit app could silently switch to synthetic candles on data failure.** Removed the generated random-price fallback. It now returns `DATA FAIL` when there is no real candle data or `DATA STALE` when only cached history remains, and both states block actionable signals and manual learning feedback.
12. **The legacy Streamlit app had the same long-only / short-signal conflict.** Short-side labels and short stop/target suggestions were replaced with `VÄLTÄ UUSIA OSTOJA`; only explicit long spot levels receive stop/target suggestions.
13. **Streamlit timeframe confirmation used a static mixture of lower, same and higher frames.** It now selects the next two higher intervals relative to the active timeframe and reads the most recent fully closed candle. The Streamlit app is explicitly labelled as REST polling of closed OHLCV, not as the browser dashboard's WebSocket tick feed.

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
- The browser dashboard uses the WebSocket stream; the legacy Streamlit interface still polls REST for closed OHLCV on its configured refresh interval, so it is not a WebSocket tick feed.
- Neither interface submits real exchange orders or reads private account balances, and the project does not yet have a durable live execution ledger, idempotent order handling, exchange reconciliation, or live capital risk controls. These require a separate security and execution architecture review before implementation.
- The open PR is `#12` on `fix/trading-audit-data-freshness`; it has not been merged to `main`. The older research PR `#1` is independent of this work.

## Validation status

The latest full GitHub Actions run for commit `532b73d4dfa6be51b23e4f26f713c82e25852faa` passed: [Trading engine tests](https://github.com/Tontsa128/-ai-trading-pro/actions/runs/38879993148), [5s/15s paper tests](https://github.com/Tontsa128/-ai-trading-pro/actions/runs/38879993037), and [15s paper tests](https://github.com/Tontsa128/-ai-trading-pro/actions/runs/38879993008). The suite includes `python -m py_compile app.py`, Streamlit stale-data/long-only tests, source-parity assertions, market-proxy and WebSocket feed tests, browser live-stream simulation (freshness and failover), dashboard inline-script tests, paper trade report checks, paper-data persistence tests and shell syntax validation.

The latest Vercel Preview for the deployed static-dashboard code commit `acde4620ee327387a2d673e53657a4333b36f97c` was `READY`: [Open preview](https://ai-trading-qttdlqfkp-tontsa128.vercel.app/). The following commit `532b73d...` changed test code only and Vercel correctly skipped a redundant deployment. Vercel publishes `public/`; Streamlit's `app.py` is a separate source app and is not launched by that static deployment.

Still outstanding: direct browser acceptance of the protected Vercel preview and an end-to-end Binance stream check from the user's actual browser/network. The Vercel inspection route denied automated content access, so deployment `READY` must not be treated as proof that the stream connects from the end user's network. No claims are made about 100% uptime, zero latency, strategy profitability, or readiness for real-money execution.
