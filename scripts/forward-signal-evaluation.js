"use strict";

// Forward signal-quality research. This records decisions, not trades. It never
// places orders and never changes the canonical TradingEngine thresholds.
global.window = global;
require("../public/trading-engine.js");
const E = global.TradingEngine;
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

if (!E || typeof E.evaluateSignal !== "function") throw new Error("Canonical TradingEngine unavailable.");
const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
const HORIZONS = [1, 4, 24];
const FEE_PER_SIDE_PCT = 0.10;
const RANDOM_SEEDS = 100;
const HOSTS = ["https://data-api.binance.vision", "https://api1.binance.com", "https://api2.binance.com", "https://api3.binance.com", "https://api.binance.com"];

function hash(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}
function netReturnPct(grossReturnPct, feePerSidePct = FEE_PER_SIDE_PCT) {
  const gross = Number(grossReturnPct);
  const fee = Number(feePerSidePct) / 100;
  if (!Number.isFinite(gross) || gross <= -100 || !Number.isFinite(fee) || fee < 0 || fee >= 1) return null;
  return ((1 + gross / 100) * (1 - fee) * (1 - fee) - 1) * 100;
}
function directionalGrossPct(direction, entry, future) {
  if (!(entry > 0) || !(future > 0) || !Number.isFinite(entry) || !Number.isFinite(future)) return null;
  if (direction === "BUY") return (future / entry - 1) * 100;
  if (direction === "SELL") return (entry / future - 1) * 100;
  return null;
}
function randomBaselineMean(signalId, entry, future, seeds = RANDOM_SEEDS) {
  const values = [];
  for (let i = 0; i < seeds; i++) {
    const side = parseInt(hash(signalId + "|random|" + i).slice(0, 8), 16) % 2 ? "BUY" : "SELL";
    const gross = directionalGrossPct(side, entry, future);
    const net = netReturnPct(gross);
    if (net !== null) values.push(net);
  }
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}
function deriveWatchDirection(signal) {
  if (signal.trendBias === "bull") return "BUY";
  if (signal.trendBias === "bear") return "SELL";
  const bull = Number(signal.checks && signal.checks.bullN);
  const bear = Number(signal.checks && signal.checks.bearN);
  if (Number.isFinite(bull) && Number.isFinite(bear) && bull !== bear) return bull > bear ? "BUY" : "SELL";
  return null;
}
function isNearMiss(signal) {
  if (!signal || signal.direction !== "WAIT" || (signal.riskPlan && signal.riskPlan.tradable === false)) return false;
  const failures = Array.isArray(signal.checklist) ? signal.checklist.filter(x => !x.ok).length : Infinity;
  return failures <= 2 && !!deriveWatchDirection(signal);
}
function sampleGroup(signal) {
  if (signal.direction === "BUY" || signal.direction === "SELL") return signal.direction;
  return isNearMiss(signal) ? "WAIT_NEAR_MISS" : "WAIT_OTHER";
}
function buildOutcome(signal, horizonHours, futureClose, futureCloseTime) {
  const direction = signal.direction === "BUY" || signal.direction === "SELL"
    ? signal.direction : (isNearMiss(signal) ? deriveWatchDirection(signal) : null);
  if (!direction) return null;
  const entry = Number(signal.price);
  const future = Number(futureClose);
  const grossDirectional = directionalGrossPct(direction, entry, future);
  const netDirectional = netReturnPct(grossDirectional);
  const buyHoldGross = directionalGrossPct("BUY", entry, future);
  const buyHoldNet = netReturnPct(buyHoldGross);
  if (netDirectional === null || buyHoldNet === null) return null;
  return {
    schema: 1,
    signalId: signal.signalId,
    symbol: signal.symbol,
    signalTimeUtc: signal.signalTimeUtc,
    candleCloseTimeUtc: signal.candleCloseTimeUtc,
    horizonHours,
    sampleGroup: sampleGroup(signal),
    signalDirection: signal.direction,
    evaluatedDirection: direction,
    watchDirection: signal.watchDirection,
    entryPrice: entry,
    futureClosePrice: future,
    futureCloseTimeUtc: futureCloseTime,
    grossDirectionalReturnPct: grossDirectional,
    netDirectionalReturnPct: netDirectional,
    buyAndHoldNetReturnPct: buyHoldNet,
    randomDirectionMeanNetReturnPct: randomBaselineMean(signal.signalId + "|" + horizonHours, entry, future),
    feesPerSidePct: FEE_PER_SIDE_PCT,
    roundTripFeePct: 2 * FEE_PER_SIDE_PCT,
    isDirectionallyPositiveAfterFees: netDirectional > 0,
    metricType: "signal_value_not_executable_trade_pnl",
  };
}
function summarize(outcomes) {
  const result = {};
  for (const horizon of HORIZONS) {
    result[horizon + "h"] = {};
    for (const group of ["BUY", "SELL", "WAIT_NEAR_MISS"]) {
      const rows = outcomes.filter(x => x.horizonHours === horizon && x.sampleGroup === group);
      const mean = key => rows.length ? rows.reduce((sum, row) => sum + Number(row[key]), 0) / rows.length : null;
      result[horizon + "h"][group] = {
        samples: rows.length,
        hitRatePct: rows.length ? rows.filter(x => x.netDirectionalReturnPct > 0).length / rows.length * 100 : null,
        avgNetDirectionalReturnPct: mean("netDirectionalReturnPct"),
        avgBuyAndHoldNetReturnPct: mean("buyAndHoldNetReturnPct"),
        avgRandomDirectionNetReturnPct: mean("randomDirectionMeanNetReturnPct"),
        excessVsBuyAndHoldPct: rows.length ? mean("netDirectionalReturnPct") - mean("buyAndHoldNetReturnPct") : null,
        excessVsRandomPct: rows.length ? mean("netDirectionalReturnPct") - mean("randomDirectionMeanNetReturnPct") : null,
        buyCount: rows.filter(x => x.evaluatedDirection === "BUY").length,
        sellCount: rows.filter(x => x.evaluatedDirection === "SELL").length,
      };
    }
  }
  return result;
}

