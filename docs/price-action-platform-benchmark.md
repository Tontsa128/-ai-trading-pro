# Rahasampo Radar – Price Action, market structure and platform benchmark

**Prepared:** 2026-11-13  
**Branch:** `research/price-action-platform-benchmark`  
**Scope:** research and implementation plan only. This document does not change production signal thresholds, submit orders, or claim profitability.

## 1. What the seven reference images contribute

The supplied carousel contains seven educational posters. Their useful concepts are grouped below; poster star ratings, success-rate claims and labels are not treated as verified market evidence.

1. **Candlestick patterns:** Doji, Hammer, Shooting Star, Bullish/Bearish Engulfing, and multi-candle reversal examples. A pattern is contextual evidence, not a standalone BUY/SELL instruction. Validate body and wick geometry, preceding trend, support/resistance proximity, volume and the next closed candle.
2. **Market structure / SMC:** swing highs and lows, HH/HL/LH/LL, Break of Structure (BOS), Change of Character (CHoCH), liquidity sweeps, order blocks and Fair Value Gaps (FVG). These need deterministic swing definitions and point-in-time timestamps. Avoid subjective chart labels and look-ahead.
3. **Classical chart patterns:** double/triple tops and bottoms, head-and-shoulders, inverse head-and-shoulders, ascending/descending/symmetrical triangles, flags, pennants, channels and wedges. Require pivot confirmation, neckline/boundary breaks and invalidation levels; do not mark a pattern complete before confirmation.
4. **Price Action:** Pin Bar, Inside Bar, Engulfing, breakout/retest, support/resistance and trend continuation. The close of the candle is the decision boundary; an unfinished candle may be displayed as live context but must not produce a confirmed historical signal.
5. **Trading styles:** scalping, intraday and swing trading, plus trend-following, breakout, reversal, liquidity and range setups. Each strategy needs its own timeframe, holding horizon, costs and evaluation cohort. Do not combine unlike horizons in one performance statistic.
6. **Risk management:** position sizing, stop/invalidation, targets, risk/reward, exposure limits and costs. A stop level is not a guaranteed fill; model gaps, spread, fees, slippage and ambiguous intrabar stop/target touches conservatively.
7. **Top-down timeframe analysis:** higher-timeframe context (for example 4h/1d), setup timeframe (1h/15m) and entry timing (15m/5m). Align every higher-timeframe candle to the exact decision timestamp and use only candles already closed and available then.

### Reference-image quality controls

- Some poster labels are informal, misspelled or non-standard (for example “Dock Wave”, “3 BAP”, “TICKSBAN”, “London Time” used as a pattern ingredient). Do not encode these labels as recognised technical patterns without an independent definition.
- “Five stars”, “high probability” and the displayed “60% success rate” are unsupported unless accompanied by reproducible sample size, market, interval, period, costs, execution assumptions and out-of-sample results.
- Pattern recognition should return a neutral/unknown state when its prerequisites are not met. Missing data must never be interpreted as a bullish or bearish pattern.

## 2. Repository findings at the time of review

The main branch already has a substantial research and safety foundation:

- The canonical browser dashboard is served from `public/`; `trading-engine.js` is also present at the repository root for shared research and tests. Keep these copies synchronized or establish one generated source before extending the engine.
- The main engine calculates EMA 9/21/50/200, Wilder RSI, ATR, MACD, ADX/DI and relative volume; it validates OHLCV and closed candles, applies conservative signal gates, estimates friction and performs a long-only spot backtest.
- The live dashboard has a separate fast-reaction score. This is not equivalent to the canonical selected-timeframe BUY/SELL/WAIT engine and must be labelled as intrabar context, not as a second independent trade signal.
- The Python Streamlit application (`app.py`) already contains preliminary candle-pattern scoring and simple structure/pattern helpers. These rules are not yet a fully specified, shared browser-engine pattern library.
- The project has historical Binance archives, point-in-time diagnostics, forward signal outcome evaluation and a research-only higher-timeframe sensitivity study. The latter compares confirmation modes by signal counts; it is not a profitability comparison.
- `npm test` includes engine, feed, chart, guard, forward-evaluation, historical-diagnostics and higher-timeframe-sensitivity regression checks.

