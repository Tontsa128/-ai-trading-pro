"use strict";
const assert = require("node:assert/strict");
global.window = global;
require("../trading-engine.js");
const E = global.TradingEngine;
assert.ok(E, "engine exposes its public API");

assert.equal(typeof E.explainCandle, "function", "engine exposes candle checklist evaluation for direct testing");
const macdFixture = {
  close: 95, ema200: 100, ema50: 98, ema9: 94, ema21: 96,
  macdHist: -0.0125, rsi: 40, adx: 30, pdi: 8, mdi: 20, volumeRatio: 0.8
};
const negativeMacdGate = E.explainCandle(macdFixture).bear.find(x => x.name.includes("MACD-histogrammi"));
assert.equal(negativeMacdGate.ok, true, "negative MACD histogram must pass the bearish MACD condition");
const positiveMacdGate = E.explainCandle({...macdFixture, macdHist: 0.0125}).bear.find(x => x.name.includes("MACD-histogrammi"));
assert.equal(positiveMacdGate.ok, false, "positive MACD histogram must fail the bearish MACD condition");
const zeroMacdGate = E.explainCandle({...macdFixture, macdHist: 0}).bear.find(x => x.name.includes("MACD-histogrammi"));
assert.equal(zeroMacdGate.ok, false, "zero MACD histogram is not strictly negative");


const fs = require("node:fs");
const path = require("node:path");
const dashboardSource = fs.readFileSync(path.join(__dirname, "../public/index.html"), "utf8");
assert.ok(dashboardSource.includes("higherSeries:higher"),
  "dashboard backtest passes its 4h and 1d series into the strategy engine");
assert.ok(!dashboardSource.includes("Testi ei vielä käytä live-signaalin korkeampien aikavälien vahvistuksia."),
  "dashboard must not claim higher-timeframe confirmation is missing when it is passed to backtest");
assert.ok(dashboardSource.includes("startIndex:splitIndex") && dashboardSource.includes("viimeiset 30 %"),
  "dashboard separates the last 30% of history as a holdout test window");
assert.ok(dashboardSource.includes("function trendFi(v)") && dashboardSource.includes("EPÄSELVÄ"),
  "paper table uses the same Finnish labels as the live timeframe panel");
assert.ok(dashboardSource.includes("Volyymi / 20 kynttilää"),
  "paper table exposes measured volume ratio as its own column");
assert.ok(dashboardSource.includes('v!==null&&v!==undefined&&v!==""'),
  "missing numeric values are rendered as unavailable rather than zero");
assert.ok(dashboardSource.includes("setInterval(function(){if(!document.hidden)loadPaper();},60000)"),
  "two-hour paper report refreshes while the dashboard is visible");
assert.ok(dashboardSource.includes("VANHA RAPORTTI — tarkista GitHub Actions -ajot"),
  "paper dashboard flags reports older than the expected reporting window");
const fastWorkerSource = fs.readFileSync(path.join(__dirname, "../scripts/fast-paper-trader.js"), "utf8");
assert.ok(fastWorkerSource.includes("const quoteFresh = isFreshQuote(s.lastQuoteAt, Date.now(), MAX_QUOTE_AGE_MS)"),
  "fast paper entries must require a fresh top-of-book quote");
assert.ok(fastWorkerSource.includes("const entryTime = new Date(Math.max(Date.now(), bar.closeTime + 1)).toISOString()"),
  "fast paper entry timestamps must be at or after the signal was observed");
assert.ok(fastWorkerSource.includes("websocketConnectedAtEnd: websocketConnectedAtEnd"),
  "end-of-session WebSocket status is captured before socket shutdown");
assert.ok(fastWorkerSource.includes("const priorCloses = closes.slice(0, -1)"),
  "fast EMA crossover compares values seeded from the same full history");

assert.ok(dashboardSource.includes("x.detail"),
  "live signal checklist displays numeric diagnostic details");
const paperScriptSource = fs.readFileSync(path.join(__dirname, "../scripts/paper-trading-cycle.js"), "utf8");
assert.ok(paperScriptSource.includes('"HTTP "+r.status+" from "+host+url'),
  "paper collector reports the exact public data endpoint that fails");

const { spawnSync } = require("node:child_process");
const fastWorkerCheck = spawnSync(process.execPath,
  ["--check", path.join(__dirname, "../scripts/fast-paper-trader.js")], { encoding: "utf8" });
assert.equal(fastWorkerCheck.status, 0,
  "fast paper WebSocket worker must pass Node syntax validation: " + fastWorkerCheck.stderr);



const now = 50000;
const candle = (t, closeTime, open, high, low, close, volume) =>
  [t, String(open), String(high), String(low), String(close), String(volume), closeTime];
