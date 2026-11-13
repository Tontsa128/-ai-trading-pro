"use strict";

const { createEtoroClient } = require("../scripts/etoro-market-feed");

function one(value) {
  if (Array.isArray(value)) return value.length === 1 ? String(value[0]) : "";
  return value == null ? "" : String(value);
}

function positiveInteger(value, max) {
  const text = one(value);
  if (!/^\d+$/.test(text)) return null;
  const number = Number(text);
  return Number.isSafeInteger(number) && number > 0 && number <= max ? number : null;
}

function createHandler(options = {}) {
  const env = options.env || process.env;
  const clientFactory = options.createClient || createEtoroClient;

  return async function etoroProxy(req, res) {
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, proxy-revalidate, max-age=0");
    res.setHeader("Pragma", "no-cache");
    res.setHeader("Expires", "0");
    res.setHeader("X-Content-Type-Options", "nosniff");

    if (!req || req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ error: "Only GET is supported." });
    }

    const apiKey = env.ETORO_API_KEY;
    const userKey = env.ETORO_USER_KEY;
    if (!apiKey || !userKey) {
      return res.status(503).json({
        configured: false,
        error: "eToro read-only credentials are not configured on the server."
      });
    }

    const query = req.query || {};
    const action = one(query.action);
    let client;
    try {
      client = clientFactory({ apiKey, userKey });
      let data;

      if (action === "search") {
        const q = one(query.q).trim();
        if (!q || q.length > 80) return res.status(400).json({ error: "A valid instrument search query is required." });
        data = await client.searchInstruments(q);
      } else if (action === "rates") {
        const raw = one(query.instrumentIds);
        const ids = raw.split(",").map(value => positiveInteger(value, Number.MAX_SAFE_INTEGER));
        if (!raw || !ids.length || ids.length > 1000 || ids.some(id => id === null)) {
          return res.status(400).json({ error: "One to one thousand valid instrument IDs are required." });
        }
        data = await client.getLiveBidAskRates(ids);
      } else if (action === "feed") {
        const instrumentId = positiveInteger(query.instrumentId, Number.MAX_SAFE_INTEGER);
        const take = query.take == null ? 20 : positiveInteger(query.take, 100);
        if (!instrumentId || !take) return res.status(400).json({ error: "A valid instrument ID and feed limit are required." });
        const type = query.type == null ? undefined : one(query.type);
        if (type !== undefined && !/^[A-Za-z_]{1,40}$/.test(type)) return res.status(400).json({ error: "Invalid social feed type." });
        data = await client.getMarketFeed(instrumentId, take, type);
      } else if (action === "profiles") {
        const usernames = one(query.usernames).split(",").map(name => name.trim()).filter(Boolean);
        if (!usernames.length || usernames.length > 20 ||
            usernames.some(name => !/^[A-Za-z0-9_.-]{1,50}$/.test(name))) {
          return res.status(400).json({ error: "One to twenty valid public usernames are required." });
        }
        data = await client.getUserProfiles(usernames);
      } else if (action === "copiers") {
        const username = one(query.username).trim();
        if (!/^[A-Za-z0-9_.-]{1,50}$/.test(username)) return res.status(400).json({ error: "A valid public investor username is required." });
        data = await client.getInvestorCopierStats(username);
      } else if (action === "rankings") {
        const filters = {};
        for (const key of ["period", "sort", "country", "gainMin", "gainMax", "copiersMin", "copiersMax",
          "riskScoreMin", "riskScoreMax", "aumTier", "page", "pageSize"]) {
          if (query[key] !== undefined) filters[key] = one(query[key]);
        }
        if (query.popularInvestor !== undefined) {
          const value = one(query.popularInvestor);
          if (value !== "true" && value !== "false") return res.status(400).json({ error: "popularInvestor must be true or false." });
          filters.popularInvestor = value === "true";
        }
        if (filters.page !== undefined) {
          filters.page = positiveInteger(filters.page, 1000000);
          if (filters.page === null) return res.status(400).json({ error: "Invalid ranking page." });
        }
        if (filters.pageSize !== undefined) {
          filters.pageSize = positiveInteger(filters.pageSize, 100);
          if (filters.pageSize === null) return res.status(400).json({ error: "Invalid ranking page size." });
        }
        if (filters.country !== undefined && !/^[A-Z]{2}$/.test(filters.country)) {
          return res.status(400).json({ error: "Ranking country must be an ISO alpha-2 code." });
        }
        for (const key of ["gainMin", "gainMax"]) {
          if (filters[key] !== undefined) {
            filters[key] = Number(filters[key]);
            if (!Number.isFinite(filters[key])) return res.status(400).json({ error: "Invalid ranking gain filter." });
          }
        }
        for (const key of ["copiersMin", "copiersMax", "riskScoreMin", "riskScoreMax", "aumTier"]) {
          if (filters[key] !== undefined) {
            filters[key] = Number(filters[key]);
            const min = key.startsWith("riskScore") ? 1 : 0;
            const max = key.startsWith("riskScore") ? 10 : Number.MAX_SAFE_INTEGER;
            if (!Number.isInteger(filters[key]) || filters[key] < min || filters[key] > max) {
              return res.status(400).json({ error: "Invalid ranking numeric filter: " + key });
            }
          }
        }
        if (filters.copiersMin !== undefined && filters.copiersMax !== undefined && filters.copiersMin > filters.copiersMax) {
          return res.status(400).json({ error: "Ranking copier minimum exceeds maximum." });
        }
        if (filters.gainMin !== undefined && filters.gainMax !== undefined && filters.gainMin > filters.gainMax) {
          return res.status(400).json({ error: "Ranking gain minimum exceeds maximum." });
        }
        data = await client.getInvestorRankings(filters);
      } else {
        return res.status(400).json({ error: "Unsupported eToro read-only action." });
      }

      return res.status(200).json({ source: "ETORO", action, data });
    } catch (error) {
      const message = String(error && error.message || "");
      const rateLimited = /rate limit|429/i.test(message);
      const denied = /HTTP (401|403)/.test(message);
      const status = rateLimited ? 429 : denied ? 502 : 502;
      return res.status(status).json({
        error: rateLimited
          ? "eToro rate limit reached. Retry after the provider's Retry-After window."
          : denied
            ? "eToro rejected the read-only credentials or the requested read scope."
            : "eToro read-only data request failed."
      });
    }
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.positiveInteger = positiveInteger;
