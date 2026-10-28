"use strict";
const assert = require("node:assert/strict");
const resolvePaperExit = require("../scripts/paper-exit.js");

assert.deepEqual(resolvePaperExit({open:95,high:97,low:94,close:96},98,103),
  {price:95,reason:"Stop-loss gap"}, "stop-market gap fills at the worse open");
assert.deepEqual(resolvePaperExit({open:100,high:101,low:97,close:99},98,103),
  {price:98,reason:"Stop-loss"}, "ordinary stop fills at stop");
assert.deepEqual(resolvePaperExit({open:104,high:106,low:103,close:105},98,103),
  {price:103,reason:"Take-profit"}, "target limit is not given optimistic gap improvement");
assert.deepEqual(resolvePaperExit({open:100,high:104,low:97,close:101},98,103),
  {price:98,reason:"Stop-first ambiguous candle"}, "stop wins when both barriers hit in one candle");
assert.equal(resolvePaperExit({open:100,high:102,low:99,close:101},98,103),null,
  "no barrier hit means no exit");
assert.equal(resolvePaperExit({open:NaN,high:104,low:97,close:100},98,103),null,
  "invalid OHLC is rejected");
console.log("Paper exit tests passed: gap handling, stop-first ambiguity, target fill and invalid OHLC.");