### Recent main-branch commits reviewed

- 2026-11-11: chart rendering / fallback and historical backtest performance fixes.
- 2026-11-11: dashboard diagnostic copy, EMA explanations and cost-aware backtest.
- 2026-11-12: Binance historical archive and forward signal evaluation.
- 2026-11-12: full-year post-warm-up strategy diagnostics.
- 2026-11-12: research-only higher-timeframe confirmation sensitivity.

The repository history therefore indicates that data integrity, closed-candle timing, point-in-time evaluation and avoiding false performance claims are already explicit design priorities. Preserve these properties.

## 3. Platform benchmark: XTB xStation and eToro / eToro Edge

This is a product-design benchmark, not a proposal to copy proprietary interfaces or assume access to private brokerage data.

### XTB xStation

Official XTB help material describes a web and mobile platform with customizable charts, technical indicators, market analysis, news, economic calendar, screeners and heatmaps. XTB also documents reusable indicator templates synchronized between web and mobile.

Important integration limitation: XTB's help centre states that API access was discontinued on 14 March 2025, and that it does not provide Expert Advisors or copy trading. Do not plan a live XTB connector or broker execution integration on the assumption that a public trading API exists.

**Useful product ideas for Rahasampo Radar**
- Reusable analysis templates (for example “BTC intraday”, “ETH swing” and “Market overview”).
- A configurable chart workspace and consistent indicator settings.
- Screener / market overview with transparent filters.
- News and economic-calendar context kept separate from technical signals.
- Clear account-independent risk calculator; do not imply that Rahasampo reads a broker portfolio.

### eToro and eToro Edge

Official eToro material describes Edge as a desktop-oriented active-trader workspace with linked watchlists, charts, news, order ticket and reusable layouts. Its published updates include chart replay, custom intervals, spread charts, chart-condition alerts evaluated at bar close, script-generated indicators, notes/journal, news markers on charts, and watchlist research. The October 2026 eToro app update also describes improved full-screen charts, indicators, comparisons and overlays for positions, orders, Stop Loss and Take Profit.

eToro announced a developer ecosystem / App Store and agent integrations in 2026. These are platform-specific capabilities; they do not establish that Rahasampo has access to eToro's internal APIs or may execute trades through them.

**Useful product ideas for Rahasampo Radar**
- Linked instrument selection: changing a pair updates chart, market context, watchlist and analysis panels together.
- Saved layouts: Overview, Multi-Timeframe, Price Action, Risk and Research.
- Bar-by-bar chart replay for learning and strategy review.
- Alerts only on confirmed closed-candle conditions, with the exact rule and timeframe shown.
- Trading journal and setup notes linked to the symbol and timestamp.
- A transparent “why this was detected” explanation with inputs, conditions, timestamp and invalidation.
- AI assistant may explain or draft an indicator rule, but generated logic must be reviewed, tested and versioned before use.

## 4. Recommended architecture and development order

### Phase A – establish one canonical analytical contract

1. Keep `evaluateSignal()` as the sole canonical BUY / SELL / WAIT decision engine.
2. Add pattern detectors as **descriptive features** first. They must not alter production gates or thresholds.
3. Define a stable result shape, e.g. `{ id, direction, state, confidence: null, timeframe, detectedAt, candleCloseTime, evidence, invalidation }`. Do not populate a numeric probability until calibrated on held-out data.
4. Keep intrabar live reaction separate from closed-candle pattern confirmation.
5. Avoid divergence between root and `public/` engine copies. Prefer one source plus a deterministic build/copy check.

### Phase B – implement the image-derived pattern library

Implement in small, separately tested groups:

- Candle geometry: Doji, Hammer, Hanging Man, Shooting Star, Inverted Hammer, Bullish/Bearish Engulfing, Inside Bar and Pin Bar.
- Swing structure: confirmed pivot highs/lows, HH/HL/LH/LL, BOS and CHoCH.
- Liquidity: equal highs/lows and sweep + close-back-inside detection.
- Zones: support/resistance, order-block candidate and FVG candidate with explicit creation and invalidation timestamps.
- Classical formations: double top/bottom, head-and-shoulders, triangles, flags and wedges only after pivot/breakout definitions are testable.

