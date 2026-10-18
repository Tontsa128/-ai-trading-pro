"use strict";

const assert = require("node:assert/strict");
const { buildTradeActivity } = require("../scripts/paper-trading-cycle");

const firstEntry = {
  symbol: "BTCUSDT", side: "PAPER_BUY",
  entryTime: "2026-10-18T12:00:00.000Z", entry: 65000, qty: 0.01
};
const secondEntry = {
  symbol: "ETHUSDT", side: "PAPER_BUY",
  entryTime: "2026-10-18T12:01:00.000Z", entry: 2500, qty: 0.1
};
const previousPositionClosed = {
  symbol: "SOLUSDT", side: "PAPER_SELL",
  entryTime: "2026-10-18T09:00:00.000Z",
  exitTime: "2026-10-18T12:02:00.000Z", entry: 100, exit: 99, qty: 1, pnl: -1
};

const opened = [firstEntry, secondEntry];
const closed = [previousPositionClosed];
const activity = buildTradeActivity(opened, closed);

assert.deepEqual(activity.newTrades.map(t => t.side), [
  "PAPER_BUY", "PAPER_BUY", "PAPER_SELL"
], "the cycle activity must include new entries and position closures");
assert.deepEqual(activity.newTrades.map(t => t.symbol), [
  "BTCUSDT", "ETHUSDT", "SOLUSDT"
], "trade events must be ordered by the actual entry/exit time");
assert.deepEqual(activity.closedTrades, closed,
  "closedTrades must remain a separate closure-only collection");
assert.deepEqual(opened, [firstEntry, secondEntry],
  "building report activity must not mutate the input entry array");
assert.deepEqual(closed, [previousPositionClosed],
  "building report activity must not mutate the input closure array");
assert.deepEqual(buildTradeActivity([], []).newTrades, [],
  "an empty cycle reports no trade events");
assert.deepEqual(buildTradeActivity(null, undefined), {
  newTrades: [], closedTrades: []
}, "missing event arrays fail safely");

console.log("Paper cycle report tests passed: entries and exits are both persisted as correctly ordered activity.");
