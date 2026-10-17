/* Rahasampo live market layer: public Binance Spot market data only. */
(function () {
  "use strict";

  var state = { ws: null, wsTimer: null, symbol: "BTCUSDT", interval: "1m", bars: [], live: null, bid: null, ask: null, lastTradeAt: 0, tradePrice: null, tradeQty: 0, trades: 0, reconnects: 0 };
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>\"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); };
  var num = function (v, d) { return Number.isFinite(Number(v)) ? Number(v).toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }) : "—"; };
  var price = function (v) { var n = Number(v); return !Number.isFinite(n) ? "—" : n < 1 ? num(n, 6) : num(n, 2); };

  function injectUi() {
    var chart = $("chart");
    if (!chart || $("liveScalpPanel")) return;
    var p = document.createElement("div");
    p.id = "liveScalpPanel";
    p.className = "panel";
    p.style.margin = "12px 0";
    p.innerHTML = '<div class="section-title"><div><strong>⚡ Pikatreidaus live-paneeli</strong><div class="sub">1m · 3m · 5m · 15m · reaaliaikainen kauppavirta + kynttilä</div></div><span id="liveState" class="pill">YHDISTETÄÄN</span></div>' +
      '<div id="liveScalpCards" class="metrics"></div>' +
      '<div class="sub" id="liveMeta">WebSocket yhdistetään Binance Spot -markkinadataan…</div>';
    chart.parentNode.insertBefore(p, chart);
  }

  function cardHtml(tf, s) {
    var side = s && s.side || "WAIT";
    var cls = side === "BUY" ? "good" : side === "SELL" ? "bad" : "neutral";
    var label = side === "BUY" ? "OSTA" : side === "SELL" ? "MYY" : "ODOTA";
    return '<div class="metric"><small>' + tf + ' · live-signaali</small><strong class="' + cls + '">' + label + ' ' + num(s && s.score, 0) + '%</strong><div class="sub" style="font-size:12px;margin-top:5px">EMA ' + (s && s.ema || "—") + ' · RSI ' + num(s && s.rsi, 1) + ' · momentum ' + (s && s.momentum >= 0 ? "+" : "") + num(s && s.momentum, 3) + '%</div></div>';
  }

  function scoreFor(bars, livePrice) {
    if (!Array.isArray(bars) || bars.length < 60) return null;
    var e = TradingEngine.enrich(bars), b = e[e.length - 1], p = e[e.length - 2];
    if (!b || !p) return null;
    var score = 50;
    if (b.close > b.ema9) score += 8; else score -= 8;
    if (b.ema9 > b.ema21) score += 12; else score -= 12;
    if (b.close > b.ema50) score += 8; else score -= 8;
    if (b.macdHist > 0) score += 10; else score -= 10;
    if (b.adx >= 18) score += b.pdi > b.mdi ? 8 : -8;
    if (Number.isFinite(b.rsi)) {
      if (b.rsi >= 50 && b.rsi <= 68) score += 7;
      else if (b.rsi <= 32 && b.rsi >= 20) score += 4;
      else if (b.rsi > 72) score -= 8;
      else if (b.rsi < 28) score += 5;
    }
    if (Number.isFinite(b.volumeRatio)) score += Math.max(-5, Math.min(5, (b.volumeRatio - 1) * 5));
    var live = Number(livePrice);
    var mom = Number.isFinite(live) && p.close > 0 ? (live / p.close - 1) * 100 : 0;
    score += Math.max(-7, Math.min(7, mom * 40));
    score = Math.max(1, Math.min(99, score));
    return { score: score, side: score >= 65 ? "BUY" : score <= 35 ? "SELL" : "WAIT", rsi: b.rsi, ema: b.ema9 > b.ema21 ? "9>21" : "9<21", momentum: mom };
  }

  async function getBars(tf) {
    var r = await fetch("/api/market?endpoint=klines&symbol=" + encodeURIComponent(state.symbol) + "&interval=" + tf + "&limit=250", { cache: "no-store" });
    if (!r.ok) throw new Error("Kynttilädatan haku HTTP " + r.status);
    return TradingEngine.enrich(TradingEngine.parseKlines(await r.json(), Date.now()));
  }

  function mergeLive(base, live) {
    var arr = (base || []).slice();
    if (!live) return arr;
    var i = arr.length - 1;
    if (i >= 0 && arr[i].time === live.time) arr[i] = live;
    else if (i >= 0 && live.time > arr[i].time) arr.push(live);
    return arr;
  }

  function renderLiveChart() {
    var target = $("chart");
    if (!target || state.bars.length < 2) return;
    var countEl = $("chartCount"), count = Math.max(80, Math.min(250, Number(countEl && countEl.value) || 150));
    var d = mergeLive(state.bars, state.live).slice(-count), vals = [];
    d.forEach(function (x) { vals.push(+x.low, +x.high); [x.ema9,x.ema21,x.ema50,x.ema200].forEach(function(v){if(Number.isFinite(v))vals.push(v);}); });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), pad = (hi-lo)*0.07 || Math.abs(hi)*0.002 || 1; lo -= pad; hi += pad;
    var w=1100,h=430,l=18,r=86,t=34,btm=38,pw=w-l-r,ph=h-t-btm,step=pw/d.length,cw=Math.max(2,Math.min(11,step*.66));
    function x(k){return l+step*(k+.5);} function y(v){return t+(hi-v)/(hi-lo)*ph;}
    var out=['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 '+w+' '+h+'" style="width:100%;height:auto;display:block;background:#101d30;border-radius:10px" role="img" aria-label="'+esc(state.symbol)+' reaaliaikainen kynttiläkaavio">','<rect width="100%" height="100%" fill="#101d30"/>'];
    for(var g=0;g<=6;g++){var gy=t+ph*g/6,pv=hi-(hi-lo)*g/6;out.push('<line x1="'+l+'" y1="'+gy.toFixed(1)+'" x2="'+(w-r)+'" y2="'+gy.toFixed(1)+'" stroke="#263750"/>');out.push('<text x="'+(w-r+7)+'" y="'+(gy+4).toFixed(1)+'" fill="#a8bdd7" font-size="11">'+esc(price(pv))+'</text>');}
    out.push('<text x="'+l+'" y="18" fill="#dce9fa" font-size="13" font-weight="700">'+esc(state.symbol)+' · LIVE · '+d.length+' kynttilää</text>');
    d.forEach(function(v,k){var op=+v.open,cl=+v.close,hh=+v.high,ll=+v.low,cx=x(k),c=cl>=op?'#28d7a0':'#ff647c';out.push('<line x1="'+cx.toFixed(1)+'" y1="'+y(hh).toFixed(1)+'" x2="'+cx.toFixed(1)+'" y2="'+y(ll).toFixed(1)+'" stroke="'+c+'" stroke-width="1.4"/>');var yy=Math.min(y(op),y(cl)),bh=Math.max(1,Math.abs(y(op)-y(cl)));out.push('<rect x="'+(cx-cw/2).toFixed(1)+'" y="'+yy.toFixed(1)+'" width="'+cw.toFixed(1)+'" height="'+bh.toFixed(1)+'" fill="'+c+'" rx=".7"/>');});
    [["ema9","#ffd166"],["ema21","#67b7ff"],["ema50","#c084fc"],["ema200","#fb7185"]].forEach(function(o){var pts=[];d.forEach(function(v,k){var q=Number(v[o[0]]);if(Number.isFinite(q))pts.push(x(k).toFixed(1)+','+y(q).toFixed(1));});if(pts.length>1)out.push('<polyline points="'+pts.join(' ')+'" fill="none" stroke="'+o[1]+'" stroke-width="'+(o[0]==='ema200'?2:1.4)+'"/>');});
    var sig=scoreFor(state.bars,state.tradePrice||state.live&&state.live.close);if(sig&&sig.side!=="WAIT"){var c=sig.side==='BUY'?'#28d7a0':'#ff647c',txt=sig.side==='BUY'?'OSTA':'MYY',yy=y(state.tradePrice||state.live.close);out.push('<line x1="'+l+'" y1="'+yy.toFixed(1)+'" x2="'+(w-r)+'" y2="'+yy.toFixed(1)+'" stroke="'+c+'" stroke-width="2" stroke-dasharray="7 4"/>');out.push('<rect x="'+(w-r-72)+'" y="'+Math.max(t,yy-18).toFixed(1)+'" width="68" height="22" rx="8" fill="'+c+'"/><text x="'+(w-r-38)+'" y="'+Math.max(t+15,yy-3).toFixed(1)+'" text-anchor="middle" fill="#07111f" font-size="11" font-weight="900">'+txt+' '+Math.round(sig.score)+'%</text>');}
    [0,Math.floor((d.length-1)/2),d.length-1].forEach(function(k){var dt=new Date(d[k].time),lab=dt.toLocaleString('fi-FI',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});out.push('<text x="'+x(k).toFixed(1)+'" y="'+(h-12)+'" text-anchor="middle" fill="#a8bdd7" font-size="11">'+esc(lab)+'</text>');});
    out.push('</svg>');target.innerHTML=out.join('');
  }

  function updateUi(scores) {
    injectUi();
    $("liveScalpCards").innerHTML=["1m","3m","5m","15m"].map(function(tf){return cardHtml(tf,scores[tf]);}).join("");
    var age=state.lastTradeAt?Math.max(0,(Date.now()-state.lastTradeAt)/1000):Infinity;
    $("liveState").textContent=age<3?"● LIVE":"YHTEYS HILJAINEN";$("liveState").className="pill "+(age<3?"good":"bad");
    $("liveMeta").textContent="Hinta "+price(state.tradePrice||state.live&&state.live.close)+" USDT · bid "+price(state.bid)+" · ask "+price(state.ask)+" · spread "+(state.bid&&state.ask?num((state.ask-state.bid)/state.bid*100,4)+"%":"—")+" · kauppatapahtumia "+state.trades+" · WS-uudelleenyhdistämisiä "+state.reconnects;
  }

  async function refreshScalpScores() {
    var scores={};
    for(var i=0;i<4;i++){var tf=["1m","3m","5m","15m"][i];try{var bars=await getBars(tf);scores[tf]=scoreFor(bars,state.tradePrice);if(tf===state.interval)state.bars=bars;}catch(e){scores[tf]=null;}}
    updateUi(scores);renderLiveChart();
  }

  function stopWs(){if(state.wsTimer)clearTimeout(state.wsTimer);state.wsTimer=null;if(state.ws){try{state.ws.close();}catch(e){}state.ws=null;}}
  function scheduleWs(){state.reconnects++;state.wsTimer=setTimeout(startWs,1500);}
  function startWs(){
    stopWs();var s=state.symbol.toLowerCase(),iv=state.interval,url="wss://stream.binance.com:9443/stream?streams="+s+"@trade/"+s+"@bookTicker/"+s+"@kline_"+iv;
    try{state.ws=new WebSocket(url);}catch(e){scheduleWs();return;}
    state.ws.onopen=function(){ $("liveState").textContent="● LIVE";$("liveState").className="pill good"; };
    state.ws.onmessage=function(ev){try{var wrap=JSON.parse(ev.data),d=wrap.data||wrap;if(d.e==="trade"){state.tradePrice=Number(d.p);state.lastTradeAt=Date.now();state.trades++;}if(d.e==="bookTicker"){state.bid=Number(d.b);state.ask=Number(d.a);}if(d.e==="kline"){var k=d.k;state.live={time:Number(k.t),closeTime:Number(k.T),open:Number(k.o),high:Number(k.h),low:Number(k.l),close:Number(k.c),volume:Number(k.v)};}updateUi({"1m":scoreFor(state.bars,state.tradePrice)});renderLiveChart();}catch(e){}};
    state.ws.onerror=function(){try{state.ws.close();}catch(e){}};state.ws.onclose=function(){scheduleWs();};
  }

  async function boot(){
    injectUi();var symbolEl=$("symbol"),intervalEl=$("interval");
    if(symbolEl)symbolEl.addEventListener("change",function(){state.symbol=symbolEl.value;refreshScalpScores();startWs();});
    if(intervalEl)intervalEl.addEventListener("change",function(){state.interval=intervalEl.value;refreshScalpScores();startWs();});
    state.symbol=symbolEl?symbolEl.value:"BTCUSDT";state.interval=intervalEl?intervalEl.value:"1m";
    try{state.bars=await getBars(state.interval);}catch(e){}
    await refreshScalpScores();startWs();setInterval(refreshScalpScores,10000);setInterval(function(){if(state.tradePrice&&Date.now()-state.lastTradeAt>5000){$("liveState").textContent="YHTEYS HILJAINEN";$("liveState").className="pill bad";}renderLiveChart();},1000);
  }
  if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",boot);else boot();
})();
