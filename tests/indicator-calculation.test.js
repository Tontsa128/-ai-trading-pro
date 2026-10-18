"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync(require.resolve("../trading-engine.js"), "utf8");
const sandbox = { console };
vm.runInNewContext(source, sandbox, { filename: "trading-engine.js" });
const E = sandbox.TradingEngine;

function makeBars(closes) {
  return closes.map((close, i) => ({ time:i*60000, closeTime:i*60000+59999, open:close, high:close+1, low:close-1, close, volume:100+i }));
}

const bars = E.enrich(makeBars(Array.from({length:40}, (_,i)=>100+i)));
assert.ok(Number.isFinite(bars[13].rsi), "RSI must start after 14 observations");
assert.ok(Number.isFinite(bars[13].atr), "ATR must start after 14 observations");
assert.equal(bars[13].rsi, 100, "Wilder RSI seed must average the first 14 changes");
assert.equal(bars[14].rsi, 100, "Wilder RSI update must use the next change");
assert.equal(bars[13].atr, 2, "Wilder ATR seed must average the first 14 true ranges");
assert.equal(bars[14].atr, 2, "Wilder ATR update must preserve constant true range");
assert.equal(bars[12].rsi, null, "RSI must not appear before 14 observations");
assert.equal(bars[12].atr, null, "ATR must not appear before 14 observations");

console.log("Indicator calculation tests passed: Wilder RSI/ATR seed alignment is correct.");
