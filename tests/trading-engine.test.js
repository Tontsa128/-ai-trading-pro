"use strict";
const assert=require("node:assert/strict");
global.window=global;
require("../trading-engine.js");
const E=global.TradingEngine;
assert.ok(E);
assert.equal(typeof E.explainCandle,"function");
assert.equal(typeof E.evaluateSignal,"function");
assert.equal(typeof E.makeSignal,"function");
assert.equal(E.STRATEGY_VERSION,"spot-long-v28");

const fixture={close:95,ema200:100,ema50:98,ema9:94,ema21:96,macdHist:-.0125,rsi:40,adx:30,pdi:8,mdi:20,volumeRatio:.8};
assert.equal(E.explainCandle(fixture).bear.find(x=>x.name.includes("MACD-histogrammi")).ok,true);
assert.equal(E.explainCandle({...fixture,macdHist:.0125}).bear.find(x=>x.name.includes("MACD-histogrammi")).ok,false);

const candle=(t,ct,o,h,l,c,v)=>[t,String(o),String(h),String(l),String(c),String(v),ct];
assert.equal(E.parseKlines([candle(100,1000,100,102,99,101,20),candle(200,60000,101,103,100,102,25)],50000).length,1);
function makeBars(length){const a=[];let p=100;for(let i=0;i<length;i++){const c=100+i*.035+Math.sin(i/6)*.5+Math.sin(i/19)*.15,o=p,h=Math.max(o,c)+Math.max(c*.0015,.02),l=Math.min(o,c)-Math.max(c*.0015,.02);a.push({time:1700000000000+i*300000,closeTime:1700000299999+i*300000,open:o,high:h,low:l,close:c,volume:100+10*(1+Math.sin(i*1.3))});p=c;}return a;}
const full=E.enrich(makeBars(520));
assert.equal(full.length,520);assert.ok(Number.isFinite(full[400].ema200));assert.ok(full[400].rsi>=0&&full[400].rsi<=100);assert.ok(Number.isFinite(full[400].adx));
assert.throws(()=>E.analyzeSeries(full.slice(0,100)),/vähintään 220/);
const changed=E.enrich(makeBars(520));changed[519].close*=2;assert.equal(full[300].ema200,changed[300].ema200);
const analysed=E.analyzeSeries(full),opts={capital:1000,riskPct:.5,maxExposurePct:25,feePct:.1,slippagePct:.05};
const signal=E.evaluateSignal(analysed,[analysed,analysed],{price:analysed.bar.close,closeTime:Date.now(),bid:100,ask:100.01},opts);
assert.ok(["BUY","WAIT"].includes(signal.direction));
assert.ok(signal.passed>=0&&signal.passed<=signal.total);
assert.equal(signal.spotPolicy,"long-only");
assert.ok(signal.checklist.every(x=>["Data OK","Trendi","Ajoitus"].includes(x.group)));
assert.ok(signal.checklist.some(x=>x.name.includes("0,5×")));
assert.ok(signal.checklist.some(x=>x.name.includes("ADX")&&x.detail.includes("DI+")));
assert.ok(signal.checklist.some(x=>x.name.includes("RSI")&&x.detail.includes("vaadittu alue")));
assert.ok(Number.isFinite(signal.spreadPct));

const bear=[];let prev=200;for(let i=0;i<520;i++){const c=200-i*.1+Math.sin(i/6)*.5,o=prev,h=Math.max(o,c)+.2,l=Math.min(o,c)-.2;bear.push({time:1700000000000+i*300000,closeTime:1700000299999+i*300000,open:o,high:h,low:l,close:c,volume:100+10*(1+Math.sin(i*1.3))});prev=c;}
const ba=E.analyzeSeries(E.enrich(bear));assert.equal(ba.checks.bias,"bear");
const bs=E.evaluateSignal(ba,[ba,ba],{price:ba.bar.close,closeTime:Date.now(),bid:ba.bar.close*.9999,ask:ba.bar.close*1.0001},opts);
assert.equal(bs.direction,"WAIT");assert.equal(bs.spotExit,true);assert.match(bs.reason,/VÄLTÄ UUSIA OSTOJA/);assert.ok(!bs.reason.includes("short"));
const low={...ba,bar:{...ba.bar,volumeRatio:.43}};low.checks=E.explainCandle(low.bar);const ls=E.evaluateSignal(low,[ba,ba],{price:low.bar.close,closeTime:Date.now(),bid:low.bar.close*.9999,ask:low.bar.close*1.0001},opts);assert.ok(ls.blockingReasons.some(x=>x.includes("0.43×")&&x.includes("0.50×")));
const ex={...analysed,overextended:true};const es=E.evaluateSignal(ex,[analysed,analysed],{price:analysed.bar.close,closeTime:Date.now(),bid:analysed.bar.close*.9999,ask:analysed.bar.close*1.0001},opts);assert.ok(es.blockingReasons.some(x=>x.includes("ehto ei täyty")));
const vol={...analysed,highVolatility:true,bar:{...analysed.bar,atrPct:4.2}};const vs=E.evaluateSignal(vol,[analysed,analysed],{price:analysed.bar.close,closeTime:Date.now(),bid:analysed.bar.close*.9999,ask:analysed.bar.close*1.0001},opts);assert.ok(vs.blockingReasons.some(x=>x.includes("4.20 %")&&x.includes("ehto ei täyty")));
const historical=E.evaluateSignal(analysed,[analysed,analysed],{price:analysed.bar.close,closeTime:1,bid:100,ask:100.01},{...opts,historical:true});assert.equal(historical.priceAgeMs,0);
const stale=E.evaluateSignal(analysed,[analysed,analysed],{price:analysed.bar.close,closeTime:Date.now()-10*60*1000,bid:100,ask:100.01},opts);assert.equal(stale.direction,"WAIT");
assert.equal(analysed.support,Math.min(...full.slice(-31,-1).map(x=>x.low)));assert.equal(analysed.resistance,Math.max(...full.slice(-31,-1).map(x=>x.high)));
const bt=E.backtest(full,opts);assert.equal(bt.count,0);assert.ok(Number.isFinite(bt.netPnl));
const aligned=E.backtest(full,{...opts,higherSeries:[full,full]});assert.ok(Number.isFinite(aligned.netPnl));assert.equal(aligned.startIndex,220);const hold=E.backtest(full,{...opts,higherSeries:[full,full],startIndex:400});assert.equal(hold.startIndex,400);assert.ok(hold.trades.every(t=>t.entryTime>=full[401].time));
console.log("OK: unified long-only signal path, diagnostics, freshness, spread precision and causal backtest.");
