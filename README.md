# Rahasampo Radar V27 PRO — Research Preview

Rahasampo Radar is a cryptocurrency market-analysis prototype. This branch hardens data handling and introduces independent research utilities for objective triple-barrier labeling and random-entry benchmarking.

## Safety status

- The app does not place live orders.
- If live data cannot be fetched and validated, signal generation is disabled. Cached data is not treated as live data.
- If persistent decision-journal writing fails, actionable signals are changed to `EI TREIDIÄ`.
- Decisive BUY/SELL candidates are gated by estimated per-side fee and adverse slippage; candidates that cannot cover modeled round-trip costs are blocked.
- A fresh Binance/Bybit spot price cross-check must pass before the app displays a valid live signal.
- Signals are calculated from fully closed candles. The chart may display the currently forming candle for visual context.
- The old manually entered win/loss learning controls have been removed.
- The score is a heuristic signal score, not a calibrated probability of profit.
- The triple-barrier and random-baseline helpers are research tools. They do not establish a profitable strategy and are not yet connected to a production model-training loop.

## Research utilities

- `rahasampo/data_quality.py`: OHLCV validation and closed-candle filtering.
- `rahasampo/triple_barrier.py`: outcome labels for take-profit, stop-loss, and time expiry; conservative stop-first handling when both barriers are hit in a single OHLC candle; unresolved labels if the full horizon is unavailable; simple configurable fee and slippage assumptions.
- `label_signal_candidates`: batch-labels historical candidates using the next candle open and ATR known when the signal occurred.
- `rahasampo/backtest.py`: replays candidate streams with a single open position, logs overlapping candidates as rejected, and reports net expectancy, win rate, profit factor, compounded return, drawdown, event counts, and a seeded bootstrap interval for mean trade return.
- `rahasampo/decision.py`: pure score classification with hard no-trade gates. Fast candle alerts cannot force a buy/sell label.
- `rahasampo/cross_exchange.py`: fail-closed Binance/Bybit spot ticker comparison; stale reference prices, invalid prices, unsupported pairs, API failures, or excessive divergence block the live signal path.
- `rahasampo/market_data.py`: isolated Binance OHLCV adapter with strict payload parsing and a shared endpoint failover timeout; API behavior is tested independently of Streamlit.
- `rahasampo/market_data.py` also provides the six-symbol 24-hour public spot watchlist (BTC, ETH, SOL, BNB, XRP, DOGE). It is display-only and never feeds the selected strategy signal.
- `rahasampo/risk.py`: fee/slippage-aware paper position sizing with a maximum 2% risk budget, no leverage, a default 1.2 minimum net reward/risk ratio, and hard blocking when modeled target reward cannot cover round-trip costs. The Streamlit signal path uses it before guardrails and journal persistence; results are estimates, not execution orders.
- `rahasampo/signal_journal.py`: persistent, idempotent SQLite decisions per symbol/timeframe/closed candle, including no-trade reasons.
- `rahasampo/guardrails.py`: persisted cooldown and UTC-day signal cap; blocks decisive signal candidates if the journal is unavailable or the rate limit is exceeded.
- The candidate replay uses a circular moving-block bootstrap interval to retain some local dependence in sequential trade outcomes.
- `run_random_entry_baseline`: reproducible random entry timing and direction with ATR-based barriers and non-overlapping trades.
- `compare_strategy_to_random`: comparison of observed average net trade return with the simulated random-run distribution.

Random-entry tests must use the same instrument, period, entry timing, stop/target rules, fees, slippage, exposure limits, and holding horizon as the strategy being tested. A single random benchmark does not prove or disprove an edge; use multiple baselines and out-of-sample validation.

## Run locally

Python 3.12 is recommended.

```bash
pip install -r requirements.txt
python -m unittest discover -s tests -v
streamlit run app.py
```

## Offline CSV backtest

There are now two offline paths. `rahasampo.backtest_cli` remains a generic engine test that accepts a separately prepared candidate-signal CSV. For a full strategy replay, use `rahasampo.strategy_backtest_cli`: it calls the same pure scoring engine used by the Streamlit app, derives only completed higher-timeframe candles from the supplied OHLCV file, applies the fee/risk gate and the three-bar cooldown / eight-signals-per-UTC-day limit, and then simulates entries at the next candle open. No live API calls are used by the replay.

OHLCV CSV columns: `timestamp,open,high,low,close,volume`. Timestamps must be candle-open times in UTC and rows must be chronological. Signal CSV columns: `timestamp,side`, where timestamp exactly matches a candle in the OHLCV file and side is `long` or `short`.

```bash
python -m rahasampo.backtest_cli \
  --ohlcv data/btcusdt_1m.csv \
  --signals data/btcusdt_signals.csv \
  --symbol BTCUSDT \
  --timeframe 1m \
  --max-holding-bars 20 \
  --stop-atr 1.25 \
  --target-atr 2.2 \
  --fee-rate 0.001 \
  --slippage-bps 5 \
  --simulations 200 \
  --trades-out backtest_trades.csv \
  --report-out backtest_report.json
```

