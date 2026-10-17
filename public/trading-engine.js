    var checklist=dataChecks.concat(directional,timingChecks);
    var passes=checklist.filter(function(x){return x.ok;}).length;
    var strengthPct=checklist.length ? Math.max(0,Math.min(100,Math.round((passes/checklist.length)*100))) : 0;
    var capital=Math.max(0,number(opts.capital)||0), riskPct=Math.max(0,Math.min(1,number(opts.riskPct)||0.5));
    var exposurePct=Math.max(1,Math.min(100,number(opts.maxExposurePct)||25));
    var fee=Math.max(0,number(opts.feePct)||0)/100, slip=Math.max(0,number(opts.slippagePct)||0)/100;
    var entry=Number(market.price), stop=null,target=null,qty=0,riskCash=capital*riskPct/100,notional=0,estLoss=0,estGain=0;
    if (direction!=="WAIT"&&Number.isFinite(entry)&&entry>0&&Number.isFinite(b.atr)&&b.atr>0) {
      var stopDistance=1.5*b.atr, targetDistance=2.5*b.atr;
      stop=direction==="BUY"?entry-stopDistance:entry+stopDistance;
      target=direction==="BUY"?entry+targetDistance:entry-targetDistance;
      if (direction==="BUY") {
        var costPerUnit=stopDistance+(entry+stop)*(fee+slip);
        qty=capital>0?Math.min(riskCash/costPerUnit,capital*(exposurePct/100)/entry):0;
        notional=qty*entry; estLoss=qty*costPerUnit;
        estGain=qty*(targetDistance-(entry+stop)*(fee+slip));
      } else {
        // A spot sell exits an existing holding; holdings were not provided, so never invent a sell quantity.
        qty=0; notional=0; estLoss=0; estGain=0;
      }
    }
    return {direction:direction,entry:entry,stop:stop,target:target,qty:qty,notional:notional,
      riskCash:riskCash,estimatedLoss:estLoss,estimatedGain:estGain,spreadPct:spreadPct,priceAgeMs:priceAgeMs,
      checklist:checklist,passed:passes,total:checklist.length,strengthPct:strengthPct,checks:checks,higher:higher,trendBias:checks.bias,higherBias:higher.map(function(x){return x.checks.bias;}),blockingReasons:checklist.filter(function(x){return !x.ok;}).map(function(x){return x.name;}),
      reason:direction==="BUY"?"Nousuehdot täyttyivät kaikilla suodattimilla. Spot-osto, ei automaattista toimeksiantoa.":
        direction==="SELL"?"Laskuehdot vahvistuivat. Spot-käytössä tämä tarkoittaa omistuksen vähentämistä tai ostamisen välttämistä, ei shorttausta.":
        "ODOTA: kaikki vaaditut ehdot eivät täyty. Signaalia ei pakoteta.",
      params:opts, main:main};
  }
