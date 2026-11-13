/* Rahasampo Radar: Fair Value Gap and Order Block research engine.
   Closed-candle, deterministic zone detection. No execution and no signal overrides.
   FVG: three-candle imbalance. OB: last opposite candle before a confirmed structure break. */
(function(root){
 "use strict";
 function validBar(b){
  return !!b && b.closed!==false && b.isClosed!==false &&
   [b.open,b.high,b.low,b.close].every(Number.isFinite) &&
   b.low>0 && b.high>=Math.max(b.open,b.close,b.low) &&
   b.low<=Math.min(b.open,b.close,b.high);
 }
 function validSeries(bars){
  return Array.isArray(bars)&&bars.length>=3&&bars.every(validBar);
 }
 function validationState(bars){
  if(!Array.isArray(bars)||bars.length<3)return "INSUFFICIENT_DATA";
  return bars.every(validBar)?"OK":"INVALID_DATA";
 }
 function detectFvgs(bars,options){
  options=options||{};
  if(!validSeries(bars))return {state:validationState(bars),zones:[]};
  var minGapPct=Number.isFinite(options.minGapPct)?Math.max(0,Math.min(2,options.minGapPct)):0.02;
  var zones=[];
  for(var i=2;i<bars.length;i++){
   var a=bars[i-2],c=bars[i],gap;
   if(c.low>a.high){
    gap=(c.low-a.high)/((c.low+a.high)/2)*100;
    if(gap>=minGapPct){
     var filled=false,partial=false,fillIndex=null;
     for(var j=i+1;j<bars.length;j++){
      if(bars[j].low<=a.high){filled=true;fillIndex=j;break;}
      if(bars[j].low<c.low)partial=true;
     }
     zones.push({type:"BULLISH_FVG",direction:"BULLISH",low:a.high,high:c.low,
      midpoint:(a.high+c.low)/2,gapPct:gap,createdIndex:i,createdAt:Number.isFinite(c.closeTime)?c.closeTime:null,
      state:filled?"FILLED":partial?"PARTIALLY_FILLED":"OPEN",fillIndex:fillIndex});
    }
   }else if(c.high<a.low){
    gap=(a.low-c.high)/((a.low+c.high)/2)*100;
    if(gap>=minGapPct){
     var bearFilled=false,bearPartial=false,bearFillIndex=null;
     for(var k=i+1;k<bars.length;k++){
      if(bars[k].high>=a.low){bearFilled=true;bearFillIndex=k;break;}
      if(bars[k].high>c.high)bearPartial=true;
     }
     zones.push({type:"BEARISH_FVG",direction:"BEARISH",low:c.high,high:a.low,
      midpoint:(c.high+a.low)/2,gapPct:gap,createdIndex:i,createdAt:Number.isFinite(c.closeTime)?c.closeTime:null,
      state:bearFilled?"FILLED":bearPartial?"PARTIALLY_FILLED":"OPEN",fillIndex:bearFillIndex});
    }
   }
  }
  var active=zones.filter(function(z){return z.state!=="FILLED";});
  active.sort(function(a,b){return b.createdIndex-a.createdIndex;});
  return {state:"OK",zones:active.slice(0,12),detected:zones.length,parameters:{minGapPct:minGapPct}};
 }
 function detectOrderBlocks(bars,structure,options){
  options=options||{};
  if(!validSeries(bars))return {state:"INVALID_DATA",zones:[]};
  if(!structure||structure.state!=="OK")return {state:"STRUCTURE_UNAVAILABLE",zones:[]};
  var lookback=Number.isInteger(options.lookback)?Math.max(1,Math.min(20,options.lookback)):8;
  var lastIndex=bars.length-1,last=bars[lastIndex],events=structure.events||[];
  var breaks=events.filter(function(e){return e.type==="BOS"||e.type==="CHOCH";});
  if(!breaks.length)return {state:"OK",zones:[],reason:"NO_CONFIRMED_BREAK"};
  var event=breaks[breaks.length-1],bull=event.direction==="BULLISH";
  var found=-1;
  for(var i=lastIndex-1;i>=Math.max(0,lastIndex-lookback);i--){
   var candle=bars[i];
   var opposite=bull?candle.close<candle.open:candle.close>candle.open;
   if(opposite){found=i;break;}
  }
  if(found<0)return {state:"OK",zones:[],reason:"NO_OPPOSITE_CANDLE"};
  var ob=bars[found],invalid=bull?last.close<ob.low:last.close>ob.high;
  var mitigated=false,mitigationIndex=null;
  for(var j=found+1;j<lastIndex;j++){
   if(bull?bars[j].low<=ob.high:bars[j].high>=ob.low){mitigated=true;mitigationIndex=j;break;}
  }
  var zone={type:bull?"BULLISH_ORDER_BLOCK":"BEARISH_ORDER_BLOCK",direction:bull?"BULLISH":"BEARISH",
   low:ob.low,high:ob.high,midpoint:(ob.low+ob.high)/2,createdIndex:found,
   createdAt:Number.isFinite(ob.closeTime)?ob.closeTime:null,breakType:event.type,
   breakLevel:event.level,state:invalid?"INVALIDATED":mitigated?"MITIGATED":"UNTESTED",
   mitigationIndex:mitigationIndex};
  return {state:"OK",zones:invalid?[]:[zone],reason:invalid?"INVALIDATED":null};
 }
 function analyze(bars,structure,options){
  if(!validSeries(bars)){var state=validationState(bars);return {state:state,fvgs:[],orderBlocks:[]};}
  var f=detectFvgs(bars,options),o=detectOrderBlocks(bars,structure,options);
  return {state:"OK",fvgs:f.zones,orderBlocks:o.zones,
   diagnostics:{fvgDetected:f.detected,orderBlockState:o.reason||o.state},
   parameters:{fvgMinGapPct:f.parameters.minGapPct,orderBlockLookback:Number.isInteger(options&&options.lookback)?options.lookback:8}};
 }
 var api={analyze:analyze,detectFvgs:detectFvgs,detectOrderBlocks:detectOrderBlocks,validBar:validBar};
 root.LiquidityZoneEngine=api;
 if(typeof module!=="undefined"&&module.exports)module.exports=api;
})(typeof window!=="undefined"?window:globalThis);
