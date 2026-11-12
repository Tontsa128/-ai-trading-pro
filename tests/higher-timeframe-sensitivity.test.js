"use strict";
const assert = require("node:assert/strict");
const { lastClosedIndex } = require("../scripts/higher-timeframe-sensitivity.js");
const bars = [
  { closeTime: 10 }, { closeTime: 20 }, { closeTime: 30 }
];
assert.equal(lastClosedIndex(bars, 9), -1, "no unfinished higher-timeframe candle is selected");
assert.equal(lastClosedIndex(bars, 20), 1, "a candle closing exactly at the decision time is available");
assert.equal(lastClosedIndex(bars, 19), 0, "a candle closing after the decision time is excluded");
console.log("Higher-timeframe sensitivity tests passed");
