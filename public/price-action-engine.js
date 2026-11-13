/* Rahasampo Radar Price Action Pattern Engine.
   Descriptive, deterministic candle patterns only. No order execution and no probability claims. */
(function (root) {
  "use strict";

  var EPS = 1e-10;
  var MIN_BODY_RANGE = 0.04;
  var PATTERN_LABELS = {
    DOJI: "Doji",
    HAMMER: "Hammer",
    SHOOTING_STAR: "Shooting Star",
    INVERTED_HAMMER: "Inverted Hammer",
    HANGING_MAN: "Hanging Man",
    BULLISH_ENGULFING: "Bullish Engulfing",
    BEARISH_ENGULFING: "Bearish Engulfing",
    INSIDE_BAR: "Inside Bar",
    BULLISH_PIN_BAR: "Bullish Pin Bar",
    BEARISH_PIN_BAR: "Bearish Pin Bar"
  };

  function validBar(bar) {
    if (!bar || bar.closed === false || bar.isClosed === false) return false;
    var values = [bar.open, bar.high, bar.low, bar.close];
    if (!values.every(function (v) { return typeof v === "number" && Number.isFinite(v); })) return false;
    return bar.open > 0 && bar.high > 0 && bar.low > 0 && bar.close > 0 &&
      bar.high >= Math.max(bar.open, bar.close, bar.low) &&
      bar.low <= Math.min(bar.open, bar.close, bar.high);
  }

  function geometry(bar) {
    var range = bar.high - bar.low;
    var body = Math.abs(bar.close - bar.open);
    var upper = bar.high - Math.max(bar.open, bar.close);
    var lower = Math.min(bar.open, bar.close) - bar.low;
    return {
      range: range,
      body: body,
      bodyRatio: range > EPS ? body / range : 0,
      upperWick: upper,
      lowerWick: lower,
      upperRatio: range > EPS ? upper / range : 0,
      lowerRatio: range > EPS ? lower / range : 0,
      bullish: bar.close > bar.open,
      bearish: bar.close < bar.open
    };
  }

  function priorTrend(bars, index) {
    var start = Math.max(0, index - 4);
    if (index - start < 3) return "unknown";
    var first = bars[start].close;
    var last = bars[index - 1].close;
    var delta = (last - first) / first;
    if (delta > 0.002) return "up";
    if (delta < -0.002) return "down";
    return "range";
  }

  function makePattern(id, direction, bar, index, reason, invalidation) {
    return {
      id: id,
      name: PATTERN_LABELS[id],
      direction: direction,
      state: "DETECTED",
      index: index,
      time: Number.isFinite(bar.closeTime) ? bar.closeTime : Number.isFinite(bar.time) ? bar.time : null,
      evidence: reason,
      invalidation: invalidation,
      confirmation: null
    };
  }

  function detectAt(bars, index) {
    if (!Array.isArray(bars) || !Number.isInteger(index) || index < 1 || index >= bars.length) return [];
    var current = bars[index], previous = bars[index - 1];
    if (!validBar(current) || !validBar(previous)) return [];
    var g = geometry(current), p = geometry(previous), trend = priorTrend(bars, index);
    var out = [];
    if (!(g.range > EPS) || g.bodyRatio < MIN_BODY_RANGE) {
      if (g.range > EPS && g.bodyRatio <= 0.10) {
        out.push(makePattern("DOJI", "neutral", current, index,
          "Runko on enintään 10 % kynttilän koko vaihteluvälistä.", current.high + " / " + current.low));
      }
    }
    var smallBody = g.bodyRatio <= 0.38;
    var longLower = g.lowerWick >= Math.max(g.body * 2, g.range * 0.55);
    var shortUpper = g.upperWick <= Math.max(g.body * 0.5, g.range * 0.10);
    var longUpper = g.upperWick >= Math.max(g.body * 2, g.range * 0.55);
    var shortLower = g.lowerWick <= Math.max(g.body * 0.5, g.range * 0.10);
    if (smallBody && longLower && shortUpper && trend === "down") {
      out.push(makePattern("HAMMER", "bullish", current, index,
        "Pitkä alavarjo, pieni runko ja aiempi laskuliike.", current.low));
    }
    if (smallBody && longUpper && shortLower && trend === "up") {
      out.push(makePattern("SHOOTING_STAR", "bearish", current, index,
        "Pitkä ylävarjo, pieni runko ja aiempi nousuliike.", current.high));
    }
    if (smallBody && longUpper && shortLower && trend === "down") {
      out.push(makePattern("INVERTED_HAMMER", "bullish", current, index,
        "Pitkä ylävarjo, pieni runko ja aiempi laskuliike.", current.low));
    }
    if (smallBody && longLower && shortUpper && trend === "up") {
      out.push(makePattern("HANGING_MAN", "bearish", current, index,
        "Pitkä alavarjo, pieni runko ja aiempi nousuliike.", current.low));
    }
    if (g.bodyRatio >= 0.45 && p.bodyRatio >= 0.25 &&
        p.bearish && g.bullish && current.open <= previous.close && current.close >= previous.open) {
      out.push(makePattern("BULLISH_ENGULFING", "bullish", current, index,
        "Nouseva runko peittää edellisen laskevan kynttilän rungon.", current.low));
    }
    if (g.bodyRatio >= 0.45 && p.bodyRatio >= 0.25 &&
        p.bullish && g.bearish && current.open >= previous.close && current.close <= previous.open) {
      out.push(makePattern("BEARISH_ENGULFING", "bearish", current, index,
        "Laskeva runko peittää edellisen nousevan kynttilän rungon.", current.high));
    }
    if (current.high < previous.high && current.low > previous.low) {
      out.push(makePattern("INSIDE_BAR", "neutral", current, index,
        "Kynttilän koko vaihteluväli jää edellisen kynttilän sisään.", previous.high + " / " + previous.low));
    }
    if (g.lowerRatio >= 0.60 && g.upperRatio <= 0.12 && g.bodyRatio <= 0.30) {
      out.push(makePattern("BULLISH_PIN_BAR", "bullish", current, index,
        "Alavarjo muodostaa vähintään 60 % vaihteluvälistä; vaatii tason ja trendin kontekstin.", current.low));
    }
    if (g.upperRatio >= 0.60 && g.lowerRatio <= 0.12 && g.bodyRatio <= 0.30) {
      out.push(makePattern("BEARISH_PIN_BAR", "bearish", current, index,
        "Ylävarjo muodostaa vähintään 60 % vaihteluvälistä; vaatii tason ja trendin kontekstin.", current.high));
    }
    return out;
  }

  function confirmPattern(pattern, nextBar) {
    if (!pattern || !validBar(nextBar)) return Object.assign({}, pattern, { state: "PENDING", confirmation: "Seuraavan sulkeutuneen kynttilän tiedot puuttuvat." });
    var confirmed = pattern.direction === "bullish" ? nextBar.close > nextBar.high - (nextBar.high - nextBar.low) * 0.25 :
      pattern.direction === "bearish" ? nextBar.close < nextBar.low + (nextBar.high - nextBar.low) * 0.25 : false;
    var broken = pattern.direction === "bullish" ? nextBar.close < Number(pattern.invalidation) :
      pattern.direction === "bearish" ? nextBar.close > Number(pattern.invalidation) : false;
    if (broken) return Object.assign({}, pattern, { state: "INVALIDATED", confirmation: "Seuraava sulkeutunut kynttilä rikkoi kuvion mitätöintitason." });
    if (confirmed) return Object.assign({}, pattern, { state: "CONFIRMED", confirmation: "Seuraava sulkeutunut kynttilä vahvisti suunnan." });
    return Object.assign({}, pattern, { state: "PENDING", confirmation: "Suuntavahvistusta ei vielä saatu." });
  }

  function analyze(bars, index) {
    var patterns = detectAt(bars, index);
    if (!patterns.length) return [];
    var next = index + 1 < bars.length ? bars[index + 1] : null;
    return patterns.map(function (pattern) {
      return next ? confirmPattern(pattern, next) : Object.assign({}, pattern, {
        state: "PENDING",
        confirmation: "Kuvio havaittiin sulkeutuneessa kynttilässä. Odotetaan seuraavan kynttilän sulkeutumista."
      });
    });
  }

  function analyzeRecent(bars, lookback) {
    if (!Array.isArray(bars) || !bars.length) return [];
    var count = Math.max(1, Math.min(20, Number.isInteger(lookback) ? lookback : 3));
    var found = [];
    var start = Math.max(1, bars.length - count);
    for (var i = bars.length - 1; i >= start; i--) {
      analyze(bars, i).forEach(function (pattern) { found.push(pattern); });
    }
    return found;
  }

  root.PriceActionEngine = {
    detectAt: detectAt,
    analyze: analyze,
    analyzeRecent: analyzeRecent,
    geometry: geometry,
    priorTrend: priorTrend,
    labels: Object.freeze(Object.assign({}, PATTERN_LABELS))
  };
  if (typeof module !== "undefined" && module.exports) module.exports = root.PriceActionEngine;
})(typeof window !== "undefined" ? window : globalThis);
