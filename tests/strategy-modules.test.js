"use strict";
const assert = require("node:assert/strict");
global.window = global;
require("../trading-engine.js");
const { createStrategyModules } = require("../scripts/strategy-modules.js");
const M = createStrategyModules(global.TradingEngine);

const bars = [];
for (let i = 0; i < 240; i++) {
  const close = 100 + i * 0.02;
  bars.push({ time: i * 60000, closeTime: i * 60000 + 59999, open: close - 0.05, high: close + 0.2, low: close - 0.2, close, volume: 100 });
}
const live = M.DataFetcher.validate({ source: "binance-spot-rest", bars }, bars[bars.length - 1].closeTime + 1000);
assert.equal(live.ok, true);
assert.equal(M.DataFetcher.validate({ source: "example-data", bars }, bars.at(-1).closeTime + 1000).status, "DATA FAIL");
assert.equal(M.DataFetcher.validate({ source: "binance-spot-rest", bars }, bars.at(-1).closeTime + 400000).status, "DATA STALE");
assert.equal(M.DataFetcher.validate({ source: "binance-spot-rest", bars: bars.slice(0, 100) }).status, "DATA FAIL");

const enriched = global.TradingEngine.enrich(bars);
const levels = M.SupportResistanceAnalyzer.analyze(enriched);
assert.ok(Number.isFinite(levels.support) && Number.isFinite(levels.resistance));
assert.equal(typeof M.PatternRecognizer.analyze(enriched).items.length, "number");
assert.equal(typeof M.TargetAndRiskCalculator.calculate("WAIT", 100, 2, {}, {}, 0).tradable, "boolean");

const wait = M.OrderExecutor.preparePaperIntent({ direction: "WAIT" }, {});
assert.equal(wait.accepted, false);
assert.equal(wait.mode, "PAPER_ONLY");
const noHoldings = M.OrderExecutor.preparePaperIntent({ direction: "SELL", symbol: "BTCUSDT" }, { holdings: {} });
assert.equal(noHoldings.accepted, false);
const invalidBuy = M.OrderExecutor.preparePaperIntent({ direction: "BUY", symbol: "BTCUSDT", riskPlan: { tradable: false, qty: 0 } }, {});
assert.equal(invalidBuy.accepted, false);
console.log("OK: strategy module boundaries, stale/invalid data guards, and paper-only execution intent.");
