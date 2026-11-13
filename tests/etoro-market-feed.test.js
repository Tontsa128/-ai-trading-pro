"use strict";
const assert = require("node:assert/strict");
const { normalizeRate, normalizeCandle, createEtoroClient, createPaperLedger, WS_URL, safePath, createWebSocketAuthMessage, createWebSocketSubscribeMessage, createWebSocketUnsubscribeMessage, parseWebSocketMessage, parseWebSocketRateUpdates } = require("../scripts/etoro-market-feed");

const now = Date.parse("2026-11-13T10:00:00Z");
const validRate = { instrumentId: 1001, symbol: "BTC", bid: 99, ask: 101, lastPrice: 100, timestamp: new Date(now - 1000).toISOString() };
assert.equal(normalizeRate(validRate, now).source, "ETORO");
assert.equal(normalizeRate({ ...validRate, bid: 0 }, now), null);
assert.equal(normalizeRate({ ...validRate, bid: Infinity, ask: Infinity }, now), null);
assert.equal(normalizeRate({ ...validRate, instrumentId: 0 }, now), null);
assert.equal(normalizeRate({ ...validRate, timestamp: new Date(now + 1).toISOString() }, now), null);
assert.equal(normalizeRate({ ...validRate, timestamp: new Date(now - 20000).toISOString() }, now), null);
assert.equal(normalizeCandle({ timestamp: new Date(now - 60000).toISOString(), open: 10, high: 12, low: 9, close: 11 }, now).closed, true);
assert.equal(normalizeCandle({ timestamp: new Date(now + 1).toISOString(), open: 10, high: 12, low: 9, close: 11 }, now), null);
assert.equal(normalizeCandle({ timestamp: new Date(now - 60000).toISOString(), open: 10, high: 8, low: 9, close: 11 }, now), null);
assert.throws(() => safePath("/api/v2/trading/execution/orders"), /read-only/);
assert.throws(() => safePath("/../secrets"), /read-only/);
assert.throws(() => safePath("/%2e%2e/secrets"), /read-only/);
assert.throws(() => safePath("/%2f%2fevil.example/path"), /read-only/);
assert.throws(() => safePath("/%252e%252e/secrets"), /read-only/);
assert.throws(() => safePath("/\\\\evil.example/path"), /read-only/);
assert.throws(() => createEtoroClient({ apiKey: "api", userKey: "user", baseUrl: "https://attacker.example" }), /official HTTPS API host/);
assert.equal(WS_URL, "wss://ws.etoro.com/ws");
const authMessage = createWebSocketAuthMessage("api", "user");
assert.match(authMessage.id, /^[0-9a-f-]{36}$/i);
assert.deepEqual({ operation: authMessage.operation, data: authMessage.data }, {
  operation: "Authenticate", data: { userKey: "user", apiKey: "api" }
});
const subscribeMessage = createWebSocketSubscribeMessage([1001, 1002, 1001]);
assert.match(subscribeMessage.id, /^[0-9a-f-]{36}$/i);
assert.deepEqual({ operation: subscribeMessage.operation, data: subscribeMessage.data }, {
  operation: "Subscribe", data: { topics: ["instrument:1001", "instrument:1002"], snapshot: false }
});
const unsubscribeMessage = createWebSocketUnsubscribeMessage([1001]);
assert.match(unsubscribeMessage.id, /^[0-9a-f-]{36}$/i);
assert.deepEqual(unsubscribeMessage.data.topics, ["instrument:1001"]);
assert.equal(parseWebSocketMessage("{bad json"), null);
assert.deepEqual(parseWebSocketMessage(Buffer.from('{"operation":"Test"}')), { operation: "Test" });
const ratePush = { messages: [
  { topic: "instrument:1001", type: "Trading.Instrument.Rate", id: "rate-1",
    content: JSON.stringify({ Ask: "101", Bid: "99", LastExecution: "100", Date: new Date(now - 1000).toISOString(), PriceRateID: "123" }) },
  { topic: "instrument:1002", type: "Trading.Instrument.Rate", id: "rate-2",
    content: JSON.stringify({ Ask: "201", Bid: "199", LastExecution: "200", Date: new Date(now - 20000).toISOString(), PriceRateID: "124" }) },
  { topic: "instrument:1003", type: "Trading.Instrument.MarketStatus", id: "status-1", content: "{}" },
  { topic: "instrument:1004", type: "Trading.Instrument.Rate", id: "bad-1", content: "{bad json" }
] };
const parsedRates = parseWebSocketRateUpdates(ratePush, now, 15000);
assert.equal(parsedRates.length, 1, "only fresh, valid rate messages are emitted");
assert.equal(parsedRates[0].instrumentId, 1001);
assert.equal(parsedRates[0].bid, 99);
assert.equal(parsedRates[0].ask, 101);
assert.equal(parsedRates[0].lastPrice, 100);
assert.equal(parsedRates[0].priceRateId, "123");
assert.equal(parseWebSocketRateUpdates({ messages: [{ topic: "private", type: "Trading.Instrument.Rate", content: "{}" }] }, now).length, 0);
assert.throws(() => createWebSocketSubscribeMessage([0]), /instrument IDs/);

