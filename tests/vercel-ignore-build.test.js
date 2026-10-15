"use strict";

const assert = require("node:assert/strict");
const { isPaperTelemetryPath, shouldIgnoreBuild } = require("../scripts/vercel-ignore-build");

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
]) assert.equal(isPaperTelemetryPath(p), false, p + " must not be classified as paper telemetry");

assert.equal(shouldIgnoreBuild("paper-data", ["public/index.html"]), true,
  "the dedicated paper-data branch must never produce a Vercel deployment");
assert.equal(shouldIgnoreBuild("main", ["data/paper-state.json", "data/reports/cycle.md"]), true);
assert.equal(shouldIgnoreBuild("main", ["data/fast-paper-latest-5s.json", "public/index.html"]), false,
  "mixed telemetry + UI changes must still trigger a deploy");
assert.equal(shouldIgnoreBuild("main", ["api/market.js"]), false);
assert.equal(shouldIgnoreBuild("main", []), false,
  "an empty/unavailable diff must fail open and run the deployment");

console.log("Vercel build filter tests passed: report-only and paper-data commits skip; application changes build.");
