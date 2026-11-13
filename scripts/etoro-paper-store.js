"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createPaperLedger } = require("./etoro-market-feed");

const STORE_SCHEMA_VERSION = 1;

function createPersistentEtoroPaperLedger(options = {}) {
  if (typeof options.filePath !== "string" || !options.filePath.trim()) {
    throw new TypeError("A paper-ledger filePath is required.");
  }
  const filePath = path.resolve(options.filePath);
  let initialSnapshot;

  if (fs.existsSync(filePath)) {
    let stored;
    try {
      stored = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      throw new Error("Existing eToro paper ledger is unreadable; refusing to reset or overwrite it.");
    }
    if (!stored || stored.schemaVersion !== STORE_SCHEMA_VERSION ||
        stored.mode !== "ETORO_PAPER" || !stored.snapshot ||
        stored.snapshot.execution !== "LOCAL_PAPER_ONLY") {
      throw new Error("Existing eToro paper ledger has an unsupported schema or mode; refusing to overwrite it.");
    }
    initialSnapshot = stored.snapshot;
  } else {
    initialSnapshot = { openPositions: [], closedTrades: [], execution: "LOCAL_PAPER_ONLY" };
  }

  const ledger = createPaperLedger({ ...options, initialSnapshot });
  function persist() {
    const directory = path.dirname(filePath);
    fs.mkdirSync(directory, { recursive: true });
    const temporaryPath = filePath + "." + process.pid + "." + Date.now() + ".tmp";
    const payload = {
      schemaVersion: STORE_SCHEMA_VERSION,
      mode: "ETORO_PAPER",
      updatedAt: new Date().toISOString(),
      snapshot: ledger.snapshot()
    };
    try {
      fs.writeFileSync(temporaryPath, JSON.stringify(payload, null, 2) + "\n", { encoding: "utf8", mode: 0o600, flag: "wx" });
      fs.chmodSync(temporaryPath, 0o600);
      fs.renameSync(temporaryPath, filePath);
    } catch (error) {
      try { fs.unlinkSync(temporaryPath); } catch {}
      throw error;
    }
    return ledger.snapshot();
  }

  // Persist the initialized/validated state so the store has a known schema.
  persist();
  return Object.freeze({
    open(...args) {
      const result = ledger.open(...args);
      persist();
      return result;
    },
    close(...args) {
      const result = ledger.close(...args);
      persist();
      return result;
    },
    snapshot: () => ledger.snapshot(),
    flush: persist,
    filePath
  });
}

module.exports = { STORE_SCHEMA_VERSION, createPersistentEtoroPaperLedger };
