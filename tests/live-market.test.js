"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

const source = fs.readFileSync("public/live-market.js", "utf8");
assert.doesNotThrow(() => new vm.Script(source), "live stream script must parse");

let now = Date.now();
const NativeDate = Date;
class FakeDate extends NativeDate {
  constructor(...args) { super(...(args.length ? args : [now])); }
  static now() { return now; }
}
const sockets = [];
const intervals = [];
const timeouts = [];
const emitted = [];
class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  constructor(url) { this.url = url; this.readyState = FakeWebSocket.CONNECTING; sockets.push(this); }
  open() { this.readyState = FakeWebSocket.OPEN; this.onopen && this.onopen({}); }
  message(payload) { this.onmessage && this.onmessage({data: JSON.stringify(payload)}); }
  close() { this.readyState = FakeWebSocket.CLOSED; this.onclose && this.onclose({}); }
}
class FakeCustomEvent {
  constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
}
const windowMock = {
  dispatchEvent(event) { emitted.push(event); return true; }
};
const context = {
  window: windowMock,
  WebSocket: FakeWebSocket,
  CustomEvent: FakeCustomEvent,
  Event: class { constructor(type) { this.type = type; } },
  Date: FakeDate,
  setInterval(fn) { intervals.push(fn); return intervals.length; },
  clearInterval() {},
  setTimeout(fn) { timeouts.push(fn); return timeouts.length; },
  clearTimeout() {},
  console
};
vm.runInNewContext(source, context, {filename: "public/live-market.js"});
assert.equal(sockets.length, 1, "initial connection starts without polling");
assert.match(sockets[0].url, /^wss:\/\/data-stream\.binance\.vision:443\/stream\?/);
sockets[0].open();
sockets[0].message({stream:"btcusdt@trade",data:{e:"trade",s:"BTCUSDT",p:"65000.10",q:"0.02",T:now}});
sockets[0].message({stream:"btcusdt@bookTicker",data:{s:"BTCUSDT",b:"65000.09",a:"65000.11"}});
let quote = windowMock.RahasampoLiveMarket.get("BTCUSDT");
assert.equal(quote.price, 65000.10);
assert.equal(quote.bid, 65000.09);
assert.equal(quote.ask, 65000.11);
assert.equal(quote.fresh, true, "fresh trade and bid/ask updates qualify as live");
assert.ok(quote.priceAgeMs >= 0 && quote.quoteAgeMs >= 0);
assert.ok(Number.isFinite(quote.spreadPct) && quote.spreadPct > 0);

now += 4000;
quote = windowMock.RahasampoLiveMarket.get("BTCUSDT");
assert.equal(quote.fresh, false, "a quote older than 3 seconds cannot be presented as fresh");
assert.ok(quote.quoteAgeMs >= 4000);

now += 12000;
assert.equal(intervals.length, 2, "publisher and idle watchdog are installed");
intervals[1]();
quote = windowMock.RahasampoLiveMarket.get("BTCUSDT");
assert.equal(quote.connected, false, "stalled socket is marked disconnected");
assert.ok(timeouts.length > 0, "stalled socket schedules reconnect");
timeouts[timeouts.length - 1]();
assert.equal(sockets.length, 2, "reconnect creates a new socket");
assert.match(sockets[1].url, /^wss:\/\/stream\.binance\.com:443\/stream\?/,
  "reconnect rotates to the next supported endpoint");

// A fallback endpoint that worked and then failed must rotate again, not get pinned.
sockets[1].open();
sockets[1].message({stream:"btcusdt@trade",data:{e:"trade",s:"BTCUSDT",p:"65001.00",q:"0.03",T:now}});
sockets[1].message({stream:"btcusdt@bookTicker",data:{s:"BTCUSDT",b:"65000.99",a:"65001.01"}});
sockets[1].close();
timeouts[timeouts.length - 1]();
assert.equal(sockets.length, 3, "second reconnect creates a third socket");
assert.match(sockets[2].url, /^wss:\\/\\/stream\\.binance\\.com:9443\\/stream\\?/,
  "success followed by a disconnect rotates to the third endpoint");

windowMock.RahasampoLiveMarket.stop();
assert.ok(emitted.some(e => e.type === "market-live-close") ||
  emitted.some(e => e.type === "market-live-stale"),
  "connection interruptions are surfaced to the UI");
console.log("Live market tests passed: WebSocket feed, separate price/quote freshness, stale guard and reconnect failover.");
