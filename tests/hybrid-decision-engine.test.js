"use strict";
const assert=require("node:assert/strict");
const H=require("../public/hybrid-decision-engine.js");
const bullish=[
 {source:"technical",direction:"BULLISH",strength:1,reliability:.9,weight:2},
 {source:"structure",direction:"BULLISH",strength:.8,reliability:.9,weight:2},
 {source:"higher-timeframe",direction:"BULLISH",strength:1,reliability:.8,weight:2},
 {source:"volume",direction:"NEUTRAL",strength:0,reliability:1,weight:1}
];
const aligned=H.analyze({evidence:bullish,baseDirection:"BUY",risk:{dataFresh:true,riskAllowed:true,spreadPct:.05,maxSpreadPct:.15,timeframeAligned:true}});
assert.equal(aligned.state,"OK");
assert.equal(aligned.researchBias,"BULLISH");
assert.equal(aligned.baseDisagreement,false);
assert.ok(aligned.score>0.5&&aligned.score<=1,"score is normalized and bounded");
const conflict=H.analyze({evidence:[bullish[0],{source:"counter",direction:"BEARISH",strength:1,reliability:1,weight:3}],baseDirection:"BUY",risk:{dataFresh:true,riskAllowed:true}});
assert.ok(conflict.conflicts===1,"opposing evidence is counted explicitly");
assert.ok(conflict.baseDisagreement,"hybrid research can expose disagreement with the existing signal");
const blocked=H.analyze({evidence:bullish,baseDirection:"BUY",risk:{dataFresh:false,riskAllowed:true,spreadPct:.2,maxSpreadPct:.15,timeframeAligned:true}});
assert.equal(blocked.state,"BLOCKED");
assert.equal(blocked.researchBias,"WAIT");
assert.ok(blocked.gates.includes("STALE_DATA")&&blocked.gates.includes("SPREAD_TOO_WIDE"));
const insufficient=H.analyze({evidence:[{direction:"NEUTRAL",strength:0,reliability:1,weight:1}]});
assert.equal(insufficient.state,"INSUFFICIENT_EVIDENCE");
const invalid=H.analyze({evidence:[{direction:"BULLISH",strength:2,reliability:1,weight:1}]});
assert.equal(invalid.state,"INVALID_EVIDENCE");
console.log("Hybrid decision engine tests passed.");
