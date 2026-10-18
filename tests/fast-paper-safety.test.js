"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isEligibleEntryBar, hasCleanEntryHistory, resolvePositionExit } = require("../scripts/fast-paper-trader");

const realTradeBar = {
  time: 1000, closeTime: 5999, volume: 12.5,
  hasTradeData: true, hasRestFallback: false
};
assert.equal(isEligibleEntryBar(realTradeBar), true,
  "a candle backed by trade-derived OHLCV can be used for an entry");

assert.equal(isEligibleEntryBar({
  volume: 0, hasTradeData: false, hasRestFallback: true
}), false, "zero-volume REST samples cannot produce paper entries");

assert.equal(isEligibleEntryBar({
  volume: 4, hasTradeData: true, hasRestFallback: true
}), false, "mixed REST/trade candles are rejected for new entries");

assert.equal(isEligibleEntryBar({
  volume: 4, hasTradeData: false, hasRestFallback: false
}), false, "a candle without trade-derived data cannot produce entries");

assert.equal(isEligibleEntryBar({
  volume: NaN, hasTradeData: true, hasRestFallback: false
}), false, "invalid volume must fail closed");

function bar(i, overrides) {
  return Object.assign({
    time: i * 5000,
    closeTime: i * 5000 + 4999,
    open: 100,
    high: 101,
    low: 99,
    close: 100.5,
    volume: 10,
    hasTradeData: true,
    hasRestFallback: false
  }, overrides || {});
}

const cleanHistory = Array.from({length: 81}, (_, i) => bar(i));
assert.equal(hasCleanEntryHistory(cleanHistory, 81), true,
  "the complete EMA/momentum lookback passes when every candle is trade-derived");

const contaminated = cleanHistory.slice();
contaminated[35] = bar(35, {hasTradeData: true, hasRestFallback: true, volume: 12});
assert.equal(hasCleanEntryHistory(contaminated, 81), false,
  "sampled REST data anywhere in the strategy lookback blocks an entry");

assert.equal(hasCleanEntryHistory(cleanHistory.slice(1), 81), false,
  "insufficient clean lookback fails closed");

const badVolume = cleanHistory.slice();
badVolume[10] = bar(10, {volume: NaN});
assert.equal(hasCleanEntryHistory(badVolume, 81), false,
  "invalid OHLCV in the lookback blocks an entry");

const exitCases = [
  [{open:95, high:97, low:94, close:96}, 98, 103, 95, "Stop-loss gap"],
  [{open:104, high:106, low:103, close:105}, 98, 103, 103, "Take-profit"],
  [{open:100, high:104, low:97, close:101}, 98, 103, 98, "Stop-first ambiguous candle"],
  [{open:100, high:101, low:97, close:99}, 98, 103, 98, "Stop-loss"],
  [{open:100, high:104, low:99, close:103}, 98, 103, 103, "Take-profit"]
];
for (const [barData, stop, target, expectedPrice, expectedCause] of exitCases) {
  const outcome = resolvePositionExit(barData, stop, target);
  assert.equal(outcome.price, expectedPrice, expectedCause + " must use the conservative reference price");
  assert.equal(outcome.cause, expectedCause, "exit reason should disclose stop gaps and same-bar ambiguity");
}
assert.equal(resolvePositionExit({open:NaN,high:104,low:99}, 98, 103), null,
  "invalid OHLC data must not yield an estimated exit");

const worker = fs.readFileSync(path.join(__dirname, "../scripts/fast-paper-trader.js"), "utf8");
assert.match(worker, /if \(!isEligibleEntryBar\(bar\) \|\| !hasCleanEntryHistory\(s\.bars, 81\)\)\s*\{\s*nonTradeBarsSkipped \+= 1;\s*return;\s*\}/,
  "the full-history guard must run before an EMA crossover can open a position");
assert.match(worker, /hasTradeData: volume > 0, hasRestFallback: false/,
  "official historical OHLCV bars must be marked as trade-derived warm-up data");
assert.match(worker, /nonTradeBarsSkipped:\s*nonTradeBarsSkipped/,
  "the report must disclose how many degraded bars were skipped");
assert.match(worker, /socketOpenAtSessionEnd = socketOpen;/,
  "worker must snapshot actual WebSocket connection state before orderly shutdown");
assert.match(worker, /websocketConnectedAtEnd: socketOpenAtSessionEnd === null \? socketOpen : socketOpenAtSessionEnd/,
  "report must use the pre-shutdown connection snapshot rather than the already-closed socket");
const sessionStopAt = worker.indexOf("stopTimer = setTimeout");
const snapshotAt = worker.indexOf("socketOpenAtSessionEnd = socketOpen;", sessionStopAt);
const closeFlagAt = worker.indexOf("socketOpen = false;", sessionStopAt);
assert.ok(sessionStopAt >= 0 && snapshotAt > sessionStopAt && closeFlagAt > snapshotAt,
  "the report snapshot must occur before the scheduled shutdown changes the socket state");

assert.match(worker, /const exit = resolvePositionExit\(bar, p\.stop, p\.target\)/,
  "paper position stops/targets must use the gap-aware exit resolver");

console.log("Fast paper safety tests passed: sampled or contaminated lookbacks cannot open new positions.");
