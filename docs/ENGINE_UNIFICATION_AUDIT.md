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

Python retains an unused EMA100 compatibility column; the active Streamlit and JavaScript trend filters both use EMA200. No approved spread, volume, ADX, risk, fee, slippage or allocation thresholds are changed by indicator parity.

## Validation

`tests/test_radar_indicators.py` includes prefix-invariance, warm-up, edge-case and data-integrity tests. The base-branch CI workflow installs Python dependencies and runs these tests for dependent pull requests as well. Its cross-language test generates one OHLCV sequence, sends the same bars to the JavaScript engine through `tests/engine-parity-probe.js`, and compares every shared indicator row-by-row.

## Python signal-gate alignment: implemented, awaiting CI verification

The Streamlit application now applies the same core BUY/SELL/WAIT gates as the browser engine before it can display a directional signal:

- EMA 9/21/50/200 trend alignment, MACD histogram direction, RSI bands, ADX >= 18, DI direction and volume ratio >= 0.50.
- Both 4h and 1d trend confirmations must agree.
- Binance public Spot bookTicker bid/ask and the latest aggregate trade timestamp/price are fetched directly; missing, invalid, future-dated or >30-second-old trade data, or spread >0.15%, blocks a signal.
- ATR volatility >3%, price extension >1.6 ATR from EMA21, or less than 0.5 ATR room to prior 30-candle support/resistance blocks a signal.
- Missing history, indicators or quote data returns WAIT. No score or pattern override can bypass these gates.
- The legacy synthetic confidence percentage was removed. The displayed score is explicitly a diagnostic score, not a probability.
- BUY risk levels now use the same 1.5 ATR stop and 2.5 ATR target distances as the JavaScript engine. SELL has no short-style stop/target; it is a spot-only reduce-existing-holding / avoid-new-purchase indication.
- Added a BUY-only USDT risk calculator with the approved 0.25/0.50/0.75/1.00% risk and 10/25/50% exposure choices. Fees, slippage and half-spread are included on entry and exit; SELL never invents a quantity without the user's holdings.
- Position quantity is an estimate only; Binance lot-size and minimum-notional filters are not yet applied, and no order is submitted.

The Python weighted score and descriptive pattern explanations remain diagnostic and are not mathematically identical to the JavaScript checklist. Full parity still requires shared decision fixtures comparing Python and JavaScript on the same OHLCV, higher-timeframe and bid/ask inputs. WAIT remains the safe outcome whenever any required gate is not satisfied. No exchange orders are introduced.
