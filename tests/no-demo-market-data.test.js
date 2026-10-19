"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");

const source = fs.readFileSync("app.py", "utf8");

assert.doesNotMatch(source, /def\s+demo_data\s*\(/,
  "the Streamlit app must not generate synthetic demo candles");
assert.doesNotMatch(source, /Demo-varadata|np\.random\.normal/,
  "demo candle labels and random candle generation must be removed");
assert.match(source, /return pd\.DataFrame\(columns=\["Open", "High", "Low", "Close", "Volume"\]\), "MARKKINADATA EI SAATAVILLA"/,
  "failed market data requests must return no fabricated candles");
assert.match(source, /if raw\.empty:[\s\S]*?st\.stop\(\)/,
  "the app must stop before indicators and signals when live data is unavailable");
assert.match(source, /Never substitute generated or stale candles for live market data/,
  "the fail-closed behavior must be documented in code");

console.log("No-demo tests passed: the Streamlit app fails closed when live market data is unavailable.");
