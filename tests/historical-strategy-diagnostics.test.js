"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const D = require("../scripts/historical-strategy-diagnostics.js");

const bars = [
  {closeTime: 1000}, {closeTime: 2000}, {closeTime: 3000}
];
assert.equal(D.lastIndexAtOrBefore(bars, 1999), 0);
assert.equal(D.lastIndexAtOrBefore(bars, 2000), 1);
assert.equal(D.lastIndexAtOrBefore(bars, 999), -1);

const baselineA = D.baselineReturns("BTCUSDT", 100, 110, 0.004);
const baselineB = D.baselineReturns("BTCUSDT", 100, 110, 0.004);
assert.deepEqual(baselineA, baselineB, "random-direction baseline is deterministic");
assert.ok(baselineA.buyAndHoldNetPct > 0);
assert.ok(Number.isFinite(baselineA.randomDirectionMeanNetPct));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "radar-diagnostics-"));
try {
  const file = path.join(tmp, "sample.csv");
  fs.writeFileSync(file,
    "symbol,interval,open_time_utc,close_time_utc,available_at_utc,collected_at_utc,open,high,low,close,base_volume,quote_volume,trade_count,taker_buy_base_volume,taker_buy_quote_volume\n" +
    "BTCUSDT,1h,2026-11-12T10:00:00.000Z,2026-11-12T10:59:59.999Z,2026-11-12T11:00:00.000Z,2026-11-12T11:01:00.000Z,100,102,99,101,10,1000,5,6,600\n" +
    "BTCUSDT,1h,2026-11-12T11:00:00.000Z,2026-11-12T11:59:59.999Z,2026-11-12T12:00:00.000Z,2026-11-12T12:01:00.000Z,101,103,100,102,11,1100,6,7,700\n");
  const rows = D.readCsv(file);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].close, 101);
  assert.ok(rows[0].availableAt > rows[0].closeTime);
} finally {
  fs.rmSync(tmp, {recursive:true,force:true});
}

console.log("OK: historical diagnostics alignment, deterministic baselines and point-in-time CSV validation.");
