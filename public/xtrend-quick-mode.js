/* XTrend Lite Quick Mode research engine.
 * Caller supplies verified XTrend quotes and closed candles. No order execution.
 */
(function (root) {
  "use strict";

  var DEFAULTS = Object.freeze({
    maxQuoteAgeMs: 5000,
    maxOneMinuteBarAgeMs: 120000,
    maxFiveMinuteBarAgeMs: 600000,
    minBars: 35,
    buyRsiMin: 50,
    buyRsiMax: 70,
    sellRsiMin: 30,
    sellRsiMax: 50,
    bollingerPeriod: 20,
    bollingerDeviation: 2
  });
  var INTERVAL_MS = Object.freeze({ "1S": 1000, "5S": 5000, "1M": 60000, "5M": 300000 });

  function finite(value) {
    return value !== null && value !== "" && Number.isFinite(Number(value));
  }

  function emaSeries(values, period) {
    if (!Array.isArray(values) || values.length < period || !Number.isInteger(period) || period < 2) return [];
    var out = new Array(values.length).fill(null);
    var seed = values.slice(0, period).reduce(function (sum, value) { return sum + value; }, 0) / period;
    out[period - 1] = seed;
    var alpha = 2 / (period + 1);
    for (var i = period; i < values.length; i += 1) out[i] = values[i] * alpha + out[i - 1] * (1 - alpha);
    return out;
  }

  function ema(values, period) {
    var series = emaSeries(values, period);
    return series.length ? series[series.length - 1] : null;
  }

  function rsi(values, period) {
    if (!Array.isArray(values) || values.length <= period) return null;
    var gain = 0, loss = 0;
    for (var i = 1; i <= period; i += 1) {
      var firstChange = values[i] - values[i - 1];
      if (firstChange > 0) gain += firstChange;
      else loss -= firstChange;
    }
    var averageGain = gain / period, averageLoss = loss / period;
    for (var j = period + 1; j < values.length; j += 1) {
      var change = values[j] - values[j - 1];
      averageGain = (averageGain * (period - 1) + Math.max(change, 0)) / period;
      averageLoss = (averageLoss * (period - 1) + Math.max(-change, 0)) / period;
    }
    if (averageLoss === 0) return averageGain === 0 ? 50 : 100;
    if (averageGain === 0) return 0;
    return 100 - 100 / (1 + averageGain / averageLoss);
  }

  function bollinger(values, period, deviations) {
    period = period || DEFAULTS.bollingerPeriod;
    deviations = deviations || DEFAULTS.bollingerDeviation;
    if (!Array.isArray(values) || values.length < period) return null;
    var sample = values.slice(-period);
    var mean = sample.reduce(function (sum, value) { return sum + value; }, 0) / period;
    var variance = sample.reduce(function (sum, value) { return sum + Math.pow(value - mean, 2); }, 0) / period;
    var standardDeviation = Math.sqrt(variance);
    return {
      middle: mean,
      upper: mean + deviations * standardDeviation,
      lower: mean - deviations * standardDeviation,
      standardDeviation: standardDeviation,
      period: period,
      deviations: deviations
    };
  }

  function macdHistogram(values) {
    if (!Array.isArray(values) || values.length < 35) return null;
    var fast = emaSeries(values, 12), slow = emaSeries(values, 26), line = [];
    for (var i = 0; i < values.length; i += 1) {
      if (fast[i] !== null && slow[i] !== null) line.push(fast[i] - slow[i]);
    }
    if (line.length < 9) return null;
    var signalSeries = emaSeries(line, 9);
    return signalSeries.length ? line[line.length - 1] - signalSeries[signalSeries.length - 1] : null;
  }


  function indicatorSeries(bars) {
    if (!Array.isArray(bars)) return { ema9: [], ema20: [], ema21: [], bbUpper: [], bbMiddle: [], bbLower: [] };
    var closes = bars.map(function (bar) { return Number(bar.close); });
    var times = bars.map(function (bar) { return Math.floor(Number(bar.closeTime) / 1000); });
    var e9 = emaSeries(closes, 9), e20 = emaSeries(closes, 20), e21 = emaSeries(closes, 21);
    var output = { ema9: [], ema20: [], ema21: [], bbUpper: [], bbMiddle: [], bbLower: [] };
    for (var i = 0; i < bars.length; i += 1) {
      if (e9[i] !== null) output.ema9.push({ time: times[i], value: e9[i] });
      if (e20[i] !== null) output.ema20.push({ time: times[i], value: e20[i] });
      if (e21[i] !== null) output.ema21.push({ time: times[i], value: e21[i] });
      var bands = bollinger(closes.slice(0, i + 1), 20, 2);
      if (bands) {
        output.bbUpper.push({ time: times[i], value: bands.upper });
        output.bbMiddle.push({ time: times[i], value: bands.middle });
        output.bbLower.push({ time: times[i], value: bands.lower });
      }
    }
    return output;
  }

  function validateBars(bars, timeframe, now, maxAge, minBars) {
    var interval = INTERVAL_MS[timeframe];
    if (!Array.isArray(bars) || bars.length < minBars) {
      return { ok: false, reason: timeframe + ": kynttilähistoriaa liian vähän" };
    }
    if (!interval) return { ok: false, reason: "Tuntematon kynttiläväli" };
    var previousOpen = -Infinity;
    for (var i = 0; i < bars.length; i += 1) {
      var bar = bars[i];
      if (!bar || bar.closed !== true || bar.source !== "XTREND" ||
          ![bar.openTime, bar.closeTime, bar.open, bar.high, bar.low, bar.close].every(finite)) {
        return { ok: false, reason: timeframe + ": puuttuva tai keskeneräinen kynttilä" };
      }
      var open = Number(bar.open), high = Number(bar.high), low = Number(bar.low), close = Number(bar.close);
      var openTime = Number(bar.openTime), closeTime = Number(bar.closeTime);
      if (open <= 0 || close <= 0 || low <= 0 || high < Math.max(open, close, low) ||
          low > Math.min(open, close) || openTime <= previousOpen ||
          closeTime !== openTime + interval - 1 || closeTime > now) {
        return { ok: false, reason: timeframe + ": OHLC-arvot tai kynttilän aikaleimat eivät ole kelvollisia" };
      }
      if (i > 0 && openTime - previousOpen !== interval) {
        return { ok: false, reason: timeframe + ": kynttilähistoriassa on aikakatko; puuttuvia kynttilöitä ei täytetä" };
      }
      previousOpen = openTime;
    }
    var age = now - Number(bars[bars.length - 1].closeTime);
    if (age < 0 || age > maxAge) return { ok: false, reason: timeframe + ": viimeisin sulkeutunut kynttilä vanhentunut" };
    return { ok: true, bars: bars };
  }

  function analyze(bars) {
    var closes = bars.map(function (bar) { return Number(bar.close); });
    var last = closes[closes.length - 1];
    var e9 = ema(closes, 9), e20 = ema(closes, 20), e21 = ema(closes, 21);
    var currentRsi = rsi(closes, 14), histogram = macdHistogram(closes);
    var bands = bollinger(closes, DEFAULTS.bollingerPeriod, DEFAULTS.bollingerDeviation);
    if (![e9, e20, e21, currentRsi, histogram].every(Number.isFinite) || !bands) return null;
    return {
      trend: last > e9 && e9 > e21 ? "BULL" : last < e9 && e9 < e21 ? "BEAR" : "MIXED",
      close: last, ema9: e9, ema20: e20, ema21: e21,
      rsi14: currentRsi, macdHistogram: histogram, bollinger: bands
    };
  }

  function wait(reasons, details) {
    return Object.assign({
      signal: "WAIT",
      actionable: false,
      executionEnabled: false,
      reasons: reasons,
      note: "Ei toimeksiantoa. WAIT on pakollinen, kun data tai vahvistus puuttuu."
    }, details || {});
  }

  function evaluate(input, options) {
    var now = options && finite(options.nowMs) ? Number(options.nowMs) : Date.now();
    var cfg = Object.assign({}, DEFAULTS, options || {}), reasons = [];
    if (!input || typeof input !== "object") return wait(["XTrend-markkinasyöte puuttuu"]);
    if (typeof input.symbol !== "string" || !input.symbol.trim()) reasons.push("XTrend-symboli puuttuu");

    var quote = input.quote || {};
    if (!finite(quote.bid) || !finite(quote.ask) || Number(quote.bid) <= 0 || Number(quote.ask) < Number(quote.bid)) {
      reasons.push("XTrendin kelvollinen bid/ask-hinta puuttuu");
    }
    if (!finite(quote.receivedAt) || now - Number(quote.receivedAt) < 0 || now - Number(quote.receivedAt) > cfg.maxQuoteAgeMs) {
      reasons.push("XTrendin bid/ask-hinta on vanhentunut tai aikaleima virheellinen");
    }
    if (quote.source !== "XTREND") reasons.push("Hintalähdettä ei ole vahvistettu XTrendiksi; Binance-hintaa ei hyväksytä");
    if (!finite(cfg.maxSpreadPct) || Number(cfg.maxSpreadPct) <= 0) {
      reasons.push("XTrendin sallittua spread-rajaa ei ole vahvistettu");
    } else if (finite(quote.bid) && finite(quote.ask) && Number(quote.bid) > 0) {
      var midpoint = (Number(quote.bid) + Number(quote.ask)) / 2;
      var spreadPct = (Number(quote.ask) - Number(quote.bid)) / midpoint * 100;
      if (!Number.isFinite(spreadPct) || spreadPct > Number(cfg.maxSpreadPct)) reasons.push("XTrend-spread ylittää määritellyn rajan");
    }

    var one = validateBars(input.oneMinuteBars, "1M", now, cfg.maxOneMinuteBarAgeMs, cfg.minBars);
    var five = validateBars(input.fiveMinuteBars, "5M", now, cfg.maxFiveMinuteBarAgeMs, cfg.minBars);
    if (!one.ok) reasons.push(one.reason);
    if (!five.ok) reasons.push(five.reason);
    if (reasons.length) return wait(reasons);

    var oneAnalysis = analyze(one.bars), fiveAnalysis = analyze(five.bars);
    if (!oneAnalysis || !fiveAnalysis) return wait(["Indikaattoreita ei voida laskea"]);
    var buy = fiveAnalysis.trend === "BULL" && oneAnalysis.trend === "BULL" &&
      oneAnalysis.macdHistogram > 0 && oneAnalysis.rsi14 >= cfg.buyRsiMin &&
      oneAnalysis.rsi14 <= cfg.buyRsiMax && oneAnalysis.close >= oneAnalysis.bollinger.middle;
    var sell = fiveAnalysis.trend === "BEAR" && oneAnalysis.trend === "BEAR" &&
      oneAnalysis.macdHistogram < 0 && oneAnalysis.rsi14 >= cfg.sellRsiMin &&
      oneAnalysis.rsi14 <= cfg.sellRsiMax && oneAnalysis.close <= oneAnalysis.bollinger.middle;

    if (!buy && !sell) {
      if (oneAnalysis.trend !== fiveAnalysis.trend) reasons.push("1M ja 5M trendit eivät vahvista samaa suuntaa");
      if (oneAnalysis.trend === "MIXED" || fiveAnalysis.trend === "MIXED") reasons.push("EMA-trendi ei ole selkeä");
      if ((oneAnalysis.trend === "BULL" && oneAnalysis.macdHistogram <= 0) ||
          (oneAnalysis.trend === "BEAR" && oneAnalysis.macdHistogram >= 0)) reasons.push("MACD ei vahvista 1M-suuntaa");
      if (oneAnalysis.trend === "BULL" && (oneAnalysis.rsi14 < cfg.buyRsiMin || oneAnalysis.rsi14 > cfg.buyRsiMax)) reasons.push("RSI ei täytä alustavaa BUY-aluetta");
      if (oneAnalysis.trend === "BEAR" && (oneAnalysis.rsi14 < cfg.sellRsiMin || oneAnalysis.rsi14 > cfg.sellRsiMax)) reasons.push("RSI ei täytä alustavaa SELL-aluetta");
      if (oneAnalysis.trend === "BULL" && oneAnalysis.close < oneAnalysis.bollinger.middle) reasons.push("Hinta on Bollingerin keskiviivan alapuolella");
      if (oneAnalysis.trend === "BEAR" && oneAnalysis.close > oneAnalysis.bollinger.middle) reasons.push("Hinta on Bollingerin keskiviivan yläpuolella");
      return wait(reasons.length ? reasons : ["Pakolliset vahvistukset eivät täyty"], {
        symbol: input.symbol, quote: quote, oneMinute: oneAnalysis, fiveMinute: fiveAnalysis
      });
    }
    return {
      signal: buy ? "BUY" : "SELL",
      actionable: false,
      executionEnabled: false,
      symbol: input.symbol,
      quote: { bid: Number(quote.bid), ask: Number(quote.ask), receivedAt: Number(quote.receivedAt), source: quote.source },
      oneMinute: oneAnalysis,
      fiveMinute: fiveAnalysis,
      reasons: ["1M ja 5M sulkeutuneet kynttilät vahvistavat saman suunnan", "EMA, RSI, MACD ja Bollinger-tarkistukset läpäisty"],
      note: "Tutkimussignaali; ei toimeksiantoa, voittoennustetta eikä vahvistettua XTrend-täyttöä."
    };
  }

  // Build completed 1s/5s OHLC candles from genuine timestamped XTrend trade ticks.
  // Missing buckets remain gaps; no synthetic candles or zero-volume fills are created.
  function aggregateTradeTicks(ticks, intervalSeconds, nowMs) {
    var intervalMs = intervalSeconds * 1000;
    if (![1, 5].includes(intervalSeconds)) return { ok: false, bars: [], gaps: [], reason: "Vain 1S ja 5S aggregointi on sallittu" };
    if (!Array.isArray(ticks) || ticks.length === 0) return { ok: false, bars: [], gaps: [], reason: "XTrend-kauppatapahtumia ei ole saatavilla" };
    var now = finite(nowMs) ? Number(nowMs) : Date.now(), sorted = ticks.slice().sort(function (a, b) { return Number(a.time) - Number(b.time); });
    var buckets = new Map();
    for (var i = 0; i < sorted.length; i += 1) {
      var tick = sorted[i];
      if (!tick || tick.source !== "XTREND" || !finite(tick.time) || !finite(tick.price) ||
          Number(tick.time) <= 0 || Number(tick.time) > now || Number(tick.price) <= 0) {
        return { ok: false, bars: [], gaps: [], reason: "Tick-syötteessä on väärä lähde, hinta tai aikaleima" };
      }
      var bucketOpen = Math.floor(Number(tick.time) / intervalMs) * intervalMs;
      if (bucketOpen + intervalMs > now) continue;
      var bucket = buckets.get(bucketOpen);
      if (!bucket) {
        bucket = { openTime: bucketOpen, open: Number(tick.price), high: Number(tick.price), low: Number(tick.price), close: Number(tick.price), volume: 0, hasVolume: true, source: "XTREND" };
        buckets.set(bucketOpen, bucket);
      }
      bucket.high = Math.max(bucket.high, Number(tick.price));
      bucket.low = Math.min(bucket.low, Number(tick.price));
      bucket.close = Number(tick.price);
      if (finite(tick.quantity) && Number(tick.quantity) >= 0) bucket.volume += Number(tick.quantity);
      else bucket.hasVolume = false;
    }
    var bars = Array.from(buckets.values()).sort(function (a, b) { return a.openTime - b.openTime; });
    var gaps = [];
    for (var j = 1; j < bars.length; j += 1) {
      if (bars[j].openTime - bars[j - 1].openTime > intervalMs) {
        for (var missing = bars[j - 1].openTime + intervalMs; missing < bars[j].openTime; missing += intervalMs) gaps.push(missing);
      }
    }
    bars = bars.map(function (bar) {
      return {
        openTime: bar.openTime,
        closeTime: bar.openTime + intervalMs - 1,
        open: bar.open, high: bar.high, low: bar.low, close: bar.close,
        volume: bar.hasVolume ? bar.volume : null,
        closed: true, source: "XTREND"
      };
    });
    return { ok: bars.length > 0 && gaps.length === 0, bars: bars, gaps: gaps,
      reason: gaps.length ? "Tick-historiassa on aukkoja; aukkoja ei täytetty" : bars.length ? null : "Sulkeutuneita tick-kynttilöitä ei vielä ole" };
  }

  var api = Object.freeze({
    evaluate: evaluate,
    analyze: analyze,
    ema: ema,
    rsi: rsi,
    bollinger: bollinger,
    indicatorSeries: indicatorSeries,
    aggregateTradeTicks: aggregateTradeTicks,
    validateBars: validateBars,
    defaults: DEFAULTS
  });
  root.XTrendQuickMode = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
