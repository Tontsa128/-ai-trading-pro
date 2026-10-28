"use strict";

const assert = require("node:assert/strict");
const marketProxy = require("../api/market.js");

async function invoke(query, mockFetch, method) {
  const originalFetch = global.fetch;
  global.fetch = mockFetch || (async () => ({ ok: true, status: 200, json: async () => ({ lastPrice: "123" }) }));
  const res = {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
  try {
    await marketProxy({ method: method || "GET", query: query || {} }, res);
    return res;
  } finally {
    global.fetch = originalFetch;
  }
}

(async function main() {
  let calls = [];
  const fallback = await invoke(
    { endpoint: "ticker24hr", symbol: "BTCUSDT" },
    async url => {
      calls.push(String(url));
      if (calls.length === 1) return { ok: false, status: 503, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ symbol: "BTCUSDT", lastPrice: "65000" }) };
    }
  );
  assert.equal(fallback.statusCode, 200);
  assert.equal(fallback.body.lastPrice, "65000");
  assert.equal(calls.length, 2, "proxy must try the backup Binance source");
  assert.match(fallback.headers["Cache-Control"], /no-store/i, "live market data must not be cached");
  assert.equal(fallback.headers.Pragma, "no-cache");
  assert.equal(fallback.headers.Expires, "0");

  let fetched = false;
  const badSymbol = await invoke({ endpoint: "ticker24hr", symbol: "NOTREAL" }, async () => {
    fetched = true;
    return { ok: true, status: 200, json: async () => ({}) };
  });
  assert.equal(badSymbol.statusCode, 400);
  assert.equal(fetched, false, "unsupported pair must not reach upstream");
  assert.match(badSymbol.headers["Cache-Control"], /no-store/i, "error responses must not be cached");

  const badInterval = await invoke({ endpoint: "klines", symbol: "BTCUSDT", interval: "10m", limit: "500" });
  assert.equal(badInterval.statusCode, 400);

  const badEndpoint = await invoke({ endpoint: "anything", symbol: "BTCUSDT" });
  assert.equal(badEndpoint.statusCode, 400);

  const wrongShape = await invoke({ endpoint: "klines", symbol: "BTCUSDT", interval: "1h", limit: "10" },
    async () => ({ ok: true, status: 200, json: async () => ({ unexpected: true }) }));
  assert.equal(wrongShape.statusCode, 502, "invalid upstream payload must fail closed");

  const wrongMethod = await invoke({ endpoint: "ticker24hr", symbol: "BTCUSDT" }, undefined, "POST");
  assert.equal(wrongMethod.statusCode, 405);

  console.log("Market proxy tests passed: no-cache live data, source failover, input allow-list, schema validation and method guard.");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
