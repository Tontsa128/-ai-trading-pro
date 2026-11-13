"use strict";
const assert=require("node:assert/strict");
const engine=require("../public/xtrend-quick-mode.js");
const now=1800000000000;
function bars(tf,dir){
 let p=dir==="down"?200:100;
 return Array.from({length:80},(_,i)=>{
  if(i>0&&dir!=="flat"){const d=(i%2===0?-0.04:0.08)*(dir==="down"?-1:1);p+=d;}
  const t=now-(80-i)*tf;
  return{openTime:t,closeTime:t+tf-1,open:p-0.01,high:p+0.03,low:p-0.03,close:p,volume:10,closed:true};
 });
}
function data(dir){return{symbol:"BTCUSD",quote:{bid:100,ask:100.01,receivedAt:now-100,source:"XTREND"},oneMinuteBars:bars(60000,dir),fiveMinuteBars:bars(300000,dir)};}
const opts={nowMs:now,maxSpreadPct:0.05};
assert.equal(engine.evaluate(data("up"),opts).signal,"BUY");
assert.equal(engine.evaluate(data("down"),opts).signal,"SELL");
assert.equal(engine.evaluate(data("flat"),opts).signal,"WAIT");
assert.equal(engine.evaluate(data("up"),{nowMs:now}).signal,"WAIT","missing spread policy blocks");
assert.equal(engine.evaluate(data("up"),{...opts,nowMs:now+10000}).signal,"WAIT","stale quote blocks");
const wrongSource=data("up");wrongSource.quote.source="BINANCE";
assert.equal(engine.evaluate(wrongSource,opts).signal,"WAIT","Binance price cannot masquerade as XTrend");
const incomplete=data("up");incomplete.oneMinuteBars[79].closed=false;
assert.equal(engine.evaluate(incomplete,opts).signal,"WAIT");
const future=data("up");future.fiveMinuteBars[79].closeTime=now+1;
assert.equal(engine.evaluate(future,opts).signal,"WAIT");
const invalid=data("up");invalid.quote.ask=0;
assert.equal(engine.evaluate(invalid,opts).signal,"WAIT");
const result=engine.evaluate(data("up"),opts);
assert.equal(result.actionable,false);assert.equal(result.executionEnabled,false);
console.log("XTrend Quick Mode foundation tests passed.");
