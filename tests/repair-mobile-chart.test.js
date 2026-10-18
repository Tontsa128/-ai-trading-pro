"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "rahasampo-dashboard-repair-"));
const publicDir = path.join(temp, "public");
const script = path.resolve(__dirname, "../scripts/repair-mobile-chart.js");
const guardTag = '<script src="./live-signal-guards.js"></script>';
const liveTag = '<script src="./live-dashboard.js"></script>';

function runRepair() {
  execFileSync(process.execPath, [script], { cwd: temp, stdio: "pipe" });
}
function count(text, needle) {
  return text.split(needle).length - 1;
}

try {
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, "trading-engine.js"), "/* test trading engine */\n");
  fs.writeFileSync(path.join(publicDir, "index.html"), "<!doctype html><html><body></body></html>\n");

  runRepair();
  let html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  assert.equal(count(html, guardTag), 1, "fresh builds install exactly one freshness guard");
  assert.equal(count(html, liveTag), 1, "fresh builds install exactly one live dashboard");
  assert.ok(html.indexOf(guardTag) < html.indexOf(liveTag),
    "freshness guard must load before the dashboard consumes it");
  let engine = fs.readFileSync(path.join(publicDir, "trading-engine.js"), "utf8");
  assert.equal(count(engine, "Rahasampo mobile chart fallback"), 1,
    "the mobile SVG fallback is installed once");

  runRepair();
  html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  engine = fs.readFileSync(path.join(publicDir, "trading-engine.js"), "utf8");
  assert.equal(count(html, guardTag), 1, "repair is idempotent for the freshness guard");
  assert.equal(count(html, liveTag), 1, "repair is idempotent for the live dashboard");
  assert.equal(count(engine, "Rahasampo mobile chart fallback"), 1,
    "repair is idempotent for the mobile fallback");

  // Existing deployments may already inject the live script but not the new guard.
  fs.writeFileSync(path.join(publicDir, "index.html"),
    "<!doctype html><html><body>" + liveTag + "\n</body></html>\n");
  runRepair();
  html = fs.readFileSync(path.join(publicDir, "index.html"), "utf8");
  assert.equal(count(html, guardTag), 1, "existing dashboard injection gains one guard");
  assert.ok(html.indexOf(guardTag) < html.indexOf(liveTag),
    "guard is inserted before an already-present dashboard script");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Dashboard repair tests passed: guard injection order and idempotence are correct.");
