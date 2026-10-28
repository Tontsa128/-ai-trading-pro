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
  function trendLabelFi(bias) { return bias === "bull" ? "NOUSU" : bias === "bear" ? "LASKU" : "Ei vahvistusta"; }
  function fixed(value, digits) { return Number.isFinite(value) ? value.toFixed(digits) : "ei saatavilla"; }
  function signedFixed(value, digits) { return Number.isFinite(value) ? (value > 0 ? "+" : "") + value.toFixed(digits) : "ei saatavilla"; }
  function fixedFi(value, digits) { return Number.isFinite(value) ? value.toLocaleString("fi-FI", {minimumFractionDigits:digits,maximumFractionDigits:digits}) : "ei saatavilla"; }
  function signedFixedFi(value, digits) { return Number.isFinite(value) ? (value > 0 ? "+" : "") + fixedFi(value, digits) : "ei saatavilla"; }
  // Percent inputs are expressed in percentage points; half the spread is charged per side.
  function estimatePerSideFriction(feePct, slippagePct, spreadPct) {
    var feeRate = Math.max(0, number(feePct) || 0) / 100;
    var slipRate = Math.max(0, number(slippagePct) || 0) / 100;
    var spreadValue = number(spreadPct);
    var spreadRate = Number.isFinite(spreadValue) ? Math.max(0, spreadValue) / 200 : 0;
    return feeRate + slipRate + spreadRate;
  }
  function describeCheck(x, b, main, higher, checks, side, supportRoom, resistanceRoom, spreadPct, priceAgeMs, referencePrice) {
    if (x.name.indexOf("MACD-histogrammi") === 0) {
      var bearishMacd = x.name.indexOf("negatiivinen") >= 0;
      var requirement = bearishMacd ? "< 0 (laskusuunnan ehto)" : "> 0 (noususuunnan ehto)";
      return "MACD-histogrammi " + signedFixedFi(b.macdHist, 6) + "; vaaditaan " + requirement + "; " + (x.ok ? "ehto täyttyy" : "ehto ei täyty");
    }
    if (x.name.indexOf("Volyymi") === 0) {
      var ratio = Number.isFinite(b.volumeRatio) ? fixedFi(b.volumeRatio, 2) + "×" : "ei saatavilla";
      return "Volyymi " + ratio + " (" + (x.ok ? "vaatimus ≥ 0.50× täyttyy" : "vaatimus ≥ 0.50× ei täyty") + ")";
    }
    if (x.name.indexOf("Kaksi suurempaa aikaväliä") === 0) {
      var hasOneHour = higher.length >= 3;
      var oneHour = hasOneHour && higher[0] && higher[0].checks ? higher[0].checks.bias : checks.bias;
      var fourHour = higher[hasOneHour ? 1 : 0] && higher[hasOneHour ? 1 : 0].checks ? higher[hasOneHour ? 1 : 0].checks.bias : "neutral";
      var daily = higher[hasOneHour ? 2 : 1] && higher[hasOneHour ? 2 : 1].checks ? higher[hasOneHour ? 2 : 1].checks.bias : "neutral";
      var requiredBias = side === "SELL" ? "bear" : "bull";
      return "1 h: " + trendLabelFi(oneHour) + ", 4 h: " + trendLabelFi(fourHour) + ", 1 d: " + trendLabelFi(daily) +
        "; vahvistus vaatii 4 h ja 1 d: " + trendLabelFi(requiredBias) + (x.ok ? "" : ". Vahvistus puuttuu: vaaditaan 4 h ja 1 d " + trendLabelFi(requiredBias).toLowerCase() + ".");
    }
    if (x.name.indexOf("Myynnille tilaa tukeen") === 0) {
      var supportDistance = referencePrice - main.support;
      var supportMin = 0.5 * b.atr;
      return "Tukea " + fixedFi(supportRoom, 2) + " ATR:n päässä; vaaditaan vähintään 0,50 ATR. Viitehinta " + fixedFi(referencePrice, 2) +
        "; tuki " + fixedFi(main.support, 2) + "; hintaero " + fixedFi(supportDistance, 2) + ".";
    }
    if (x.name.indexOf("Ostolle tilaa vastukseen") === 0) {
      var resistanceDistance = main.resistance - referencePrice;
      var resistanceMin = 0.5 * b.atr;
      return "Viitehinta " + fixedFi(referencePrice, 2) + "; vastus " + fixedFi(main.resistance, 2) + "; etäisyys " + fixedFi(resistanceDistance, 2) +
        " hinnan yksikköä (" + fixedFi(resistanceRoom, 2) + " ATR); vaatimus ≥ " + fixedFi(resistanceMin, 2) + " (0.50 ATR)";
    }
    if (x.name === "Hinta ei ole liian kaukana EMA 21:stä") {
      var emaDistanceAtr = Number.isFinite(b.atr) && b.atr > 0 ? Math.abs(b.close-b.ema21)/b.atr : NaN;
      return (x.ok ? "Hinta ei ole liian kaukana" : "Hinta on liian kaukana") + " EMA 21:stä: " +
        fixedFi(Math.abs(b.close-b.ema21), 2) + " hinnan yksikköä (" + fixedFi(emaDistanceAtr, 2) +
        " ATR; sallittu enintään 1.60 ATR); " + (x.ok ? "ehto täyttyy" : "ehto ei täyty");
    }
    if (x.name.indexOf("Ei poikkeuksellisen suuri ATR-volatiliteetti") === 0) {
      return "ATR-volatiliteetti " + fixedFi(b.atrPct, 2) + " %; raja enintään 3.00 %; " + (x.ok ? "ehto täyttyy" : "ehto ei täyty");
    }
    if (x.name.indexOf("Riittävästi historiadataa") === 0) {
      return main.high.length + " suljettua kynttilää; vähimmäismäärä 220";
    }
    if (x.name.indexOf("Hinta EMA 200:n") === 0) {
      return "Hinta " + fixedFi(b.close, 2) + " on EMA 200:n (" + fixedFi(b.ema200, 2) + ") alapuolella";
    }
    if (x.name.indexOf("EMA 50 EMA 200:n") === 0) {
      return "EMA 50 = " + fixedFi(b.ema50, 2) + " on EMA 200:n (" + fixedFi(b.ema200, 2) + ") alapuolella";
    }
    if (x.name.indexOf("EMA 9 EMA 21:n") === 0) {
      return "EMA 9 = " + fixedFi(b.ema9, 2) + " on EMA 21:n (" + fixedFi(b.ema21, 2) + ") alapuolella";
    }
    if (x.name.indexOf("RSI 32–50") === 0) {
      return "RSI " + fixedFi(b.rsi, 1) + "; vaaditaan 32–50";
    }
    if (x.name.indexOf("Osto/myyntihajonta") === 0) {
      return "Hajonta " + fixedFi(spreadPct, 4) + " %; raja enintään 0,15 %; " + (x.ok ? "ehto täyttyy" : "ehto ei täyty");
    }
    if (x.name.indexOf("Markkinahinta tuore") === 0 || x.name.indexOf("Historiallinen kynttilä sulkeutunut") === 0) {
      return "Ikä " + fixedFi(priceAgeMs / 1000, 1) + " s; raja 30 s";
    }
    return x.name;
  }
  function explainCandle(b) {
    var bull=[{name:"Hinta EMA 200:n yläpuolella",ok:b.close>b.ema200},{name:"EMA 50 EMA 200:n yläpuolella",ok:b.ema50>b.ema200},{name:"EMA 9 EMA 21:n yläpuolella",ok:b.ema9>b.ema21},{name:"MACD-histogrammi positiivinen (nousupainotteinen)",ok:b.macdHist>0},{name:"RSI 50–68 (ei ylikuumentunut)",ok:b.rsi>=50&&b.rsi<=68},{name:"ADX vähintään 18 ja ostajien suunta vahvempi",ok:b.adx>=18&&b.pdi>b.mdi},{name:"Volyymi vähintään 0,5× edeltävän 20 kynttilän keskiarvo",ok:Number.isFinite(b.volumeRatio)&&b.volumeRatio>=MIN_VOLUME_RATIO}];
    var bear=[{name:"Hinta EMA 200:n alapuolella",ok:b.close<b.ema200},{name:"EMA 50 EMA 200:n alapuolella",ok:b.ema50<b.ema200},{name:"EMA 9 EMA 21:n alapuolella",ok:b.ema9<b.ema21},{name:"MACD-histogrammi negatiivinen (laskupainotteinen)",ok:b.macdHist<0},{name:"RSI 32–50 (ei ylikuumentunut)",ok:b.rsi>=32&&b.rsi<=50},{name:"ADX vähintään 18 ja myyjien suunta vahvempi",ok:b.adx>=18&&b.mdi>b.pdi},{name:"Volyymi vähintään 0,5× edeltävän 20 kynttilän keskiarvo",ok:Number.isFinite(b.volumeRatio)&&b.volumeRatio>=MIN_VOLUME_RATIO}];
    var bullN=bull.filter(function(x){return x.ok;}).length,bearN=bear.filter(function(x){return x.ok;}).length,bias="neutral";
    if(b.close>b.ema200&&b.ema50>b.ema200&&b.ema9>b.ema21)bias="bull";
    if(b.close<b.ema200&&b.ema50<b.ema200&&b.ema9<b.ema21)bias="bear";
    return {bull:bull,bear:bear,bullN:bullN,bearN:bearN,bias:bias};
  }
  function analyzeSeries(series) {
    if(!Array.isArray(series)||series.length<220)throw new Error("Tarvitaan vähintään 220 sulkeutunutta kynttilää EMA 200 -suodattimeen.");
    var b=series[series.length-1],checks=explainCandle(b);
    var longCore=b.close>b.ema200&&b.ema50>b.ema200&&b.ema9>b.ema21&&b.macdHist>0&&b.rsi>=50&&b.rsi<=68&&b.adx>=18&&b.pdi>b.mdi&&Number.isFinite(b.volumeRatio)&&b.volumeRatio>=MIN_VOLUME_RATIO;
    var shortCore=b.close<b.ema200&&b.ema50<b.ema200&&b.ema9<b.ema21&&b.macdHist<0&&b.rsi>=32&&b.rsi<=50&&b.adx>=18&&b.mdi>b.pdi&&Number.isFinite(b.volumeRatio)&&b.volumeRatio>=MIN_VOLUME_RATIO;
    var validEmaDistance=Number.isFinite(b.close)&&Number.isFinite(b.ema21)&&Number.isFinite(b.atr)&&b.atr>0;var overextended=!validEmaDistance||Math.abs(b.close-b.ema21)>1.6*b.atr,highVolatility=!Number.isFinite(b.atrPct)||b.atrPct>3;
    return {bar:b,checks:checks,longCore:longCore,shortCore:shortCore,overextended:overextended,highVolatility:highVolatility,support:Math.min.apply(null,series.slice(-31,-1).map(function(x){return x.low;})),resistance:Math.max.apply(null,series.slice(-31,-1).map(function(x){return x.high;})),high:series};
  }
  function evaluateSignal(main,higher,market,options) {
    var opts=Object.assign({},COST_DEFAULTS,options||{}),checks=main.checks,b=main.bar;
    var spreadPct=market.bid>0&&market.ask>=market.bid?(market.ask-market.bid)/((market.ask+market.bid)/2)*100:Infinity;
    var rawPriceAgeMs=opts.historical?0:Date.now()-Number(market.closeTime||0);var priceAgeMs=rawPriceAgeMs<0&&rawPriceAgeMs>=-5000?0:rawPriceAgeMs;
    var common=[{name:"Riittävästi historiadataa",ok:main.high.length>=220},{name:opts.historical?"Historiallinen kynttilä sulkeutunut":"Markkinahinta tuore (alle 30 s)",ok:opts.historical===true||(Number.isFinite(priceAgeMs)&&priceAgeMs>=-30000&&priceAgeMs<=30000)},{name:"Osto/myyntihajonta enintään 0,15 %",ok:spreadPct<=0.15},{name:"Ei poikkeuksellisen suuri ATR-volatiliteetti",ok:!main.highVolatility},{name:"Hinta ei ole liian kaukana EMA 21:stä",ok:!main.overextended}];
    var hasThreeHigher=higher.length>=3;
    var confirmationHigher=hasThreeHigher?[higher[1],higher[2]]:higher;
    var upConfirmed=confirmationHigher.length>=2&&confirmationHigher.every(function(x){return x&&x.checks&&x.checks.bias==="bull";}),downConfirmed=confirmationHigher.length>=2&&confirmationHigher.every(function(x){return x&&x.checks&&x.checks.bias==="bear";});
    var referencePrice=Number.isFinite(market.price)&&market.price>0?market.price:b.close;
    var supportRoom=main.support>0&&Number.isFinite(b.atr)?(referencePrice-main.support)/b.atr:NaN,resistanceRoom=main.resistance>0&&Number.isFinite(b.atr)?(main.resistance-referencePrice)/b.atr:NaN;
    var longSpace=Number.isFinite(resistanceRoom)&&resistanceRoom>=MIN_LEVEL_CLEARANCE_ATR,shortSpace=Number.isFinite(supportRoom)&&supportRoom>=MIN_LEVEL_CLEARANCE_ATR;
    var long=main.longCore&&upConfirmed&&common.every(function(x){return x.ok;})&&longSpace,short=main.shortCore&&downConfirmed&&common.every(function(x){return x.ok;})&&shortSpace;
    var direction=long?"BUY":short?"SELL":"WAIT",side=direction==="BUY"?"BUY":direction==="SELL"?"SELL":checks.bias==="bear"?"SELL":checks.bias==="bull"?"BUY":checks.bearN>checks.bullN?"SELL":"BUY";
    var directional=(side==="BUY"?checks.bull:checks.bear).map(function(x){return {name:x.name,ok:x.ok,group:"Trendi",direction:side,detail:describeCheck(x,b,main,higher,checks,side,supportRoom,resistanceRoom,spreadPct,priceAgeMs,referencePrice)};});
    var dataChecks=common.slice(0,4).map(function(x){return {name:x.name,ok:x.ok,group:"Data OK",direction:side,detail:describeCheck(x,b,main,higher,checks,side,supportRoom,resistanceRoom,spreadPct,priceAgeMs,referencePrice)};});
    var timingChecks=[{name:"Hinta ei ole liian kaukana EMA 21:stä",ok:!main.overextended,group:"Ajoitus",direction:side,detail:describeCheck({name:"Hinta ei ole liian kaukana EMA 21:stä"},b,main,higher,checks,side,supportRoom,resistanceRoom,spreadPct,priceAgeMs,referencePrice)},{name:side==="BUY"?"Ostolle tilaa vastukseen vähintään 0,5 ATR":"Myynnille tilaa tukeen vähintään 0,5 ATR",ok:side==="BUY"?longSpace:shortSpace,group:"Ajoitus",direction:side,detail:describeCheck({name:side==="BUY"?"Ostolle tilaa vastukseen":"Myynnille tilaa tukeen"},b,main,higher,checks,side,supportRoom,resistanceRoom,spreadPct,priceAgeMs,referencePrice)},{name:"Kaksi suurempaa aikaväliä vahvistaa samaa suuntaa",ok:side==="BUY"?upConfirmed:downConfirmed,group:"Ajoitus",direction:side,detail:describeCheck({name:"Kaksi suurempaa aikaväliä"},b,main,higher,checks,side,supportRoom,resistanceRoom,spreadPct,priceAgeMs,referencePrice)}];
    var checklist=dataChecks.concat(directional,timingChecks),passes=checklist.filter(function(x){return x.ok;}).length;
    var capital=Math.max(0,number(opts.capital)||0),riskPct=Math.max(0,Math.min(1,number(opts.riskPct)||0.5)),exposurePct=Math.max(1,Math.min(100,number(opts.maxExposurePct)||25));
    var spreadFriction=estimatePerSideFriction(opts.feePct,opts.slippagePct,spreadPct),riskCash=capital*riskPct/100,entry=Number(market.price),stop=null,target=null,qty=0,notional=0,estLoss=0,estGain=0;
    if(direction!=="WAIT"&&Number.isFinite(entry)&&entry>0&&Number.isFinite(b.atr)&&b.atr>0){var stopDistance=1.5*b.atr,targetDistance=2.5*b.atr;stop=direction==="BUY"?entry-stopDistance:entry+stopDistance;target=direction==="BUY"?entry+targetDistance:entry-targetDistance;if(direction==="BUY"){var costPerUnit=stopDistance+(entry+stop)*spreadFriction;qty=capital>0?Math.min(riskCash/costPerUnit,capital*(exposurePct/100)/entry):0;notional=qty*entry;estLoss=qty*costPerUnit;estGain=qty*(targetDistance-(entry+target)*spreadFriction);}}
    return {direction:direction,entry:entry,stop:stop,target:target,qty:qty,notional:notional,riskCash:riskCash,estimatedLoss:estLoss,estimatedGain:estGain,spreadPct:spreadPct,priceAgeMs:priceAgeMs,checklist:checklist,passed:passes,total:checklist.length,checks:checks,higher:higher,trendBias:checks.bias,higherBias:higher.map(function(x){return x.checks.bias;}),blockingReasons:checklist.filter(function(x){return !x.ok;}).map(function(x){return describeCheck(x,b,main,higher,checks,side,supportRoom,resistanceRoom,spreadPct,priceAgeMs,referencePrice);}),supportDistanceAtr:supportRoom,resistanceDistanceAtr:resistanceRoom,reason:direction==="BUY"?"Nousuehdot täyttyivät kaikilla suodattimilla. Spot-osto, ei automaattista toimeksiantoa.":direction==="SELL"?"Laskuehdot vahvistuivat. Spot-käytössä tämä tarkoittaa omistuksen vähentämistä tai ostamisen välttämistä, ei shorttausta.":"ODOTA: kaikki vaaditut ehdot eivät täyty. Signaalia ei pakoteta.",params:opts,main:main};
  }
  function fastReaction(series) {
    function idle(note) {
      return {score:0,signal:"EI",notes:note?[note]:[],atr:null};
    }
    if (!Array.isArray(series) || series.length < 30) {
      return idle("Nopeaan signaaliin tarvitaan vähintään 30 kynttilää.");
    }
    var c = series[series.length - 1], prev = series.slice(0, -1);
    var required = ["open","high","low","close","volume","ema9","ema21"];
    if (!c || required.some(function (key) { return !Number.isFinite(c[key]); }) ||
        c.close <= 0 || c.high < Math.max(c.open,c.close,c.low) ||
        c.low > Math.min(c.open,c.close,c.high)) {
      return idle("Live-kynttilän tiedot puuttuvat tai ovat virheelliset.");
    }

    var price = c.close;
    var body = Math.abs(c.close - c.open);
    var priorAtr = prev[prev.length - 1] && prev[prev.length - 1].atr;
    var atr = Math.max(Number.isFinite(priorAtr) && priorAtr > 0 ? priorAtr : 0, price * 0.001);
    var priorVolumes = prev.slice(-20).map(function (bar) { return bar.volume; });
    if (priorVolumes.length < 20 || priorVolumes.some(function (value) { return !Number.isFinite(value) || value < 0; })) {
      return idle("Volyymihistoria ei riitä nopean signaalin laskentaan.");
    }
    var volMa = Math.max(priorVolumes.reduce(function (sum, value) { return sum + value; }, 0) / priorVolumes.length, 1e-9);
    var recent = prev.slice(-8);
    if (recent.length < 8 || recent.some(function (bar) { return !Number.isFinite(bar.high) || !Number.isFinite(bar.low); })) {
      return idle("Breakout-tarkasteluun tarvitaan kahdeksan aiempaa kynttilää.");
    }

    var green = c.close > c.open, red = c.close < c.open;
    var score = 0, notes = [];
    if (green) {
      if (body > atr * 0.22) { score += 24; notes.push("Live-vihreä kynttilä vahvistuu"); }
      if (body > atr * 0.48) { score += 18; notes.push("Live-vihreä kynttilä erittäin vahva"); }
      if (c.close > c.ema9) { score += 10; notes.push("Hinta EMA9 yläpuolella"); }
      if (c.close > c.ema21) { score += 10; notes.push("Hinta EMA21 yläpuolella"); }
      if (c.high >= Math.max.apply(null, recent.map(function (bar) { return bar.high; }))) {
        score += 14; notes.push("Uusi lyhyen aikavälin huippu / breakout");
      }
      if (c.volume > volMa) { score += 8; notes.push("Volyymi tukee nousua"); }
    }
    if (red) {
      if (body > atr * 0.22) { score -= 24; notes.push("Live-punainen kynttilä vahvistuu"); }
      if (body > atr * 0.48) { score -= 18; notes.push("Live-punainen kynttilä erittäin vahva"); }
      if (c.close < c.ema9) { score -= 10; notes.push("Hinta EMA9 alapuolella"); }
      if (c.close < c.ema21) { score -= 10; notes.push("Hinta EMA21 alapuolella"); }
      if (c.low <= Math.min.apply(null, recent.map(function (bar) { return bar.low; }))) {
        score -= 14; notes.push("Uusi lyhyen aikavälin pohja / breakdown");
      }
      if (c.volume > volMa) { score -= 8; notes.push("Volyymi tukee laskua"); }
    }

    return {
      score: score,
      signal: score >= 30 ? "NOPEA OSTA" : score <= -30 ? "NOPEA MYY" : "EI",
      notes: notes,
      atr: atr
    };
  }

  function resolveLongExit(bar, stop, target) {
    if (!bar || ![bar.open, bar.high, bar.low, stop, target].every(Number.isFinite) ||
        !(stop > 0) || !(target > stop)) return null;
    // A stop-market order can gap through its trigger; do not pretend it fills at stop.
    if (bar.open < stop) return {price: bar.open, cause: "Stop-loss gap"};
    // A target limit is considered filled at the target when the market opens through it.
    if (bar.open >= target) return {price: target, cause: "Tavoite"};
    // If both levels are touched within one OHLC bar, conservatively assume stop first.
    if (bar.low <= stop) return {price: stop, cause: bar.high >= target ? "Stop-first ambiguous candle" : "Stop-loss"};
    if (bar.high >= target) return {price: target, cause: "Tavoite"};
    return null;
  }

  function backtest(series,options){
    var opts=Object.assign({},COST_DEFAULTS,options||{}),startCapital=Math.max(100,number(opts.capital)||10000),equity=startCapital,peak=equity,maxDd=0,trades=[];
    var riskPct=Math.max(0,Math.min(1,number(opts.riskPct)||0.5))/100,exposurePct=Math.max(1,Math.min(100,number(opts.maxExposurePct)||25))/100,higherSeries=Array.isArray(opts.higherSeries)?opts.higherSeries:[],assumedSpreadRaw=number(opts.assumedSpreadPct),assumedSpreadPct=Math.max(0,Number.isFinite(assumedSpreadRaw)?assumedSpreadRaw:0.10),friction=estimatePerSideFriction(opts.feePct,opts.slippagePct,assumedSpreadPct),requestedStart=Number(opts.startIndex),startIndex=Number.isInteger(requestedStart)?Math.max(220,Math.min(series.length-2,requestedStart)):220,inPositionUntil=-1;
    for(var i=startIndex;i<series.length-2;i++){if(i<=inPositionUntil)continue;var b=series[i],prefix=series.slice(0,i+1),main;try{main=analyzeSeries(prefix);}catch(_){continue;}var higher=[];for(var h=0;h<higherSeries.length;h++){var hist=higherSeries[h].filter(function(x){return x.closeTime<=b.closeTime;});if(hist.length<220){higher=[];break;}try{higher.push(analyzeSeries(hist));}catch(_){higher=[];break;}}if(higher.length<2)continue;var halfSpread=b.close*assumedSpreadPct/200,decision=evaluateSignal(main,higher,{price:b.close,closeTime:b.closeTime,bid:b.close-halfSpread,ask:b.close+halfSpread},Object.assign({},opts,{capital:equity,historical:true}));if(decision.direction!=="BUY")continue;var entryBar=series[i+1],entry=entryBar.open,atr=b.atr;if(!Number.isFinite(entry)||!Number.isFinite(atr)||entry<=0||atr<=0)continue;var stop=entry-1.5*atr,target=entry+2.5*atr,riskPerUnit=(entry-stop)+(entry+stop)*friction,qty=Math.min((equity*riskPct)/riskPerUnit,(equity*exposurePct)/entry);if(!(qty>0))continue;var exit=entry,exitIndex=i+1,cause="Aikaraja",maxIndex=Math.min(series.length-1,i+30);for(var j=i+1;j<=maxIndex;j++){var bar=series[j],outcome=resolveLongExit(bar,stop,target);if(outcome){exit=outcome.price;exitIndex=j;cause=outcome.cause;break;}exit=bar.close;exitIndex=j;}var gross=(exit-entry)*qty,costs=(entry+exit)*qty*friction,pnl=gross-costs,before=equity;equity+=pnl;peak=Math.max(peak,equity);maxDd=Math.max(maxDd,peak>0?(peak-equity)/peak*100:0);trades.push({entryTime:entryBar.time,exitTime:series[exitIndex].time,entry:entry,exit:exit,stop:stop,target:target,qty:qty,pnl:pnl,returnPct:before>0?pnl/before*100:0,cause:cause,win:pnl>0});inPositionUntil=exitIndex;}
    var wins=trades.filter(function(t){return t.win;}),losses=trades.filter(function(t){return !t.win;}),grossWins=wins.reduce(function(a,t){return a+t.pnl;},0),grossLoss=Math.abs(losses.reduce(function(a,t){return a+t.pnl;},0));
    return {trades:trades,count:trades.length,wins:wins.length,winRate:trades.length?wins.length/trades.length*100:0,startIndex:startIndex,startCapital:startCapital,endEquity:equity,netPnl:equity-startCapital,netPct:(equity/startCapital-1)*100,maxDrawdownPct:maxDd,profitFactor:grossLoss>0?grossWins/grossLoss:(grossWins>0?Infinity:0),note:"Suljettujen kynttilöiden long-only spot-koe. Jokainen sisääntulo käyttää evaluateSignal()-arviota sekä annettuja sulkeutuneita korkeampia aikavälejä; kulut ja lipsuma vähennetään. Historiallinen tulos ei ennusta tulevaa."};
  }
  root.TradingEngine={parseKlines:parseKlines,enrich:enrich,analyzeSeries:analyzeSeries,explainCandle:explainCandle,evaluateSignal:evaluateSignal,makeSignal:evaluateSignal,fastReaction:fastReaction,resolveLongExit:resolveLongExit,estimatePerSideFriction:estimatePerSideFriction,backtest:backtest,defaults:COST_DEFAULTS};
})(typeof window !== "undefined" ? window : globalThis);

/* Rahasampo mobile chart fallback */
(function () {
  "use strict";
  if (window.matchMedia && window.matchMedia("(max-width: 850px)").matches) {
    window.Plotly = null;
  }
})();
