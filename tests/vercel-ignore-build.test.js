"use strict";

const assert = require("node:assert/strict");
const { isPaperTelemetryPath, isDeploymentRelevantPath, shouldIgnoreBuild } = require("../scripts/vercel-ignore-build");

for (const p of [
  "data/paper-state.json",
  "data/latest-report.json",
  "data/reports/2026-10-15T15-00-00-000Z.json",
  "data/reports/2026-10-15T15-00-00-000Z.md",
  "data/fast-paper-state-5s.json",
  "data/fast-paper-latest-15s.json",
  "data/fast-reports/5s/session.json",
  "data/fast-reports/15s/session.json"
]) assert.equal(isPaperTelemetryPath(p), true, p + " should be classified as paper telemetry");

for (const p of [
  "public/index.html",
  "api/market.js",
  "scripts/fast-paper-trader.js",
  "vercel.json",
  "data/unrecognized.json"
]) assert.equal(isPaperTelemetryPath(p), false, p + " must not be classified as a recognized paper report");

for (const p of [
  "public/index.html",
  "public/trading-engine.js",
  "api/market.js",
  "vercel.json",
  "package.json",
  "app.py",
  "requirements.txt"
]) assert.equal(isDeploymentRelevantPath(p), true, p + " must trigger a deployment");

for (const p of [
  "README.md",
  ".github/workflows/paper-trading-cycle.yml",
  "scripts/persist-paper-data.sh",
  "scripts/vercel-ignore-build.js",
  "tests/paper-data-persistence.test.js",
  "tests/trading-engine.test.js",
  "trading-engine.js",
  "data/unrecognized.json"
]) assert.equal(isDeploymentRelevantPath(p), false, p + " does not belong in the deployed public/API artifact");

assert.equal(shouldIgnoreBuild("paper-data", ["public/index.html"]), true,
  "the dedicated paper-data branch must never produce a Vercel deployment");
const deploymentConfig = require("../vercel.json");
assert.equal(deploymentConfig.git?.deploymentEnabled?.["paper-data"], false,
  "Vercel Git integration must not create deployments from paper-data commits");
assert.equal(shouldIgnoreBuild("main", ["data/paper-state.json", "data/reports/cycle.md"]), true);
assert.equal(shouldIgnoreBuild("main", ["README.md", ".github/workflows/paper-trading-cycle.yml", "tests/paper-data-persistence.test.js"]), true,
  "documentation, workflow and test-only commits should not consume deployment builds");
assert.equal(shouldIgnoreBuild("main", ["scripts/persist-paper-data.sh", "scripts/vercel-ignore-build.js"]), true,
  "non-deployed scripts should not trigger a deployment");
assert.equal(shouldIgnoreBuild("main", ["data/fast-paper-latest-5s.json", "public/index.html"]), false,
  "mixed telemetry + UI changes must still trigger a deploy");
assert.equal(shouldIgnoreBuild("main", ["README.md", "api/market.js"]), false,
  "API changes must still trigger a deploy");
assert.equal(shouldIgnoreBuild("main", ["vercel.json"]), false);
assert.equal(shouldIgnoreBuild("main", ["package.json"]), false);
assert.equal(shouldIgnoreBuild("main", []), false,
  "an empty/unavailable diff must fail open and run the deployment");

console.log("Vercel build filter tests passed: report-only and non-deployed source changes skip; application changes build.");