The command writes the trade-level journal and a JSON report with fees/slippage assumptions and a random-entry comparison when there are enough eligible non-overlapping bars. Defaults are a 0.10% fee per side and 5 basis points of adverse slippage per fill: this is a conservative starting point for basic spot taker orders, not a measured fill model. Check the exact fee tier for the account/venue and override `--fee-rate` as required. The random benchmark matches the accepted strategy trades' long/short ratio and samples an exact number of non-overlapping random entries. This is a research tool; it does not automatically generate the existing app's strategy signals and does not place orders.

The strategy replay supports `1m`, `3m`, `5m` and `15m` source candles. It requires a long history: because the existing strategy requires at least 110 closed candles on three higher timeframes, early candles are skipped during warmup (for 1-minute history the 4-hour filter can require more than 18 days of complete data). The generated signal audit marks each decisive candidate as accepted or blocked by cost/risk, cooldown, or daily limit.

```bash
python -m rahasampo.strategy_backtest_cli \
  --ohlcv data/btcusdt_1m.csv \
  --symbol BTCUSDT \
  --timeframe 1m \
  --window-bars 420 \
  --paper-equity 1000 \
  --risk-fraction 0.005 \
  --fee-rate 0.001 \
  --slippage-bps 5 \
  --minimum-net-rr 1.2 \
  --max-holding-bars 20 \
  --signals-out strategy_signals.csv \
  --trades-out strategy_trades.csv \
  --report-out strategy_report.json
```

For a quick no-CSV historical run, the CLI can fetch recent public Binance candles (no API key is required for public market data):

```bash
python -m rahasampo.strategy_backtest_cli \
  --download-days 35 \
  --symbol BTCUSDT \
  --timeframe 1m \
  --max-download-bars 200000 \
  --signals-out results/btc_signals.csv \
  --trades-out results/btc_trades.csv \
  --report-out results/btc_report.json
```

Repeat separately with `--symbol ETHUSDT` and `--symbol SOLUSDT`; keep each instrument's report separate. A longer sample is generally preferable, but the configured download cap and endpoint timeout are intentional safeguards. The CLI excludes the current incomplete candle and records the actual UTC start/end of the downloaded data.

`--timeframe` is the strategy/signal interval. For a downloaded run, `--source-timeframe` defaults to `1m`, so the historical engine can reconstruct all four live higher-timeframe filters even when you test 3m, 5m or 15m signals. For a local CSV, the source interval defaults to the selected signal interval; pass `--source-timeframe 1m` when the file contains 1-minute candles but the signal interval is slower. Source data must be at least as fine as the signal interval, and the signal interval must be an integer multiple of the source interval.

Review `strategy_report.json` before interpreting performance. Fewer than 10 resolved trades deliberately yields no random-benchmark claim. The replay is causally timestamped, but it is not yet an exact execution simulator: EMA/RSI warm-up history can differ slightly from the app's rolling fetch window, higher timeframes are reconstructed from the input series, and spread, order-book depth, queue priority, latency, partial fills, minimum lot sizes and stop gaps are not fully modeled. Validate the replay against captured live signals before using its results.

## Live market watchlist

The app's market overview displays public Binance spot last prices, rolling 24-hour price changes, and quote volume for BTC, ETH, SOL, BNB, XRP and DOGE. This is an informational watchlist only. The figures are not order-book bid/ask data, do not prove liquidity at the intended size, and are not used as signal inputs. The selected instrument's own candle validation and Binance/Bybit price sanity check remain separate.

## Persistent signal journal and conservative guardrails

The Streamlit app writes one journal row per symbol, timeframe, and fully closed candle into `signal_journal.sqlite` (override the path with `RAHASAMPO_SIGNAL_JOURNAL`). The journal includes the decision score, label, key prices, trend/structure context, source, and explanatory notes including rejection reasons. Repeated UI refreshes do not create duplicate records for the same candle.

By default, decisive BUY/SELL candidates are subject to a three-bar cooldown and an eight-candidate-per-UTC-day cap per symbol/timeframe. These are conservative engineering defaults, not empirically optimized trading parameters. If the guardrail journal cannot be read, a decisive candidate is blocked. Watch/wait/no-trade decisions are journaled but do not consume the directional-signal cap.

The SQLite file is local and is ignored by Git. Ephemeral deployment platforms may delete local files when instances restart; use a managed persistent database before relying on the journal across restarts or multiple app instances.

## Before any live-trading use

The project still needs a full historical backtest engine, walk-forward and untouched out-of-sample validation, ablation testing, automated signal journaling, market-regime filters, risk controls, shadow mode, operational monitoring, and extensive paper trading. Do not enable real-money execution based on this research preview.
