"use strict";
const fs=require("node:fs");
const file="public/index.html";
let s=fs.readFileSync(file,"utf8");
if(!s.includes('id="entryScore"')){
  s=s.replace('<span id="passed" class="pill">Ehdot —</span>','<span id="passed" class="pill">Ehdot —</span><span id="entryScore" class="pill">Entry-score —</span>');
}
s=s.replace('$("passed").textContent="Ehdot "+sig.passed+"/"+sig.total;', '$("passed").textContent="Ehdot "+sig.passed+"/"+sig.total;$("entryScore").textContent="Entry-score "+(Number.isFinite(Number(sig.entryScore))?sig.entryScore+"/11 · min "+sig.minEntryScore:"—");');
s=s.replace('candleLastEventAt=0,candleReconnects=0,candleLastBar=null,candleEventLatency=null,candleSocketOpenedAt=0;', 'candleLastEventAt=0,candleReconnects=0,candleLastBar=null,candleEventLatency=null,candleClockSkew=null,candleSocketOpenedAt=0;');
s=s.replace('candleEventLatency=Number.isFinite(Number(msg.E))?now-Number(msg.E):null;', 'candleClockSkew=Number.isFinite(Number(msg.E))?now-Number(msg.E):null;candleEventLatency=Number.isFinite(candleClockSkew)?Math.max(0,candleClockSkew):null;');
s=s.replace('+(Number.isFinite(lat)?" · tapahtuma-aikaleiman ja selaimen vastaanoton ero noin "+lat+" ms":"")+" · "+new Date(candleLastEventAt).toISOString();', '+(Number.isFinite(lat)?" · havaittu vähimmäisikä "+lat+" ms":"")+(Number.isFinite(candleClockSkew)&&candleClockSkew<0?" · selaimen/kellon poikkeama "+candleClockSkew+" ms":"")+" · "+new Date(candleLastEventAt).toISOString();');
fs.writeFileSync(file,s);
console.log("Live UI repaired: entry-score visibility and negative WebSocket event-time display fixed.");
