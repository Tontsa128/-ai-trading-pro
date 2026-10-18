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
assert.ok(html.includes("var valid=Array.isArray(series)") && html.includes("if(valid.length<2)") && html.includes("return false;"),
  "chart must validate candle data and reject fewer than two valid candles");
assert.ok(html.includes("return renderNativeCandleChart(valid,signal,symbol,count)"),
  "missing Plotly should render the validated, bounded candle series");
assert.ok(html.includes(".catch(function(){renderNativeCandleChart(valid,signal,symbol,count);})"),
  "asynchronous Plotly failures should fall back locally using validated data");
assert.ok(html.includes("VANHA RAPORTTI") && html.includes("reportAgeSeconds"),
  "two-hour paper report must show age and warn when stale");
assert.ok(html.includes("REST-VARASYÖTE") && html.includes("wsMessages===0&&restUpdates>0"),
  "fast paper report must warn when REST-sampled prices replace missing WebSocket trade events");
console.log("Dashboard inline script tests passed: " + scripts.length + " inline script(s) parse; validated SVG candlestick fallback is wired.");
