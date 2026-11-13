/* Rahasampo Radar Market Structure Engine.
   Confirmed pivots only: a pivot is published after rightBars closed candles.
   Descriptive research output; never changes BUY/SELL/WAIT and never places orders. */
(function(root){
 "use strict";
 function validBar(b){
  return !!b && b.closed!==false && b.isClosed!==false &&
   [b.open,b.high,b.low,b.close].every(Number.isFinite) &&
   b.low>0 && b.high>=Math.max(b.open,b.close,b.low) &&
   b.low<=Math.min(b.open,b.close,b.high);
 }
 function pivotAt(bars,i,left,right,kind){
  var b=bars[i]; if(!validBar(b))return false;
  var value=kind==="high"?b.high:b.low;
  for(var j=i-left;j<=i+right;j++){
   if(j===i)continue;
   if(!validBar(bars[j]))return false;
   var other=kind==="high"?bars[j].high:bars[j].low;
   if(kind==="high" ? other>=value : other<=value)return false;
  }
  return true;
 }
 function collectPivots(bars,left,right){
  var highs=[],lows=[],end=bars.length-1-right;
  for(var i=left;i<=end;i++){
   if(pivotAt(bars,i,left,right,"high"))highs.push({index:i,confirmedAt:i+right,price:bars[i].high,time:Number.isFinite(bars[i].closeTime)?bars[i].closeTime:null});
   if(pivotAt(bars,i,left,right,"low"))lows.push({index:i,confirmedAt:i+right,price:bars[i].low,time:Number.isFinite(bars[i].closeTime)?bars[i].closeTime:null});
  }
  return {highs:highs,lows:lows};
 }
 function analyze(bars,options){
  options=options||{};
  if(!Array.isArray(bars)||bars.length<5)return {state:"INSUFFICIENT_DATA",trend:"UNKNOWN",pivots:{highs:[],lows:[]},events:[],levels:[]};
  var left=Number.isInteger(options.leftBars)?Math.max(1,Math.min(8,options.leftBars)):2;
  var right=Number.isInteger(options.rightBars)?Math.max(1,Math.min(8,options.rightBars)):2;
  var clean=bars.filter(validBar);
  if(clean.length!==bars.length)return {state:"INVALID_DATA",trend:"UNKNOWN",pivots:{highs:[],lows:[]},events:[],levels:[]};
  var pivots=collectPivots(clean,left,right), highs=pivots.highs,lows=pivots.lows;
  var last=clean[clean.length-1],events=[],trend="UNKNOWN";
  if(highs.length>=2&&lows.length>=2){
   var h1=highs[highs.length-2],h2=highs[highs.length-1],l1=lows[lows.length-2],l2=lows[lows.length-1];
   if(h2.price>h1.price&&l2.price>l1.price)trend="BULLISH";
   else if(h2.price<h1.price&&l2.price<l1.price)trend="BEARISH";
   else trend="RANGE";
  }
  var latestHigh=highs[highs.length-1]||null,latestLow=lows[lows.length-1]||null;
  var priorTrend=trend;
  if(latestHigh&&last.close>latestHigh.price){
   var direction=trend==="BEARISH"?"BULLISH":"BULLISH";
   events.push({type:trend==="BEARISH"?"CHOCH":"BOS",direction:direction,level:latestHigh.price,close:last.close,description:"Sulkeutunut hinta ylitti viimeisimmän vahvistetun swing-huipun."});
   trend="BULLISH";
  }else if(latestLow&&last.close<latestLow.price){
   var down=trend==="BULLISH"?"BEARISH":"BEARISH";
   events.push({type:trend==="BULLISH"?"CHOCH":"BOS",direction:down,level:latestLow.price,close:last.close,description:"Sulkeutunut hinta alitti viimeisimmän vahvistetun swing-pohjan."});
   trend="BEARISH";
  }else if(latestHigh&&last.high>latestHigh.price&&last.close<latestHigh.price){
   events.push({type:"BEARISH_SWEEP",direction:"BEARISH",level:latestHigh.price,close:last.close,description:"Hinta kävi swing-huipun yläpuolella mutta sulkeutui takaisin sen alle."});
  }else if(latestLow&&last.low<latestLow.price&&last.close>latestLow.price){
   events.push({type:"BULLISH_SWEEP",direction:"BULLISH",level:latestLow.price,close:last.close,description:"Hinta kävi swing-pohjan alapuolella mutta sulkeutui takaisin sen yläpuolelle."});
  }
  var tolerance=Number.isFinite(options.equalTolerancePct)?Math.max(0.0001,Math.min(0.01,options.equalTolerancePct)):0.001;
  var levels=[];
  function equalPair(points,type){
   if(points.length<2)return;
   var a=points[points.length-2],b=points[points.length-1],mid=(a.price+b.price)/2;
   if(Math.abs(a.price-b.price)/mid<=tolerance)levels.push({type:type,price:mid,firstIndex:a.index,lastIndex:b.index,tolerancePct:tolerance*100});
  }
  equalPair(highs,"EQUAL_HIGHS"); equalPair(lows,"EQUAL_LOWS");
  if(levels.length){
   var eq=levels[levels.length-1];
   if(eq.type==="EQUAL_HIGHS"&&last.high>eq.price&&last.close<eq.price)events.push({type:"LIQUIDITY_SWEEP_HIGH",direction:"BEARISH",level:eq.price,close:last.close,description:"Equal Highs -alue pyyhkäistiin ja kynttilä sulkeutui alueen alle."});
   if(eq.type==="EQUAL_LOWS"&&last.low<eq.price&&last.close>eq.price)events.push({type:"LIQUIDITY_SWEEP_LOW",direction:"BULLISH",level:eq.price,close:last.close,description:"Equal Lows -alue pyyhkäistiin ja kynttilä sulkeutui alueen yläpuolelle."});
  }
  return {state:"OK",trend:trend,priorTrend:priorTrend,pivots:pivots,latestHigh:latestHigh,latestLow:latestLow,levels:levels,events:events,parameters:{leftBars:left,rightBars:right,equalTolerancePct:tolerance*100},lastClose:last.close};
 }
 root.MarketStructureEngine={analyze:analyze,collectPivots:collectPivots,validBar:validBar};
 if(typeof module!=="undefined"&&module.exports)module.exports=root.MarketStructureEngine;
})(typeof window!=="undefined"?window:globalThis);
