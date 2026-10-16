"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const html = fs.readFileSync("public/index.html", "utf8");
const scripts = [];
const re = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
let match;
while ((match = re.exec(html)) !== null) {
  if (/\bsrc\s*=/i.test(match[1])) continue;
  if (match[2].trim()) scripts.push({ body: match[2], offset: match.index });
}
assert.ok(scripts.length > 0, "expected at least one inline script");
for (const script of scripts) {
  try {
    new Function(script.body);
  } catch (error) {
    error.message = "Inline script at HTML offset " + script.offset + ": " + error.message;
    throw error;
  }
}
assert.match(html, /function renderNativeCandleChart\s*\(/, "native SVG chart fallback must be present");
assert.match(html, /return renderNativeCandleChart\(series,signal,symbol,chartCount\)/, "missing Plotly should use local chart");
assert.match(html, /\.catch\(function\(\)\{renderNativeCandleChart/, "asynchronous Plotly failures should fall back locally");
assert.ok(html.includes("VANHA RAPORTTI") && html.includes("reportAgeSeconds"),
  "two-hour paper report must show age and warn when stale");
assert.ok(html.includes("REST-VARASYÖTE") && html.includes("wsMessages===0&&restUpdates>0"),
  "fast paper report must warn when REST-sampled prices replace missing WebSocket trade events");
console.log("Dashboard inline script tests passed: " + scripts.length + " inline script(s) parse; SVG candlestick fallback is wired.");
