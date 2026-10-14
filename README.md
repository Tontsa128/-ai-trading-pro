# Rahasampo Radar V27 PRO — Research Preview

Rahasampo Radar is a cryptocurrency market-analysis prototype. This branch hardens data handling and introduces independent research utilities for objective triple-barrier labeling and random-entry benchmarking.

## Safety status

- The app does not place live orders.
- If live data cannot be fetched and validated, signal generation is disabled. Cached data is not treated as live data.
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

The current strategy is not yet automatically exported to this research runner. It accepts a historical OHLCV CSV plus a separate candidate-signal CSV so the replay engine and cost model can be tested without using live orders.

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
  --simulations 200 \
  --trades-out backtest_trades.csv \
  --report-out backtest_report.json
```

The command writes the trade-level journal and a JSON report with fees/slippage assumptions and a random-entry comparison when there are enough eligible non-overlapping bars. The random benchmark matches the accepted strategy trades' long/short ratio and samples an exact number of non-overlapping random entries. This is a research tool; it does not automatically generate the existing app's strategy signals and does not place orders.

## Before any live-trading use

The project still needs a full historical backtest engine, walk-forward and untouched out-of-sample validation, ablation testing, automated signal journaling, market-regime filters, risk controls, shadow mode, operational monitoring, and extensive paper trading. Do not enable real-money execution based on this research preview.
