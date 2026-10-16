"use strict";
const fs=require("node:fs");

function patchFile(file){
  let s=fs.readFileSync(file,"utf8");
  if(s.includes('STRATEGY_VERSION="spot-long-v29"')) return false;
  s=s.replace(
    'var PERIOD=14, MIN_VOLUME_RATIO=0.5, STRATEGY_VERSION="spot-long-v28";',
    'var PERIOD=14, MIN_VOLUME_RATIO=0.5, MIN_ENTRY_SCORE=9, STRATEGY_VERSION="spot-long-v29";'
  );
  s=s.replace(
    'htfBull=higherOk&&four==="bull"&&daily==="bull"',
    'htfBull=higherOk&&(four==="bull"||daily==="bull")&&four!=="bear"&&daily!=="bear"'
  );
  s=s.replace(
    'var direction="WAIT",reason="ODOTA — long-only spot-strategian ehdot eivät täyty.";',
    'var scoreChecks=checks.filter(function(x){return x.group!=="Data OK";}),entryScore=scoreChecks.filter(function(x){return x.ok;}).length;var direction="WAIT",reason="ODOTA — long-only spot-strategian ehdot eivät täyty.";'
  );
  const buy=/if\(longTrend&&longMomentum&&rsiOk&&adxOk&&volOk&&htfBull&&fresh&&spreadOk&&!overextended&&!highVol\)\{direction="BUY";reason="OSTA \(SPOT\) — kaikki kriittiset long-entry ehdot täyttyvät\.";\}/;
  if(!buy.test(s)) throw new Error(`${file}: expected v28 BUY gate not found`);
  s=s.replace(buy,
    'if(priceAboveEma200&&b.ema50>b.ema200&&htfBull&&fresh&&spreadOk&&!overextended&&!highVol&&entryScore>=MIN_ENTRY_SCORE&&((b.ema9>b.ema21)||longMomentum)){direction="BUY";reason="OSTA (SPOT) — vahva long-entry: "+entryScore+"/"+scoreChecks.length+" teknistä ehtoa täyttyy ja moniaikavälivahvistus on riittävä.";}'
  );
  s=s.replace(
    'passed:checks.filter(function(x){return x.ok;}).length,total:checks.length,',
    'passed:checks.filter(function(x){return x.ok;}).length,total:checks.length,entryScore:entryScore,minEntryScore:MIN_ENTRY_SCORE,'
  );
  fs.writeFileSync(file,s);
  return true;
}

for(const file of ["trading-engine.js","public/trading-engine.js"]) patchFile(file);

const test="tests/trading-engine.test.js";
let t=fs.readFileSync(test,"utf8");
t=t.replace('assert.equal(E.STRATEGY_VERSION,"spot-long-v28");','assert.equal(E.STRATEGY_VERSION,"spot-long-v29");');
fs.writeFileSync(test,t);

console.log("Signal engine repaired to spot-long-v29: HTF confirmation accepts bull+neutral, entry uses a 9/11 technical score with hard data/risk gates, and diagnostics expose entryScore.");
