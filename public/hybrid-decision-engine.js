/* Rahasampo Radar Hybrid Decision Engine.
   Deterministic evidence aggregation for research and paper-review only.
   This module never places orders and never overrides the canonical Spot signal. */
(function(root){
 "use strict";
 var DIRECTIONS={BULLISH:1,BEARISH:-1,NEUTRAL:0};
 function validEvidence(item){
  return item&&Object.prototype.hasOwnProperty.call(DIRECTIONS,item.direction)&&
   Number.isFinite(item.strength)&&item.strength>=0&&item.strength<=1&&
   Number.isFinite(item.reliability)&&item.reliability>=0&&item.reliability<=1&&
   Number.isFinite(item.weight)&&item.weight>0;
 }
 function collectGates(risk){
  risk=risk||{};
  var gates=[];
  if(risk.dataFresh===false)gates.push("STALE_DATA");
  if(risk.riskAllowed===false)gates.push("RISK_GATE_BLOCKED");
  if(Number.isFinite(risk.spreadPct)&&Number.isFinite(risk.maxSpreadPct)&&risk.spreadPct>risk.maxSpreadPct)gates.push("SPREAD_TOO_WIDE");
  if(risk.timeframeAligned===false)gates.push("TIMEFRAME_CONFLICT");
  return gates;
 }
 function analyze(input){
  input=input||{};
  var evidence=Array.isArray(input.evidence)?input.evidence:[];
  var gates=collectGates(input.risk);
  if(evidence.some(function(e){return !validEvidence(e);}))
   return {state:"INVALID_EVIDENCE",researchBias:"WAIT",rawBias:"INSUFFICIENT",score:null,strength:"NONE",evidenceCount:0,conflicts:0,gates:["INVALID_EVIDENCE"].concat(gates)};
  var usable=evidence.filter(function(e){return e.direction!=="NEUTRAL"&&e.strength>0&&e.reliability>0;});
  if(!usable.length)
   return {state:gates.length?"BLOCKED":"INSUFFICIENT_EVIDENCE",researchBias:"WAIT",rawBias:"INSUFFICIENT",score:0,strength:"NONE",evidenceCount:0,conflicts:0,gates:gates.length?gates:["NO_DIRECTIONAL_EVIDENCE"]};
  var numerator=0,denominator=0,bull=0,bear=0;
  usable.forEach(function(e){
   var contribution=DIRECTIONS[e.direction]*e.strength*e.reliability*e.weight;
   numerator+=contribution;denominator+=e.strength*e.reliability*e.weight;
   if(e.direction==="BULLISH")bull++;if(e.direction==="BEARISH")bear++;
  });
  var score=denominator?numerator/denominator:0;
  var bias=score>=0.25?"BULLISH":score<=-0.25?"BEARISH":"NEUTRAL";
  var magnitude=Math.abs(score);
  var strength=magnitude>=0.65?"STRONG":magnitude>=0.4?"MODERATE":"WEAK";
  var base=input.baseDirection;
  var baseDirection=base==="BUY"?"BULLISH":base==="SELL"?"BEARISH":"WAIT";
  var disagreement=baseDirection!=="WAIT"&&bias!=="NEUTRAL"&&baseDirection!==bias;
  return {state:gates.length?"BLOCKED":"OK",researchBias:gates.length?"WAIT":bias,
   rawBias:bias,score:Number(score.toFixed(4)),strength:strength,
   evidenceCount:usable.length,conflicts:Math.min(bull,bear),bullishSources:bull,bearishSources:bear,
   baseDirection:baseDirection,baseDisagreement:disagreement,gates:gates,
   sources:usable.map(function(e){return {source:e.source||"UNNAMED",direction:e.direction,contribution:Number((DIRECTIONS[e.direction]*e.strength*e.reliability*e.weight).toFixed(4))};}),
   interpretation:"Painotettu evidenssin yhteensopivuus, ei onnistumistodennäköisyys eikä itsenäinen kaupankäyntisignaali."};
 }
 root.HybridDecisionEngine={analyze:analyze,validEvidence:validEvidence};
 if(typeof module!=="undefined"&&module.exports)module.exports=root.HybridDecisionEngine;
})(typeof window!=="undefined"?window:globalThis);
