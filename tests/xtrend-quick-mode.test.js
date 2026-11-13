"use strict";
const assert = require("node:assert/strict");
const engine = require("../public/xtrend-quick-mode.js");
const now = 1800000000000;

function bars(tf, direction) {
  let p = direction === "down" ? 200 : 100;
  return Array.from({ length: 80 }, (_, i) => {
    if (i > 0 && direction !== "flat") p += (i % 2 === 0 ? -0.04 : 0.08) * (direction === "down" ? -1 : 1);
    const t = now - (80 - i) * tf;
    return { openTime: t, closeTime: t + tf - 1, open: p - 0.01, high: p + 0.03, low: p - 0.03, close: p, volume: 10, closed: true };
  });
}
function data(direction) {
  return { symbol: "BTCUSD", quote: { bid: 100, ask: 100.01, receivedAt: now - 100, source: "XTREND" },
    oneMinuteBars: bars(60000, direction), fiveMinuteBars: bars(300000, direction) };
}
const options = { nowMs: now, maxSpreadPct: 0.05 };
assert.equal(engine.evaluate(data("up"), options).signal, "BUY");
assert.equal(engine.evaluate(data("down"), options).signal, "SELL");
assert.equal(engine.evaluate(data("flat"), options).signal, "WAIT");
assert.equal(engine.evaluate(data("up"), { nowMs: now }).signal, "WAIT", "unknown spread limit must block");
assert.equal(engine.evaluate(data("up"), { ...options, nowMs: now + 10000 }).signal, "WAIT", "stale quote must block");
const wrongSource = data("up"); wrongSource.quote.source = "BINANCE";
assert.equal(engine.evaluate(wrongSource, options).signal, "WAIT", "Binance quote must not masquerade as XTrend");
const incomplete = data("up"); incomplete.oneMinuteBars[79].closed = false;
assert.equal(engine.evaluate(incomplete, options).signal, "WAIT");
const future = data("up"); future.fiveMinuteBars[79].closeTime = now + 1;
assert.equal(engine.evaluate(future, options).signal, "WAIT");
const invalid = data("up"); invalid.quote.ask = 0;
assert.equal(engine.evaluate(invalid, options).signal, "WAIT");
const gap = data("up"); gap.oneMinuteBars[30].openTime += 60000; gap.oneMinuteBars[30].closeTime += 60000;
assert.equal(engine.evaluate(gap, options).signal, "WAIT", "candle gaps must block");
const analysed = engine.analyze(bars(60000, "up"));
assert.equal(Number.isFinite(analysed.ema20), true);
assert.equal(Number.isFinite(analysed.bollinger.upper), true);
assert.equal(Number.isFinite(analysed.bollinger.middle), true);
assert.equal(Number.isFinite(analysed.bollinger.lower), true);

const ticks = [];
for (let bucket = 0; bucket < 3; bucket += 1) {
  ticks.push({ time: now - 4000 + bucket * 1000, price: 100 + bucket, quantity: 0.1, source: "XTREND" });
}
const oneSecond = engine.aggregateTradeTicks(ticks, 1, now);
assert.equal(oneSecond.ok, true);
assert.equal(oneSecond.bars.length, 3);
assert.equal(oneSecond.bars[0].volume, 0.1);
assert.equal(oneSecond.bars[2].close, 102);
const gapTicks = [ticks[0], ticks[2]];
const gapResult = engine.aggregateTradeTicks(gapTicks, 1, now);
assert.equal(gapResult.ok, false);
assert.equal(gapResult.gaps.length, 1);
assert.equal(gapResult.bars.length, 2, "missing buckets must not be filled");
assert.equal(engine.aggregateTradeTicks(ticks, 60, now).ok, false);
const fakeTicks = [{ time: now - 1000, price: 100, source: "BINANCE" }];
assert.equal(engine.aggregateTradeTicks(fakeTicks, 1, now).ok, false);

const result = engine.evaluate(data("up"), options);
assert.equal(result.actionable, false);
assert.equal(result.executionEnabled, false);
console.log("XTrend Quick Mode tests passed: bidirectional signals, EMA20/Bollinger, closed candles, freshness, source validation and real-tick 1S/5S aggregation.");
