"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const inputPath = path.resolve(process.env.LEARNER_DATA_FILE || path.join(root, "data", "learner-data.ndjson"));
const outputPaths = [
  path.resolve(process.env.LEARNER_MODEL_FILE || path.join(root, "data", "learner-model.json")),
  path.resolve(process.env.LEARNER_PUBLIC_MODEL_FILE || path.join(root, "public", "learner-model.json"))
];

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function mean(values) {
  const valid = values.filter((v) => v !== null && Number.isFinite(v));
  return valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : null;
}

function loadExamples() {
  if (!fs.existsSync(inputPath)) return { examples: [], rejected: 0 };
  const examples = [];
  let rejected = 0;
  for (const line of fs.readFileSync(inputPath, "utf8").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const item = JSON.parse(line);
      const pnl = finite(item.pnl);
      const rawLabel = finite(item.label);
      const label = rawLabel === null ? (pnl === null ? null : pnl > 0 ? 1 : 0) : (rawLabel > 0 ? 1 : 0);
      if (typeof item.symbol !== "string" || !item.symbol || pnl === null || label === null) {
        rejected++;
        continue;
      }
      examples.push({
        symbol: item.symbol,
        pnl,
        label,
        momentum: finite(item.momentum),
        fastMinusSlow: finite(item.fastMinusSlow),
        spreadPct: finite(item.spreadPct)
      });
    } catch {
      rejected++;
    }
  }
  return { examples, rejected };
}

function buildModel({ examples, rejected }) {
  const wins = examples.filter((item) => item.label === 1).length;
  const winRate = examples.length ? wins / examples.length : null;
  const avgPnl = mean(examples.map((item) => item.pnl));
  // A bounded descriptive adjustment only; this is not a trained predictor.
  const adaptiveStrength = examples.length < 10 || winRate === null
    ? 0
    : Number(Math.max(-0.15, Math.min(0.15, (winRate - 0.5) * 0.3)).toFixed(4));
  return {
    schema: 1,
    modelType: "descriptive-paper-trading-statistics",
    generatedAt: new Date().toISOString(),
    samples: examples.length,
    rejectedRecords: rejected,
    winRate: winRate === null ? null : Number(winRate.toFixed(4)),
    adaptiveStrength,
    avgPnl: avgPnl === null ? null : Number(avgPnl.toFixed(6)),
    avgMomentum: mean(examples.map((item) => item.momentum)),
    avgFastSlow: mean(examples.map((item) => item.fastMinusSlow)),
    avgSpreadPct: mean(examples.map((item) => item.spreadPct)),
    status: examples.length < 10 ? "insufficient-data" : "descriptive-only",
    disclaimer: "Paper-trading statistics only; not a validated predictive model and not evidence of profitability."
  };
}

function main() {
  const data = loadExamples();
  const model = buildModel(data);
  const json = JSON.stringify(model, null, 2) + "\n";
  for (const outputPath of outputPaths) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json, "utf8");
  }
  console.log(`Learner model refreshed: ${model.samples} valid samples, ${model.rejectedRecords} rejected records; status=${model.status}`);
}

if (require.main === module) main();
module.exports = { buildModel, loadExamples };
