"use strict";

const assert = require("node:assert/strict");
const { aggregateOneSecondKlines, trailingContiguousBars } = require("../scripts/fast-paper-data");

function oneSecondRow(time, price = 100, volume = 1) {
  return [time, String(price), String(price + 1), String(price - 1), String(price), String(volume), time + 999];
}
function rowsFor(start, count, price = 100) {
  return Array.from({ length: count }, (_, i) => oneSecondRow(start + i * 1000, price + i));
}

const fiveSecond = aggregateOneSecondKlines(rowsFor(0, 5), 5, 5000);
assert.equal(fiveSecond.length, 1);
assert.deepEqual(fiveSecond[0], {
  time: 0, open: 100, high: 105, low: 99, close: 104, volume: 5, closeTime: 4999
});

assert.equal(aggregateOneSecondKlines(rowsFor(0, 4), 5, 5000).length, 0,
  "a bucket missing one constituent second is not promoted to a candle");
const duplicate = rowsFor(0, 5);
duplicate.push(duplicate[2]);
assert.equal(aggregateOneSecondKlines(duplicate, 5, 5000).length, 0,
  "duplicate one-second klines invalidate their bucket");
assert.equal(aggregateOneSecondKlines(rowsFor(5000, 5), 5, 6500).length, 0,
  "an unfinished 5-second bucket is excluded");
const invalid = rowsFor(0, 5);
invalid[2] = [2000, "100", "1", "99", "101", "1", 2999];
assert.equal(aggregateOneSecondKlines(invalid, 5, 5000).length, 0,
  "an internally inconsistent OHLC row invalidates its bucket");
const badCloseTime = rowsFor(0, 5);
badCloseTime[1][6] = 2500;
assert.equal(aggregateOneSecondKlines(badCloseTime, 5, 5000).length, 0,
  "a one-second candle with an invalid close timestamp invalidates its bucket");
assert.equal(aggregateOneSecondKlines(rowsFor(0, 15), 15, 15000).length, 1,
  "15-second aggregation requires and accepts all fifteen constituents");
assert.throws(() => aggregateOneSecondKlines({}, 5, 5000), /must be an array/);
assert.throws(() => aggregateOneSecondKlines([], 10, 5000), /Only 5s and 15s/);

const bars = [0, 5000, 15000, 20000, 25000].map(time => ({
  time, closeTime: time + 4999, open: 100, high: 101, low: 99, close: 100, volume: 1
}));
bars.push({ time: 30000, open: 100, high: 101, low: 99, close: 100, volume: 1 });
assert.deepEqual(trailingContiguousBars(bars, 5000).map(bar => bar.time), [15000, 20000, 25000],
  "a data gap resets the contiguous warm-up sequence and open bars are excluded");
assert.deepEqual(trailingContiguousBars(bars.slice().reverse(), 5000), [],
  "out-of-order candle history fails closed");
assert.deepEqual(trailingContiguousBars([], 5000), []);
console.log("Fast paper data aggregation tests passed.");
