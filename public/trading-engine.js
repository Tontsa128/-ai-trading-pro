/* Rahasampo Radar: deterministic indicator and spot-risk engine.
   No exchange orders are sent. This is not an AI model or a guarantee of returns. */
(function (root) {
  "use strict";
  var PERIOD = 14;
  var MIN_VOLUME_RATIO = 0.5;
  var MIN_LEVEL_CLEARANCE_ATR = 0.5;
  var COST_DEFAULTS = { feePct: 0.10, slippagePct: 0.05, riskPct: 0.50, maxExposurePct: 25 };

  function number(v) { return Number.isFinite(Number(v)) ? Number(v) : NaN; }
  function average(values) {
    var ok = values.filter(Number.isFinite);
    return ok.length ? ok.reduce(function (a, b) { return a + b; }, 0) / ok.length : NaN;
  }
  function ema(values, period) {
    var out = Array(values.length).fill(null), k = 2 / (period + 1), prev = null;
    values.forEach(function (v, i) {
      if (!Number.isFinite(v)) return;
      prev = prev === null ? v : v * k + prev * (1 - k);
      out[i] = prev;
    });
    return out;
  }
  function wilder(values, period) {
    var out = Array(values.length).fill(null), prev = null, seed = 0;
    for (var i = 0; i < values.length; i++) {
      var v = Number.isFinite(values[i]) ? values[i] : 0;
      if (i > 0 && i <= period) seed += v;
      if (i === period) { prev = seed / period; out[i] = prev; }
      else if (i > period && prev !== null) { prev = (prev * (period - 1) + v) / period; out[i] = prev; }
    }
    return out;
  }
  function parseKlines(raw, nowMs) {
    var now = nowMs || Date.now();
    if (!Array.isArray(raw)) throw new Error("Markkinadata ei ole odotetussa muodossa.");
    return raw.filter(function (k) { return Array.isArray(k) && Number(k[6]) < now; })
      .map(function (k) {
        return { time: Number(k[0]), closeTime: Number(k[6]), open: +k[1], high: +k[2], low: +k[3], close: +k[4], volume: +k[5] };
      }).filter(function (b) {
        return [b.time,b.open,b.high,b.low,b.close,b.volume].every(Number.isFinite) && b.open > 0 && b.high > 0 && b.low > 0 && b.close > 0 && b.volume >= 0 && b.high >= Math.max(b.open,b.close,b.low) && b.low <= Math.min(b.open,b.close,b.high);
      });
  }
  function enrich(bars) {
    var closes = bars.map(function (b) { return b.close; });
    var ranges = [], gains = [], losses = [], plusDm = [], minusDm = [];
    for (var i = 0; i < bars.length; i++) {
      var b = bars[i], p = bars[i - 1];
      ranges.push(p ? Math.max(b.high - b.low, Math.abs(b.high - p.close), Math.abs(b.low - p.close)) : b.high - b.low);
      var delta = p ? b.close - p.close : 0;
      gains.push(Math.max(delta,0)); losses.push(Math.max(-delta,0));
      var up = p ? b.high - p.high : 0, down = p ? p.low - b.low : 0;
      plusDm.push(up > down && up > 0 ? up : 0);
      minusDm.push(down > up && down > 0 ? down : 0);
    }
    var e9=ema(closes,9), e21=ema(closes,21), e50=ema(closes,50), e200=ema(closes,200);
    var gainAvg=wilder(gains,PERIOD), lossAvg=wilder(losses,PERIOD), rsi=closes.map(function (_,i) {
      if (gainAvg[i] === null || lossAvg[i] === null) return null;
      if (lossAvg[i] === 0) return gainAvg[i] === 0 ? 50 : 100;
      return 100 - 100/(1+gainAvg[i]/lossAvg[i]);
    });
    var atr=wilder(ranges,PERIOD), plusAvg=wilder(plusDm,PERIOD), minusAvg=wilder(minusDm,PERIOD);
    var pdi=atr.map(function (a,i) { return a > 0 && plusAvg[i] !== null ? 100*plusAvg[i]/a : null; });
    var mdi=atr.map(function (a,i) { return a > 0 && minusAvg[i] !== null ? 100*minusAvg[i]/a : null; });
    var dx=atr.map(function (_,i) {
      if (!Number.isFinite(pdi[i]) || !Number.isFinite(mdi[i]) || pdi[i]+mdi[i] === 0) return null;
      return 100*Math.abs(pdi[i]-mdi[i])/(pdi[i]+mdi[i]);
    });
    var adx=Array(bars.length).fill(null), dxSeed=0, previousAdx=null;
    for (var ai=PERIOD;ai<dx.length;ai++) {
      var dxValue=Number.isFinite(dx[ai])?dx[ai]:0;
      if (ai<2*PERIOD-1) dxSeed+=dxValue;
      else if (ai===2*PERIOD-1) { previousAdx=(dxSeed+dxValue)/PERIOD; adx[ai]=previousAdx; }
      else { previousAdx=(previousAdx*(PERIOD-1)+dxValue)/PERIOD; adx[ai]=previousAdx; }
    }
    var e12=ema(closes,12), e26=ema(closes,26);
    var macd=e12.map(function(v,i){ return v-e26[i]; });
    var macdSignal=ema(macd,9);
    var hist=macd.map(function(v,i){ return v-macdSignal[i]; });
    var volAvg=bars.map(function (_,i) { return i >= 20 ? average(bars.slice(i-20,i).map(function(b){return b.volume;})) : null; });
    var volumeRatio=bars.map(function(b,i){ return Number.isFinite(volAvg[i]) && volAvg[i]>0 ? b.volume/volAvg[i] : null; });
    return bars.map(function(b,i) {
      return Object.assign({},b,{ema9:e9[i],ema21:e21[i],ema50:e50[i],ema200:e200[i],rsi:rsi[i],atr:atr[i],
        atrPct:atr[i]/b.close*100, pdi:pdi[i],mdi:mdi[i],adx:adx[i],macd:macd[i],macdSignal:macdSignal[i],
        macdHist:hist[i],volumeRatio:volumeRatio[i]});
    });
  }
  function trendLabelFi(bias) {
    return bias === "bull" ? "NOUSU" : bias === "bear" ? "LASKU" : "EPÄSELVÄ";
  }
  function fixed(value, digits) {
    return Number.isFinite(value) ? value.toFixed(digits) : "ei saatavilla";
  }
  function signedFixed(value, digits) {
    return Number.isFinite(value) ? (value > 0 ? "+" : "") + value.toFixed(digits) : "ei saatavilla";
  }
  function describeCheck(x, b, main, higher, checks, side, supportRoom, resistanceRoom, spreadPct, priceAgeMs, upConfirmed, downConfirmed) {
    if (x.name.indexOf("MACD-histogrammi") === 0) {
      var bearishMacd = x.name.indexOf("negatiivinen") >= 0;
      var requirement = bearishMacd ? "< 0 (laskusuunnan ehto)" : "> 0 (noususuunnan ehto)";
      return "MACD-histogrammi " + signedFixed(b.macdHist, 6) + "; vaaditaan " + requirement + "; " + (x.ok ? "ehto täyttyy" : "ehto ei täyty");
    }
    if (x.name.indexOf("Volyymi") === 0) {
      var ratio = Number.isFinite(b.volumeRatio) ? b.volumeRatio.toFixed(2) + "×" : "ei saatavilla";
      return "Volyymi " + ratio + " (" + (x.ok ? "vaatimus ≥ 0.50× täyttyy" : "vaatimus ≥ 0.50× ei täyty") + ")";
    }
    if (x.name.indexOf("Kaksi suurempaa aikaväliä") === 0) {
      var fourHour = higher[0] && higher[0].checks ? higher[0].checks.bias : "neutral";
      var daily = higher[1] && higher[1].checks ? higher[1].checks.bias : "neutral";
      var requiredBias = side === "SELL" ? "bear" : "bull";
      return "Moniaikavälivahvistus: 1 h " + trendLabelFi(checks.bias) + ", 4 h " + trendLabelFi(fourHour) + ", 1 d " + trendLabelFi(daily) +
        "; vahvistus vaatii 4 h ja 1 d: " + trendLabelFi(requiredBias);
    }
    if (x.name.indexOf("Myynnille tilaa tukeen") === 0) {
      var supportDistance = b.close - main.support;
      var supportMin = 0.5 * b.atr;
      return "Tuen etäisyys " + fixed(supportDistance, 2) + " hinnan yksikköä (" + fixed(supportRoom, 2) +
        " ATR); vaatimus ≥ " + fixed(supportMin, 2) + " (" + fixed(0.5, 2) + " ATR)";
    }
    if (x.name.indexOf("Ostolle tilaa vastukseen") === 0) {
      var resistanceDistance = main.resistance - b.close;
      var resistanceMin = 0.5 * b.atr;
      return "Vastuksen etäisyys " + fixed(resistanceDistance, 2) + " hinnan yksikköä (" + fixed(resistanceRoom, 2) +
        " ATR); vaatimus ≥ " + fixed(resistanceMin, 2) + " (" + fixed(0.5, 2) + " ATR)";
    }
    if (x.name === "Hinta ei ole liian kaukana EMA 21:stä") {
      var emaDistanceAtr = Number.isFinite(b.atr) && b.atr > 0 ? Math.abs(b.close-b.ema21)/b.atr : NaN;
      return (x.ok ? "Hinta ei ole liian kaukana" : "Hinta on liian kaukana") + " EMA 21:stä: " +
        fixed(Math.abs(b.close-b.ema21), 2) + " hinnan yksikköä (" + fixed(emaDistanceAtr, 2) +
        " ATR; sallittu enintään 1.60 ATR); " + (x.ok ? "ehto täyttyy" : "ehto ei täyty");
    }
    if (x.name.indexOf("Ei poikkeuksellisen suuri ATR-volatiliteetti") === 0) {
      return "ATR-volatiliteetti " + fixed(b.atrPct, 2) + " %; raja enintään 3.00 %; " + (x.ok ? "ehto täyttyy" : "ehto ei täyty");
    }
    if (x.name.indexOf("Riittävästi historiadataa") === 0) {
      return "Sulkeutuneita kynttilöitä " + main.high.length + "; vähimmäisvaatimus 220; " + (x.ok ? "ehto täyttyy" : "ehto ei täyty");
    }
    if (x.name.indexOf("Osto/myyntihajonta") === 0) {
      return "Nykyinen hajonta " + fixed(spreadPct, 4) + " %; raja enintään 0.1500 %; " + (x.ok ? "ehto täyttyy" : "ehto ei täyty");
    }
    if (x.name.indexOf("Markkinahinta tuore") === 0 || x.name.indexOf("Historiallinen kynttilä sulkeutunut") === 0) {
      return "Markkinahinnan ikä " + fixed(priceAgeMs / 1000, 1) + " sekuntia";
    }
    return x.name;
  }
  function explainCandle(b) {
    var bull = [
      {name:"Hinta EMA 200:n yläpuolella",ok:b.close>b.ema200},
      {name:"EMA 50 EMA 200:n yläpuolella",ok:b.ema50>b.ema200},
      {name:"EMA 9 EMA 21:n yläpuolella",ok:b.ema9>b.ema21},
      {name:"MACD-histogrammi positiivinen (nousupainotteinen)",ok:b.macdHist>0},
      {name:"RSI 50–68 (ei ylikuumentunut)",ok:b.rsi>=50&&b.rsi<=68},
      {name:"ADX vähintään 18 ja ostajien suunta vahvempi",ok:b.adx>=18&&b.pdi>b.mdi},
      {name:"Volyymi vähintään 0,5× edeltävän 20 kynttilän keskiarvo",ok:Number.isFinite(b.volumeRatio)&&b.volumeRatio>=MIN_VOLUME_RATIO}
    ];
    var bear = [
      {name:"Hinta EMA 200:n alapuolella",ok:b.close<b.ema200},
      {name:"EMA 50 EMA 200:n alapuolella",ok:b.ema50<b.ema200},
      {name:"EMA 9 EMA 21:n alapuolella",ok:b.ema9<b.ema21},
      {name:"MACD-histogrammi negatiivinen (laskupainotteinen)",ok:b.macdHist<0},
      {name:"RSI 32–50 (ei ylikuumentunut)",ok:b.rsi>=32&&b.rsi<=50},
      {name:"ADX vähintään 18 ja myyjien suunta vahvempi",ok:b.adx>=18&&b.mdi>b.pdi},
      {name:"Volyymi vähintään 0,5× edeltävän 20 kynttilän keskiarvo",ok:Number.isFinite(b.volumeRatio)&&b.volumeRatio>=MIN_VOLUME_RATIO}
    ];
    var bullN=bull.filter(function(x){return x.ok;}).length, bearN=bear.filter(function(x){return x.ok;}).length;
    var bias="neutral";
    if (b.close>b.ema200 && b.ema50>b.ema200 && b.ema9>b.ema21) bias="bull";
    if (b.close<b.ema200 && b.ema50<b.ema200 && b.ema9<b.ema21) bias="bear";
    return {bull:bull,bear:bear,bullN:bullN,bearN:bearN,bias:bias};
  }
  function analyzeSeries(series) {
    if (!Array.isArray(series) || series.length < 220) throw new Error("Tarvitaan vähintään 220 sulkeutunutta kynttilää EMA 200 -suodattimen luotettavaan laskentaan.");
    var b=series[series.length-1], checks=explainCandle(b);
    var longCore=b.close>b.ema200 && b.ema50>b.ema200 && b.ema9>b.ema21 && b.macdHist>0 &&
      b.rsi>=50 && b.rsi<=68 && b.adx>=18 && b.pdi>b.mdi && Number.isFinite(b.volumeRatio) && b.volumeRatio>=MIN_VOLUME_RATIO;
    var shortCore=b.close<b.ema200 && b.ema50<b.ema200 && b.ema9<b.ema21 && b.macdHist<0 &&
      b.rsi>=32 && b.rsi<=50 && b.adx>=18 && b.mdi>b.pdi && Number.isFinite(b.volumeRatio) && b.volumeRatio>=MIN_VOLUME_RATIO;
    var support=Math.min.apply(null,series.slice(-31,-1).map(function(x){return x.low;}));
    var resistance=Math.max.apply(null,series.slice(-31,-1).map(function(x){return x.high;}));
    var supportRoom=Number.isFinite(b.atr)&&b.atr>0?(b.close-support)/b.atr:NaN;
    var resistanceRoom=Number.isFinite(b.atr)&&b.atr>0?(resistance-b.close)/b.atr:NaN;
    return {bar:b,checks:checks,longCore:longCore,shortCore:shortCore,support:support,resistance:resistance,supportRoom:supportRoom,resistanceRoom:resistanceRoom,
      overextended:Number.isFinite(b.atr)&&b.atr>0&&Math.abs(b.close-b.ema21)/b.atr>1.6,highVolatility:Number.isFinite(b.atrPct)&&b.atrPct>3};
  }
  function evaluateSignal(main,higher,market,opts) {
    opts=Object.assign({},COST_DEFAULTS,opts||{}); higher=higher||[]; market=market||{};
    var b=main.bar, checks=main.checks, side=checks.bias==="bear"?"SELL":checks.bias==="bull"?"BUY":checks.bearN>checks.bullN?"SELL":"BUY";
    var price=number(market.price), bid=number(market.bid), ask=number(market.ask);
    var spreadPct=Number.isFinite(bid)&&Number.isFinite(ask)&&bid>0&&ask>=bid?(ask-bid)/((ask+bid)/2)*100:NaN;
    var priceAgeMs=Number.isFinite(market.closeTime)&&market.closeTime>0?Math.max(0,Date.now()-market.closeTime):Infinity;
    var historical=opts.historical===true;
    var fresh=historical||priceAgeMs<=180000;
    var spreadOk=Number.isFinite(spreadPct)&&spreadPct<=0.15;
    var upConfirmed=higher.length>=2&&higher[0]&&higher[1]&&higher[0].checks.bias==="bull"&&higher[1].checks.bias==="bull";
    var downConfirmed=higher.length>=2&&higher[0]&&higher[1]&&higher[0].checks.bias==="bear"&&higher[1].checks.bias==="bear";
    var core=side==="BUY"?main.longCore:main.shortCore;
    var distanceOk=!main.overextended, volatilityOk=!main.highVolatility;
    var levelOk=side==="BUY"?main.resistanceRoom>=MIN_LEVEL_CLEARANCE_ATR:main.supportRoom>=MIN_LEVEL_CLEARANCE_ATR;
    var timeframeOk=side==="BUY"?upConfirmed:downConfirmed;
    var checklist=[
      {group:"Data OK",name:"Markkinahinta tuore",ok:Number.isFinite(price)&&fresh},
      {group:"Data OK",name:"Osto/myyntihajonta ≤ 0,1500 %",ok:spreadOk},
      {group:"Data OK",name:"Historiallinen kynttilä sulkeutunut",ok:historical||Number.isFinite(market.closeTime)},
      {group:"Trendi",name:side==="BUY"?"Nousun ydinehdot": "Laskun ydinehdot",ok:core,direction:side},
      {group:"Trendi",name:side==="BUY"?"Volyymi vähintään 0,5× edeltävän 20 kynttilän keskiarvo":"Volyymi vähintään 0,5× edeltävän 20 kynttilän keskiarvo",ok:Number.isFinite(b.volumeRatio)&&b.volumeRatio>=MIN_VOLUME_RATIO,direction:side},
      {group:"Ajoitus",name:"Hinta ei ole liian kaukana EMA 21:stä",ok:distanceOk,direction:side},
      {group:"Ajoitus",name:"Ei poikkeuksellisen suuri ATR-volatiliteetti",ok:volatilityOk,direction:side},
      {group:"Ajoitus",name:side==="BUY"?"Ostolle tilaa vastukseen":"Myynnille tilaa tukeen",ok:levelOk,direction:side},
      {group:"Ajoitus",name:"Kaksi suurempaa aikaväliä vahvistaa",ok:timeframeOk,direction:side}
    ];
    var passed=checklist.filter(function(x){return x.ok;}).length, blocking=checklist.filter(function(x){return !x.ok;});
    var blockingReasons=blocking.map(function(x){return describeCheck(x,b,main,higher,checks,side,main.supportRoom,main.resistanceRoom,spreadPct,priceAgeMs,upConfirmed,downConfirmed);});
    var direction=passed===checklist.length&&side==="BUY"?"BUY":passed===checklist.length&&side==="SELL"?"SELL":"WAIT";
    var riskCapital=number(opts.capital), riskPct=number(opts.riskPct), feePct=number(opts.feePct), slippagePct=number(opts.slippagePct), maxExposurePct=number(opts.maxExposurePct);
    var stop=Number.isFinite(b.atr)?(direction==="BUY"?price-1.5*b.atr:price+1.5*b.atr):NaN;
    var target=Number.isFinite(b.atr)?(direction==="BUY"?price+2.25*b.atr:price-2.25*b.atr):NaN;
    var qty=0;
    if(direction==="BUY"&&riskCapital>0&&riskPct>0&&Number.isFinite(price)&&Number.isFinite(stop)&&stop<price){
      var riskPerUnit=price-stop, riskBudget=riskCapital*riskPct/100;
      qty=Math.min(riskBudget/riskPerUnit,riskCapital*(maxExposurePct/100)/price);
      qty=Math.max(0,qty);
    }
    return {direction:direction,side:side,passed:passed,total:checklist.length,checklist:checklist,blockingReasons:blockingReasons,reason:direction==="WAIT"?"ODOTA: kaikki vaaditut ehdot eivät täyty. Signaalia ei pakoteta.":direction==="BUY"?"OSTA: kaikki vahvistetut ehdot täyttyvät.":"MYY: kaikki vahvistetut ehdot täyttyvät.",
      trendBias:checks.bias,spreadPct:spreadPct,priceAgeMs:priceAgeMs,upConfirmed:upConfirmed,downConfirmed:downConfirmed,stop:stop,target:target,qty:qty,feePct:feePct,slippagePct:slippagePct};
  }
  function backtest(series,opts) {
    opts=Object.assign({},COST_DEFAULTS,opts||{});
    var higher=opts.higherSeries||[];
    var start=Math.max(220,Number.isInteger(opts.startIndex)?opts.startIndex:220);
    if(!Array.isArray(series)||series.length<=start||higher.length<2)return {count:0,trades:[],netPnl:0,maxDrawdownPct:0,startIndex:start};
    var cash=number(opts.capital); if(!Number.isFinite(cash)||cash<=0)cash=1000;
    var initial=cash,peak=cash,maxDrawdown=0,trades=[];
    for(var i=start;i<series.length;i++){
      var main=analyzeSeries(series.slice(0,i+1));
      var higherAnalyses=higher.map(function(h){return analyzeSeries(h.slice(0,Math.min(h.length,i+1)));});
      var m=main.bar;
      var s=evaluateSignal(main,higherAnalyses,{price:m.close,closeTime:m.closeTime,bid:m.close,ask:m.close},{capital:initial,riskPct:opts.riskPct,feePct:opts.feePct,slippagePct:opts.slippagePct,maxExposurePct:opts.maxExposurePct,historical:true});
      if(s.direction!=="BUY"||!Number.isFinite(s.qty)||s.qty<=0)continue;
      var next=series[i+1]; if(!next)break;
      var entry=next.open*(1+opts.slippagePct/100), exit=entry;
      var stop=s.stop*(1-opts.slippagePct/100), target=s.target*(1-opts.slippagePct/100);
      for(var j=i+1;j<series.length;j++){
        var bar=series[j];
        if(bar.low<=stop){exit=stop;break;}
        if(bar.high>=target){exit=target;break;}
        exit=bar.close*(1-opts.slippagePct/100);
      }
      var gross=(exit-entry)*s.qty, fees=(entry*s.qty+exit*s.qty)*opts.feePct/100, pnl=gross-fees;
      cash+=pnl;peak=Math.max(peak,cash);maxDrawdown=Math.max(maxDrawdown,(peak-cash)/peak*100);
      trades.push({entryTime:next.time,exitTime:series[Math.min(series.length-1,j)].time,pnl:pnl});
    }
    return {count:trades.length,trades:trades,netPnl:cash-initial,maxDrawdownPct:maxDrawdown,startIndex:start};
  }
  root.TradingEngine={parseKlines:parseKlines,enrich:enrich,analyzeSeries:analyzeSeries,explainCandle:explainCandle,evaluateSignal:evaluateSignal,makeSignal:evaluateSignal,backtest:backtest,defaults:COST_DEFAULTS};
})(typeof window !== "undefined" ? window : globalThis);
