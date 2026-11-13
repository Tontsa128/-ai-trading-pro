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
first.message({ topic: "instrument:1001", data: { bid: 10, ask: 11 } });
assert.equal(received.length, 1);
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