Each detector must have positive, negative, boundary, incomplete-candle, insufficient-history and no-look-ahead tests. A detector should report evidence, not claim that a pattern guarantees reversal.

### Phase C – multi-timeframe and visual explanation

- Display higher-timeframe bias, setup timeframe and entry timeframe separately.
- Show the timestamp of the last closed candle used for each timeframe.
- Mark support/resistance, confirmed pivots, pattern boundaries, breakout/retest, invalidation and risk levels on the chart.
- Provide a compact explanation: **what was detected → what confirms it → what invalidates it → what data is missing**.
- Make every overlay optional and preserve mobile chart performance.

### Phase D – research before production use

- Add pattern features to historical and forward-signal records without changing decisions.
- Compare baseline engine vs baseline + one feature family at a time.
- Use chronological train/validation/holdout splits; do not randomly mix adjacent candles across splits.
- Report sample count, coverage, precision/recall where labels are defined, net returns after costs, drawdown, profit factor, expectancy and confidence intervals.
- Segment by symbol, timeframe, volatility regime and trend/range regime.
- Use walk-forward validation and a final untouched holdout. Do not tune thresholds on the same data used to report performance.
- Require enough observations before displaying a metric; label low-sample results inconclusive.

### Phase E – product features inspired by XTB / eToro

Priority order:
1. Saved analysis layouts and indicator templates.
2. Watchlist / market overview with configurable columns and explicit data freshness.
3. Chart replay from archived candles.
4. Closed-candle alert rules with alert history and duplicate suppression.
5. Trading journal with notes, screenshots/links, setup tags and post-trade review.
6. AI explanation assistant with auditable inputs and no autonomous order execution.

## 5. Non-negotiable safeguards

- No automatic orders; retain the existing “BINANCE SPOT DATA · EI AUTOMAATTISIA TOIMEKSIANTOJA” boundary.
- Never add broker or exchange secrets to browser code, Git or public environment variables.
- Do not use XTB API integration without a newly verified official supported API.
- Do not present eToro platform capabilities as available Rahasampo integrations.
- Never score an unfinished candle as a confirmed historical pattern.
- Never use future pivots, future higher-timeframe closes or revised data at an earlier decision timestamp.
- Do not convert a checklist pass percentage or a pattern score into a win probability.
- Keep strategy experiments research-only until reproducible out-of-sample evidence supports a change.

## 6. Official product references

- XTB platforms: https://www.xtb.com/en/help-center/our-platforms/what-trading-platforms-are-available-at-xtb
- XTB indicators: https://www.xtb.com/en/help-center/our-platforms-6/indicators-available-on-the-xtb-web-platform
- XTB chart customization and layouts: https://www.xtb.com/en/help-center/our-platforms-5/web-platform-layout-and-customization
- XTB updated layouts / indicator templates: https://www.xtb.com/en/help-center/our-platforms/using-the-updated-xtb-web-platform-layouts-charts-and-trading-tools
- XTB automation/API status: https://www.xtb.com/en/help-center/our-platforms-6/does-xtb-offer-investment-automation-tools
- eToro Edge product updates: https://edge.etoro.com/blog
- eToro Edge workspace: https://edge.etoro.com/
- eToro App Store / developer ecosystem: https://www.etoro.com/news-and-analysis/press-releases/etoro-launches-etoro-app-store-its-ai-enabled-application-ecosystem-for-trading-and-investing/
- eToro new app announcement: https://www.etoro.com/en-us/news-and-analysis/latest-news/press-release/etoro-launches-new-app-ai-first-smart-and-social/

---

**Implementation status:** this branch adds the research/architecture specification only. No production trading rules or user-facing signals have been changed. The next code change should be a separately tested, research-only pattern detector module, then wire its descriptive output into the dashboard without changing BUY/SELL/WAIT decisions.
