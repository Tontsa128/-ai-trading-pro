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

1. **Stale top-of-book data could pass the fast strategy's spread gate.** The previous code validated bid/ask values but did not require a recent quote timestamp before opening a position. The worker now rejects missing, future-dated and older-than-five-second quotes for new entries; a pure helper has regression tests.
2. **EMA crossover comparisons used differently seeded rolling windows.** Current and previous EMA values were each seeded from shifted 80-bar slices, which can introduce window-boundary artifacts. The worker now calculates both current and prior values from the same full available candle history.
3. **Fast simulated entry timestamps could be earlier than signal observation.** The entry was recorded at the prior candle's nominal close, even though the next event had to arrive before the worker could close and evaluate it. Entry/position timestamps now use the actual decision-processing time, never earlier than one millisecond after the candle close.
4. **WebSocket end-of-session status was always reported as disconnected.** The worker explicitly set `socketOpen = false` before generating its report. It now snapshots the connection state before shutdown, including the interrupt path.
5. **The two-hour dashboard report could look current indefinitely.** Its data was loaded only at page load or button click and did not display report age. The page now refreshes the report periodically while visible and warns when the report is over three hours old.

## Important limitations and remaining work

- The project is a deterministic, rule-based technical-analysis and paper-simulation tool. It is not a trained AI trading model and has no proven profitability.
- The inspected persisted data has no completed simulated trades. Do not optimize thresholds to force more trades; first acquire a meaningful sample and evaluate net results after realistic fees, spread, slippage and adverse fills.
- The 5-second/15-second sessions are short scheduled GitHub Actions jobs, not a permanently running trading process. GitHub scheduling can be delayed, and saved reports cannot be treated as real-time quotes.
- REST ticker fallback can advance zero-volume sampled-price bars. Such bars are not equivalent to genuine trade-by-trade candles and should be reported separately in analysis.
- The two-hour paper simulation checks stops/targets on newly observed closed hourly candles. It can miss intra-hour stop/target events.
- Historical tests approximate historical spread and cannot reproduce historical order-book depth, latency, partial fills, outages, changing fees/slippage or all market constraints. A holdout period alone is not enough; use out-of-sample and walk-forward evaluation.
- The browser dashboard never reads private exchange balances or submits real orders. Keep it that way until a separate, independently reviewed execution architecture and risk controls exist.
- The latest retrieved status for the main commit had a Vercel status failure linking to a build-rate-limit/plan page. This is a hosting/deployment blocker, separate from the code changes in this audit branch; verify a new preview deployment rather than assuming a commit deployed.
- The open draft pull request `#1` (`fix/v27-triple-barrier-data-quality`) is separate research work and is not part of `main` or this branch. Review its diff and run its own checks before deciding whether to merge it.

## Validation status

Regression tests were updated for quote freshness, EMA input consistency, simulated entry timestamps, WebSocket status reporting, periodic dashboard refresh and stale-report warnings. The branch must pass its GitHub Actions checks before the fixes are considered validated. No claim is made here that a fresh CI run or Vercel deployment has passed.
