"use strict";
const assert=require("node:assert/strict");
const M=require("../public/market-structure-engine.js");
function b(o,h,l,c,i){return {open:o,high:h,low:l,close:c,closeTime:1700000000000+i*300000};}
const rising=[
 b(10,11,9,10,0),b(10,12,9.5,11,1),b(11,11.5,8.5,9,2),b(9,13,9,12,3),
 b(12,12,8,10,4),b(10,11,9,10,5),b(10,12,9.5,11,6),b(11,14,10,13,7),
 b(13,13,10.5,12,8),b(12,12,9.8,11,9),b(11,13,10.2,12,10),b(12,15,11,14,11),
 b(14,14,11.5,13,12),b(13,13,10.5,12.5,13)
];
const pivots=M.collectPivots(rising,2,2);
assert.ok(pivots.highs.every(p=>p.confirmedAt===p.index+2),"swing highs publish only after right-side candles close");
assert.ok(pivots.lows.every(p=>p.confirmedAt===p.index+2),"swing lows publish only after right-side candles close");
assert.ok(!pivots.highs.some(p=>p.index===rising.length-1),"latest unconfirmed candles cannot become pivots");
assert.ok(pivots.highs.length>=2&&pivots.lows.length>=2,"the synthetic series contains enough confirmed swing points");
assert.equal(M.analyze(rising).trend,"BULLISH","higher confirmed highs and higher confirmed lows define bullish structure");
const invalid=M.analyze([b(1,2,.5,1,0),{open:1,high:0,low:2,close:1},b(1,2,.5,1,2)]);
assert.equal(invalid.state,"INVALID_DATA","malformed OHLC series fails closed");
const insufficient=M.analyze([b(1,2,.5,1,0),b(1,2,.5,1,1)]);
assert.equal(insufficient.state,"INSUFFICIENT_DATA");
const sweepBars=[
 b(100,102,98,100,0),b(100,105,99,103,1),b(103,104,97,99,2),
 b(99,103,98,102,3),b(102,106,100,104,4),b(104,105,96,98,5),
 b(98,104,97,103,6),b(103,107,101,105,7),b(105,106,97,99,8)
];
const sweep=M.analyze(sweepBars,{leftBars:1,rightBars:1});
assert.equal(sweep.state,"OK","valid closed candle series is analyzed");
assert.ok(Array.isArray(sweep.events)&&Array.isArray(sweep.levels),"analysis returns explicit events and liquidity levels");
const equalHighSweep=[
 b(100,102,99,101,0),b(101,105,100,104,1),b(104,103,98,100,2),
 b(100,105.04,99,103,3),b(103,104,100,102,4),b(102,106,100,104,5)
];
const equalResult=M.analyze(equalHighSweep,{leftBars:1,rightBars:1,equalTolerancePct:0.001});
assert.ok(equalResult.levels.some(x=>x.type==="EQUAL_HIGHS"),"near-identical confirmed swing highs form an Equal Highs liquidity level");
assert.ok(equalResult.events.some(x=>x.type==="BEARISH_SWEEP"),"a wick above a confirmed swing high followed by a close below it is a bearish sweep");
const closed=M.analyze([...rising,{...b(14,16,13,15,10),closed:false}]);
assert.equal(closed.state,"INVALID_DATA","unfinished candle is never silently mixed into a closed-candle analysis");
console.log("Market structure engine tests passed.");
