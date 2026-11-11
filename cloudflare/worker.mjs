"use strict";

const MARKET_API_ORIGIN = "https://ai-trading-pro-azure.vercel.app";

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Keep the market-data API on the existing, validated Vercel function.
    // This Worker only proxies the fixed same-origin market route; it never
    // accepts an arbitrary upstream URL from a request parameter.
    if (url.pathname === "/api/market") {
      if (request.method !== "GET") {
        return new Response(JSON.stringify({ error: "Method not allowed" }), {
          status: 405,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store"
          }
        });
      }

      const upstreamUrl = new URL("/api/market", MARKET_API_ORIGIN);
      upstreamUrl.search = url.search;
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.set("accept", "application/json");

      try {
        const upstream = await fetch(new Request(upstreamUrl, {
          method: "GET",
          headers,
          redirect: "error"
        }));
        const responseHeaders = new Headers(upstream.headers);
        responseHeaders.set("cache-control", "no-store, max-age=0");
        responseHeaders.delete("set-cookie");
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: responseHeaders
        });
      } catch {
        return new Response(JSON.stringify({ error: "Market data upstream unavailable" }), {
          status: 502,
          headers: {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store"
          }
        });
      }
    }

    return env.ASSETS.fetch(request);
  }
};
