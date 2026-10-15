"use strict";

const SYMBOLS = new Set(["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"]);
const INTERVALS = new Set(["1m", "3m", "5m", "15m", "1h", "4h", "1d", "3d", "1w"]);
const SOURCES = [
  "https://data-api.binance.vision",
  "https://api.binance.com",
  "https://api1.binance.com"
];
const ENDPOINTS = {
  klines: "/api/v3/klines",
  ticker24hr: "/api/v3/ticker/24hr",
  bookTicker: "/api/v3/ticker/bookTicker"
};

function one(value) {
  if (Array.isArray(value)) return value.length === 1 ? String(value[0]) : "";
  return value == null ? "" : String(value);
}

function integer(value, min, max) {
  if (value === "") return null;
  if (!/^\d+$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
}

module.exports = async function marketProxy(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=1, s-maxage=3, stale-while-revalidate=5");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    return res.status(405).json({ error: "Only GET is supported." });
  }

  const endpoint = one(req.query && req.query.endpoint);
  if (!Object.prototype.hasOwnProperty.call(ENDPOINTS, endpoint)) {
    return res.status(400).json({ error: "Unsupported market-data endpoint." });
  }

  const symbol = one(req.query && req.query.symbol);
  if (!SYMBOLS.has(symbol)) {
    return res.status(400).json({ error: "Unsupported trading pair." });
  }

  const params = new URLSearchParams();
  params.set("symbol", symbol);
  if (endpoint === "klines") {
    const interval = one(req.query && req.query.interval);
    const limitText = one(req.query && req.query.limit);
    const endTimeText = one(req.query && req.query.endTime);
    const limit = integer(limitText || "500", 1, 1000);
    if (!INTERVALS.has(interval) || limit === null) {
      return res.status(400).json({ error: "Invalid interval or candle limit." });
    }
    params.set("interval", interval);
    params.set("limit", String(limit));
    if (endTimeText) {
      const endTime = integer(endTimeText, 1, Date.now() + 60000);
      if (endTime === null) return res.status(400).json({ error: "Invalid endTime." });
      params.set("endTime", String(endTime));
    }
  }

  let lastError = "No Binance data source responded.";
  let lastStatus = 502;
  for (const origin of SOURCES) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 7000);
    try {
      const url = origin + ENDPOINTS[endpoint] + "?" + params.toString();
      const response = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json" },
        signal: controller.signal
      });
      clearTimeout(timeout);
      if (response.ok) {
        const payload = await response.json();
        if ((endpoint === "klines" && !Array.isArray(payload)) ||
            (endpoint !== "klines" && (!payload || typeof payload !== "object" || Array.isArray(payload)))) {
          lastError = "Binance returned an unexpected response shape.";
          lastStatus = 502;
          continue;
        }
        res.setHeader("X-Market-Data-Source", new URL(origin).hostname);
        return res.status(200).json(payload);
      }
      lastStatus = response.status === 418 || response.status === 429 ? 429 : 502;
      lastError = "Binance source returned HTTP " + response.status + ".";
    } catch (error) {
      clearTimeout(timeout);
      lastStatus = 502;
      lastError = error && error.name === "AbortError"
        ? "Binance data request timed out."
        : "Unable to reach the Binance public market-data source.";
    }
  }

  res.setHeader("Cache-Control", "no-store");
  return res.status(lastStatus).json({ error: lastError });
};
