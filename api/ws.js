"use strict";

/*
 * Vercel serverless functions cannot provide a durable WebSocket server.
 * This endpoint is therefore a capability/status endpoint, not a fake WS proxy.
 * The browser connects directly to Binance's public market stream.
 */
module.exports = function wsCapability(req, res) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "GET") return res.status(405).json({error:"Only GET is supported."});
  return res.status(200).json({
    websocket: true,
    provider: "Binance Spot",
    stream: "wss://stream.binance.com:9443/ws/<symbol>@bookTicker",
    purpose: "browser-direct live best bid/ask stream",
    note: "The API function does not proxy a WebSocket connection."
  });
};
