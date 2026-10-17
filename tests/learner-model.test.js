"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const cp = require("node:child_process");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "learner-model-test-"));
try {
  const input = path.join(temp, "learner-data.ndjson");
  const modelData = path.join(temp, "data", "learner-model.json");
  const modelPublic = path.join(temp, "public", "learner-model.json");
  const examples = [
    { id: "t1", symbol: "BTCUSDT", entry: 100, fastMinusSlow: 0.5, momentum: 2, spreadPct: 0.05, label: 1, pnl: 10, createdAt: "2026-01-01T00:00:00.000Z" },
    { id: "t2", symbol: "BTCUSDT", entry: 101, fastMinusSlow: -0.2, momentum: -1, spreadPct: 0.04, label: 0, pnl: -5, createdAt: "2026-01-01T00:01:00.000Z" }
  ];
  fs.writeFileSync(input, examples.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");

  cp.execFileSync(process.execPath, [path.resolve(__dirname, "../scripts/refresh-learner-model.js")], {
    stdio: "inherit",
    env: { ...process.env, LEARNER_DATA_FILE: input, LEARNER_MODEL_FILE: modelData, LEARNER_PUBLIC_MODEL_FILE: modelPublic }
  });

  assert.ok(fs.existsSync(modelData), "data model was not created");
  assert.ok(fs.existsSync(modelPublic), "public model was not created");
  const m1 = JSON.parse(fs.readFileSync(modelData, "utf8"));
  const m2 = JSON.parse(fs.readFileSync(modelPublic, "utf8"));
  for (const model of [m1, m2]) {
    assert.equal(model.samples, 2);
    assert.equal(model.winRate, 0.5);
    assert.equal(model.adaptiveStrength, 0);
    assert.equal(model.status, "insufficient-data");
    assert.equal(model.avgPnl, 2.5);
    assert.equal(model.schema, 1);
  }
  assert.deepEqual(m1, m2);
  console.log("Learner model test passed.");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}
