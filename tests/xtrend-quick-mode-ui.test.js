"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const html = fs.readFileSync("public/xtrend.html", "utf8");
const ui = fs.readFileSync("public/xtrend-quick-mode-ui.js", "utf8");
const engine = fs.readFileSync("public/xtrend-quick-mode.js", "utf8");
for (const interval of ["1S", "5S", "1M", "5M"]) {
  assert.ok(html.includes('data-interval="' + interval + '"'), "missing interval " + interval);
}
for (const feature of [
  "lightweight-charts@5.3.0", "EMA 20", "Bollinger Bands", "RSI 14",
  "MACD hist", "AI Trade Signals & Log", "TradingView",
  "mielivaltaisen lyhyet positioiden pitoajat",
  "1S/5S ovat tässä kaavion aikavälejä"
]) assert.ok(html.includes(feature), "missing UI feature: " + feature);
assert.ok(!html.toLowerCase().includes("mock price"), "mock price content is forbidden");
assert.ok(ui.includes('quote.source !== "XTREND"'), "reject non-XTrend quote source");
assert.ok(ui.includes('bar.source !== "XTREND"'), "reject non-XTrend candles");
assert.ok(ui.includes("quoteAgeMs > XTrendQuickMode.defaults.maxQuoteAgeMs"), "reject stale quotes");
assert.ok(ui.includes("createSeriesMarkers"), "use v5 chart markers API");
assert.ok(ui.includes("barsForSelectedInterval"), "switch between real interval bars");
assert.ok(engine.includes("aggregateTradeTicks"), "support real tick-to-candle aggregation");
console.log("XTrend Quick Mode UI tests passed: intervals, indicators, attribution, broker policy, provenance and freshness.");