const parsed = E.parseKlines([
  candle(100, 1000, 100, 102, 99, 101, 20),
  candle(200, 60000, 101, 103, 100, 102, 25)
], now);
assert.equal(parsed.length, 1, "unfinished candles are excluded");
assert.equal(parsed[0].close, 101);

function makeBars(length, breakAfter) {
  const bars = [];
  let prior = 100;
  for (let i = 0; i < length; i++) {
    let close = 100 + i * 0.035 + Math.sin(i / 6) * 0.5 + Math.sin(i / 19) * 0.15;
    if (breakAfter !== undefined && i >= breakAfter) close *= 1.8;
    const open = prior;
    const high = Math.max(open, close) + Math.max(close * 0.0015, 0.02);
    const low = Math.min(open, close) - Math.max(close * 0.0015, 0.02);
    bars.push({time: 1700000000000 + i * 300000, closeTime: 1700000299999 + i * 300000,
      open: open, high: high, low: low, close: close, volume: 100 + 10 * (1 + Math.sin(i * 1.3))});
    prior = close;
  }
  return bars;
}
const raw = makeBars(520);
const full = E.enrich(raw);
assert.equal(full.length, 520);
assert.ok(Number.isFinite(full[400].ema200), "EMA 200 is computed");
assert.ok(Number.isFinite(full[400].atr) && full[400].atr > 0, "ATR is positive");
assert.ok(full[400].rsi >= 0 && full[400].rsi <= 100, "RSI stays within [0,100]");
assert.ok(Number.isFinite(full[400].adx), "ADX is finite after warm-up");
assert.throws(() => E.analyzeSeries(full.slice(0, 100)), /vähintään 220/, "short history fails closed");

const changedFuture = E.enrich(makeBars(520, 301));
assert.equal(full[300].ema200, changedFuture[300].ema200, "future data cannot change a prior EMA");
assert.equal(full[300].rsi, changedFuture[300].rsi, "future data cannot change a prior RSI");

const analysed = E.analyzeSeries(full);
const opts = {capital: 1000, riskPct: 0.5, maxExposurePct: 25, feePct: 0.1, slippagePct: 0.05};
const signal = E.makeSignal(analysed, [analysed, analysed],
  {price: analysed.bar.close, closeTime: Date.now(), bid: 100, ask: 100.01}, opts);
assert.ok(["BUY", "SELL", "WAIT"].includes(signal.direction), "signal is a known enum");
assert.ok(signal.passed <= signal.total && signal.passed >= 0, "checklist count is coherent");
assert.equal(E.evaluateSignal, E.makeSignal, "legacy and shared evaluator names point to one function");
assert.ok(signal.checklist.every(x => ["Data OK", "Trendi", "Ajoitus"].includes(x.group)), "signal checklist is grouped");
const expectedSide = signal.direction === "BUY" ? "BUY" : signal.direction === "SELL" ? "SELL" : analysed.checks.bias === "bear" ? "SELL" : analysed.checks.bias === "bull" ? "BUY" : analysed.checks.bearN > analysed.checks.bullN ? "SELL" : "BUY";
assert.ok(signal.checklist.filter(x => x.group === "Trendi").every(x => x.direction === expectedSide), "checklist direction follows EMA trend bias before score fallback");
assert.ok(signal.checklist.some(x => x.name.includes("0,5×")), "volume gate uses the calibrated 0.5x threshold");

const bearRaw = [];
let previousBearClose = 200;
for (let i = 0; i < 520; i++) {
  const close = 200 - i * 0.1 + Math.sin(i / 6) * 0.5;
  const open = previousBearClose;
  const high = Math.max(open, close) + 0.2;
  const low = Math.min(open, close) - 0.2;
  bearRaw.push({time:1700000000000+i*300000,closeTime:1700000299999+i*300000,
    open,high,low,close,volume:100+10*(1+Math.sin(i*1.3))});
  previousBearClose = close;
}
const bearAnalysis = E.analyzeSeries(E.enrich(bearRaw));
assert.equal(bearAnalysis.checks.bias, "bear", "synthetic falling market has bearish EMA bias");
const bearSignal = E.evaluateSignal(bearAnalysis, [bearAnalysis, bearAnalysis],
  {price:bearAnalysis.bar.close,closeTime:Date.now(),bid:bearAnalysis.bar.close*0.9999,
    ask:bearAnalysis.bar.close*1.0001}, opts);
const bearVolumeGate = bearSignal.checklist.find(x => x.group === "Trendi" && x.name.includes("Volyymi"));
assert.ok(bearVolumeGate, "bearish checklist includes its volume condition");
assert.ok(bearVolumeGate.name.includes("0,5×"), "bearish checklist label uses the same 0.5x threshold as signal logic");
assert.equal(bearVolumeGate.ok,
  Number.isFinite(bearAnalysis.bar.volumeRatio) && bearAnalysis.bar.volumeRatio >= 0.5,
  "bearish checklist result uses the same 0.5x volume gate as signal logic");
