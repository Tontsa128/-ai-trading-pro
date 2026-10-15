"use strict";

const { execFileSync } = require("node:child_process");

function isPaperTelemetryPath(file) {
  return /^data\/(?:paper-state\.json|latest-report\.json|reports\/[^/]+\.(?:json|md)|fast-paper-state-(?:5|15)s\.json|fast-paper-latest-(?:5|15)s\.json|fast-reports\/(?:5s|15s)\/[^/]+\.json)$/.test(file);
}

function shouldIgnoreBuild(ref, changedFiles) {
  if (ref === "paper-data") return true;
  return Array.isArray(changedFiles) && changedFiles.length > 0 && changedFiles.every(isPaperTelemetryPath);
}

function main() {
  const ref = process.env.VERCEL_GIT_COMMIT_REF || "";
  if (shouldIgnoreBuild(ref, [])) {
    console.log("Skipping deployment from the paper-data branch; this branch only stores simulation state and reports.");
    process.exit(0);
  }
  const current = process.env.VERCEL_GIT_COMMIT_SHA || "HEAD";
  const previous = process.env.VERCEL_GIT_PREVIOUS_SHA || current + "^";
  let files;
  try {
    files = execFileSync("git", ["diff", "--name-only", previous, current], { encoding: "utf8" })
      .split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  } catch (error) {
    console.log("Could not safely compare Vercel commit files; proceeding with build. " + String(error.message || error));
    process.exit(1);
  }
  if (shouldIgnoreBuild(ref, files)) {
    console.log("Skipping Vercel build because this commit only changes paper-trading state and report files.");
    process.exit(0);
  }
  console.log("Application code or configuration changed; proceeding with Vercel build.");
  process.exit(1);
}

if (require.main === module) main();
module.exports = { isPaperTelemetryPath, shouldIgnoreBuild };
