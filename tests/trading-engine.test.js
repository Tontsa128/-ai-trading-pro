"use strict";
const assert = require("node:assert/strict");
global.window = global;
require("../trading-engine.js");
const E = global.TradingEngine;
assert.ok(E, "engine exposes its public API");

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
assert.ok(alignedBt.trades.every(t => Number.isFinite(t.pnl) && t.entryTime < t.exitTime), "backtest trades have valid timing and P/L");
console.log("OK: market-data filtering, indicators, no-lookahead check, signal gates and risk-aware backtest.");
