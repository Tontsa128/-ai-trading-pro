"use strict";
const assert = require("node:assert/strict");
const E = require("../scripts/forward-signal-evaluation.js");

assert.ok(Math.abs(E.netReturnPct(1) - ((1.01 * 0.999 * 0.999 - 1) * 100)) < 1e-10,
  "net return deducts the 0.10% fee on both entry and exit");
assert.ok(Math.abs(E.directionalGrossPct("SELL", 100, 90) - (100 / 90 - 1) * 100) < 1e-10,
  "SELL measures inverse directional movement and does not submit a short");
assert.equal(E.directionalGrossPct("WAIT", 100, 101), null);
assert.equal(E.netReturnPct(NaN), null);

const nearMiss = {
  direction: "WAIT",
  trendBias: "bear",
  checks: { bullN: 1, bearN: 6 },
  checklist: [{ok:true},{ok:false},{ok:true},{ok:true}],
  riskPlan: {tradable:true}
};
assert.equal(E.deriveWatchDirection(nearMiss), "SELL");
assert.equal(E.isNearMiss(nearMiss), true, "WAIT with directional bias and at most two failed gates is retained as a near miss");
assert.equal(E.isNearMiss({...nearMiss, checklist:[{ok:false},{ok:false},{ok:false}]}), false);
assert.equal(E.isNearMiss({...nearMiss, riskPlan:{tradable:false}}), false);
assert.equal(E.deriveWatchDirection({trendBias:"neutral",checks:{bullN:3,bearN:3}}), null);

const signal = {
  signalId:"abc", symbol:"BTCUSDT", signalTimeUtc:"2026-11-12T10:00:00.000Z",
  candleCloseTimeUtc:"2026-11-12T09:59:59.999Z", price:100,
  direction:"WAIT", signalDirection:"WAIT", watchDirection:"BUY", nearMiss:true
};
const outcome = E.buildOutcome(signal, 1, 102, "2026-11-12T11:00:00.000Z");
assert.equal(outcome.sampleGroup, "WAIT_NEAR_MISS");
assert.equal(outcome.evaluatedDirection, "BUY");
assert.ok(outcome.netDirectionalReturnPct > 0);
assert.equal(outcome.feesPerSidePct, 0.10);
assert.equal(outcome.metricType, "signal_value_not_executable_trade_pnl");

const rows = [
  {...outcome, horizonHours:1, sampleGroup:"BUY", evaluatedDirection:"BUY"},
  {...outcome, horizonHours:1, sampleGroup:"BUY", netDirectionalReturnPct:-0.5},
  {...outcome, horizonHours:4, sampleGroup:"SELL", evaluatedDirection:"SELL"}
];
const summary = E.summarize(rows);
assert.equal(summary["1h"].BUY.samples, 2);
assert.equal(summary["1h"].BUY.hitRatePct, 50);
assert.equal(summary["4h"].SELL.samples, 1);
assert.equal(summary["24h"].BUY.samples, 0);

const bars = [
  {closeTime:1000,close:100},
  {closeTime:2000,close:101},
  {closeTime:3000,close:102}
];
assert.equal(E.findFutureClose(bars, 1000, 0, 3000).close, 100);
assert.equal(E.findFutureClose(bars, 1000, 0.0000001, 3000).close, 101);
assert.equal(E.findFutureClose(bars, 3000, 1, 3000), null);

console.log("OK: forward signal returns, WAIT near-misses, fees and baselines.");
