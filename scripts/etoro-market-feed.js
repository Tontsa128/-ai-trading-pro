"use strict";

// Read-only eToro adapter. This module intentionally has no order/trading methods.
const API_BASE = "https://public-api.etoro.com/api/v1";
const WS_URL = "wss://ws.etoro.com/ws";
const DEFAULT_MAX_AGE_MS = 15000;
const FORBIDDEN_PATH = /(?:^|\/)(?:trading\/execution|orders?|positions\/open)(?:\/|$)/i;

function requestId() {
  return require("node:crypto").randomUUID();
}

function makeHeaders(apiKey, userKey) {
  if (!apiKey || !userKey) throw new Error("eToro API credentials are not configured.");
  return {
    "x-api-key": apiKey,
    "x-user-key": userKey,
    "x-request-id": requestId(),
    Accept: "application/json"
  };
}

function safePath(path) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") ||
      path.includes("\\") || /%(?:25|2e|2f|5c)/i.test(path) ||
      path.split("/").some(segment => segment === "." || segment === "..") ||
      FORBIDDEN_PATH.test(path)) {
    throw new TypeError("Only approved read-only eToro API paths are allowed.");
  }
  return path;
}

function normalizeRate(row, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (!row || typeof row !== "object") return null;
  const bid = Number(row.bid), ask = Number(row.ask), last = Number(row.lastPrice);
  const timestamp = Date.parse(row.timestamp);
  const instrumentId = Number(row.instrumentId);
  if (!Number.isSafeInteger(instrumentId) || instrumentId <= 0 ||
      ![bid, ask, last].every(Number.isFinite) || !(bid > 0) || !(ask >= bid) || !(last > 0) || !Number.isFinite(timestamp) ||
      timestamp > now || now - timestamp > maxAgeMs) return null;
  return {
    source: "ETORO", instrumentId,
    symbol: String(row.symbol || ""), bid, ask, lastPrice: last,
    spreadPct: ((ask - bid) / ((ask + bid) / 2)) * 100,
    timestamp, receivedAt: now
  };
}

