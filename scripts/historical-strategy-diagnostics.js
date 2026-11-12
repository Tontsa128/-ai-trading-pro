"use strict";

// Point-in-time diagnostics for the canonical Spot decision engine.
// Reads only archived, closed Binance candles. Never places orders or tunes rules.
global.window = global;
require("../trading-engine.js");
const E = global.TradingEngine;
const fs = require("node:fs");
const path = require("node:path");

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
const HOUR_MS = 3600000;
const FEE_PCT = 0.10;
const SLIPPAGE_PCT = 0.05;
const ASSUMED_SPREAD_PCT = 0.10;
const RANDOM_SEEDS = 100;

function readCsv(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("Archive contains no candle rows: " + file);
  const headers = lines[0].split(",");
  const indexes = Object.fromEntries(headers.map((name, i) => [name, i]));
  const required = ["open_time_utc", "close_time_utc", "open", "high", "low", "close", "base_volume", "available_at_utc"];
  for (const name of required) if (!(name in indexes)) throw new Error("Missing CSV column " + name + " in " + file);
  const bars = lines.slice(1).filter(Boolean).map(line => {
    const cells = line.split(",");
    const bar = {
      time: Date.parse(cells[indexes.open_time_utc]),
      closeTime: Date.parse(cells[indexes.close_time_utc]),
      availableAt: Date.parse(cells[indexes.available_at_utc]),
      open: Number(cells[indexes.open]), high: Number(cells[indexes.high]),
      low: Number(cells[indexes.low]), close: Number(cells[indexes.close]),
      volume: Number(cells[indexes.base_volume])
    };
    if (![bar.time, bar.closeTime, bar.availableAt, bar.open, bar.high, bar.low, bar.close, bar.volume].every(Number.isFinite) ||
        bar.closeTime < bar.time || bar.availableAt <= bar.closeTime ||
        bar.open <= 0 || bar.high <= 0 || bar.low <= 0 || bar.close <= 0 || bar.volume < 0 ||
        bar.high < Math.max(bar.open, bar.close, bar.low) || bar.low > Math.min(bar.open, bar.close, bar.high)) {
      throw new Error("Invalid candle row in " + file);
    }
    return bar;
  });
  for (let i = 1; i < bars.length; i++) {
    if (bars[i].time <= bars[i - 1].time) throw new Error("Non-monotonic or duplicate candle timestamps in " + file);
  }
  return E.enrich(bars);
}

function lastIndexAtOrBefore(bars, timestamp) {
  let lo = 0, hi = bars.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].closeTime <= timestamp) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function randomValue(seed, symbol) {
  let h = seed >>> 0;
  for (let i = 0; i < symbol.length; i++) h = Math.imul(h ^ symbol.charCodeAt(i), 16777619) >>> 0;
  h ^= h << 13; h ^= h >>> 17; h ^= h << 5;
  return (h >>> 0) / 4294967296;
}

function baselineReturns(symbol, entry, finalPrice, friction) {
  if (!(entry > 0) || !(finalPrice > 0)) return { buyAndHoldNetPct: null, randomDirectionMeanNetPct: null };
  const buyGross = (finalPrice / entry - 1) * 100;
  const buyNet = ((1 + buyGross / 100) * (1 - friction) - 1) * 100;
  const random = [];
  for (let seed = 0; seed < RANDOM_SEEDS; seed++) {
    const isBuy = randomValue(seed, symbol) >= 0.5;
    const gross = isBuy ? buyGross : (entry / finalPrice - 1) * 100;
    random.push(((1 + gross / 100) * (1 - friction) - 1) * 100);
  }
  return { buyAndHoldNetPct: buyNet, randomDirectionMeanNetPct: random.reduce((a, b) => a + b, 0) / random.length };
}

