"use strict";

const assert = require("node:assert/strict");
const guards = require("../public/live-signal-guards");

const now = 100000;
const fresh = {
  tradePrice: 100,
  lastTradeAt: now - 500,
  bid: 99.99,
  ask: 100.01,
  lastBookAt: now - 500
};
assert.equal(guards.gateReason(fresh, now), null,
  "fresh trade and order-book quotes with a tight spread pass");
const validBuy = guards.apply({ side: "BUY", score: 72 }, fresh, now);
assert.equal(validBuy.side, "BUY");
assert.equal(validBuy.actionable, true);
assert.equal(validBuy.gateReason, null);

assert.match(guards.gateReason({...fresh, lastTradeAt: now - 6000}, now), /kauppahinta vanhentunut/i,
  "stale last trade blocks an actionable signal");
assert.match(guards.gateReason({...fresh, lastBookAt: now - 4000}, now), /tarjous vanhentunut/i,
  "stale order-book data blocks an actionable signal");
assert.match(guards.gateReason({...fresh, bid: 100.02, ask: 100.01}, now), /puuttuu tai on virheellinen/i,
  "crossed or invalid quotes fail closed");
assert.match(guards.gateReason({...fresh, bid: 99.8, ask: 100.2}, now), /ylittää 0,15/i,
  "excessive spread blocks an actionable signal");
assert.match(guards.gateReason({...fresh, tradePrice: null}, now), /kauppahinta puuttuu/i,
  "missing trade prices fail closed");

const staleSignal = guards.apply({ side: "BUY", score: 72 }, {...fresh, lastTradeAt: now - 6000}, now);
assert.equal(staleSignal.side, "WAIT");
assert.equal(staleSignal.actionable, false);
assert.ok(staleSignal.gateReason);

const waitingSignal = guards.apply({ side: "WAIT", score: 54 }, fresh, now);
assert.equal(waitingSignal.side, "WAIT");
assert.equal(waitingSignal.actionable, false);

console.log("Live signal guard tests passed: stale trade/quote feeds and invalid/wide spreads cannot display actionable signals.");