function normalizeBidAskRate(row, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS) {
  if (!row || typeof row !== "object" || row.quoteType !== "realtime" ||
      !Number.isFinite(now) || !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return null;
  const instrumentId = Number(row.instrumentId);
  const bid = Number(row.bid), ask = Number(row.ask);
  const timestamp = Date.parse(row.date);
  if (!Number.isSafeInteger(instrumentId) || instrumentId <= 0 ||
      !Number.isFinite(bid) || !Number.isFinite(ask) || !(bid > 0) || !(ask >= bid) ||
      !Number.isFinite(timestamp) || timestamp > now || now - timestamp > maxAgeMs) return null;
  const midPrice = (bid + ask) / 2;
  return {
    source: "ETORO", instrumentId, bid, ask,
    lastPrice: null, midPrice, spread: ask - bid,
    spreadPct: ((ask - bid) / midPrice) * 100,
    timestamp, receivedAt: now, quoteType: "realtime"
  };
}

function normalizeCandle(row, now = Date.now()) {
  if (!row || typeof row !== "object") return null;
  const time = Date.parse(row.timestamp || row.time);
  const open = Number(row.open), high = Number(row.high);
  const low = Number(row.low), close = Number(row.close);
  const volume = row.volume == null ? null : Number(row.volume);
  if (!Number.isFinite(time) || time >= now || ![open, high, low, close].every(Number.isFinite) ||
      Math.min(open, high, low, close) <= 0 ||
      high < Math.max(open, close, low) || low > Math.min(open, close) ||
      (volume !== null && (!Number.isFinite(volume) || volume < 0))) return null;
  return { source: "ETORO", openTime: time, closeTime: time, open, high, low, close, volume, closed: true };
}

function createEtoroClient(options = {}) {
  const apiKey = options.apiKey || process.env.ETORO_API_KEY;
  const userKey = options.userKey || process.env.ETORO_USER_KEY;
  const fetchImpl = options.fetch || globalThis.fetch;
  const baseUrl = options.baseUrl || API_BASE;
  const maxAgeMs = options.maxAgeMs == null ? DEFAULT_MAX_AGE_MS : options.maxAgeMs;
  if (typeof fetchImpl !== "function") throw new Error("A Fetch-compatible HTTP client is required.");
  const parsedBaseUrl = new URL(baseUrl);
  if (parsedBaseUrl.protocol !== "https:" ||
      (parsedBaseUrl.hostname !== "public-api.etoro.com" && typeof options.fetch !== "function")) {
    throw new Error("eToro credentials may only be sent to the official HTTPS API host.");
  }

  async function requestJson(url) {
    const response = await fetchImpl(url.toString(), { method: "GET", headers: makeHeaders(apiKey, userKey) });
    if (response.status === 429) {
      const retryAfter = response.headers && typeof response.headers.get === "function"
        ? response.headers.get("retry-after") : null;
      throw new Error("eToro API rate limit reached (429)." + (retryAfter ? " Retry-After: " + retryAfter + "." : " Retry with backoff."));
    }
    if (!response.ok) throw new Error("eToro API request failed with HTTP " + response.status + ".");
    return response.json();
  }

  async function get(path, query = {}) {
    const endpoint = safePath(path);
    const url = new URL(baseUrl + endpoint);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return requestJson(url);
  }

  async function getV2(path, query = {}) {
    const endpoint = safePath(path);
    if (!/^\/api\/v2\/(?:market-data\/rates|portfolios\/(?:rankings|[A-Za-z0-9_.-]{1,50}\/copiers))$/.test(endpoint)) {
      throw new TypeError("Only documented read-only eToro v2 paths are allowed.");
    }
    const url = new URL(endpoint, parsedBaseUrl.origin);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    return requestJson(url);
  }

  const rankingPeriods = new Set([
    "CurrMonth", "OneMonthAgo", "TwoMonthsAgo", "CurrQuarter", "ThreeMonthsAgo",
    "SixMonthsAgo", "CurrYear", "OneYearAgo", "LastYear", "LastTwoYears",
    "AbsOneYear", "AbsTwoYears"
  ]);
  const userSearchPeriods = new Set([
    "CurrMonth", "CurrQuarter", "CurrYear", "LastYear", "LastTwoYears",
    "OneMonthAgo", "TwoMonthsAgo", "ThreeMonthsAgo", "SixMonthsAgo", "OneYearAgo"
  ]);

  async function fetchMarketFeed(instrumentId, take = 20, type) {
    if (!Number.isSafeInteger(Number(instrumentId)) || Number(instrumentId) <= 0 ||
        !Number.isInteger(take) || take < 1 || take > 100 ||
        (type !== undefined && (typeof type !== "string" || !/^[A-Za-z_]{1,40}$/.test(type)))) {
      throw new TypeError("Invalid social feed request.");
    }
    return get("/feeds/markets/" + Number(instrumentId), { take, type });
  }

  return Object.freeze({
    async searchInstruments(query, options = {}) {
      if (typeof query !== "string" || !query.trim() || !options || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Instrument search query is required.");
      const pageSize = options.pageSize == null ? 100 : Number(options.pageSize);
      const pageNumber = options.pageNumber == null ? 1 : Number(options.pageNumber);
      if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 100 || !Number.isInteger(pageNumber) || pageNumber < 1) throw new TypeError("Invalid instrument search pagination.");
      return get("/market-data/search", { fields: "instrumentId,internalSymbolFull,displayname,isCurrentlyTradable,isOpen,currentRate", internalSymbolFull: query.trim(), pageSize, pageNumber });
    },
    async getLiveBidAskRates(instrumentIds, now = Date.now()) {
      if (!Array.isArray(instrumentIds) || !instrumentIds.length || instrumentIds.length > 1000 ||
          instrumentIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
        throw new TypeError("One to one thousand valid eToro instrument IDs are required.");
      }
      const requestedIds = new Set(instrumentIds.map(Number));
      const payload = await getV2("/api/v2/market-data/rates", { instrumentIds: instrumentIds.join(",") });
      const rows = Array.isArray(payload.results) ? payload.results : [];
      return rows.map(row => normalizeBidAskRate(row, now, maxAgeMs))
        .filter(quote => quote && requestedIds.has(quote.instrumentId));
    },
    async getRates(instrumentIds, now = Date.now()) {
      if (!Array.isArray(instrumentIds) || !instrumentIds.length ||
          instrumentIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
        throw new TypeError("One or more valid eToro instrument IDs are required.");
      }
      const payload = await get("/market-data/instruments/rates", { instrumentIds: instrumentIds.join(",") });
      const rows = Array.isArray(payload.rates) ? payload.rates : [];
      return rows.map(row => normalizeRate(row, now, maxAgeMs)).filter(Boolean);
    },
    async getCandles(instrumentId, direction, interval, count, now = Date.now()) {
      if (!Number.isSafeInteger(Number(instrumentId)) || Number(instrumentId) <= 0 ||
          !["asc", "desc"].includes(direction) || !/^(?:OneMinute|FiveMinutes|FifteenMinutes|OneHour|OneDay)$/i.test(interval) ||
          !Number.isInteger(count) || count < 1 || count > 500) {
        throw new TypeError("Invalid eToro candle request.");
      }
      const path = "/market-data/instruments/" + Number(instrumentId) +
        "/history/candles/" + direction + "/" + interval + "/" + count;
      const payload = await get(path);
      const rows = Array.isArray(payload) ? payload : (payload.candles || payload.items || []);
      return rows.map(row => normalizeCandle(row, now)).filter(Boolean).sort((a, b) => a.openTime - b.openTime);
    },
    async getMarketFeed(instrumentId, take = 20, type) {
      return fetchMarketFeed(instrumentId, take, type);
    },
    async getInstrumentFeed(instrumentId, take = 20) {
      const payload = await fetchMarketFeed(instrumentId, take);
      return Array.isArray(payload.posts) ? payload.posts : (Array.isArray(payload.items) ? payload.items : []);
    },
    async getUserFeed(userId, take = 20) {
      if (!Number.isSafeInteger(Number(userId)) || Number(userId) <= 0 ||
          !Number.isInteger(take) || take < 1 || take > 100) throw new TypeError("Invalid user feed request.");
      return get("/feeds/users/" + Number(userId), { take });
    },
    async getUserProfiles(usernames) {
      if (!Array.isArray(usernames) || usernames.length < 1 || usernames.length > 20 ||
          usernames.some(name => typeof name !== "string" || !name.trim() || name.length > 50 || name.includes(","))) {
        throw new TypeError("One to twenty valid public eToro usernames are required.");
      }
      const payload = await get("/user-info/people", { usernames: usernames.map(name => name.trim()).join(",") });
      return Array.isArray(payload.users) ? payload.users : [];
    },
    async searchUsers(filters = {}) {
      if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw new TypeError("User search filters must be an object.");
      const query = { ...filters, period: filters.period || "CurrYear" };
      if (!userSearchPeriods.has(query.period)) throw new TypeError("Unsupported eToro user-search period.");
      if (query.page !== undefined && (!Number.isInteger(query.page) || query.page < 1)) throw new TypeError("Invalid user-search page.");
      if (query.pageSize !== undefined && (!Number.isInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 100)) throw new TypeError("Invalid user-search page size.");
      for (const key of ["isTestAccount", "optIn", "blocked", "popularInvestor"]) {
        if (query[key] !== undefined && typeof query[key] !== "boolean") throw new TypeError("Invalid boolean user-search filter: " + key);
      }
      const allowed = new Set(["period", "isTestAccount", "optIn", "blocked", "page", "pageSize", "sort",
        "popularInvestor", "gainMax", "maxDailyRiskScoreMin", "maxDailyRiskScoreMax",
        "maxMonthlyRiskScoreMin", "maxMonthlyRiskScoreMax", "weeksSinceRegistrationMin",
        "countryId", "instrumentId", "instrumentPctMin", "instrumentPctMax"]);
      if (Object.keys(query).some(key => !allowed.has(key))) throw new TypeError("Unsupported eToro user-search filter.");
      for (const key of ["gainMax"]) {
        if (query[key] !== undefined && !Number.isFinite(Number(query[key]))) throw new TypeError("Invalid numeric user-search filter: " + key);
      }
      for (const key of ["maxDailyRiskScoreMin", "maxDailyRiskScoreMax", "maxMonthlyRiskScoreMin", "maxMonthlyRiskScoreMax"]) {
        if (query[key] !== undefined && (!Number.isInteger(Number(query[key])) || Number(query[key]) < 1 || Number(query[key]) > 10)) {
          throw new TypeError("Invalid risk-score user-search filter: " + key);
        }
      }
      for (const key of ["weeksSinceRegistrationMin", "countryId"]) {
        if (query[key] !== undefined && (!Number.isInteger(Number(query[key])) || Number(query[key]) < 0)) {
          throw new TypeError("Invalid integer user-search filter: " + key);
        }
      }
      for (const key of ["instrumentId"]) {
        if (query[key] !== undefined && (!Number.isSafeInteger(Number(query[key])) || Number(query[key]) === 0)) {
          throw new TypeError("Invalid instrument user-search filter.");
        }
      }
      for (const key of ["instrumentPctMin", "instrumentPctMax"]) {
        if (query[key] !== undefined && (!Number.isFinite(Number(query[key])) || Number(query[key]) < 0 || Number(query[key]) > 100)) {
          throw new TypeError("Invalid instrument percentage user-search filter.");
        }
      }
      const payload = await get("/user-info/people/search", query);
      return { totalItems: Number(payload.totalItems) || 0, items: Array.isArray(payload.items) ? payload.items : [] };
    },
    async getInvestorRankings(filters = {}) {
      if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw new TypeError("Ranking filters must be an object.");
      const query = { ...filters, period: filters.period || "CurrYear" };
      if (!rankingPeriods.has(query.period)) throw new TypeError("Unsupported eToro ranking period.");
      if (query.page !== undefined && (!Number.isInteger(query.page) || query.page < 1)) throw new TypeError("Invalid ranking page.");
      if (query.pageSize !== undefined && (!Number.isInteger(query.pageSize) || query.pageSize < 1 || query.pageSize > 100)) throw new TypeError("Invalid ranking page size.");
      if (query.sort !== undefined && (typeof query.sort !== "string" || !/^-?[A-Za-z][A-Za-z0-9]*$/.test(query.sort))) throw new TypeError("Invalid ranking sort field.");
      if (query.popularInvestor !== undefined && typeof query.popularInvestor !== "boolean") throw new TypeError("Invalid popularInvestor filter.");
      const allowed = new Set(["period", "sort", "page", "pageSize", "country", "gainMin", "gainMax",
        "copiersMin", "copiersMax", "riskScoreMin", "riskScoreMax", "popularInvestor", "aumTier"]);
      if (Object.keys(query).some(key => !allowed.has(key))) throw new TypeError("Unsupported eToro ranking filter.");
      if (query.country !== undefined && (typeof query.country !== "string" || !/^[A-Z]{2}$/.test(query.country))) {
        throw new TypeError("Ranking country must be an ISO alpha-2 code.");
      }
      for (const key of ["gainMin", "gainMax"]) {
        if (query[key] !== undefined && !Number.isFinite(Number(query[key]))) throw new TypeError("Invalid ranking gain filter: " + key);
      }
      for (const key of ["copiersMin", "copiersMax", "aumTier"]) {
        if (query[key] !== undefined && (!Number.isInteger(Number(query[key])) || Number(query[key]) < 0)) {
          throw new TypeError("Invalid ranking integer filter: " + key);
        }
      }
      for (const key of ["riskScoreMin", "riskScoreMax"]) {
        if (query[key] !== undefined && (!Number.isInteger(Number(query[key])) || Number(query[key]) < 1 || Number(query[key]) > 10)) {
          throw new TypeError("Invalid ranking risk-score filter: " + key);
        }
      }
      if (query.copiersMin !== undefined && query.copiersMax !== undefined && Number(query.copiersMin) > Number(query.copiersMax)) {
        throw new TypeError("Ranking copier minimum exceeds maximum.");
      }
      if (query.gainMin !== undefined && query.gainMax !== undefined && Number(query.gainMin) > Number(query.gainMax)) {
        throw new TypeError("Ranking gain minimum exceeds maximum.");
      }
      return getV2("/api/v2/portfolios/rankings", query);
    },
    async getInvestorCopierStats(username) {
      if (typeof username !== "string" || !/^[A-Za-z0-9_.-]{1,50}$/.test(username)) {
        throw new TypeError("A valid public eToro username is required.");
      }
      return getV2("/api/v2/portfolios/" + username + "/copiers");
    },
    async getReadOnly(path, query = {}) {
      return get(path, query);
    }
  });
}

// Official WebSocket protocol message builders. Transport lifecycle is intentionally separate.
function createWebSocketAuthMessage(apiKey, userKey) {
  if (!apiKey || !userKey) throw new Error("eToro WebSocket credentials are not configured.");
  return { id: requestId(), operation: "Authenticate", data: { userKey, apiKey } };
}

function createWebSocketSubscribeMessage(instrumentIds, snapshot = false) {
  if (!Array.isArray(instrumentIds) || !instrumentIds.length ||
      instrumentIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw new TypeError("Valid eToro instrument IDs are required for WebSocket subscription.");
  }
  return { id: requestId(), operation: "Subscribe", data: {
    topics: [...new Set(instrumentIds.map(id => "instrument:" + Number(id)))],
    snapshot: Boolean(snapshot)
  }};
}

function createWebSocketUnsubscribeMessage(instrumentIds) {
  if (!Array.isArray(instrumentIds) || !instrumentIds.length ||
      instrumentIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw new TypeError("Valid eToro instrument IDs are required for WebSocket unsubscription.");
  }
  return { id: requestId(), operation: "Unsubscribe", data: {
    topics: [...new Set(instrumentIds.map(id => "instrument:" + Number(id)))]
  }};
}

function parseWebSocketMessage(input) {
  let value = input;
  if (value && typeof value === "object" && value.data !== undefined && !Buffer.isBuffer(value)) value = value.data;
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { return null; }
  }
  return value && typeof value === "object" && !Array.isArray(value) ? value : null;
}

