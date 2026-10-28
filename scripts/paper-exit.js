"use strict";

// Conservative OHLC fill model for the two-hour paper trader.
// If both barriers are touched, assume the stop executes first.
module.exports = function resolvePaperExit(bar, stop, target) {
  if (!bar || ![bar.open, bar.high, bar.low, stop, target].every(Number.isFinite) ||
      stop <= 0 || target <= stop || bar.high < bar.low) return null;
  const hitStop = bar.low <= stop;
  const hitTarget = bar.high >= target;
  if (!hitStop && !hitTarget) return null;
  if (hitStop) {
    const gap = bar.open < stop;
    return {
      price: gap ? bar.open : stop,
      reason: hitStop && hitTarget ? "Stop-first ambiguous candle" : gap ? "Stop-loss gap" : "Stop-loss"
    };
  }
  // Limit target is conservatively filled at the target, not an optimistic opening price.
  return { price: target, reason: "Take-profit" };
};