const calls = [];
const client = createEtoroClient({
  apiKey: "public-test-key", userKey: "user-test-key", baseUrl: "https://api.test/v1",
  fetch: async (url, init) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => ({ rates: [validRate] }) };
  }
});
(async () => {
  const rates = await client.getRates([1001], now);
  assert.equal(rates.length, 1);
  assert.equal(rates[0].spreadPct, 2);
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers["x-api-key"], "public-test-key");
  assert.ok(calls[0].init.headers["x-request-id"]);
  assert.equal(calls[0].url, "https://api.test/v1/market-data/instruments/rates?instrumentIds=1001");
  await assert.rejects(() => client.getRates([0], now), /instrument IDs/);

  const socialCalls = [];
  const socialClient = createEtoroClient({
    apiKey: "public-test-key", userKey: "user-test-key", baseUrl: "https://api.test/api/v1",
    fetch: async (url, init) => {
      socialCalls.push({ url, init });
      const parsed = new URL(url);
      let payload = {};
      if (parsed.pathname === "/api/v1/user-info/people") payload = { users: [{ username: "alice", isPi: true }] };
      else if (parsed.pathname === "/api/v1/user-info/people/search") payload = { totalItems: 1, items: [{ userName: "alice", copiers: 123, riskScore: 4 }] };
      else if (parsed.pathname === "/api/v1/feeds/markets/1001") payload = { posts: [{ postId: "p1" }], hasMore: true };
      else if (parsed.pathname === "/api/v1/feeds/users/123") payload = { items: [{ postId: "p2" }] };
      else if (parsed.pathname === "/api/v2/portfolios/rankings") payload = { results: [{ username: "alice", gain: 0.12, copiers: 123 }], pagination: { page: 1, hasNext: false } };
      else if (parsed.pathname === "/api/v2/portfolios/alice/copiers") payload = { copiers: 123, aumTier: 3, aumTierDesc: "Gold" };
      return { ok: true, status: 200, json: async () => payload };
    }
  });
  const profiles = await socialClient.getUserProfiles(["alice", "bob"]);
  assert.equal(profiles[0].isPi, true);
  assert.equal(new URL(socialCalls[0].url).searchParams.get("usernames"), "alice,bob");
  const foundUsers = await socialClient.searchUsers({ page: 2, pageSize: 10, popularInvestor: true });
  assert.equal(foundUsers.totalItems, 1);
  assert.equal(foundUsers.items[0].copiers, 123);
  const marketPosts = await socialClient.getInstrumentFeed(1001, 10);
  assert.equal(marketPosts[0].postId, "p1");
  const userFeed = await socialClient.getUserFeed(123, 10);
  assert.equal(userFeed.items[0].postId, "p2");
  const rankings = await socialClient.getInvestorRankings({ period: "CurrYear", sort: "-copiers", pageSize: 5, popularInvestor: true });
  assert.equal(rankings.results[0].username, "alice");
  assert.equal(new URL(socialCalls.find(c => new URL(c.url).pathname === "/api/v2/portfolios/rankings").url).pathname, "/api/v2/portfolios/rankings");
  const copierStats = await socialClient.getInvestorCopierStats("alice");
  assert.equal(copierStats.copiers, 123);
  assert.equal(copierStats.aumTierDesc, "Gold");
  assert.ok(socialCalls.every(call => call.init.method === "GET"), "social and CopyTrader analytics must stay read-only");
  await assert.rejects(() => socialClient.getInvestorCopierStats("../orders"), /username/);
  await assert.rejects(() => socialClient.getInvestorRankings({ period: "not-a-period" }), /period/);
  await assert.rejects(() => socialClient.searchUsers({ period: "AbsOneYear" }), /period/);
  await assert.rejects(() => socialClient.getInvestorRankings({ country: "USA" }), /ISO alpha-2/);
  await assert.rejects(() => socialClient.getInvestorRankings({ riskScoreMin: 11 }), /risk-score/);
  await assert.rejects(() => socialClient.searchUsers({ maxDailyRiskScoreMin: 11 }), /risk-score/);
  const ledger = createPaperLedger({ feeRate: 0.001 });
  const quote = { source: "ETORO", instrumentId: 1001, bid: 99, ask: 101, timestamp: now - 500 };
  const opened = ledger.open({ action: "BUY", instrumentId: 1001 }, quote, 2, now);
  assert.equal(opened.entryPrice, 101, "BUY enters at ask");
  assert.throws(() => ledger.open({ action: "SELL", instrumentId: 1002 }, quote, 2, now), /Only BUY/);
  assert.throws(() => ledger.open({ action: "BUY", instrumentId: 1002 }, quote, 2, now), /fresh, valid/);
  const closed = ledger.close(1001, { source: "ETORO", instrumentId: 1001, bid: 103, ask: 104, timestamp: now + 500 }, now + 1000);
  assert.equal(closed.exitPrice, 103, "BUY exits at bid");
  assert.ok(closed.netPnl < closed.grossPnl, "fees reduce paper PnL");
  assert.equal(ledger.snapshot().openPositions.length, 0);
  assert.equal(ledger.snapshot().closedTrades.length, 1);
  assert.equal(ledger.snapshot().execution, "LOCAL_PAPER_ONLY");
  await assert.rejects(async () => client.getReadOnly("/api/v2/trading/execution/orders"), /read-only/);
  console.log("eToro read-only adapter tests passed: quote/candle validation, auth headers, endpoint safety, and long-only local paper fills/fees.");
})().catch(error => { console.error(error); process.exitCode = 1; });