// eToro rate pushes are batched in { messages: [...] }; each message.content
// is itself a JSON string containing the Trading.Instrument.Rate fields.
function parseWebSocketRateUpdates(input, now = Date.now(), maxAgeMs = DEFAULT_MAX_AGE_MS) {
  const envelope = parseWebSocketMessage(input);
  if (!envelope || !Array.isArray(envelope.messages) || !Number.isFinite(now) ||
      !Number.isFinite(maxAgeMs) || maxAgeMs < 0) return [];
  const updates = [];
  for (const item of envelope.messages) {
    if (!item || item.type !== "Trading.Instrument.Rate" ||
        typeof item.topic !== "string" || typeof item.content !== "string") continue;
    const topicMatch = /^instrument:(\d+)$/.exec(item.topic);
    if (!topicMatch) continue;
    let content;
    try { content = JSON.parse(item.content); } catch { continue; }
    if (!content || typeof content !== "object" || Array.isArray(content)) continue;
    const quote = normalizeRate({
      instrumentId: Number(topicMatch[1]),
      symbol: "",
      bid: content.Bid,
      ask: content.Ask,
      lastPrice: content.LastExecution,
      timestamp: content.Date
    }, now, maxAgeMs);
    if (!quote) continue;
    updates.push({
      ...quote,
      priceRateId: typeof content.PriceRateID === "string" ? content.PriceRateID : null,
      topic: item.topic,
      messageId: typeof item.id === "string" ? item.id : null,
      messageType: item.type
    });
  }
  return updates;
}

