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
assert.ok(html.includes('src="./price-action-engine.js"') && html.includes('src="./market-structure-engine.js"'),
  "dashboard must load the separate deterministic price action and market structure engines");
assert.ok(html.includes('id="structureResults"') && html.includes('id="structureState"') &&
  html.includes("function renderMarketStructure(bars)") && html.includes("renderMarketStructure(main)"),
  "market structure and liquidity findings must be rendered from the same closed-candle snapshot");
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
assert.ok(html.includes("fallbackTimer=setTimeout") && html.includes("Plotly-piirto ei valmistunut 5 sekunnissa"),
  "a stalled Plotly promise must time out and render the local SVG fallback");
assert.ok(html.includes("Kaavion piirto-ongelma: ") && html.includes("Plotly ei luonut kaavion SVG-elementtiä."),
  "chart failures must be visible instead of leaving an indefinite loading message");
assert.ok(html.includes('currentNode.querySelector("svg")') && html.includes('node.querySelector("svg")'),
  "the delayed Plotly fallback must not overwrite a live SVG chart rendered by the live dashboard");
const formatterSource = fs.readFileSync("public/number-format.js", "utf8");
assert.ok(html.includes('src="./number-format.js"') && formatterSource.includes('Intl.NumberFormat("fi-FI"'),
  "dashboard values must use the shared Finnish number formatter");
assert.ok(!/Paper Trading|Paper-Treidaus|paper-data\/data\/latest-report|fastPaperRefresh|fast5Status|fast15Status/i.test(html),
  "the user-facing dashboard must not contain demo/paper-trading report panels");

const liveDashboard = fs.readFileSync("public/live-dashboard.js", "utf8");
assert.ok(liveDashboard.includes("Tekninen suuntapiste") && liveDashboard.includes("Ei kaupankäyntisignaali.") && html.includes("Voittotodennäköisyyttä ei arvioida."),
  "technical direction scores are explicitly distinguished from canonical trading decisions");
assert.ok(liveDashboard.includes("MYY / KEVENNÄ") && liveDashboard.includes("Myynti koskee vain jo omistamaasi omaisuutta"),
  "bearish spot guidance must not imply short-selling or invent a sell quantity");
assert.ok(liveDashboard.includes('side === "SELL" ? 100 - rawScore : rawScore'),
  "bearish technical points must be oriented to the displayed direction");
assert.ok(liveDashboard.includes("technicalItems") &&
  liveDashboard.includes('selectedInterval === "1h" ? ["4h", "1d"]') &&
  liveDashboard.includes('selectedInterval === "4h" ? ["1d", "3d"]') &&
  liveDashboard.includes("riskExample.hidden = direction === \"WAIT\""),
  "live UI must separate data checks from technical checks, use the correct higher intervals, and hide the risk example for WAIT");
assert.ok(liveDashboard.includes("state.decisionError") && liveDashboard.includes("ODOTA"),
  "missing or invalid canonical analysis must fail closed as WAIT with an explicit reason");
assert.ok(!liveDashboard.includes("num(s && s.score, 0) + '%'") &&
  !liveDashboard.includes('Math.round(base.score) + "%"') &&
  !liveDashboard.includes('Math.round(50 + Math.abs(base.score - 50)) + "%"'),
  "heuristic scores must never be rendered as percentages or win probabilities");

const liveGuards = fs.readFileSync("public/live-signal-guards.js", "utf8");
assert.ok(liveDashboard.includes("refreshRestFallback") && liveDashboard.includes("setInterval(refreshRestFallback, 2000)") && liveDashboard.includes("state.tradeSource = \"REST\"") && liveDashboard.includes("state.bookSource = \"REST\""),
  "live dashboard must automatically fall back to fresh Binance REST quotes when WebSocket data is stale");
assert.ok(liveDashboard.includes("state.chartLive = enriched[enriched.length - 1]") && liveDashboard.includes("closeTime >= Date.now()"),
  "REST fallback must update the current chart candle only from a validated, still-open Binance candle");
assert.ok(liveDashboard.includes("TradingEngine.evaluateSignal(main, higher") && liveDashboard.includes("var decision = state.decision"),
  "the primary live BUY/SELL/WAIT decision must come from the canonical multi-timeframe strategy engine");
assert.ok(liveDashboard.includes("Tekninen suuntapiste") && liveDashboard.includes("Ei kaupankäyntisignaali.") &&
  !liveDashboard.includes('base.side === "BUY" ? "OSTA · pisteet "'),
  "short-term heuristic scores must be shown only as technical bias and must not overwrite the canonical trading decision");
assert.ok(liveDashboard.includes('sig.direction !== "WAIT"') && liveDashboard.includes("currentGateReason()"),
  "chart BUY/SELL overlays must use the canonical decision and live freshness guards");
assert.ok(liveDashboard.includes("txt + '</text>'") && !liveDashboard.includes("txt + ' ' + points + '/100p"),
  "canonical chart signal overlay must not reference the removed heuristic score variable");
assert.ok(liveDashboard.includes("gatedScore(score)") && liveDashboard.includes("lastBookAt = Date.now()"),
  "live dashboard must gate signals on recent trade and order-book data");
assert.ok(liveDashboard.includes("window.LiveSignalGuards.apply") &&
  liveDashboard.includes("SIGNAALI ESTETTY"),
  "live dashboard must fail closed and display a visible blocked-signal state");
assert.ok(liveGuards.includes("MAX_TRADE_AGE_MS = 5000") &&
  liveGuards.includes("MAX_BOOK_AGE_MS = 3000") &&
  liveGuards.includes("MAX_SPREAD_PCT = 0.15"),
  "live signal guard must enforce documented data-age and spread thresholds");
const repairScript = fs.readFileSync("scripts/repair-mobile-chart.js", "utf8");
assert.ok(repairScript.indexOf("live-signal-guards.js") < repairScript.indexOf("live-dashboard.js"),
  "Vercel build must load live signal guards before live dashboard code");

console.log("Dashboard tests passed: inline scripts parse, chart fallback is wired, and heuristic scores are not shown as win probabilities.");
