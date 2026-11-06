# Trading engine unification audit

## Current architecture

The JavaScript decision engine has two entry points:

- `trading-engine.js` is the root/server and collector entry point. It contains the pure decision engine and an additional browser live-WebSocket layer.
- `public/trading-engine.js` is the public dashboard entry point. It contains the same pure decision engine and a mobile chart fallback.

The pure engine implementation, from the file start through the `root.TradingEngine` export boundary, is currently byte-identical in both files. The existing integration test already compares indicator output, signal output, friction calculations, and backtest output. This change adds a source-level regression guard so the shared implementation cannot silently drift while allowing the two runtime-specific wrappers to remain different.

## Python Streamlit engine is not yet unified

`app.py` is a separate legacy scoring implementation, not a Python port of the JavaScript decision engine. The inspected differences include:

| Area | JavaScript engine | Python Streamlit engine |
|---|---|---|
| Trend indicators | EMA 9/21/50/200 | EMA 9/21/50/100 |
| Main signal | Explicit BUY/SELL/WAIT gates, ADX/DI, MACD, RSI, volume, spread, ATR and level clearance | Weighted score from multiple pattern and indicator rules |
| Higher timeframes | Dashboard integration expects 1h context plus 4h and 1d confirmation; 4h and 1d are the required pair | `higher_tf_bias()` checks 5m, 15m, 1h and 4h, using EMA50/EMA100 and a 3-of-4 vote |
| Candle handling | `parseKlines()` excludes klines whose close time is not earlier than the supplied current time | `ai_engine()` scores `df.iloc[-1]` as live and separately uses `df.iloc[:-1]` as closed history; higher-timeframe bias selects `d.iloc[-2]` |

These differences mean the Python and JavaScript apps must not be described as one unified strategy yet. Blindly copying files or changing only timeframe labels would create false parity.

## Phase 2 guardrail and next decision

This branch adds a test that enforces byte-identical pure JavaScript engine code across the root and public entry points while preserving their separate runtime wrappers.

Before changing Python signal behavior, decide whether the Streamlit app should:
1. become a consumer of the JavaScript engine's canonical decision API, or
2. remain a separate strategy with its own explicit contract and separately validated performance.

Do not merge these strategies by simply changing EMA periods or timeframe names. First establish identical candle-closure rules, feature definitions, signal semantics, and backtest labels. No real exchange orders are introduced by this work.
