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
assert.ok(!/Paper Trading|Paper-Treidaus|paper-data\/data\/latest-report|fastPaperRefresh|fast5Status|fast15Status/i.test(html),
  "the user-facing dashboard must not contain demo/paper-trading report panels");

const liveDashboard = fs.readFileSync("public/live-dashboard.js", "utf8");
assert.ok(liveDashboard.includes("indikaattorit") && liveDashboard.includes("EI PÄÄTÖSTÄ"),
  "short-timeframe cards display measured indicators, not an independent buy/sell decision");
assert.ok(!liveDashboard.includes('var label = side === "BUY" ? "OSTA"') &&
  !liveDashboard.includes('var sig = gatedScore(scoreFor(state.bars'),
  "the independent score heuristic must not create buy labels or chart signal annotations");
assert.ok(liveDashboard.includes("canonical TradingEngine.evaluateSignal() owns the main decision"),
  "the canonical evaluator is the sole owner of the main decision");
assert.ok(!liveDashboard.includes('var sig = $("signal"); if (sig)'),
  "the live indicator layer must not overwrite the canonical decision");
assert.ok(!liveDashboard.includes('var re = $("rsi")') && !liveDashboard.includes('var ae = $("adx")'),
  "the WebSocket layer must not overwrite RSI/ADX from the selected analysis timeframe");
assert.ok(html.includes("Voittotodennäköisyyttä ei arvioida."),
  "the dashboard must not claim to estimate win probability");
assert.ok(!liveDashboard.includes('Math.round(base.score) + "%"') &&
  !liveDashboard.includes('Math.round(50 + Math.abs(base.score - 50)) + "%"'),
  "heuristic scores must never be rendered as win probabilities");

const liveGuards = fs.readFileSync("public/live-signal-guards.js", "utf8");
assert.ok(liveDashboard.includes("gatedScore(score)") && liveDashboard.includes("lastBookAt = Date.now()"),
  "live dashboard must gate signals on recent trade and order-book data");
assert.ok(liveDashboard.includes("window.LiveSignalGuards.apply") &&
  liveDashboard.includes("SIGNAALI ESTETTY"),
  "live dashboard must fail closed and display a visible blocked-signal state");
assert.ok(liveGuards.includes("MAX_TRADE_AGE_MS = 5000") &&
  liveGuards.includes("MAX_BOOK_AGE_MS = 3000") &&
  liveGuards.includes("MAX_SPREAD_PCT = 0.15"),
  "live signal guard must enforce documented data-age and spread thresholds");
const engineSource = fs.readFileSync("public/trading-engine.js", "utf8");
assert.ok(engineSource.includes('b.close > b.ema200 ? "yläpuolella"') &&
  engineSource.includes('b.ema50 > b.ema200 ? "yläpuolella"') &&
  engineSource.includes('b.ema9 > b.ema21 ? "yläpuolella"'),
  "EMA checklist descriptions must be generated from the actual measured relationships");
assert.ok(engineSource.includes('"+DI " + fixedFi(b.pdi, 1)') &&
  engineSource.includes('"−DI " + fixedFi(b.mdi, 1)') &&
  engineSource.includes('"RSI " + fixedFi(b.rsi, 1)'),
  "the checklist must expose the actual RSI, ADX and directional-index values");
assert.ok(!/toLocaleString\("en-US"/.test(html),
  "dashboard numeric formatting must use Finnish locale consistently");

const repairScript = fs.readFileSync("scripts/repair-mobile-chart.js", "utf8");
assert.ok(repairScript.indexOf("live-signal-guards.js") < repairScript.indexOf("live-dashboard.js"),
  "Vercel build must load live signal guards before live dashboard code");

console.log("Dashboard tests passed: inline scripts parse, chart fallback is wired, and heuristic scores are not shown as win probabilities.");
