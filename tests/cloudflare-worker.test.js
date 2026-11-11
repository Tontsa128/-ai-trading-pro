"use strict";

const assert = require("node:assert/strict");

async function run() {
  const { default: worker } = await import("../cloudflare/worker.mjs");
  const originalFetch = global.fetch;
  let upstreamRequest;
  let assetRequest;

  try {
    global.fetch = async (request) => {
      upstreamRequest = new URL(request.url);
      return new Response(JSON.stringify({ price: "123.45" }), {
        status: 200,
        headers: { "content-type": "application/json", "cache-control": "public, max-age=60" }
      });
    };

    const apiResponse = await worker.fetch(
      new Request("https://preview.example/api/market?endpoint=ticker24hr&symbol=BTCUSDT"),
      { ASSETS: { fetch: async () => { throw new Error("API must not fall through to assets"); } } }
    );
    assert.equal(apiResponse.status, 200);
    assert.equal(upstreamRequest.origin, "https://ai-trading-pro-azure.vercel.app");
    assert.equal(upstreamRequest.pathname, "/api/market");
    assert.equal(upstreamRequest.search, "?endpoint=ticker24hr&symbol=BTCUSDT");
    assert.match(apiResponse.headers.get("cache-control"), /no-store/);
    assert.deepEqual(await apiResponse.json(), { price: "123.45" });

    const denied = await worker.fetch(
      new Request("https://preview.example/api/market", { method: "POST" }),
      { ASSETS: { fetch: async () => { throw new Error("POST must not fall through to assets"); } } }
    );
    assert.equal(denied.status, 405);

    const assets = await worker.fetch(
      new Request("https://preview.example/"),
      { ASSETS: { fetch: async (request) => { assetRequest = request; return new Response("index"); } } }
    );
    assert.equal(await assets.text(), "index");
    assert.equal(new URL(assetRequest.url).pathname, "/");
  } finally {
    global.fetch = originalFetch;
  }

  console.log("Cloudflare Worker tests passed: fixed-origin live market proxy, no-cache response, method guard and static asset fallback.");
}

run().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
