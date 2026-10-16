"use strict";
(function(){
  const SYMBOLS=["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT","XRPUSDT","DOGEUSDT"];
  const BASES=["wss://data-stream.binance.vision:443","wss://stream.binance.com:443","wss://stream.binance.com:9443"];
  const MAX_AGE_MS=3000;
  let socket=null,reconnectTimer=null,stopped=false,baseIndex=0;
  const state=new Map(SYMBOLS.map(s=>[s,{price:null,bid:null,ask:null,exchangeTime:null,receivedAt:null,connected:false,source:null}]));
  function emit(){window.dispatchEvent(new CustomEvent("market-live-update",{detail:Object.fromEntries(state)}));}
  function streamUrl(base){return base+"/stream?streams="+SYMBOLS.flatMap(s=>{const x=s.toLowerCase();return [x+"@trade",x+"@bookTicker"]}).join("/");}
  function stale(q,now=Date.now()){return !q||!Number.isFinite(q.receivedAt)||now<q.receivedAt||now-q.receivedAt>MAX_AGE_MS;}
  function connect(){
    if(stopped)return;
    const base=BASES[baseIndex%BASES.length];
    try{socket=new WebSocket(streamUrl(base));}catch(e){schedule();return;}
    socket.onopen=()=>{baseIndex=0;for(const q of state.values())q.connected=true;window.dispatchEvent(new Event("market-live-open"));emit();};
    socket.onmessage=e=>{let m;try{m=JSON.parse(e.data);}catch{return;}const d=m.data||m;if(!d||!d.s)return;const q=state.get(String(d.s).toUpperCase());if(!q)return;const now=Date.now();if(d.e==="trade"||d.p!=null){const p=Number(d.p);if(p>0){q.price=p;q.exchangeTime=Number(d.T)||now;q.receivedAt=now;q.source="Binance WebSocket trade";}}if(d.b!=null&&d.a!=null){const bid=Number(d.b),ask=Number(d.a);if(bid>0&&ask>=bid){q.bid=bid;q.ask=ask;q.receivedAt=now;q.source="Binance WebSocket bookTicker";}}emit();};
    socket.onerror=()=>window.dispatchEvent(new Event("market-live-error"));
    socket.onclose=()=>{for(const q of state.values())q.connected=false;window.dispatchEvent(new Event("market-live-close"));schedule();};
  }
  function schedule(){if(stopped||reconnectTimer)return;reconnectTimer=setTimeout(()=>{reconnectTimer=null;baseIndex=(baseIndex+1)%BASES.length;connect();},1000);}
  window.RahasampoLiveMarket={get(symbol){const q=state.get(String(symbol).toUpperCase());if(!q)return null;return {...q,fresh:!stale(q),ageMs:Number.isFinite(q.receivedAt)?Math.max(0,Date.now()-q.receivedAt):Infinity,spreadPct:q.bid>0&&q.ask>=q.bid?(q.ask-q.bid)/((q.ask+q.bid)/2)*100:NaN};},isFresh(symbol){const q=state.get(String(symbol).toUpperCase());return !!q&&!stale(q);},stop(){stopped=true;if(reconnectTimer)clearTimeout(reconnectTimer);if(socket)socket.close();}};
  connect();setInterval(emit,250);
})();
