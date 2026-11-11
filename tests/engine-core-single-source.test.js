"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const root = fs.readFileSync(path.join(__dirname, "../trading-engine.js"), "utf8");
const browser = fs.readFileSync(path.join(__dirname, "../public/trading-engine.js"), "utf8");
const marker = "  root.TradingEngine={";
const rootBoundary = root.indexOf(marker);
const browserBoundary = browser.indexOf(marker);
assert.ok(rootBoundary > 0 && browserBoundary > 0, "both engines expose the shared public API boundary");
assert.equal(root.slice(0, rootBoundary), browser.slice(0, browserBoundary),
  "the pure indicator and decision engine must remain byte-identical across server and browser entry points");
assert.ok(root.slice(0, rootBoundary).includes("vwap:vwap[i]"),
  "the canonical shared indicator engine includes daily VWAP");
console.log("Shared JavaScript engine source parity passed.");
