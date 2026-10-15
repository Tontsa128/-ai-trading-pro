# Rahasampo Radar / AI Trading Pro

Trading dashboard and deterministic indicator engine for research and education. The original Streamlit application (`app.py`) is preserved. The browser dashboard is served from `public/` on Vercel.

## Browser dashboard

- Public Binance Spot market data: closed OHLCV candles, 24-hour ticker, and bid/ask book ticker. Public market-data endpoints do not require a user API key.
- Supported pairs: BTC, ETH, SOL, BNB, XRP and DOGE against USDT.
- Indicators: EMA 9/21/50/200, Wilder RSI, ATR, MACD, ADX and relative volume.
- Conservative signal gates: requires a trend/momentum setup plus confirmation from two higher timeframes, recent price data, a sufficiently narrow spread and non-extreme volatility. If a required check fails or data cannot be validated, it returns `ODOTA`.
- Spot risk calculator estimates position sizing for a BUY using account value, a configurable risk fraction, a maximum exposure cap, estimated exchange fees and slippage. SELL signals do not invent a sell quantity because the app does not know the user's holdings.
- Historical test: single-timeframe, long-only spot simulation on up to 500 closed candles. It applies estimated costs; if stop and target are both touched in the same candle, the stop is assumed first.

## Run tests

Requires Node.js 20 or newer:

```bash
npm test
```

GitHub Actions runs this test on pushes and pull requests to `main`.

## Vercel setup

The Vercel project should use **Framework Preset: Other**, no build command, and **Output Directory: `public`**. These values are also represented in `vercel.json`. Connect this repository's `main` branch to Vercel to publish changes automatically. Check build logs and the resulting URL after each change; a commit being present in GitHub does not itself prove that a deployment succeeded.

## Important limitations

- This is a rule-based technical-analysis tool, not a machine-learning model and not a proven profitable strategy.
- A signal is not a probability of success and cannot be a "safe" guarantee. Crypto prices can gap or move quickly; stop orders may fill materially away from the estimated level.
- `OSTA` is only a research signal for a spot purchase. `MYY / KEVENNÄ` means consider reducing an existing spot holding or avoiding a new purchase; it does not initiate a short position.
- The historical test does not include multi-timeframe confirmation, funding costs, taxes, spread variability beyond the configured slippage estimate, order-book depth, outages, or realistic partial fills. Historical performance is not a prediction.
- The web dashboard does not read account balances, hold exchange secrets, or submit orders. Do not put exchange API keys in browser code or Git.
- Live signal results must be independently reviewed and paper-tested before any real-money use.
