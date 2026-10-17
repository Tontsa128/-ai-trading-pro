"use strict";

const assert = require("node:assert/strict");
const { parseBinanceMessage, normalizeTickerQuote, isFreshQuote, WEBSOCKET_BASES, buildCombinedStreamUrl } = require("../scripts/market-feed");

const tradeNow = Date.now();
const trade = parseBinanceMessage(JSON.stringify({
  stream: "btcusdt@trade",
  data: { e: "trade", s: "BTCUSDT", p: "65000.25", q: "0.01", T: tradeNow }
}), tradeNow);
assert.deepEqual(trade, {
  type: "trade", symbol: "BTCUSDT", price: 65000.25, qty: 0.01, time: tradeNow
});
const staleTrade = JSON.stringify({ data: { e: "trade", s: "BTCUSDT", p: "65000.25", q: "0.01", T: tradeNow - 6000 } });
const futureTrade = JSON.stringify({ data: { e: "trade", s: "BTCUSDT", p: "65000.25", q: "0.01", T: tradeNow + 6000 } });
assert.equal(parseBinanceMessage(staleTrade, tradeNow), null, "stale exchange trades must not advance short-horizon bars");
assert.equal(parseBinanceMessage(futureTrade, tradeNow), null, "future-dated exchange trades must fail closed");

const book = parseBinanceMessage(Buffer.from(JSON.stringify({
  stream: "ethusdt@bookTicker",
  data: { s: "ETHUSDT", b: "2500.10", a: "2500.20" }
})));
assert.deepEqual(book, {
  type: "bookTicker", symbol: "ETHUSDT", bid: 2500.1, ask: 2500.2
});

assert.equal(parseBinanceMessage("not-json"), null);
assert.equal(parseBinanceMessage(JSON.stringify({ data: { s: "BTCUSDT", b: "0", a: "1" } })), null);
assert.equal(normalizeTickerQuote({ lastPrice: "10", bidPrice: "9.99", askPrice: "10.01" }).price, 10);
assert.equal(normalizeTickerQuote({ lastPrice: "0", bidPrice: "9.99", askPrice: "10.01" }), null);
assert.equal(normalizeTickerQuote({ lastPrice: "10", bidPrice: "11", askPrice: "10" }), null);
assert.equal(normalizeTickerQuote(null), null);
assert.equal(isFreshQuote(9500, 10000, 500), true, "recent quote is accepted");
assert.equal(isFreshQuote(9499, 10000, 500), false, "older quote is rejected");
assert.equal(isFreshQuote(10001, 10000, 500), false, "future-dated quote is rejected");
assert.equal(isFreshQuote(null, 10000, 500), false, "missing quote timestamp is rejected");
assert.equal(isFreshQuote(9999, 10000, -1), false, "invalid freshness bound fails closed");

assert.deepEqual(WEBSOCKET_BASES, [
  "wss://data-stream.binance.vision:443",
  "wss://stream.binance.com:443",
  "wss://stream.binance.com:9443"
], "try the dedicated public market-data stream first");
assert.equal(
  buildCombinedStreamUrl(WEBSOCKET_BASES[0], ["BTCUSDT", "ETHUSDT"]),
  "wss://data-stream.binance.vision:443/stream?streams=btcusdt@trade/btcusdt@bookTicker/ethusdt@trade/ethusdt@bookTicker"
);
assert.throws(() => buildCombinedStreamUrl("https://not-ws.example", ["BTCUSDT"]), /secure WebSocket/);
assert.throws(() => buildCombinedStreamUrl(WEBSOCKET_BASES[0], []), /at least one market symbol/);
assert.throws(() => buildCombinedStreamUrl(WEBSOCKET_BASES[0], ["BTC/USDT"]), /Invalid WebSocket market symbol/);

console.log("Live market feed tests passed: WebSocket host failover URLs, wrapped trade stream, book ticker, Buffer input and REST quote validation.");
