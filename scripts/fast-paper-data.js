"use strict";

function validOneSecondKline(k, nowMs) {
  if (!Array.isArray(k) || k.length < 7) return null;
  const time = Number(k[0]), closeTime = Number(k[6]);
  const open = Number(k[1]), high = Number(k[2]), low = Number(k[3]);
  const close = Number(k[4]), volume = Number(k[5]);
  if (!Number.isSafeInteger(time) || time < 0 || time % 1000 !== 0 ||
      !Number.isFinite(closeTime) || closeTime <= time || closeTime >= nowMs ||
      ![open, high, low, close, volume].every(Number.isFinite) ||
      Math.min(open, high, low, close) <= 0 || volume < 0 ||
      high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null;
  return { time, open, high, low, close, volume };
}

function aggregateOneSecondKlines(rows, intervalSeconds, nowMs = Date.now()) {
  if (!Array.isArray(rows)) throw new TypeError("Binance one-second klines must be an array.");
  if (![5, 15].includes(intervalSeconds)) throw new RangeError("Only 5s and 15s bars are supported.");
  if (!Number.isFinite(nowMs)) throw new TypeError("nowMs must be finite.");
  const barMs = intervalSeconds * 1000;
  const grouped = new Map();

  for (const row of rows) {
    if (!Array.isArray(row) || row.length < 7) continue;
    const rawTime = Number(row[0]);
    if (!Number.isSafeInteger(rawTime) || rawTime < 0) continue;
    const bucketTime = Math.floor(rawTime / barMs) * barMs;
    if (bucketTime + barMs > nowMs) continue;
    const candle = validOneSecondKline(row, nowMs);
    const group = grouped.get(bucketTime);
    if (!candle) {
      if (group) group.invalid = true;
      continue;
    }
    if (!group) {
      grouped.set(bucketTime, {
        time: bucketTime, open: candle.open, high: candle.high, low: candle.low,
        close: candle.close, volume: candle.volume,
        seconds: new Set([candle.time]), invalid: false
      });
      continue;
    }
    if (group.seconds.has(candle.time)) {
      group.invalid = true;
      continue;
    }
    group.seconds.add(candle.time);
    group.high = Math.max(group.high, candle.high);
    group.low = Math.min(group.low, candle.low);
    group.close = candle.close;
    group.volume += candle.volume;
  }

  return Array.from(grouped.values())
    .filter(group => !group.invalid && group.seconds.size === intervalSeconds)
    .map(({ seconds, invalid, ...bar }) => ({ ...bar, closeTime: bar.time + barMs - 1 }))
    .sort((a, b) => a.time - b.time);
}

function trailingContiguousBars(bars, barMs) {
  if (!Array.isArray(bars) || !Number.isFinite(barMs) || barMs <= 0) return [];
  const closed = bars.filter(bar =>
    bar && Number.isFinite(bar.time) && Number.isFinite(bar.closeTime) &&
    bar.closeTime === bar.time + barMs - 1
  );
  for (let i = 1; i < closed.length; i++) {
    if (closed[i].time <= closed[i - 1].time) return [];
  }
  if (!closed.length) return [];
  let start = closed.length - 1;
  for (let i = closed.length - 1; i > 0; i--) {
    if (closed[i].time - closed[i - 1].time !== barMs) break;
    start = i - 1;
  }
  return closed.slice(start);
}

module.exports = { aggregateOneSecondKlines, trailingContiguousBars };
