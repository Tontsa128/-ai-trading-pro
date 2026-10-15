"use strict";

const assert = require("node:assert/strict");
const { parseBinanceMessage, normalizeTickerQuote } = require("../scripts/market-feed");

const trade = parseBinanceMessage(JSON.stringify({
  stream: "btcusdt@trade",
  data: { e: "trade", s: "BTCUSDT", p: "65000.25", q: "0.01", T: 1792000000000 }
}));
assert.deepEqual(trade, {
  type: "trade", symbol: "BTCUSDT", price: 65000.25, qty: 0.01, time: 1792000000000
});

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

console.log("Live market feed tests passed: wrapped trade stream, book ticker, buffer input and REST quote validation.");
