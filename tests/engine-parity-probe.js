"use strict";
const fs = require("node:fs");
// The browser engine binds its root argument to window; expose the Node global for this test probe.
global.window = globalThis;
require("../trading-engine.js");
const engine = globalThis.TradingEngine;
if (!engine || typeof engine.enrich !== "function") throw new Error("TradingEngine.enrich is unavailable");
const input = JSON.parse(fs.readFileSync(0, "utf8"));
const keys = ["ema9","ema21","ema50","ema200","rsi","atr","pdi","mdi","adx","macd","macdSignal","macdHist","volumeRatio","vwap"];
const result = engine.enrich(input).map(bar => {
  const row = {};
  for (const key of keys) row[key] = Number.isFinite(bar[key]) ? bar[key] : null;
  return row;
});
process.stdout.write(JSON.stringify(result));
