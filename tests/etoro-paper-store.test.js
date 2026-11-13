"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createPersistentEtoroPaperLedger } = require("../scripts/etoro-paper-store");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "etoro-paper-store-"));
const filePath = path.join(root, "paper", "ledger.json");
const openedAt = Date.parse("2026-11-13T10:00:00.000Z");
const entryQuote = { source: "ETORO", instrumentId: 1001, bid: 99, ask: 101, timestamp: openedAt - 500 };
const exitQuote = { source: "ETORO", instrumentId: 1001, bid: 103, ask: 104, timestamp: openedAt + 500 };

try {
  const ledger = createPersistentEtoroPaperLedger({ filePath, feeRate: 0.001, maxQuoteAgeMs: 2000 });
  assert.equal(ledger.snapshot().openPositions.length, 0);
  assert.throws(() => ledger.open({ action: "BUY", instrumentId: 1001 }, {
    ...entryQuote, timestamp: openedAt - 3000
  }, 2, openedAt), /fresh, valid/);
  assert.equal(ledger.snapshot().openPositions.length, 0, "stale quote must not create a paper position");

  const opened = ledger.open({ action: "BUY", instrumentId: 1001 }, entryQuote, 2, openedAt);
  assert.equal(opened.entryPrice, 101, "BUY enters at ask");
  const persisted = JSON.parse(fs.readFileSync(filePath, "utf8"));
  assert.equal(persisted.schemaVersion, 1);
  assert.equal(persisted.mode, "ETORO_PAPER");
  assert.equal(persisted.snapshot.openPositions.length, 1);
  assert.equal(persisted.snapshot.execution, "LOCAL_PAPER_ONLY");
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600, "ledger file must be owner-readable only");

  const restored = createPersistentEtoroPaperLedger({ filePath, feeRate: 0.001, maxQuoteAgeMs: 2000 });
  assert.equal(restored.snapshot().openPositions.length, 1, "open positions survive process restart");
  const closed = restored.close(1001, exitQuote, openedAt + 1000);
  assert.equal(closed.exitPrice, 103, "BUY exits at bid");
  assert.ok(closed.netPnl < closed.grossPnl, "fees reduce paper PnL");

  const afterRestart = createPersistentEtoroPaperLedger({ filePath, feeRate: 0.001, maxQuoteAgeMs: 2000 });
  assert.equal(afterRestart.snapshot().openPositions.length, 0);
  assert.equal(afterRestart.snapshot().closedTrades.length, 1, "closed trades survive process restart");
  assert.equal(afterRestart.snapshot().closedTrades[0].status, "CLOSED");

  const corruptPath = path.join(root, "corrupt.json");
  fs.writeFileSync(corruptPath, "{broken");
  assert.throws(() => createPersistentEtoroPaperLedger({ filePath: corruptPath }), /unreadable/);
  const wrongModePath = path.join(root, "wrong-mode.json");
  fs.writeFileSync(wrongModePath, JSON.stringify({ schemaVersion: 1, mode: "LIVE", snapshot: { execution: "LIVE" } }));
  assert.throws(() => createPersistentEtoroPaperLedger({ filePath: wrongModePath }), /unsupported schema or mode/);
  console.log("eToro persistent paper ledger tests passed: freshness, atomic persistence, restart recovery, permissions and fail-closed corruption handling.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
