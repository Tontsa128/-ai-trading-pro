"use strict";
global.window=global;
require("../trading-engine.js");
const E=global.TradingEngine,fs=require("node:fs"),path=require("node:path");
const root=path.resolve(__dirname,".."),data=path.join(root,"data"),reports=path.join(data,"reports");
const symbols=["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT"],feePct=.10,slipPct=.05,cycleAt=Date.now();
const statePath=path.join(data,"paper-state.json");
const read=()=>JSON.parse(fs.readFileSync(statePath,"utf8"));
async function get(url){let last;for(const host of ["https://data-api.binance.vision","https://api1.binance.com","https://api2.binance.com","https://api3.binance.com","https://api.binance.com"]){const c=new AbortController(),t=setTimeout(()=>c.abort(),12000);try{const r=await fetch(host+url,{signal:c.signal});clearTimeout(t);if(r.status===418||r.status===429)throw Error("Binance rate limit HTTP "+r.status+" from "+host+url);if(!r.ok)throw Error("HTTP "+r.status+" from "+host+url);return await r.json()}catch(e){clearTimeout(t);last=e;if(/rate limit/.test(e.message))throw e}}throw last||Error("Data unavailable")}
async function bars(s,iv,n){return E.enrich(E.parseKlines(await get("/api/v3/klines?symbol="+s+"&interval="+iv+"&limit="+n),Date.now()))}
async function market(s){const [d,b]=await Promise.all([get("/api/v3/ticker/24hr?symbol="+s),get("/api/v3/ticker/bookTicker?symbol="+s)]);return{price:+d.lastPrice,closeTime:+d.closeTime,change:+d.priceChangePercent,bid:+b.bidPrice,ask:+b.askPrice}}
function equity(s,prices){return s.cash+Object.entries(s.positions).reduce((a,[k,p])=>a+p.qty*(prices[k]||p.lastPrice||p.entry),0)}
function buildTradeActivity(opened,closed){
 const opens=Array.isArray(opened)?opened:[];
 const exits=Array.isArray(closed)?closed:[];
 const eventTime=t=>Date.parse(t.exitTime||t.entryTime||"");
 return {newTrades:opens.concat(exits).slice().sort((a,b)=>{
  const at=eventTime(a),bt=eventTime(b);
  return (Number.isFinite(at)?at:0)-(Number.isFinite(bt)?bt:0);
 }),closedTrades:exits.slice()};
}
function sell(s,sym,p,price,reason,time){const fill=price*(1-slipPct/100),fee=fill*p.qty*feePct/100,proceeds=fill*p.qty-fee,pnl=proceeds-p.costBasis;s.cash+=proceeds;delete s.positions[sym];const t={symbol:sym,side:"PAPER_SELL",entryTime:p.entryTime,exitTime:new Date(time).toISOString(),entry:p.entry,exit:fill,qty:p.qty,costBasis:p.costBasis,proceeds,pnl,returnPct:pnl/p.costBasis*100,reason};s.trades.push(t);return t}
async function run(){
 fs.mkdirSync(reports,{recursive:true});const s=read();if(s.mode!=="paper"||s.schema!==1)throw Error("Unsafe state mode/schema; aborting");
 const rows=[],errors=[],opened=[],closed=[],prices={};
 for(const sym of symbols){try{
  const [one,four,day,m]=await Promise.all([bars(sym,"1h",500),bars(sym,"4h",300),bars(sym,"1d",300),market(sym)]);
  if(one.length<220||four.length<220||day.length<220)throw Error("Not enough closed candles");
  const a=E.analyzeSeries(one),higher=[E.analyzeSeries(four),E.analyzeSeries(day)],b=a.bar;
  const sig=E.evaluateSignal(a,higher,m,{capital:s.cash,riskPct:.5,maxExposurePct:20,feePct,slippagePct:slipPct});
  prices[sym]=m.price;let action="NO_ACTION",reason=sig.reason,pos=s.positions[sym];
  const lastSeen=Number(s.lastCandleTimeBySymbol[sym]||0),newBars=one.filter(x=>x.closeTime>lastSeen);
  if(pos){
   pos.lastPrice=m.price;
   for(const cb of newBars){
    if(cb.closeTime<=Number(pos.entryCandleTime||0))continue;
    const stop=cb.low<=pos.stop,target=cb.high>=pos.target;
    if(stop||target){
     const outcome=E.resolveLongExit(cb,pos.stop,pos.target);
     if(!outcome)continue;
     const t=sell(s,sym,pos,outcome.price,outcome.cause,cb.closeTime);
     closed.push(t);action="PAPER_SELL";reason=t.reason;pos=null;break;
    }
   }
   if(pos&&sig.direction==="SELL"){const t=sell(s,sym,pos,m.bid||m.price,"Confirmed bearish signal",cycleAt);closed.push(t);action="PAPER_SELL";reason=t.reason;pos=null}
   if(pos)action="HOLD";
  }else if(sig.direction==="BUY"){
   if(Object.keys(s.positions).length>=3){action="BLOCKED";reason="Maximum 3 open paper positions"}
   else{
    const fill=m.ask*(1+slipPct/100),budget=Math.min(s.cash,equity(s,prices)*.20),qty=Math.min(sig.qty||0,budget/fill),fee=fill*qty*feePct/100,cost=fill*qty+fee;
    if(qty>0&&cost<=s.cash&&sig.stop<fill&&sig.target>fill){
     s.cash-=cost;s.positions[sym]={qty,entry:fill,entryTime:new Date(cycleAt).toISOString(),entryCandleTime:b.closeTime,costBasis:cost,stop:sig.stop,target:sig.target,lastPrice:m.price};
     const openedTrade={symbol:sym,side:"PAPER_BUY",entryTime:new Date(cycleAt).toISOString(),entry:fill,qty,costBasis:cost,fee,stop:sig.stop,target:sig.target,reason:"Simulated only; no exchange order"};
     s.trades.push(openedTrade);opened.push(openedTrade);
     action="PAPER_BUY";reason="Virtual purchase; estimated fee and slippage applied";
    }else{action="BLOCKED";reason="Cash, quantity or stop/target risk guard rejected trade"}
   }
  }
  const newCount=newBars.length;s.lastCandleTimeBySymbol[sym]=Math.max(lastSeen,...one.map(x=>x.closeTime));
  rows.push({symbol:sym,price:m.price,change24hPct:m.change,spreadPct:sig.spreadPct,timeframe:"1h",confirmations:["4h","1d"],lastClosedCandleAt:new Date(b.closeTime).toISOString(),newClosedCandles:newCount,signal:sig.direction,trendBias:sig.trendBias,higherBias:sig.higherBias,blockedBy:sig.blockingReasons,supportDistanceAtr:Number.isFinite(sig.supportDistanceAtr)?Number(sig.supportDistanceAtr.toFixed(3)):null,resistanceDistanceAtr:Number.isFinite(sig.resistanceDistanceAtr)?Number(sig.resistanceDistanceAtr.toFixed(3)):null,passed:sig.passed,total:sig.total,indicators:{rsi:b.rsi,adx:b.adx,atr:b.atr,atrPct:b.atrPct,ema9:b.ema9,ema21:b.ema21,ema50:b.ema50,ema200:b.ema200,macdHist:b.macdHist,volumeRatio:b.volumeRatio},action,reason,position:s.positions[sym]||null});
  s.stats.signals[sig.direction]=(s.stats.signals[sig.direction]||0)+1;
 }catch(e){errors.push({symbol:sym,error:String(e.message||e),at:new Date().toISOString()});s.stats.errors++}}
 if(!rows.length)throw Error("No symbol data was collected; state was not advanced");
 const realized=s.trades.filter(t=>Number.isFinite(t.pnl)).reduce((a,t)=>a+t.pnl,0),eq=equity(s,prices);
 const tradeActivity=buildTradeActivity(opened,closed);
 const report={schema:1,mode:"paper",cycleStartedAt:new Date(cycleAt).toISOString(),cycleHours:2,source:"Binance public Spot API",symbols:rows,errors,newTrades:tradeActivity.newTrades,closedTrades:tradeActivity.closedTrades,portfolio:{initialCash:s.initialCash,cash:s.cash,equity:eq,realizedPnl:realized,openPositions:Object.keys(s.positions).length,positions:s.positions},notes:["Simulated paper trades only; no real exchange orders.","One decision per two-hour scheduled run, using 1h candles and 4h/1d confirmations.","Stops and targets are checked against every newly closed hourly candle since the previous successful cycle. A gap below the stop exits at the candle open plus estimated slippage instead of the idealized stop price; when both barriers are touched intrabar, stop-first is assumed. Intracandle fills and historical spreads remain approximate.","No automatic parameter tuning; strategy changes require out-of-sample validation."]};
 s.cycles.push({at:report.cycleStartedAt,errors:errors.length,signals:rows.reduce((o,r)=>(o[r.signal]=(o[r.signal]||0)+1,o),{}),equity:eq,realizedPnl:realized,closedTrades:closed.length});s.cycles=s.cycles.slice(-500);s.trades=s.trades.slice(-2000);s.stats.cycles++;s.lastCycleAt=report.cycleStartedAt;
 const stamp=new Date(cycleAt).toISOString().replace(/[:.]/g,"-"),json=JSON.stringify(report,null,2)+"\n";
 fs.writeFileSync(path.join(reports,stamp+".json"),json);fs.writeFileSync(path.join(data,"latest-report.json"),json);fs.writeFileSync(statePath,JSON.stringify(s,null,2)+"\n");
 const md=["# Paper-trading cycle — "+report.cycleStartedAt,"","**Mode:** paper only. No exchange orders are submitted.","","## Portfolio","", "- Virtual cash: "+s.cash.toFixed(2)+" USDT","- Estimated equity: "+eq.toFixed(2)+" USDT","- Realized P/L: "+realized.toFixed(2)+" USDT","- Open positions: "+Object.keys(s.positions).length,"- Collection errors: "+errors.length,"","## Signals","","| Pair | Price | 24h % | Signal | Action | RSI | ADX | Spread % |","|---|---:|---:|---|---|---:|---:|---:|"].concat(rows.map(r=>"| "+r.symbol+" | "+r.price+" | "+r.change24hPct+" | "+r.signal+" | "+r.action+" | "+Number(r.indicators.rsi).toFixed(1)+" | "+Number(r.indicators.adx).toFixed(1)+" | "+Number(r.spreadPct).toFixed(3)+" |"),["","## Errors",""],errors.length?errors.map(e=>"- "+e.symbol+": "+e.error):["- None"],["","## Review",""],closed.length?closed.map(t=>"- "+t.symbol+": "+t.reason+", P/L "+t.pnl.toFixed(2)+" USDT"):["- No position closed this cycle."],["","Review false signals, fees, drawdown, missed candles and source errors. Historical outcomes do not guarantee future results."]).join("\n")+"\n";
 fs.writeFileSync(path.join(reports,stamp+".md"),md);
 console.log(JSON.stringify({report:stamp,symbols:rows.length,errors:errors.length,closedTrades:closed.length,equity:eq},null,2));
}
if(require.main===module)run().catch(e=>{console.error(e);process.exitCode=1});
module.exports={buildTradeActivity};
