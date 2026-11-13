/* XTrend Lite Quick Mode research engine. No data fetching or order execution. */
(function (root) {
  "use strict";
  var DEFAULTS = Object.freeze({ maxQuoteAgeMs: 5000, maxOneMinuteBarAgeMs: 120000, maxFiveMinuteBarAgeMs: 600000, minBars: 35, buyRsiMin: 50, buyRsiMax: 70, sellRsiMin: 30, sellRsiMax: 50 });
  function finite(v) { return v !== null && v !== "" && Number.isFinite(Number(v)); }
  function ema(values, period) {
    if (!Array.isArray(values) || values.length < period) return null;
    var alpha = 2 / (period + 1), out = values.slice(0, period).reduce(function(a,b){return a+b;},0) / period;
    for (var i=period;i<values.length;i++) out=values[i]*alpha+out*(1-alpha);
    return out;
  }
  function rsi(values, period) {
    if (!Array.isArray(values) || values.length <= period) return null;
    var gain=0,loss=0;
    for(var i=values.length-period;i<values.length;i++){var d=values[i]-values[i-1];if(d>0)gain+=d;else loss-=d;}
    if(loss===0)return gain===0?50:100;
    return 100-100/(1+(gain/period)/(loss/period));
  }
  function macdHistogram(values) {
    if(!Array.isArray(values)||values.length<35)return null;
    var line=[];
    for(var i=0;i<values.length;i++){var f=ema(values.slice(0,i+1),12),s=ema(values.slice(0,i+1),26);if(f!==null&&s!==null)line.push(f-s);}
    if(line.length<9)return null;
    var signal=ema(line,9);return signal===null?null:line[line.length-1]-signal;
  }
  function validateBars(bars,tf,now,maxAge,minBars){
    if(!Array.isArray(bars)||bars.length<minBars)return{ok:false,reason:tf+": kynttilähistoriaa liian vähän"};
    var prev=-Infinity;
    for(var i=0;i<bars.length;i++){
      var b=bars[i];
      if(!b||b.closed!==true||![b.openTime,b.closeTime,b.open,b.high,b.low,b.close,b.volume].every(finite))return{ok:false,reason:tf+": puuttuva, virheellinen tai keskeneräinen kynttilä"};
      var o=Number(b.open),h=Number(b.high),l=Number(b.low),c=Number(b.close);
      if(o<=0||h<Math.max(o,c,l)||l>Math.min(o,c)||l<=0||c<=0||Number(b.openTime)<=prev||Number(b.closeTime)<Number(b.openTime)||Number(b.closeTime)>now)return{ok:false,reason:tf+": OHLC tai aikaleimat eivät ole kelvollisia"};
      prev=Number(b.openTime);
    }
    var age=now-Number(bars[bars.length-1].closeTime);
    if(age<0||age>maxAge)return{ok:false,reason:tf+": viimeisin sulkeutunut kynttilä vanhentunut"};
    return{ok:true,bars:bars};
  }
  function analyze(bars){
    var closes=bars.map(function(b){return Number(b.close);}), e9=ema(closes,9),e21=ema(closes,21),r=rsi(closes,14),m=macdHistogram(closes),last=closes[closes.length-1];
    if(![e9,e21,r,m].every(Number.isFinite))return null;
    return{trend:last>e9&&e9>e21?"BULL":last<e9&&e9<e21?"BEAR":"MIXED",close:last,ema9:e9,ema21:e21,rsi14:r,macdHistogram:m};
  }
  function wait(reasons,details){return Object.assign({signal:"WAIT",actionable:false,executionEnabled:false,reasons:reasons,note:"Ei toimeksiantoa. WAIT on pakollinen, kun data tai vahvistus puuttuu."},details||{});}
  function evaluate(input,options){
    var now=options&&finite(options.nowMs)?Number(options.nowMs):Date.now(),cfg=Object.assign({},DEFAULTS,options||{}),reasons=[];
    if(!input||typeof input!=="object")return wait(["XTrend-markkinasyöte puuttuu"]);
    if(typeof input.symbol!=="string"||!input.symbol.trim())reasons.push("XTrend-symboli puuttuu");
    var q=input.quote||{};
    if(!finite(q.bid)||!finite(q.ask)||Number(q.bid)<=0||Number(q.ask)<Number(q.bid))reasons.push("XTrendin kelvollinen bid/ask-hinta puuttuu");
    if(!finite(q.receivedAt)||now-Number(q.receivedAt)<0||now-Number(q.receivedAt)>cfg.maxQuoteAgeMs)reasons.push("XTrendin bid/ask-hinta on vanhentunut tai aikaleima virheellinen");
    if(q.source!=="XTREND")reasons.push("Hintalähdettä ei ole vahvistettu XTrendiksi; Binance-hintaa ei hyväksytä");
    if(!finite(cfg.maxSpreadPct)||Number(cfg.maxSpreadPct)<=0)reasons.push("XTrendin sallittua spread-rajaa ei ole vahvistettu");
    else if(finite(q.bid)&&finite(q.ask)&&Number(q.bid)>0){var mid=(Number(q.bid)+Number(q.ask))/2,spread=(Number(q.ask)-Number(q.bid))/mid*100;if(!Number.isFinite(spread)||spread>Number(cfg.maxSpreadPct))reasons.push("XTrend-spread ylittää määritellyn rajan");}
    var one=validateBars(input.oneMinuteBars,"1M",now,cfg.maxOneMinuteBarAgeMs,cfg.minBars),five=validateBars(input.fiveMinuteBars,"5M",now,cfg.maxFiveMinuteBarAgeMs,cfg.minBars);
    if(!one.ok)reasons.push(one.reason);if(!five.ok)reasons.push(five.reason);if(reasons.length)return wait(reasons);
    var a=analyze(one.bars),b=analyze(five.bars);if(!a||!b)return wait(["Indikaattoreita ei voida laskea"]);
    var buy=b.trend==="BULL"&&a.trend==="BULL"&&a.macdHistogram>0&&a.rsi14>=cfg.buyRsiMin&&a.rsi14<=cfg.buyRsiMax;
    var sell=b.trend==="BEAR"&&a.trend==="BEAR"&&a.macdHistogram<0&&a.rsi14>=cfg.sellRsiMin&&a.rsi14<=cfg.sellRsiMax;
    if(!buy&&!sell){
      if(a.trend!==b.trend)reasons.push("1M ja 5M trendit eivät vahvista samaa suuntaa");
      if(a.trend==="MIXED"||b.trend==="MIXED")reasons.push("EMA-trendi ei ole selkeä");
      if((a.trend==="BULL"&&a.macdHistogram<=0)||(a.trend==="BEAR"&&a.macdHistogram>=0))reasons.push("MACD ei vahvista 1M-suuntaa");
      if(a.trend==="BULL"&&(a.rsi14<cfg.buyRsiMin||a.rsi14>cfg.buyRsiMax))reasons.push("RSI ei täytä alustavaa BUY-aluetta");
      if(a.trend==="BEAR"&&(a.rsi14<cfg.sellRsiMin||a.rsi14>cfg.sellRsiMax))reasons.push("RSI ei täytä alustavaa SELL-aluetta");
      return wait(reasons.length?reasons:["Pakolliset vahvistukset eivät täyty"],{symbol:input.symbol,oneMinute:a,fiveMinute:b});
    }
    return{signal:buy?"BUY":"SELL",actionable:false,executionEnabled:false,symbol:input.symbol,quote:{bid:Number(q.bid),ask:Number(q.ask),receivedAt:Number(q.receivedAt),source:q.source},oneMinute:a,fiveMinute:b,reasons:["1M ja 5M sulkeutuneet kynttilät vahvistavat saman suunnan","XTrend-quote ja spread läpäisivät datatarkistukset"],note:"Tutkimussignaali; ei toimeksiantoa, voittoennustetta eikä vahvistettua XTrend-täyttöä."};
  }
  var api=Object.freeze({evaluate:evaluate,defaults:DEFAULTS});root.XTrendQuickMode=api;if(typeof module!=="undefined"&&module.exports)module.exports=api;
})(typeof window!=="undefined"?window:globalThis);