async function getJson(urlPath) {
  let lastError;
  for (const host of HOSTS) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch(host + urlPath, { signal: controller.signal, headers: { "User-Agent": "RahasampoRadar-ForwardTest/1.0" } });
      clearTimeout(timeout);
      if (response.status === 418 || response.status === 429) throw new Error("Binance rate limit HTTP " + response.status);
      if (!response.ok) throw new Error("HTTP " + response.status + " from " + host);
      return await response.json();
    } catch (error) {
      clearTimeout(timeout);
      lastError = error;
      if (/rate limit/.test(String(error.message))) throw error;
    }
  }
  throw lastError || new Error("Binance public Spot API unavailable");
}
async function getBars(symbol, interval, limit) {
  const raw = await getJson("/api/v3/klines?symbol=" + symbol + "&interval=" + interval + "&limit=" + limit);
  return E.enrich(E.parseKlines(raw, Date.now()));
}
async function getMarket(symbol) {
  const [ticker, book] = await Promise.all([
    getJson("/api/v3/ticker/24hr?symbol=" + symbol),
    getJson("/api/v3/ticker/bookTicker?symbol=" + symbol)
  ]);
  const market = { price: Number(ticker.lastPrice), closeTime: Number(ticker.closeTime), bid: Number(book.bidPrice), ask: Number(book.askPrice), change24hPct: Number(ticker.priceChangePercent) };
  if (![market.price, market.closeTime, market.bid, market.ask].every(Number.isFinite) || market.price <= 0 || market.bid <= 0 || market.ask < market.bid) {
    throw new Error("Invalid or stale market quote");
  }
  return market;
}
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}
function appendJsonl(file, rows) {
  if (!rows.length) return;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, rows.map(row => JSON.stringify(row)).join("\n") + "\n");
}
function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n");
  fs.renameSync(temp, file);
}
function findFutureClose(bars, signalTimeMs, horizonHours, nowMs) {
  const target = signalTimeMs + horizonHours * 60 * 60 * 1000;
  const candidate = bars.find(bar => bar.closeTime >= target && bar.closeTime > signalTimeMs && bar.closeTime < nowMs);
  return candidate || null;
}
async function run(dataDir) {
  const signalsFile = path.join(dataDir, "signals.jsonl");
  const outcomesFile = path.join(dataDir, "outcomes.jsonl");
  const errors = [];
  const signals = readJsonl(signalsFile);
  const outcomes = readJsonl(outcomesFile);
  const knownSignals = new Set(signals.map(x => x.signalId));
  const knownOutcomes = new Set(outcomes.map(x => x.signalId + "|" + x.horizonHours));
  const newSignals = [];
  const newOutcomes = [];
  const observedAt = new Date().toISOString();
  const observedAtMs = Date.now();

  for (const symbol of SYMBOLS) {
    try {
      const [one, four, day, market] = await Promise.all([
        getBars(symbol, "1h", 1000), getBars(symbol, "4h", 300), getBars(symbol, "1d", 300), getMarket(symbol)
      ]);
      if (one.length < 220 || four.length < 220 || day.length < 220) throw new Error("At least 220 closed candles are required on all timeframes");
      const main = E.analyzeSeries(one);
      const signalCandle = main.bar;
      const alignedFour = four.filter(bar => bar.closeTime <= signalCandle.closeTime);
      const alignedDay = day.filter(bar => bar.closeTime <= signalCandle.closeTime);
      if (alignedFour.length < 220 || alignedDay.length < 220) throw new Error("Insufficient higher-timeframe candles aligned to the signal close");
      const higher = [E.analyzeSeries(alignedFour), E.analyzeSeries(alignedDay)];
      const evaluated = E.evaluateSignal(main, higher, market, { feePct: FEE_PER_SIDE_PCT, slippagePct: 0.05 });
      const watchDirection = deriveWatchDirection(evaluated);
      const id = hash(symbol + "|" + signalCandle.closeTime);
      if (!knownSignals.has(id)) {
        const failures = evaluated.checklist.filter(x => !x.ok).length;
        const record = {
          schema: 1,
          signalId: id,
          symbol,
          signalTimeUtc: observedAt,
          signalAvailableAtUtc: new Date(signalCandle.closeTime + 1).toISOString(),
          candleOpenTimeUtc: new Date(signalCandle.time).toISOString(),
          candleCloseTimeUtc: new Date(signalCandle.closeTime).toISOString(),
          price: market.price,
          bid: market.bid,
          ask: market.ask,
          spreadPct: evaluated.spreadPct,
          change24hPct: market.change24hPct,
          signalDirection: evaluated.direction,
          watchDirection,
          nearMiss: isNearMiss(evaluated),
          checklistPassed: evaluated.passed,
          checklistTotal: evaluated.total,
          checklistPassPct: evaluated.total ? evaluated.passed / evaluated.total * 100 : null,
          failedGateCount: failures,
          trendBias: evaluated.trendBias,
          higherBias: evaluated.higherBias,
          blockingReasons: evaluated.blockingReasons,
          indicators: {
            rsi: main.bar.rsi, adx: main.bar.adx, atr: main.bar.atr,
            ema9: main.bar.ema9, ema21: main.bar.ema21, ema50: main.bar.ema50,
            ema200: main.bar.ema200, macdHist: main.bar.macdHist,
            volumeRatio: main.bar.volumeRatio
          },
          feePerSidePct: FEE_PER_SIDE_PCT,
          confidenceDefinition: "checklist pass percentage; diagnostic completeness only, not a probability of success",
          metricType: "signal_value_not_executable_trade_pnl"
        };
        newSignals.push(record);
        knownSignals.add(id);
      }
      const futureBars = one;
      for (const signal of signals.concat(newSignals).filter(x => x.symbol === symbol)) {
        const signalMs = Date.parse(signal.signalTimeUtc);
        for (const horizon of HORIZONS) {
          const outcomeKey = signal.signalId + "|" + horizon;
          if (knownOutcomes.has(outcomeKey)) continue;
          const future = findFutureClose(futureBars, signalMs, horizon, observedAtMs);
          if (!future) continue;
          const outcome = buildOutcome(signal, horizon, future.close, new Date(future.closeTime).toISOString());
          if (outcome) {
            newOutcomes.push(outcome);
            knownOutcomes.add(outcomeKey);
          }
        }
      }
    } catch (error) {
      errors.push({ symbol, error: String(error.message || error), at: observedAt });
    }
  }

  appendJsonl(signalsFile, newSignals);
  appendJsonl(outcomesFile, newOutcomes);
  const allOutcomes = outcomes.concat(newOutcomes);
  const summary = {
    schema: 1,
    generatedAtUtc: new Date().toISOString(),
    mode: "forward_signal_evaluation",
    metricType: "signal_value_not_executable_trade_pnl",
    symbols: SYMBOLS,
    horizonsHours: HORIZONS,
    feesPerSidePct: FEE_PER_SIDE_PCT,
    randomBaselineSeeds: RANDOM_SEEDS,
    signalCount: signals.length + newSignals.length,
    maturedOutcomeCount: allOutcomes.length,
    newSignals: newSignals.length,
    newOutcomes: newOutcomes.length,
    errors,
    metrics: summarize(allOutcomes),
    notes: [
      "Every unique closed 1h candle per symbol is recorded, including BUY, SELL and WAIT.",
      "WAIT_NEAR_MISS means WAIT with a directional bias and no more than two failed checklist gates; this is analysis-only and does not change the decision engine.",
      "Checklist pass percentage is not a success probability or calibrated confidence.",
      "BUY/SELL directional returns and WAIT near-miss watch-direction returns are research metrics, not executed trades. SELL is not a short order.",
      "Net directional return applies 0.10% fee per side. Buy-and-hold and deterministic 100-seed random-direction baselines use the same fee model.",
      "Higher-timeframe candles are aligned to the 1h signal candle close. Signal collection time and market price observation are recorded separately.",
      "Do not tune parameters on this forward-evaluation sample. Preserve it as unseen evaluation data."
    ]
  };
  atomicJson(path.join(dataDir, "summary.json"), summary);
  console.log(JSON.stringify({ newSignals: newSignals.length, newOutcomes: newOutcomes.length, errors, matured: allOutcomes.length }, null, 2));
  if (errors.length === SYMBOLS.length) throw new Error("All six symbol evaluations failed; see summary.json");
}

if (require.main === module) {
  const argIndex = process.argv.indexOf("--data-dir");
  const dataDir = argIndex >= 0 ? path.resolve(process.argv[argIndex + 1]) : path.resolve("forward-test");
  run(dataDir).catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { netReturnPct, directionalGrossPct, randomBaselineMean, deriveWatchDirection, isNearMiss, buildOutcome, summarize, findFutureClose };
