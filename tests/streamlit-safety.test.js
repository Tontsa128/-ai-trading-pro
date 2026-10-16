"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const app = fs.readFileSync("app.py", "utf8");

assert.doesNotMatch(app, /def demo_data\s*\(/, "legacy Streamlit path must not create synthetic market prices");
assert.match(app, /if close_time >= now_ms:/, "only closed candles may feed Streamlit indicators");
assert.match(app, /return None, "DATA FAIL — oikeaa markkinadataa ei saatu", False/, "no data must fail closed");
assert.match(app, /raw, source, market_data_ok = load_data\(\)/, "Streamlit caller must receive feed validity");
assert.match(app, /if not market_data_ok:/, "stale feed must enter a separate safety path");
assert.match(app, /"level": "DATA STALE"/, "stale data is clearly marked in the UI model");
assert.match(app, /higher_tf_bias\(symbol, tf\)/, "higher timeframe confirmations are selected relative to the active timeframe");
assert.match(app, /higher_frames = frames\[index \+ 1:index \+ 3\]/, "confirmations use strictly higher timeframes");
assert.match(app, /if any\(value == "EI DATA" for value in result\.values\(\)\):/, "missing higher timeframe data fails closed");
assert.match(app, /if not higher_data_ok:/, "missing HTF data suppresses signals");
assert.match(app, /confidence = 0 if not higher_data_ok/, "stale HTF status does not show a heuristic strength score");
assert.match(app, /last = data\.iloc\[-1\]/, "closed higher-timeframe candles use the latest closed bar");
assert.match(app, /REST-päivitysväli/, "legacy Streamlit source does not claim its OHLC polling is a WebSocket stream");
assert.match(app, /REST-päivitysväli — suljetut kynttilät/, "sidebar accurately describes closed-candle polling");
assert.doesNotMatch(app, /st\.sidebar\.radio\("Live-päivitys"/, "legacy Streamlit app does not call REST polling a live stream");
assert.match(app, /Heuristinen vahvuusindeksi .* ei voittotodennäköisyys/, "score strength is not misrepresented as win probability");
assert.match(app, /actionable_buy = level in \{"OSTA", "VAHVA OSTA", "⚡ NOPEA OSTA"\}/, "only explicit long spot entry levels create stop/target suggestions");
assert.doesNotMatch(app, /level = "VAHVA MYY"/, "no strong-short label is presented as a spot trade");
assert.doesNotMatch(app, /level = "TARKKAILU MYY"/, "no watch-short level is presented as a spot trade");
assert.doesNotMatch(app, /elif "MYY" in level:/, "bearish state must never calculate a short entry stop/target");
assert.match(app, /⚠ VÄLTÄ UUSIA OSTOJA/, "fast bearish alert is converted to a long-only spot warning");

console.log("Streamlit safety tests passed: no synthetic fallback, closed-candle guard, stale-data block and long-only spot policy.");
