"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const html = fs.readFileSync("public/index.html", "utf8");
const live = fs.readFileSync("public/live-dashboard.js", "utf8");

assert.match(html, /<select id="interval">[\s\S]*?<option selected>5m<\/option>/,
  "dashboard must open with the 5-minute analysis interval selected");
assert.match(html, /<option value="5" selected>5 sekuntia \(Binance REST\)<\/option>/,
  "real Binance REST refresh should be the default instead of claiming a WebSocket that is not connected");
assert.match(html, /<option value="0">Manuaalinen \(ei automaattista päivitystä\)<\/option>/,
  "manual mode must be labeled honestly");
assert.match(html, /<option value="5" selected>5 sekuntia \(Binance REST\)<\/option>/,
  "the selected automatic refresh must use real Binance REST data");
assert.match(live, /interval: "5m"/, "live chart defaults to 5m");
assert.match(live, /&limit=500/, "chart history must fetch enough real candles for the 500-candle option");
assert.match(live, /Math\.min\(500, Number\(countEl && countEl\.value\) \|\| 150\)/,
  "chart renderer must honor the visible 500-candle option");
assert.match(live, /setInterval\(loadChartBars, 30000\)/,
  "chart history must retry periodically after transient market-data failures");
assert.match(live, /var s = state\.symbol\.toLowerCase\(\), iv = state\.interval \|\| "5m"/,
  "WebSocket candle stream must follow the selected chart interval");
assert.match(live, /scores\[state\.interval\] \|\| scores\["5m"\] \|\| scores\["1m"\]/,
  "main signal must follow the selected interval when that timeframe is scored");
assert.match(live, /loadChartBars\(\)\.then\(function \(\) \{[\s\S]*?startWs\(\)/,
  "changing pair or interval must reload matching chart history before reconnecting");
assert.match(live, /var sourceBars = Array\.isArray\(state\.chartBars\) \? state\.chartBars : \[\]/,
  "the chart must render only candles for the selected interval, never silently fall back to 1m bars");
assert.match(live, /state\.chartBars = \[\];\s*state\.chartLive = null;\s*renderLiveChart\(\)/,
  "a failed selected-interval fetch must clear stale candles and show an error");
assert.match(live, /state\.chartBars = \[\]; state\.bars = \[\]/,
  "switching trading pairs must clear old-pair candles before loading new data");
assert.match(live, /async function getBars\(tf, requestedSymbol\)/,
  "candle requests must bind the requested symbol instead of reading mutable global state after a switch");
assert.match(live, /var symbol = state\.symbol;[\s\S]*?getBars\(interval, symbol\)[\s\S]*?symbol === state\.symbol && interval === state\.interval/,
  "chart history responses must be discarded if symbol or interval changed while the request was in flight");
assert.match(live, /async function refreshScalpScores\(\)[\s\S]*?var symbol = state\.symbol;[\s\S]*?if \(symbol !== state\.symbol\) return;[\s\S]*?getBars\(tf, symbol\)/,
  "scalp scores must not combine candles from different symbols during a switch");
assert.match(live, /async function refreshTicker\(\)[\s\S]*?var symbol = state\.symbol;[\s\S]*?if \(symbol === state\.symbol\) state\.tickerChange/,
  "late 24-hour ticker responses must not overwrite the newly selected symbol");
assert.match(live, /state\.symbol = symbolEl\.value; state\.tradePrice = null; state\.tickerChange = null;/,
  "switching pairs must clear the previous pair's 24-hour change until fresh ticker data arrives");
assert.match(live, /symbolEl\.addEventListener\("change", function \(\) \{\s*stopWs\(\)/,
  "switching symbols must stop the old stream before requesting new market data");
assert.match(live, /var socket = state\.ws;[\s\S]*?socket\.onmessage = function \(ev\) \{\s*if \(state\.ws !== socket\) return;/,
  "messages from a replaced WebSocket must be ignored after a pair or interval switch");
assert.match(live, /socket\.onclose = function \(\) \{\s*if \(state\.ws !== socket\) return;\s*state\.ws = null;\s*scheduleWs\(\);/,
  "only the currently active WebSocket may schedule a reconnect");
assert.match(live, /LIVE '\s*\+ esc\(state\.interval\.toUpperCase\(\)\)/,
  "chart label must show the actual selected interval");
console.log("Quick Mode tests passed: 5m default, live WebSocket refresh, and selected-interval candles.");

assert.match(live, /v == null \|\| v === ""/, "missing market values must remain missing rather than becoming zero");
assert.match(live, /if \(live === null \|\| live <= 0 \|\| !Number\.isFinite\(state\.lastTradeAt\)/, "missing live price must fail closed before momentum is calculated");
assert.match(live, /live \/ enriched\[enriched\.length - 2\]\.close - 1/, "momentum must use a valid live price and the prior real candle");
assert.match(live, /validBook = Number\.isFinite\(state\.bid\).*state\.bid > 0 && state\.ask >= state\.bid/, "zero or invalid bid/ask must not be rendered as a valid spread");
