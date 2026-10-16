"use strict";

const WEBSOCKET_BASES = Object.freeze([
  "wss://data-stream.binance.vision:443",
  "wss://stream.binance.com:443",
  "wss://stream.binance.com:9443"
]);

function buildCombinedStreamUrl(base, symbols) {
  if (typeof base !== "string" || !/^wss:\/\//.test(base) || !Array.isArray(symbols) || symbols.length === 0) {
    throw new TypeError("A secure WebSocket base and at least one market symbol are required.");
  }
  const streams = symbols.flatMap(symbol => {
    if (typeof symbol !== "string" || !/^[A-Z0-9]{4,20}$/.test(symbol)) {
      throw new TypeError("Invalid WebSocket market symbol.");
    }
    const ticker = symbol.toLowerCase();
    return [ticker + "@trade", ticker + "@bookTicker"];
  });
  return base.replace(/\/+$/, "") + "/stream?streams=" + streams.join("/");
}

function parseBinanceMessage(raw) {
  let text;
  if (typeof raw === "string") text = raw;
  else if (Buffer.isBuffer(raw)) text = raw.toString("utf8");
  else if (raw instanceof ArrayBuffer) text = Buffer.from(raw).toString("utf8");
  else if (raw && typeof raw.text === "function") return null; // Browser Blob is not used by the Node worker.
  else text = String(raw);
  let envelope;
  try { envelope = JSON.parse(text); } catch { return null; }
  const d = envelope && (envelope.data || envelope);
  if (!d || typeof d.s !== "string") return null;
  const symbol = d.s.toUpperCase();
  if (d.e === "trade" || (d.p != null && d.q != null && d.T != null)) {
    const price = Number(d.p), qty = Number(d.q), time = Number(d.T);
    if (price > 0 && qty >= 0 && Number.isFinite(time)) return { type: "trade", symbol, price, qty, time };
    return null;
  }
  if (d.b != null && d.a != null) {
    const bid = Number(d.b), ask = Number(d.a);
    if (bid > 0 && ask >= bid) return { type: "bookTicker", symbol, bid, ask };
  }
  return null;
}

function normalizeTickerQuote(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const price = Number(payload.lastPrice);
  const bid = Number(payload.bidPrice);
  const ask = Number(payload.askPrice);
  if (!(price > 0) || !(bid > 0) || !(ask >= bid)) return null;
  return { price, bid, ask };
}

// Reject unavailable, future-dated or stale top-of-book quotes before opening a position.
function isFreshQuote(lastQuoteAt, now = Date.now(), maxAgeMs = 5000) {
  return Number.isFinite(lastQuoteAt) &&
    Number.isFinite(now) &&
    Number.isFinite(maxAgeMs) &&
    maxAgeMs >= 0 &&
    lastQuoteAt <= now &&
    now - lastQuoteAt <= maxAgeMs;
}

module.exports = { parseBinanceMessage, normalizeTickerQuote, isFreshQuote, WEBSOCKET_BASES, buildCombinedStreamUrl };
