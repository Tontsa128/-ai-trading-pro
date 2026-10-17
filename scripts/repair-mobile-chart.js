"use strict";

const fs = require("node:fs");
const path = require("node:path");

const file = path.join(process.cwd(), "public", "trading-engine.js");
const marker = "Rahasampo mobile chart fallback";

const source = fs.readFileSync(file, "utf8");
if (!source.includes(marker)) {
  fs.writeFileSync(file, `${source.trimEnd()}\n\n/* Rahasampo mobile chart fallback */\n(function () {\n  "use strict";\n  if (window.matchMedia && window.matchMedia("(max-width: 850px)").matches) {\n    window.Plotly = null;\n  }\n})();\n`, "utf8");
}

console.log("Mobile chart repair applied: small screens use the dependency-free SVG renderer.");
