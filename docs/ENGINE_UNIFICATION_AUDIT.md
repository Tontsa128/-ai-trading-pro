# Trading engine unification audit

## Current architecture

The JavaScript decision engine has two entry points:

- `trading-engine.js` is the root/server and collector entry point, with its runtime-specific live layer.
- `public/trading-engine.js` is the public dashboard entry point, with its runtime-specific chart fallback.

The pure indicator and decision-engine source is guarded by `tests/engine-core-single-source.test.js`; the shared portion must remain byte-identical while runtime wrappers may differ.

## Indicator formula contract

The Python `radar_indicators.py` implementation now follows the JavaScript `TradingEngine.enrich()` indicator contract:

| Indicator | Canonical definition |
|---|---|
| EMA | Recursive EMA seeded from the first finite close; periods 9, 21, 50 and 200 |
| RSI | 14-period Wilder gain/loss smoothing; first valid value at index 14; flat = 50, rise-only = 100, fall-only = 0 |
| ATR | 14-period Wilder true range; first valid value at index 14 |
| DI / ADX | Wilder-smoothed +DM/-DM and DX; ADX first valid at index 27 |
| MACD | EMA(12) - EMA(26), signal EMA(9), histogram = MACD - signal |
| Volume ratio | Current volume divided by the mean of the preceding 20 closed bars; current bar excluded from its own baseline |
| VWAP | Typical-price × volume cumulative VWAP, reset at each UTC day boundary |
| Candle closure | Only closed candles enter indicator and signal calculations |

Python retains EMA100 temporarily because the legacy `ai_engine()` still reads it; EMA200 is the shared JavaScript trend-filter indicator. No approved spread, volume, ADX, risk, fee, slippage or allocation thresholds are changed by indicator parity.

## Validation

`tests/test_radar_indicators.py` includes prefix-invariance, warm-up, edge-case and data-integrity tests. Its cross-language test generates one OHLCV sequence, sends the same bars to the JavaScript engine through `tests/engine-parity-probe.js`, and compares every shared indicator row-by-row.

## Remaining work: signal-engine parity

The Python Streamlit signal layer is still separate from the JavaScript `evaluateSignal()` decision contract. The remaining differences include:

- Python currently uses a weighted pattern/indicator score; JavaScript uses explicit BUY/SELL/WAIT gates.
- Python higher-timeframe context currently uses 5m/15m/1h/4h; JavaScript requires 4h and 1d confirmation with 1h context.
- Python's current live quote/spread handling is not yet the same as the JavaScript decision API.
- The Streamlit UI still has legacy confidence/score presentation that must not be mistaken for a calibrated probability.

Do not claim full engine unification until the Python signal evaluator has been ported and compared on identical OHLCV, higher-timeframe and bid/ask fixtures. Keep WAIT as the safe outcome when data or context is missing. No real exchange orders are introduced.