function evaluateArchive(symbol, dataDir) {
  const one = readCsv(path.join(dataDir, symbol, "1h.csv"));
  const four = readCsv(path.join(dataDir, symbol, "4h.csv"));
  const day = readCsv(path.join(dataDir, symbol, "1d.csv"));
  if (one.length < 220 || four.length < 220 || day.length < 220) {
    throw new Error("Insufficient warm-up history: 1h=" + one.length + ", 4h=" + four.length + ", 1d=" + day.length + "; need at least 220 each.");
  }

  const gateFailures = {};
  const gatePasses = {};
  let evaluated = 0, buys = 0, sells = 0, waits = 0, nearMisses = 0;
  let longCoreBars = 0, shortCoreBars = 0, higherBull = 0, higherBear = 0;
  let firstEligible = null, firstEligibleIndex = null, lastEligible = null;
  const assumedHalfSpread = ASSUMED_SPREAD_PCT / 200;

  for (let i = 219; i < one.length; i++) {
    const bar = one[i];
    const dayIndex = lastIndexAtOrBefore(day, bar.closeTime);
    const fourIndex = lastIndexAtOrBefore(four, bar.closeTime);
    if (fourIndex < 219 || dayIndex < 219) continue;
    const main = E.analyzeSeriesAt(one, i, true);
    main.checks = E.explainCandle(main.bar);
    const higher = [E.analyzeSeriesAt(four, fourIndex, true), E.analyzeSeriesAt(day, dayIndex, true)];
    if (!firstEligible) { firstEligible = new Date(bar.closeTime).toISOString(); firstEligibleIndex = i; }
    lastEligible = new Date(bar.closeTime).toISOString();
    if (main.longCore) longCoreBars++;
    if (main.shortCore) shortCoreBars++;
    if (higher.every(x => x.checks.bias === "bull")) higherBull++;
    if (higher.every(x => x.checks.bias === "bear")) higherBear++;
    const price = bar.close;
    const decision = E.evaluateSignal(main, higher, {
      price, closeTime: bar.closeTime,
      bid: price * (1 - assumedHalfSpread),
      ask: price * (1 + assumedHalfSpread)
    }, { historical: true, feePct: FEE_PCT, slippagePct: SLIPPAGE_PCT });
    evaluated++;
    if (decision.direction === "BUY") buys++;
    else if (decision.direction === "SELL") sells++;
    else {
      waits++;
      const failed = decision.checklist.filter(x => !x.ok).length;
      if (failed <= 2 && decision.trendBias !== "neutral") nearMisses++;
    }
    for (const check of decision.checklist) {
      const target = check.ok ? gatePasses : gateFailures;
      target[check.name] = (target[check.name] || 0) + 1;
    }
  }

  const friction = E.estimateRoundTripFriction(FEE_PCT, SLIPPAGE_PCT, ASSUMED_SPREAD_PCT);
  const backtest = E.backtest(one, {
    capital: 10000, riskPct: 0.5, maxExposurePct: 25,
    feePct: FEE_PCT, slippagePct: SLIPPAGE_PCT,
    assumedSpreadPct: ASSUMED_SPREAD_PCT,
    higherSeries: [four, day], startIndex: 220
  });
  const baselineStart = firstEligibleIndex === null ? null : one[Math.min(one.length - 1, firstEligibleIndex + 1)];
  const baselineEnd = one[one.length - 1];
  const baselines = baselineStart ? baselineReturns(symbol, baselineStart.open, baselineEnd.close, friction) :
    { buyAndHoldNetPct: null, randomDirectionMeanNetPct: null };

  return {
    symbol,
    source: "Binance public Spot closed-candle CSV archive",
    candleCounts: { "1h": one.length, "4h": four.length, "1d": day.length },
    evaluatedHourlyBars: evaluated,
    eligibleWindowUtc: { first: firstEligible, last: lastEligible },
    signalCounts: { BUY: buys, SELL: sells, WAIT: waits, WAIT_NEAR_MISS: nearMisses },
    setupDiagnostics: { longCoreBars, shortCoreBars, bothHigherBullBars: higherBull, bothHigherBearBars: higherBear },
    gateFailures,
    gatePasses,
    canonicalLongOnlySpotBacktest: {
      trades: backtest.count, wins: backtest.wins, winRatePct: backtest.winRate,
      netPnlUsdt: backtest.netPnl, netReturnPct: backtest.netPct,
      maxDrawdownPct: backtest.maxDrawdownPct, profitFactor: Number.isFinite(backtest.profitFactor) ? backtest.profitFactor : null,
      startCapitalUsdt: backtest.startCapital, endEquityUsdt: backtest.endEquity
    },
    sameWindowBaselines: {
      windowStartUtc: baselineStart ? new Date(baselineStart.time).toISOString() : null,
      windowEndUtc: new Date(baselineEnd.time).toISOString(),
      buyAndHoldNetReturnPct: baselines.buyAndHoldNetPct,
      randomDirectionMeanNetReturnPct: baselines.randomDirectionMeanNetPct,
      randomSeeds: RANDOM_SEEDS,
      note: "Single entry-to-end directional baselines, not a trade-by-trade strategy simulation."
    },
    costAssumptions: { feePerSidePct: FEE_PCT, slippagePerSidePct: SLIPPAGE_PCT, assumedFullSpreadPct: ASSUMED_SPREAD_PCT, roundTripFrictionPct: friction * 100 },
    notes: [
      "Production signal rules and thresholds are unchanged.",
      "SELL counts are theoretical directional signals; the canonical historical trade simulation remains long-only Spot.",
      "Historical spread is assumed, not measured from archived order-book snapshots.",
      "Every higher-timeframe candle is selected only when its close timestamp is at or before the 1h decision candle close.",
      "This is exploratory in-sample diagnostics, not proof of profitability and not a parameter-tuning target."
    ]
  };
}

function run(dataDir, outputFile) {
  const results = SYMBOLS.map(symbol => evaluateArchive(symbol, dataDir));
  const report = {
    schema: 1,
    generatedAtUtc: new Date().toISOString(),
    source: "paper-data/historical-data/binance",
    symbols: SYMBOLS,
    requiredTimeframes: ["1h", "4h", "1d"],
    archiveLookbackDays: 600,
    targetPostWarmupEvaluationDays: 365,
    results,
    totals: results.reduce((acc, item) => {
      for (const key of ["BUY", "SELL", "WAIT", "WAIT_NEAR_MISS"]) acc[key] += item.signalCounts[key];
      acc.backtestTrades += item.canonicalLongOnlySpotBacktest.trades;
      return acc;
    }, { BUY: 0, SELL: 0, WAIT: 0, WAIT_NEAR_MISS: 0, backtestTrades: 0 })
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const temp = outputFile + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(report, null, 2) + "\n");
  fs.renameSync(temp, outputFile);
  console.log(JSON.stringify({ outputFile, totals: report.totals, symbols: results.map(x => ({ symbol: x.symbol, candleCounts: x.candleCounts, trades: x.canonicalLongOnlySpotBacktest.trades, BUY: x.signalCounts.BUY, SELL: x.signalCounts.SELL, WAIT: x.signalCounts.WAIT })) }, null, 2));
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const dataIndex = args.indexOf("--data-dir");
  const outputIndex = args.indexOf("--output");
  const dataDir = dataIndex >= 0 ? args[dataIndex + 1] : "historical-data/binance";
  const outputFile = outputIndex >= 0 ? args[outputIndex + 1] : "historical-data/diagnostics/latest.json";
  run(dataDir, outputFile);
}

module.exports = { readCsv, lastIndexAtOrBefore, baselineReturns, evaluateArchive, run };
