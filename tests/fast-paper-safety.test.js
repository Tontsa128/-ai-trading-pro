"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { isEligibleEntryBar } = require("../scripts/fast-paper-trader");

const realTradeBar = {
  volume: 12.5,
  hasWebSocketTrades: true,
  hasRestFallback: false
};
assert.equal(isEligibleEntryBar(realTradeBar), true,
  "a closed candle made only from real WebSocket trades can be evaluated for entry");

assert.equal(isEligibleEntryBar({
  volume: 0,
  hasWebSocketTrades: false,
  hasRestFallback: true
}), false, "zero-volume REST samples cannot produce paper entries");

assert.equal(isEligibleEntryBar({
  volume: 4,
  hasWebSocketTrades: true,
  hasRestFallback: true
}), false, "mixed REST/WebSocket candles are rejected for new entries");

assert.equal(isEligibleEntryBar({
  volume: 4,
  hasWebSocketTrades: false,
  hasRestFallback: false
}), false, "a candle without real WebSocket trade events cannot produce entries");

assert.equal(isEligibleEntryBar({
  volume: NaN,
  hasWebSocketTrades: true,
  hasRestFallback: false
}), false, "invalid volume must fail closed");

const worker = fs.readFileSync(path.join(__dirname, "../scripts/fast-paper-trader.js"), "utf8");
assert.match(worker, /if \(!isEligibleEntryBar\(bar\)\)\s*\{\s*nonTradeBarsSkipped \+= 1;\s*return;\s*\}/,
  "the entry guard must execute before the EMA crossover can open a position");
assert.match(worker, /nonTradeBarsSkipped:\s*nonTradeBarsSkipped/,
  "the report must disclose how many degraded bars were skipped");

console.log("Fast paper safety tests passed: REST-only and mixed-source candles cannot open new positions.");
