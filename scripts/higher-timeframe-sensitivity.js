"use strict";

// Research-only higher-timeframe confirmation sensitivity.
// It reports signal counts only; it does not change production settings or place orders.
global.window = global;
require("../trading-engine.js");
const E = global.TradingEngine;
const fs = require("node:fs");
const path = require("node:path");

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];

function readCsv(file) {
  const lines = fs.readFileSync(file, "utf8").trim().split(/\r?\n/);
  if (lines.length < 2) throw new Error("Archive contains no candle rows: " + file);
  const headers = lines[0].split(",");
  const ix = Object.fromEntries(headers.map((h, i) => [h, i]));
  const required = ["open_time_utc", "close_time_utc", "open", "high", "low", "close", "base_volume"];
  for (const key of required) if (!(key in ix)) throw new Error("Missing " + key + " in " + file);
  const bars = lines.slice(1).filter(Boolean).map(line => {
    const c = line.split(",");
    return {
      time: Date.parse(c[ix.open_time_utc]), closeTime: Date.parse(c[ix.close_time_utc]),
      open: Number(c[ix.open]), high: Number(c[ix.high]), low: Number(c[ix.low]),
      close: Number(c[ix.close]), volume: Number(c[ix.base_volume])
    };
  });
  if (bars.some(b => ![b.time,b.closeTime,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite) ||
      b.closeTime < b.time || b.open <= 0 || b.high <= 0 || b.low <= 0 || b.close <= 0 || b.volume < 0 ||
      b.high < Math.max(b.open,b.close,b.low) || b.low > Math.min(b.open,b.close,b.high))) {
    throw new Error("Invalid candle in " + file);
  }
  for (let i = 1; i < bars.length; i++) if (bars[i].time <= bars[i-1].time) throw new Error("Unsorted/duplicate candle in " + file);
  return E.enrich(bars);
}

function lastClosedIndex(series, timestamp) {
  let lo = 0, hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (series[mid].closeTime <= timestamp) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function blankCounts() {
  return { BUY: 0, SELL: 0, WAIT: 0, CONFLICT: 0 };
}
function addDecision(counts, direction) {
  if (direction === "BUY" || direction === "SELL") counts[direction]++;
  else counts.WAIT++;
}

function evaluateSymbol(symbol, dataDir) {
  const one = readCsv(path.join(dataDir, symbol, "1h.csv"));
  const four = readCsv(path.join(dataDir, symbol, "4h.csv"));
  const day = readCsv(path.join(dataDir, symbol, "1d.csv"));
  const modes = { strictBoth: blankCounts(), fourHourOnly: blankCounts(), dailyOnly: blankCounts(), eitherHigher: blankCounts() };
  let evaluated = 0;
  const halfSpreadPct = 0.10 / 2;
  for (let i = 219; i < one.length; i++) {
    const bar = one[i];
    const fi = lastClosedIndex(four, bar.closeTime);
    const di = lastClosedIndex(day, bar.closeTime);
    if (fi < 219 || di < 219) continue;
    const main = E.analyzeSeriesAt(one, i, true);
    main.checks = E.explainCandle(main.bar);
    const h4 = E.analyzeSeriesAt(four, fi, true);
    const d1 = E.analyzeSeriesAt(day, di, true);
    const halfSpread = bar.close * halfSpreadPct / 100;
    const market = { price: bar.close, closeTime: bar.closeTime, bid: bar.close - halfSpread, ask: bar.close + halfSpread };
    const opts = { historical: true, feePct: 0.10, slippagePct: 0.05 };
    const strict = E.evaluateSignal(main, [h4, d1], market, opts);
    // The duplicated frame is a research adapter for the existing "both supplied frames agree" API.
    // It means "the named single timeframe is the sole confirmation source", not two independent votes.
    const fourOnly = E.evaluateSignal(main, [h4, h4], market, opts);
    const dailyOnly = E.evaluateSignal(main, [d1, d1], market, opts);
    addDecision(modes.strictBoth, strict.direction);
    addDecision(modes.fourHourOnly, fourOnly.direction);
    addDecision(modes.dailyOnly, dailyOnly.direction);
    if (fourOnly.direction === dailyOnly.direction && (fourOnly.direction === "BUY" || fourOnly.direction === "SELL")) {
      addDecision(modes.eitherHigher, fourOnly.direction);
    } else if ((fourOnly.direction === "BUY" && dailyOnly.direction === "SELL") ||
               (fourOnly.direction === "SELL" && dailyOnly.direction === "BUY")) {
      modes.eitherHigher.CONFLICT++;
    } else {
      modes.eitherHigher.WAIT++;
    }
    evaluated++;
  }
  return { symbol, evaluatedHourlyBars: evaluated, modes };
}

function run(dataDir, outputFile) {
  const results = SYMBOLS.map(symbol => evaluateSymbol(symbol, dataDir));
  const totals = {};
  for (const mode of ["strictBoth", "fourHourOnly", "dailyOnly", "eitherHigher"]) {
    totals[mode] = blankCounts();
    for (const result of results) {
      for (const key of Object.keys(totals[mode])) totals[mode][key] += result.modes[mode][key];
    }
  }
  const report = {
    schema: 1,
    generatedAtUtc: new Date().toISOString(),
    source: "paper-data/historical-data/binance",
    purpose: "Research-only signal-count sensitivity; not a production strategy change or profitability test.",
    noProductionRuleChanges: true,
    modes: {
      strictBoth: "Canonical production confirmation: 4h AND 1d agree.",
      fourHourOnly: "Research comparison: 4h is the sole higher-timeframe confirmation.",
      dailyOnly: "Research comparison: 1d is the sole higher-timeframe confirmation.",
      eitherHigher: "Research comparison: accept only when 4h-only and 1d-only independently agree on the same direction; opposite directions are conflicts."
    },
    results, totals
  };
  fs.mkdirSync(path.dirname(outputFile), { recursive: true });
  const temp = outputFile + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(report, null, 2) + "\n");
  fs.renameSync(temp, outputFile);
  console.log(JSON.stringify({ outputFile, totals }, null, 2));
  return report;
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const di = args.indexOf("--data-dir"), oi = args.indexOf("--output");
  run(di >= 0 ? args[di + 1] : "historical-data/binance",
      oi >= 0 ? args[oi + 1] : "historical-data/diagnostics/higher-timeframe-sensitivity.json");
}
module.exports = { readCsv, lastClosedIndex, evaluateSymbol, run };
