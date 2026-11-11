"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), "paper-data-writer-test-"));
const remote = path.join(temporaryRoot, "remote.git");
const repository = path.join(temporaryRoot, "repository");
const helperSource = path.resolve(__dirname, "../scripts/persist-paper-data.sh");

function runGit(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
function write(relativePath, content) {
  const target = path.join(repository, relativePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}
function readGit(ref, relativePath) {
  return runGit(repository, ["show", ref + ":" + relativePath]);
}
function setupTrackedFile(relativePath, content) {
  write(relativePath, content);
}

try {
  fs.mkdirSync(repository, { recursive: true });
  runGit(temporaryRoot, ["init", "--bare", remote]);
  runGit(repository, ["init", "-b", "main"]);
  runGit(repository, ["config", "user.name", "Paper data test"]);
  runGit(repository, ["config", "user.email", "paper-data-test@example.invalid"]);
  runGit(repository, ["remote", "add", "origin", remote]);

  fs.mkdirSync(path.join(repository, "scripts"), { recursive: true });
  fs.copyFileSync(helperSource, path.join(repository, "scripts/persist-paper-data.sh"));

  setupTrackedFile("data/fast-paper-state-5s.json", '{"marker":"seed-5s"}\n');
  setupTrackedFile("data/fast-paper-latest-5s.json", '{"marker":"seed-report-5s"}\n');
  setupTrackedFile("data/fast-reports/5s/seed.json", '{"marker":"seed-history-5s"}\n');
  setupTrackedFile("data/fast-paper-state-15s.json", '{"marker":"seed-15s"}\n');
  setupTrackedFile("data/fast-paper-latest-15s.json", '{"marker":"seed-report-15s"}\n');
  setupTrackedFile("data/fast-reports/15s/seed.json", '{"marker":"seed-history-15s"}\n');
  setupTrackedFile("data/paper-state.json", '{"marker":"seed-2h"}\n');
  setupTrackedFile("data/latest-report.json", '{"marker":"seed-report-2h"}\n');
  setupTrackedFile("data/reports/seed.json", '{"marker":"seed-history-2h"}\n');

  runGit(repository, ["add", "scripts/persist-paper-data.sh", "data"]);
  runGit(repository, ["commit", "-m", "Seed paper-data test repository"]);
  runGit(repository, ["push", "-u", "origin", "main"]);
  runGit(repository, ["checkout", "-b", "paper-data"]);
  runGit(repository, ["push", "-u", "origin", "paper-data"]);
  runGit(repository, ["checkout", "main"]);
  runGit(repository, ["fetch", "origin", "+refs/heads/paper-data:refs/remotes/origin/paper-data"]);

  const scenarios = [
    {
      mode: "fast-5s",
      marker: "fresh-5s",
      file: "data/fast-paper-state-5s.json",
      history: "data/fast-reports/5s/fresh.json",
      expectedMain: "seed-5s"
    },
    {
      mode: "fast-15s",
      marker: "fresh-15s",
      file: "data/fast-paper-state-15s.json",
      history: "data/fast-reports/15s/fresh.json",
      expectedMain: "seed-15s"
    },
    {
      mode: "two-hour",
      marker: "fresh-2h",
      file: "data/paper-state.json",
      history: "data/reports/fresh.json",
      expectedMain: "seed-2h"
    }
  ];

  for (const scenario of scenarios) {
    write(scenario.file, JSON.stringify({ marker: scenario.marker }) + "\n");
    write(scenario.history, JSON.stringify({ marker: scenario.marker + "-history" }) + "\n");
    execFileSync("bash", ["scripts/persist-paper-data.sh", scenario.mode], {
      cwd: repository,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    runGit(repository, ["fetch", "origin", "+refs/heads/paper-data:refs/remotes/origin/paper-data"]);
    assert.match(readGit("origin/paper-data", scenario.file), new RegExp(scenario.marker),
      scenario.mode + " must persist its state to paper-data");
    assert.match(readGit("origin/paper-data", scenario.history), new RegExp(scenario.marker + "-history"),
      scenario.mode + " must append report history to paper-data");
    assert.match(readGit("origin/main", scenario.file), new RegExp(scenario.expectedMain),
      scenario.mode + " must not commit paper data into main");
  }

  let badMode = false;
  try {
    execFileSync("bash", ["scripts/persist-paper-data.sh", "not-a-mode"], {
      cwd: repository,
      stdio: "ignore"
    });
  } catch (error) {
    badMode = error.status === 2;
  }
  assert.equal(badMode, true, "unknown modes must fail safely");
  console.log("Paper data persistence integration tests passed for 5s, 15s and 2-hour portfolios.");
} finally {
  fs.rmSync(temporaryRoot, { recursive: true, force: true });
}
