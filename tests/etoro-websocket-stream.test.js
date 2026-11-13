"use strict";
const assert = require("node:assert/strict");
const { createEtoroStream } = require("../scripts/etoro-websocket-stream");

class FakeSocket {
  static instances = [];
  constructor(url) { this.url = url; this.readyState = 0; this.sent = []; FakeSocket.instances.push(this); }
  send(value) { this.sent.push(JSON.parse(value)); }
  open() { this.readyState = 1; this.onopen && this.onopen(); }
  message(value) { this.onmessage && this.onmessage({ data: JSON.stringify(value) }); }
  close() { this.readyState = 3; this.onclose && this.onclose(); }
}

const scheduled = [];
const statuses = [], received = [], errors = [];
const stream = createEtoroStream({
  WebSocket: FakeSocket, instrumentIds: [1001, 1002],
  apiKey: "test-api", userKey: "test-user",
  setTimeout: (fn, delay) => { scheduled.push({ fn, delay }); return scheduled.length; },
  clearTimeout: () => {},
  onStatus: status => statuses.push(status),
  onMessage: message => received.push(message),
  onError: error => errors.push(error),
  autoStart: false,
});
stream.start();
const first = FakeSocket.instances[0];
assert.equal(first.url, "wss://ws.etoro.com/ws");
first.open();
assert.equal(first.sent[0].operation, "Authenticate");
assert.equal(first.sent[1].operation, "Subscribe");
assert.deepEqual(first.sent[1].data.topics, ["instrument:1001", "instrument:1002"]);
const rateContent = (bid, ask, last, date, priceRateId) => JSON.stringify({
  Bid: String(bid), Ask: String(ask), LastExecution: String(last),
  Date: new Date(date).toISOString(), PriceRateID: String(priceRateId)
});
const rateTime = Date.now() - 500;
first.message({ messages: [
  { topic: "instrument:1001", type: "Trading.Instrument.Rate", id: "push-1",
    content: rateContent(10, 11, 10.5, rateTime, 1) },
  { topic: "instrument:1002", type: "Trading.Instrument.Rate", id: "push-stale",
    content: rateContent(20, 21, 20.5, rateTime - 30000, 2) },
  { topic: "instrument:9999", type: "Trading.Instrument.Rate", id: "push-unsubscribed",
    content: rateContent(30, 31, 30.5, rateTime, 3) },
  { topic: "instrument:1001", type: "Trading.Instrument.MarketStatus", id: "push-status", content: "{}" }
] });
assert.equal(received.length, 1, "only fresh rates for subscribed instruments are delivered");
assert.equal(received[0].instrumentId, 1001);
assert.equal(received[0].bid, 10);
assert.equal(received[0].ask, 11);
assert.equal(received[0].lastPrice, 10.5);
first.message({ messages: [
  { topic: "instrument:1001", type: "Trading.Instrument.Rate", id: "push-duplicate",
    content: rateContent(9, 10, 9.5, rateTime, 4) }
] });
assert.equal(received.length, 1, "duplicate/older timestamps cannot overwrite a newer quote");
first.message({ operation: "Subscribe", success: true, id: first.sent[1].id });
assert.equal(received.length, 1, "control acknowledgements are not market data");
first.close();
assert.equal(scheduled[0].delay, 1000);
scheduled[0].fn();
assert.equal(FakeSocket.instances.length, 2);
stream.stop();
assert.equal(stream.getState().state, "STOPPED");
assert.equal(errors.length, 0);
assert.ok(statuses.some(s => s.state === "RECONNECTING"));

assert.throws(() => createEtoroStream({ WebSocket: FakeSocket, instrumentIds: [0], autoStart: false }), /instrument IDs/);
assert.throws(() => createEtoroStream({ WebSocket: FakeSocket, instrumentIds: [1], apiKey: "only-one", autoStart: false }), /Both eToro/);
console.log("eToro WebSocket transport tests passed: auth, subscribe, data delivery, reconnect, stop and validation.");
