# Rahasampo Radar V27 PRO — Research Preview

Rahasampo Radar is a cryptocurrency market-analysis prototype. This branch hardens data handling and introduces independent research utilities for objective triple-barrier labeling and random-entry benchmarking.

## Safety status

- The app does not place live orders.
- If live data cannot be fetched and validated, signal generation is disabled. Cached data is not treated as live data.
- Signals are calculated from fully closed candles. The chart may display the currently forming candle for visual context.
- The old manually entered win/loss learning controls have been removed.
- The score is a heuristic signal score, not a calibrated probability of profit.
- The triple-barrier and random-baseline helpers are research tools. They do not establish a profitable strategy and are not yet connected to a production model-training loop.

## Research utilities

- `rahasampo/data_quality.py`: OHLCV validation and closed-candle filtering.
- `rahasampo/triple_barrier.py`: outcome labels for take-profit, stop-loss, and time expiry; conservative stop-first handling when both barriers are hit in a single OHLC candle; unresolved labels if the full horizon is unavailable; simple configurable fee and slippage assumptions.
- `label_signal_candidates`: batch-labels historical candidates using the next candle open and ATR known when the signal occurred.
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

## Before any live-trading use

The project still needs a full historical backtest engine, walk-forward and untouched out-of-sample validation, ablation testing, automated signal journaling, market-regime filters, risk controls, shadow mode, operational monitoring, and extensive paper trading. Do not enable real-money execution based on this research preview.