// Local-only long Spot-style paper ledger. SELL can only close an existing BUY.
function createPaperLedger(options = {}) {
  const positions = new Map();
  const trades = [];
  const feeRate = Number(options.feeRate || 0);
  const maxQuoteAgeMs = options.maxQuoteAgeMs == null ? DEFAULT_MAX_AGE_MS : Number(options.maxQuoteAgeMs);
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > 0.1) throw new RangeError("Invalid paper fee rate.");
  if (!Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs < 0) throw new RangeError("Invalid paper quote age limit.");

  function validPaperQuote(quote, at, instrumentId) {
    const timestamp = quote && Number(quote.timestamp);
    return Boolean(quote && quote.source === "ETORO" &&
      Number(quote.instrumentId) === Number(instrumentId) &&
      Number.isFinite(Number(quote.bid)) && Number.isFinite(Number(quote.ask)) &&
      Number(quote.bid) > 0 && Number(quote.ask) >= Number(quote.bid) &&
      Number.isFinite(timestamp) && timestamp <= at && at - timestamp <= maxQuoteAgeMs);
  }

  const initial = options.initialSnapshot;
  if (initial !== undefined) {
    if (!initial || initial.execution !== "LOCAL_PAPER_ONLY" ||
        !Array.isArray(initial.openPositions) || !Array.isArray(initial.closedTrades)) {
      throw new TypeError("Invalid eToro paper ledger snapshot; refusing to restore.");
    }
    for (const p of initial.openPositions) {
      if (!p || !Number.isSafeInteger(Number(p.instrumentId)) || Number(p.instrumentId) <= 0 ||
          p.action !== "BUY" || !(Number(p.units) > 0) || !(Number(p.entryPrice) > 0) ||
          !Number.isFinite(Number(p.entryFee)) || Number(p.entryFee) < 0 ||
          !Number.isFinite(Number(p.openedAt)) || p.source !== "ETORO_PAPER") {
        throw new TypeError("Invalid open position in eToro paper snapshot.");
      }
      const key = String(p.instrumentId);
      if (positions.has(key)) throw new TypeError("Duplicate position in eToro paper snapshot.");
      positions.set(key, { ...p, instrumentId: key, units: Number(p.units), entryPrice: Number(p.entryPrice),
        entryFee: Number(p.entryFee), openedAt: Number(p.openedAt) });
    }
    for (const t of initial.closedTrades) {
      if (!t || !Number.isSafeInteger(Number(t.instrumentId)) || Number(t.instrumentId) <= 0 ||
          t.action !== "BUY" || t.status !== "CLOSED" || t.source !== "ETORO_PAPER" ||
          !(Number(t.units) > 0) || !(Number(t.entryPrice) > 0) || !(Number(t.exitPrice) > 0) ||
          !Number.isFinite(Number(t.openedAt)) || !Number.isFinite(Number(t.closedAt)) ||
          Number(t.closedAt) < Number(t.openedAt) || !Number.isFinite(Number(t.netPnl))) {
        throw new TypeError("Invalid closed trade in eToro paper snapshot.");
      }
      trades.push({ ...t });
    }
  }

  function open(signal, quote, units, at = Date.now()) {
    if (!signal || signal.action !== "BUY" || !Number.isFinite(at) ||
        !validPaperQuote(quote, at, signal.instrumentId) || !Number.isFinite(Number(units)) || Number(units) <= 0) {
      throw new Error("Only BUY paper entries with a fresh, valid eToro quote and positive units are allowed.");
    }
    const key = String(signal.instrumentId);
    if (!Number.isSafeInteger(Number(signal.instrumentId)) || Number(signal.instrumentId) <= 0) {
      throw new Error("A valid eToro instrument ID is required.");
    }
    if (positions.has(key)) throw new Error("A paper position already exists for this instrument.");
    const entry = Number(quote.ask);
    const notional = entry * Number(units);
    const position = { instrumentId: key, action: "BUY", units: Number(units), entryPrice: entry,
      entryFee: notional * feeRate, openedAt: at, source: "ETORO_PAPER" };
    positions.set(key, position);
    return { ...position };
  }

  function close(instrumentId, quote, at = Date.now()) {
    const key = String(instrumentId), position = positions.get(key);
    if (!position || !Number.isFinite(at) || at < position.openedAt || !validPaperQuote(quote, at, instrumentId)) {
      throw new Error("Invalid paper close; matching BUY position and fresh, valid eToro quote required.");
    }
    const exit = Number(quote.bid);
    const gross = (exit - position.entryPrice) * position.units;
    const exitFee = exit * position.units * feeRate;
    const trade = { ...position, exitPrice: exit, closedAt: at, exitFee,
      fees: position.entryFee + exitFee, grossPnl: gross, netPnl: gross - position.entryFee - exitFee,
      status: "CLOSED", source: "ETORO_PAPER" };
    positions.delete(key);
    trades.push(trade);
    return { ...trade };
  }

  return Object.freeze({
    open, close,
    snapshot() { return { openPositions: Array.from(positions.values()).map(p => ({ ...p })),
      closedTrades: trades.map(t => ({ ...t })), execution: "LOCAL_PAPER_ONLY" }; }
  });
}

module.exports = { API_BASE, WS_URL, DEFAULT_MAX_AGE_MS, normalizeRate, normalizeBidAskRate, normalizeCandle, createEtoroClient, createPaperLedger, safePath, createWebSocketAuthMessage, createWebSocketSubscribeMessage, createWebSocketUnsubscribeMessage, parseWebSocketMessage, parseWebSocketRateUpdates };
