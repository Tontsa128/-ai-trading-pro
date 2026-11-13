"use strict";
const assert = require("node:assert/strict");
const E = require("../public/price-action-engine.js");
assert.ok(E && typeof E.detectAt === "function", "pattern engine exports deterministic detector API");

function bar(open, high, low, close, i) {
  return {time: 1700000000000 + i * 300000, closeTime: 1700000299999 + i * 300000, open, high, low, close, volume: 100};
}
function trendBars(direction, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const close = direction === "down" ? 110 - i * 2 : 90 + i * 2;
    const open = direction === "down" ? close + 1 : close - 1;
    out.push(bar(open, Math.max(open, close) + 0.5, Math.min(open, close) - 0.5, close, i));
  }
  return out;
}

const down = trendBars("down", 5);
down.push(bar(101, 102, 94, 101.5, 5));
assert.ok(E.detectAt(down, 5).some(x => x.id === "HAMMER"), "hammer is detected after a prior downtrend");
assert.ok(E.detectAt(down, 5).some(x => x.id === "BULLISH_PIN_BAR"), "long lower wick can also be described as bullish pin bar");

const up = trendBars("up", 5);
up.push(bar(99, 106, 98.5, 99.5, 5));
assert.ok(E.detectAt(up, 5).some(x => x.id === "SHOOTING_STAR"), "shooting star is detected after a prior uptrend");
assert.ok(E.detectAt(up, 5).some(x => x.id === "BEARISH_PIN_BAR"), "long upper wick can also be described as bearish pin bar");

const bullish = trendBars("down", 5);
bullish.push(bar(100, 101, 99, 99.5, 5));
bullish.push(bar(99, 102, 98.5, 101.5, 6));
assert.ok(E.detectAt(bullish, 6).some(x => x.id === "BULLISH_ENGULFING"), "bullish engulfing covers the previous bearish body");

const bearish = trendBars("up", 5);
bearish.push(bar(100, 101, 99, 100.5, 5));
bearish.push(bar(101, 102, 98, 98.5, 6));
assert.ok(E.detectAt(bearish, 6).some(x => x.id === "BEARISH_ENGULFING"), "bearish engulfing covers the previous bullish body");

const doji = [bar(100, 101, 99, 100, 0), bar(100, 102, 98, 100.05, 1)];
assert.ok(E.detectAt(doji, 1).some(x => x.id === "DOJI"), "small real body is a doji");
const inside = [bar(100, 105, 95, 102, 0), bar(101, 104, 96, 103, 1)];
assert.ok(E.detectAt(inside, 1).some(x => x.id === "INSIDE_BAR"), "inside bar is detected when both extremes are contained");

const pendingBars = [bar(100, 102, 98, 101, 0), bar(100, 101, 99, 100.5, 1)];
const pending = E.analyze(pendingBars, 1).find(x => x.id === "DOJI");
assert.equal(pending, undefined, "non-doji does not create a false pattern");
const currentPattern = E.analyze(doji, 1).find(x => x.id === "DOJI");
assert.equal(currentPattern.state, "PENDING", "latest closed candle is not confirmed using future/unclosed data");

const confirmedBars = [bar(100, 101, 99, 100, 0), bar(100, 102, 98, 100.02, 1), bar(100, 104, 99, 103.5, 2)];
const confirmed = E.analyze(confirmedBars, 1).find(x => x.id === "DOJI");
assert.equal(confirmed.state, "PENDING", "neutral doji never receives directional confirmation by itself");

const invalid = E.detectAt([{open:1,high:2,low:0.5,close:1.5},{open:1,high:2,low:0.5,close:1.5,closed:false}],1);
assert.deepEqual(invalid, [], "unfinished candles are excluded");
assert.deepEqual(E.detectAt([bar(1,2,0.5,1.5,0)],0), [], "no prior candle means insufficient context");
assert.deepEqual(E.detectAt([bar(100,101,99,100,0),{open:100,high:99,low:101,close:100}],1), [], "malformed OHLC is rejected");
assert.ok(E.analyzeRecent(doji, 3).length >= 1, "recent analysis scans only the requested bounded window");
console.log("Price action pattern engine tests passed.");
