"use strict";

const assert = require("node:assert/strict");

// The browser engine must expose the same pure decision API as the collector.
global.window = global;
require("../trading-engine.js");
const canonical = global.TradingEngine;
assert.ok(canonical, "canonical trading engine must load in Node without a DOM");

require("../public/trading-engine.js");
const deployed = global.TradingEngine;
assert.ok(deployed, "deployed dashboard engine must load without starting browser-only code");
assert.equal(typeof deployed.fastReaction, "function",
  "deployed engine must include the tested fast reaction scorer");
assert.equal(typeof deployed.resolveLongExit, "function",
  "deployed engine must use the gap-aware exit resolver");
assert.equal(typeof deployed.estimatePerSideFriction, "function",
  "deployed engine must expose the per-side fee/slippage/spread cost model");
assert.equal(deployed.estimatePerSideFriction(0.10, 0.05, 0.10),
  canonical.estimatePerSideFriction(0.10, 0.05, 0.10),
  "deployed dashboard and collector must agree on spread-aware trading costs");

function makeBars(length) {
  const bars = [];
  let previous = 100;
  for (let i = 0; i < length; i++) {
    const close = 100 + i * 0.035 + Math.sin(i / 6) * 0.5 + Math.sin(i / 19) * 0.15;
    const open = previous;
    bars.push({
      time: 1700000000000 + i * 3600000,
      closeTime: 1700003599999 + i * 3600000,
      open,
      high: Math.max(open, close) + Math.max(close * 0.0015, 0.02),
      low: Math.min(open, close) - Math.max(close * 0.0015, 0.02),
      close,
      volume: 100 + 10 * (1 + Math.sin(i * 1.3))
    });
    previous = close;
  }
  return bars;
}

const raw = makeBars(520);
const canonicalSeries = canonical.enrich(raw);
const deployedSeries = deployed.enrich(raw);
assert.deepEqual(deployedSeries, canonicalSeries,
  "dashboard indicators must match the canonical collector indicators");

const canonicalMain = canonical.analyzeSeries(canonicalSeries);
const deployedMain = deployed.analyzeSeries(deployedSeries);
const market = {
  price: canonicalMain.bar.close,
  closeTime: Date.now(),
  bid: canonicalMain.bar.close * 0.9999,
  ask: canonicalMain.bar.close * 1.0001
};
const options = {
  historical: true,
  capital: 1000,
  riskPct: 0.5,
  maxExposurePct: 25,
  feePct: 0.1,
  slippagePct: 0.05
};
const canonicalSignal = canonical.evaluateSignal(canonicalMain, [
  canonical.analyzeSeries(canonicalSeries),
  canonical.analyzeSeries(canonicalSeries)
], market, options);
const deployedSignal = deployed.evaluateSignal(deployedMain, [
  deployed.analyzeSeries(deployedSeries),
  deployed.analyzeSeries(deployedSeries)
], market, options);
assert.ok(deployedSignal.main && deployedSignal.main.bar,
  "dashboard requires signal.main.bar to render metrics and levels");
assert.deepEqual(deployedSignal, canonicalSignal,
  "live dashboard and paper collector must use identical signal outputs");

const btOptions = {
  capital: 1000,
  riskPct: 0.5,
  maxExposurePct: 25,
  feePct: 0.1,
  slippagePct: 0.05,
  assumedSpreadPct: 0.05,
  higherSeries: [canonicalSeries, canonicalSeries],
  startIndex: 300
};
const canonicalBacktest = canonical.backtest(canonicalSeries, btOptions);
const deployedBacktest = deployed.backtest(deployedSeries, {
  ...btOptions,
  higherSeries: [deployedSeries, deployedSeries]
});
assert.deepEqual(deployedBacktest, canonicalBacktest,
  "dashboard backtest metrics and trades must match the canonical engine");
assert.equal(typeof deployedBacktest.winRate, "number",
  "dashboard backtest must return the win rate it displays");
assert.equal(typeof deployedBacktest.profitFactor, "number",
  "dashboard backtest must return profit factor");

console.log("Dashboard engine integration tests passed: deployed API, indicators, signals, and backtest match the canonical engine.");


// The live dashboard must not have its own independent EMA/MACD score thresholds.
const fs = require("node:fs");
const dashboardSource = fs.readFileSync(require.resolve("../public/live-dashboard.js"), "utf8");
assert.ok(dashboardSource.includes("TradingEngine.evaluateSignal(main, higher,"),
  "live dashboard must use canonical TradingEngine.evaluateSignal");
assert.ok(dashboardSource.includes('"1m": ["3m", "15m"]'),
  "1m signals must use actual 3m and 15m confirmation data");
assert.ok(dashboardSource.includes('"3m": ["15m", "1h"]'),
  "3m signals must use actual 15m and 1h confirmation data");
assert.ok(dashboardSource.includes('"5m": ["15m", "1h"]'),
  "5m signals must use actual 15m and 1h confirmation data");
assert.ok(dashboardSource.includes('"15m": ["1h", "4h"]'),
  "15m signals must use actual 1h and 4h confirmation data");
assert.ok(!dashboardSource.includes('score >= 65 ? "BUY" : score <= 35 ? "SELL"'),
  "legacy independent threshold scorer must not generate BUY/SELL");
