"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createHandler } = require("../api/etoro");

function response() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; }
  };
}

(async () => {
  let factoryCalls = 0;
  const calls = [];
  const client = {
    async searchInstruments(q) { calls.push(["search", q]); return { items: [{ instrumentId: 1001, internalSymbolFull: "BTC" }] }; },
    async getLiveBidAskRates(ids) { calls.push(["rates", ids]); return [{ instrumentId: 1001, quoteType: "realtime", bid: 99, ask: 101 }]; },
    async getMarketFeed(id, take) { calls.push(["feed", id, take]); return { posts: [{ id: "post-1" }] }; },
    async getUserProfiles(names) { calls.push(["profiles", names]); return [{ username: "alice" }]; },
    async getInvestorCopierStats(username) { calls.push(["copiers", username]); return { copiers: 123, aumTier: 3 }; },
    async getInvestorRankings(filters) { calls.push(["rankings", filters]); return { results: [{ username: "alice" }] }; }
  };
  const handler = createHandler({
    env: { ETORO_API_KEY: "test-app-key", ETORO_USER_KEY: "test-user-key" },
    createClient: options => {
      factoryCalls++;
      assert.equal(options.apiKey, "test-app-key");
      assert.equal(options.userKey, "test-user-key");
      return client;
    }
  });

  let res = response();
  await handler({ method: "POST", query: { action: "search", q: "BTC" } }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(factoryCalls, 0, "non-GET requests must not instantiate the client");

  const missing = createHandler({ env: {}, createClient: () => { throw new Error("must not create client"); } });
  res = response();
  await missing({ method: "GET", query: { action: "search", q: "BTC" } }, res);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.configured, false);

  res = response();
  await handler({ method: "GET", query: { action: "search", q: "BTC" } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.data.items[0].instrumentId, 1001);

  res = response();
  await handler({ method: "GET", query: { action: "rates", instrumentIds: "1001" } }, res);
  assert.equal(res.body.data[0].quoteType, "realtime");
  assert.match(res.headers["Cache-Control"], /no-store/);

  res = response();
  await handler({ method: "GET", query: { action: "feed", instrumentId: "1001", take: "10" } }, res);
  assert.equal(res.body.data.posts[0].id, "post-1");
  assert.match(res.headers["Cache-Control"], /s-maxage=30/);

  res = response();
  await handler({ method: "GET", query: { action: "profiles", usernames: "alice" } }, res);
  assert.equal(res.body.data[0].username, "alice");

  res = response();
  await handler({ method: "GET", query: { action: "copiers", username: "alice" } }, res);
  assert.equal(res.body.data.copiers, 123);

  res = response();
  await handler({ method: "GET", query: { action: "rankings", period: "CurrYear", page: "1", pageSize: "10", popularInvestor: "true" } }, res);
  assert.equal(res.body.data.results[0].username, "alice");
  assert.equal(calls.find(call => call[0] === "rankings")[1].popularInvestor, true);
  assert.ok(calls.every(call => !["POST", "PUT", "PATCH", "DELETE"].includes(call[0])), "no execution method exists in the API surface");

  res = response();
  await handler({ method: "GET", query: { action: "rates", instrumentIds: "1,nope" } }, res);
  assert.equal(res.statusCode, 400);

  res = response();
  await handler({ method: "GET", query: { action: "rankings", page: "zero" } }, res);
  assert.equal(res.statusCode, 400);

  res = response();
  await handler({ method: "GET", query: { action: "copiers", username: "../orders" } }, res);
  assert.equal(res.statusCode, 400);

  res = response();
  await handler({ method: "GET", query: { action: "unknown" } }, res);
  assert.equal(res.statusCode, 400);

  const limited = createHandler({
    env: { ETORO_API_KEY: "test", ETORO_USER_KEY: "test" },
    createClient: () => ({ searchInstruments: async () => { throw new Error("eToro API rate limit reached (429). Retry with backoff."); } })
  });
  res = response();
  await limited({ method: "GET", query: { action: "search", q: "BTC" } }, res);
  assert.equal(res.statusCode, 429);

  const denied = createHandler({
    env: { ETORO_API_KEY: "test", ETORO_USER_KEY: "test" },
    createClient: () => ({ searchInstruments: async () => { throw new Error("eToro API request failed with HTTP 403."); } })
  });
  res = response();
  await denied({ method: "GET", query: { action: "search", q: "BTC" } }, res);
  assert.equal(res.statusCode, 502);
  assert.equal(JSON.stringify(res.body).includes("test"), false, "credential values must never appear in proxy errors");

  const html = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
  const panelScript = fs.readFileSync(path.join(__dirname, "../public/etoro-panel.js"), "utf8");
  assert.ok(html.includes('id="etoroPanel"') && html.includes('src="/etoro-panel.js"'), "dashboard must load the separate eToro panel");
  assert.ok(!panelScript.includes("ETORO_API_KEY") && !panelScript.includes("ETORO_USER_KEY"), "browser code must never contain server credentials");
  assert.ok(!panelScript.includes("innerHTML"), "provider data must be rendered as text, not injected HTML");

  console.log("eToro read-only API proxy tests passed: GET-only routes, secret isolation, public data validation and no execution surface.");
})().catch(error => { console.error(error); process.exitCode = 1; });
