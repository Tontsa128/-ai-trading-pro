"use strict";

// Read-only eToro adapter. This module intentionally has no order/trading methods.
const API_BASE = "https://public-api.etoro.com/api/v1";
const WS_URL = "wss://ws.etoro.com/ws";
const DEFAULT_MAX_AGE_MS = 15000;
const FORBIDDEN_PATH = /(?:^|\\/)(?:trading\\/execution|orders?|positions\\/open)(?:\\/|$)/i;

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
      path.includes("..") || FORBIDDEN_PATH.test(path)) {
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
      !(bid > 0) || !(ask >= bid) || !(last > 0) || !Number.isFinite(timestamp) ||
      timestamp > now || now - timestamp > maxAgeMs) return null;
  return {
    source: "ETORO", instrumentId,
    symbol: String(row.symbol || ""), bid, ask, lastPrice: last,
    spreadPct: ((ask - bid) / ((ask + bid) / 2)) * 100,
    timestamp, receivedAt: now
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

  async function get(path, query = {}) {
    const endpoint = safePath(path);
    const url = new URL(baseUrl + endpoint);
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const response = await fetchImpl(url.toString(), { method: "GET", headers: makeHeaders(apiKey, userKey) });
    if (response.status === 429) {
      const retryAfter = response.headers && typeof response.headers.get === "function"
        ? response.headers.get("retry-after") : null;
      throw new Error("eToro API rate limit reached (429)." + (retryAfter ? " Retry-After: " + retryAfter + "." : " Retry with backoff."));
    }
    if (!response.ok) throw new Error("eToro API request failed with HTTP " + response.status + ".");
    return response.json();
  }

  return Object.freeze({
    async searchInstruments(query) {
      if (typeof query !== "string" || !query.trim()) throw new TypeError("Instrument search query is required.");
      return get("/market-data/search", { query: query.trim() });
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
    async getInstrumentFeed(instrumentId, take = 20) {
      if (!Number.isSafeInteger(Number(instrumentId)) || Number(instrumentId) <= 0 ||
          !Number.isInteger(take) || take < 1 || take > 100) throw new TypeError("Invalid social feed request.");
      const payload = await get("/feeds/markets/" + Number(instrumentId), { take });
      return Array.isArray(payload.posts) ? payload.posts : [];
    },
    async getReadOnly(path, query = {}) {
      return get(path, query);
    }
  });
}

// Local-only long Spot-style paper ledger. SELL can only close an existing BUY.
function createPaperLedger(options = {}) {
  const positions = new Map();
  const trades = [];
  const feeRate = Number(options.feeRate || 0);
  if (!Number.isFinite(feeRate) || feeRate < 0 || feeRate > 0.1) throw new RangeError("Invalid paper fee rate.");

  function open(signal, quote, units, at = Date.now()) {
    if (!signal || signal.action !== "BUY" || !quote || quote.source !== "ETORO" ||
        !(Number(quote.bid) > 0) || !(Number(quote.ask) >= Number(quote.bid)) ||
        !Number.isFinite(Number(units)) || Number(units) <= 0 || !Number.isFinite(at)) {
      throw new Error("Only BUY paper entries are allowed; a valid eToro quote and positive units are required.");
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
    if (!position || !quote || quote.source !== "ETORO" || !(Number(quote.bid) > 0) ||
        !(Number(quote.ask) >= Number(quote.bid)) || !Number.isFinite(at) || at < position.openedAt) {
      throw new Error("Invalid paper close; matching BUY position and valid eToro quote required.");
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

module.exports = { API_BASE, WS_URL, DEFAULT_MAX_AGE_MS, normalizeRate, normalizeCandle, createEtoroClient, createPaperLedger, safePath };
