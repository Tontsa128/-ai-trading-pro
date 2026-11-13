"use strict";
const assert=require("node:assert/strict");
const L=require("../public/liquidity-zone-engine.js");
const M=require("../public/market-structure-engine.js");
function b(o,h,l,c,i){return {open:o,high:h,low:l,close:c,closeTime:1700000000000+i*300000};}
const bullishGap=[
 b(100,102,99,101,0),b(101,104,100,103,1),b(105,108,104,107,2),
 b(107,109,106,108,3),b(108,109,104,105,4)
];
const f=L.detectFvgs(bullishGap,{minGapPct:0});
assert.equal(f.state,"OK");
assert.ok(f.zones.some(z=>z.type==="BULLISH_FVG"&&z.low===102&&z.high===104),
 "three-candle bullish imbalance is identified from the first and third candles");
assert.ok(f.zones.some(z=>z.state==="PARTIALLY_FILLED"||z.state==="FILLED"),
 "later candle overlap updates FVG mitigation state");
const bearishGap=[
 b(110,111,108,109,0),b(109,110,106,107,1),b(105,106,102,103,2),
 b(104,105,103,104,3)
];
const bear=L.detectFvgs(bearishGap,{minGapPct:0});
assert.ok(bear.zones.some(z=>z.type==="BEARISH_FVG"&&z.low===106&&z.high===108),
 "three-candle bearish imbalance is identified");
assert.equal(L.detectFvgs([b(1,2,0,1,0),{open:1,high:0,low:2,close:1},b(1,2,0,1,2)]).state,"INVALID_DATA",
 "malformed OHLC data fails closed");
assert.equal(L.detectFvgs([{open:1,high:2,low:0,close:1}]).state,"INVALID_DATA",
 "insufficient history fails closed");
const obBars=[
 b(100,102,99,101,0),b(101,103,100,102,1),b(102,104,101,103,2),
 b(103,104,99,100,3),b(100,103,99,102,4),b(102,105,101,104,5),
 b(104,106,103,105,6),b(105,108,104,107,7),b(107,109,106,108,8)
];
const fakeStructure={state:"OK",events:[{type:"BOS",direction:"BULLISH",level:104}]};
const ob=L.detectOrderBlocks(obBars,fakeStructure,{lookback:8});
assert.equal(ob.state,"OK");
assert.equal(ob.zones.length,1,"confirmed bullish structure break creates one candidate order block");
assert.equal(ob.zones[0].type,"BULLISH_ORDER_BLOCK");
assert.ok(ob.zones[0].low<=ob.zones[0].high);
const invalidated=L.detectOrderBlocks([...obBars.slice(0,-1),b(107,108,95,96,9)],fakeStructure,{lookback:8});
assert.equal(invalidated.zones.length,0,"a close through the order block invalidates it");
assert.equal(L.detectOrderBlocks(obBars,null).state,"STRUCTURE_UNAVAILABLE",
 "order blocks require a valid structure engine result");
console.log("Liquidity zone engine tests passed.");