const lowVolumeBar = {...bearAnalysis.bar, volumeRatio: 0.43};
const lowVolumeMain = {...bearAnalysis, bar: lowVolumeBar, checks: E.explainCandle(lowVolumeBar)};
const lowVolumeSignal = E.evaluateSignal(lowVolumeMain, [bearAnalysis, bearAnalysis],
  {price:lowVolumeBar.close,closeTime:Date.now(),bid:lowVolumeBar.close*0.9999,ask:lowVolumeBar.close*1.0001}, opts);
assert.ok(lowVolumeSignal.blockingReasons.some(x => x.includes("Volyymi 0.43×") && x.includes("vaatimus ≥ 0.50×")),
  "volume blocker states the measured ratio and the required minimum");

const extendedMain = {...analysed, overextended:true};
const extendedSignal = E.evaluateSignal(extendedMain, [analysed, analysed],
  {price:analysed.bar.close,closeTime:Date.now(),bid:analysed.bar.close*0.9999,ask:analysed.bar.close*1.0001}, opts);
assert.ok(extendedSignal.blockingReasons.some(x => x.includes("Hinta on liian kaukana EMA 21:stä") && x.includes("ehto ei täyty")),
  "failed EMA-distance gate is described as a failure, not as a satisfied condition");
const volatileMain = {...analysed, highVolatility:true, bar:{...analysed.bar,atrPct:4.2}};
const volatileSignal = E.evaluateSignal(volatileMain, [analysed, analysed],
  {price:analysed.bar.close,closeTime:Date.now(),bid:analysed.bar.close*0.9999,ask:analysed.bar.close*1.0001}, opts);
assert.ok(volatileSignal.blockingReasons.some(x => x.includes("ATR-volatiliteetti 4.20 %") && x.includes("ehto ei täyty")),
  "high ATR volatility blocker displays the measured value and explicit failure");

assert.ok(lowVolumeSignal.blockingReasons.every(x => !x.includes("neutral")),
  "visible blocker explanations use Finnish trend terminology rather than raw neutral enums");

assert.equal(analysed.support, Math.min(...full.slice(-31, -1).map(x => x.low)), "support excludes the current candle");
assert.equal(analysed.resistance, Math.max(...full.slice(-31, -1).map(x => x.high)), "resistance excludes the current candle");
assert.ok(Array.isArray(signal.blockingReasons), "signal exposes failed conditions for diagnosis");
assert.equal(signal.trendBias, analysed.checks.bias, "signal exposes the main timeframe trend bias");
const historicalSignal = E.evaluateSignal(analysed, [analysed, analysed],
  {price: analysed.bar.close, closeTime: 1, bid: 100, ask: 100.01}, {...opts, historical: true});
assert.equal(historicalSignal.priceAgeMs, 0, "historical evaluation does not fail the live freshness gate");
const stale = E.makeSignal(analysed, [analysed, analysed],
  {price: analysed.bar.close, closeTime: Date.now() - 10 * 60 * 1000, bid: 100, ask: 100.01}, opts);
assert.equal(stale.direction, "WAIT", "stale market data must force WAIT");
if (signal.direction === "BUY") assert.ok(signal.qty > 0, "a buy has a positive risk-sized quantity");
if (signal.direction === "SELL") assert.equal(signal.qty, 0, "spot sell size is never invented without holdings");

const bt = E.backtest(full, opts);
assert.equal(bt.count, 0, "backtest without higher-timeframe data fails closed");
assert.ok(Number.isFinite(bt.netPnl) && Number.isFinite(bt.maxDrawdownPct), "backtest metrics are finite");
const alignedBt = E.backtest(full, {...opts, higherSeries: [full, full]});
assert.ok(Number.isFinite(alignedBt.netPnl) && Number.isFinite(alignedBt.maxDrawdownPct), "aligned backtest metrics are finite");

assert.equal(alignedBt.startIndex, 220, "full-history backtest preserves the default warm-up period");
const holdoutStart = 400;
const holdoutBt = E.backtest(full, {...opts, higherSeries: [full, full], startIndex: holdoutStart});
assert.equal(holdoutBt.startIndex, holdoutStart, "backtest supports an explicit holdout start index");
assert.ok(holdoutBt.trades.every(t => t.entryTime >= full[holdoutStart + 1].time),
  "holdout trades cannot be opened before the holdout window");
assert.ok(holdoutBt.trades.every(t => t.exitTime > t.entryTime), "holdout trades still exit after entry");
assert.ok(alignedBt.trades.every(t => Number.isFinite(t.pnl) && t.entryTime < t.exitTime), "backtest trades have valid timing and P/L");
console.log("OK: market-data filtering, indicators, no-lookahead check, signal gates and risk-aware backtest.");
