"use strict";

const fs = require("node:fs");
const path = require("node:path");

const engineFile = path.join(process.cwd(), "public", "trading-engine.js");
const indexFile = path.join(process.cwd(), "public", "index.html");
const engineMarker = "Rahasampo mobile chart fallback";
const guardMarker = '<script src="./live-signal-guards.js"></script>';
const liveMarker = '<script src="./live-dashboard.js"></script>';

const engine = fs.readFileSync(engineFile, "utf8");
if (!engine.includes(engineMarker)) {
  fs.writeFileSync(engineFile, `${engine.trimEnd()}\n\n/* Rahasampo mobile chart fallback */\n(function () {\n  "use strict";\n  if (window.matchMedia && window.matchMedia("(max-width: 850px)").matches) {\n    window.Plotly = null;\n  }\n})();\n`, "utf8");
}

let index = fs.readFileSync(indexFile, "utf8");
const originalIndex = index;
if (!index.includes("</body>")) throw new Error("public/index.html: </body> not found");
if (!index.includes(liveMarker)) {
  index = index.replace("</body>", `${liveMarker}\n</body>`);
}
if (!index.includes(guardMarker)) {
  if (!index.includes(liveMarker)) throw new Error("Could not install the live signal freshness guard.");
  index = index.replace(liveMarker, `${guardMarker}\n${liveMarker}`);
}
if (index !== originalIndex) fs.writeFileSync(indexFile, index, "utf8");

console.log("Dashboard repair applied: mobile SVG chart fallback + real-time Binance WebSocket live layer.");
