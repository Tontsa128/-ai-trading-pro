"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const html = fs.readFileSync("public/index.html", "utf8");
const live = fs.readFileSync("public/live-dashboard.js", "utf8");

assert.match(html, /<select id="interval">[\s\S]*?<option selected>5m<\/option>/,
  "dashboard must open with the 5-minute analysis interval selected");
assert.match(html, /<option value="0" selected>WebSocket live \(reaaliaikainen\)<\/option>/,
  "live WebSocket updates should be the default refresh mode");
assert.match(html, /<option value="5">5 sekuntia \(varapäivitys\)<\/option>/,
  "a 5-second fallback refresh should be available");
assert.match(live, /interval: "5m"/, "live chart defaults to 5m");
assert.match(live, /var s = state\.symbol\.toLowerCase\(\), iv = state\.interval \|\| "5m"/,
  "WebSocket candle stream must follow the selected chart interval");
assert.match(live, /scores\[state\.interval\] \|\| scores\["5m"\] \|\| scores\["1m"\]/,
  "main signal must follow the selected interval when that timeframe is scored");
assert.match(live, /loadChartBars\(\)\.then\(startWs\)/,
  "changing pair or interval must reload chart history before reconnecting");
assert.match(live, /LIVE '\s*\+ esc\(state\.interval\.toUpperCase\(\)\)/,
  "chart label must show the actual selected interval");
console.log("Quick Mode tests passed: 5m default, live WebSocket refresh, and selected-interval candles.");
