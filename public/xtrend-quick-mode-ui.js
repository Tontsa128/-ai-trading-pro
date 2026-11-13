/* UI adapter for the isolated XTrend Quick Mode page. No market feed is assumed. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var chart = null, candles = null, ema9 = null, ema20 = null, ema21 = null, bbUpper = null, bbMiddle = null, bbLower = null, signalMarkers = null;
  var activeInterval = "1M";
  var snapshot = null;
  var log = [];
  var lastLogKey = null;

  function setStatus(message, kind) {
    var el = $("feedStatus");
    if (!el) return;
    el.textContent = message;
    el.className = "status " + (kind || "warning");
  }
  function createChart() {
    if (!window.LightweightCharts || !$("chart")) {
      setStatus("Kaaviokirjasto ei latautunut. Tarkista verkkoyhteys.", "error");
      return;
    }
    chart = LightweightCharts.createChart($("chart"), {
      autoSize: true,
      layout: { background: { color: "#0b1422" }, textColor: "#c3d1e3" },
      grid: { vertLines: { color: "#1b2a3d" }, horzLines: { color: "#1b2a3d" } },
      rightPriceScale: { borderColor: "#30445c" },
      timeScale: { borderColor: "#30445c", timeVisible: true, secondsVisible: activeInterval === "1S" || activeInterval === "5S" },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal }
    });
    candles = chart.addSeries(LightweightCharts.CandlestickSeries, {
      upColor: "#19c995", downColor: "#f05270", borderVisible: false,
      wickUpColor: "#19c995", wickDownColor: "#f05270"
    });
    if (typeof LightweightCharts.createSeriesMarkers === "function") signalMarkers = LightweightCharts.createSeriesMarkers(candles, []);
    ema9 = chart.addSeries(LightweightCharts.LineSeries, { color: "#4fc3f7", lineWidth: 1, title: "EMA 9" });
    ema20 = chart.addSeries(LightweightCharts.LineSeries, { color: "#ffd166", lineWidth: 1, title: "EMA 20" });
    ema21 = chart.addSeries(LightweightCharts.LineSeries, { color: "#a78bfa", lineWidth: 1, title: "EMA 21" });
    bbUpper = chart.addSeries(LightweightCharts.LineSeries, { color: "#52769d", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, title: "BB upper" });
    bbMiddle = chart.addSeries(LightweightCharts.LineSeries, { color: "#718ba9", lineWidth: 1, title: "BB middle" });
    bbLower = chart.addSeries(LightweightCharts.LineSeries, { color: "#52769d", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, title: "BB lower" });
    setStatus("Kaavio valmis. Odotetaan varmennettua XTrend-hintasyötettä; tyhjää kaaviota ei täytetä esimerkkihinnoilla.", "warning");
  }
  function clearChart() {
    if (!chart) return;
    [candles, ema9, ema20, ema21, bbUpper, bbMiddle, bbLower].forEach(function (series) {
      if (series) series.setData([]);
    });
    if (signalMarkers) signalMarkers.setMarkers([]);
  }
  function showUnavailable() {
    clearChart();
    ["lastPrice", "bidAsk", "quoteAge", "rsiValue", "macdValue", "ema20Value", "bbValue", "creditValue"].forEach(function (id) {
      var el = $(id); if (el) el.textContent = "—";
    });
    $("signal").textContent = "WAIT";
    $("signal").className = "signal wait";
    $("signalReason").textContent = "XTrendin omaa hintaa ja 1M/5M sulkeutunutta kynttilähistoriaa ei ole vielä kytketty. Signaalia ei muodosteta Binance-datasta.";
  }
  function addLog(item) {
    log.unshift(item);
    log = log.slice(0, 40);
    $("signalLog").innerHTML = log.map(function (row) {
      var klass = row.signal === "BUY" ? "buy" : row.signal === "SELL" ? "sell" : "wait";
      return '<div class="logrow"><span class="logsignal ' + klass + '">' + row.signal + '</span><div><strong>' +
        escapeHtml(row.symbol) + '</strong><small>' + escapeHtml(row.time) + ' · ' + escapeHtml(row.reason) + '</small></div></div>';
    }).join("");
  }
  function escapeHtml(value) {
    return String(value == null ? "" : value).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function timeToSeconds(ms) { return Math.floor(ms / 1000); }

  // Called only by a future verified XTrend adapter; never by Binance data.

  function drawBars(bars) {
    if (!chart || !Array.isArray(bars) || !bars.length) return false;
    if (bars.some(function (bar) { return !bar || bar.source !== "XTREND" || bar.closed !== true; })) {
      clearChart();
      setStatus("Kaavion kynttilöiden XTrend-lähdettä tai sulkeutumista ei voitu vahvistaa.", "error");
      return false;
    }
    var previousTime = -Infinity;
    for (var checkIndex = 0; checkIndex < bars.length; checkIndex += 1) {
      var checked = bars[checkIndex];
      var checkedTime = Number(checked && checked.closeTime);
      var valid = checked && [checked.openTime, checked.closeTime, checked.open, checked.high, checked.low, checked.close].every(function (value) { return Number.isFinite(Number(value)); });
      if (!valid || checkedTime <= previousTime || Number(checked.open) <= 0 || Number(checked.close) <= 0 ||
          Number(checked.low) <= 0 || Number(checked.high) < Math.max(Number(checked.open), Number(checked.close), Number(checked.low)) ||
          Number(checked.low) > Math.min(Number(checked.open), Number(checked.close))) {
        setStatus("Kaavion kynttilöiden arvot tai aikajärjestys eivät kelpaa.", "error");
        clearChart();
        return false;
      }
      previousTime = checkedTime;
    }
    var rows = bars.map(function (bar) {
      return { time: Math.floor(Number(bar.closeTime) / 1000), open: Number(bar.open), high: Number(bar.high), low: Number(bar.low), close: Number(bar.close) };
    }).filter(function (bar) {
      return Number.isFinite(bar.time) && bar.open > 0 && bar.high >= Math.max(bar.open, bar.close, bar.low) &&
        bar.low > 0 && bar.close > 0 && bar.low <= Math.min(bar.open, bar.close);
    });
    if (!rows.length) return false;
    candles.setData(rows);
    var lines = XTrendQuickMode.indicatorSeries(bars);
    ema9.setData(lines.ema9); ema20.setData(lines.ema20); ema21.setData(lines.ema21);
    bbUpper.setData(lines.bbUpper); bbMiddle.setData(lines.bbMiddle); bbLower.setData(lines.bbLower);
    chart.timeScale().fitContent();
    return true;
  }
  function barsForSelectedInterval(data) {
    if (activeInterval === "1M") return data.oneMinuteBars || [];
    if (activeInterval === "5M") return data.fiveMinuteBars || [];
    if (activeInterval === "1S" || activeInterval === "5S") {
      var supplied = activeInterval === "1S" ? data.oneSecondBars : data.fiveSecondBars;
      if (Array.isArray(supplied)) return supplied;
      if (Array.isArray(data.ticks)) {
        var aggregated = XTrendQuickMode.aggregateTradeTicks(data.ticks, activeInterval === "1S" ? 1 : 5, Date.now());
        if (aggregated.bars.length) {
          if (!aggregated.ok) setStatus(aggregated.reason + ". Aukkoja ei täytetty.", "warning");
          return aggregated.bars;
        }
      }
    }
    return [];
  }


  function updateMarker(result, bars) {
    if (!signalMarkers || !Array.isArray(bars) || !bars.length || result.signal === "WAIT") {
      if (signalMarkers) signalMarkers.setMarkers([]);
      return;
    }
    signalMarkers.setMarkers([{
      time: Math.floor(Number(bars[bars.length - 1].closeTime) / 1000),
      position: result.signal === "BUY" ? "belowBar" : "aboveBar",
      color: result.signal === "BUY" ? "#28d7a0" : "#ff647c",
      shape: result.signal === "BUY" ? "arrowUp" : "arrowDown",
      text: result.signal
    }]);
  }

  function acceptSnapshot(data, config) {
    if (!data || !data.quote || data.quote.source !== "XTREND") {
      setStatus("Virheellinen lähde: vain varmennettu XTrend-syöte hyväksytään.", "error");
      showUnavailable();
      return { accepted: false };
    }
    var result = XTrendQuickMode.evaluate(data, config || {});
    snapshot = data;
    var chartBars = barsForSelectedInterval(data);
    if (chartBars.length) drawBars(chartBars);
    else setStatus("XTrend-quote saatu, mutta valitun aikavälin kynttilöitä ei ole saatavilla.", "warning");
    var quote = data.quote;
    var quoteAgeMs = Date.now() - Number(quote.receivedAt);
    if (!Number.isFinite(quoteAgeMs) || quoteAgeMs < 0 || quoteAgeMs > XTrendQuickMode.defaults.maxQuoteAgeMs ||
        !Number.isFinite(Number(quote.bid)) || !Number.isFinite(Number(quote.ask)) ||
        Number(quote.bid) <= 0 || Number(quote.ask) < Number(quote.bid)) {
      showUnavailable();
      $("signalReason").textContent = result.reasons.join(" · ") || "XTrendin hintatarjous ei ole tuore tai kelvollinen.";
      setStatus("Vanhentunutta tai virheellistä XTrend-hintaa ei näytetä.", "error");
      return { accepted: true, result: result };
    }
    $("lastPrice").textContent = Number(((Number(quote.bid) + Number(quote.ask)) / 2)).toFixed(2);
    $("bidAsk").textContent = Number(quote.bid).toFixed(2) + " / " + Number(quote.ask).toFixed(2);
    $("quoteAge").textContent = Math.max(0, Date.now() - Number(quote.receivedAt)) + " ms";
    $("signal").textContent = result.signal;
    $("signal").className = "signal " + result.signal.toLowerCase();
    $("signalReason").textContent = result.reasons.join(" · ");
    if (result.oneMinute) {
      $("rsiValue").textContent = result.oneMinute.rsi14.toFixed(1);
      $("macdValue").textContent = result.oneMinute.macdHistogram.toFixed(5);
      $("ema20Value").textContent = result.oneMinute.ema20.toFixed(2);
      var bb = result.oneMinute.bollinger;
      $("bbValue").textContent = bb.lower.toFixed(2) + " / " + bb.middle.toFixed(2) + " / " + bb.upper.toFixed(2);
    }
    setStatus(result.signal === "WAIT" ? "XTrend-data vastaanotettu. Kauppaehtoja ei täytetty." : "XTrend-data vastaanotettu. Tutkimussignaali, ei toimeksiantoa.", result.signal === "WAIT" ? "warning" : "ok");
    updateMarker(result, chartBars);
    var signalBar = Array.isArray(data.oneMinuteBars) && data.oneMinuteBars.length ? data.oneMinuteBars[data.oneMinuteBars.length - 1] : null;
    var logKey = [result.symbol || data.symbol, signalBar ? signalBar.closeTime : quote.receivedAt, result.signal].join("|");
    if (logKey !== lastLogKey) {
      lastLogKey = logKey;
      addLog({ signal: result.signal, symbol: result.symbol || data.symbol, time: new Date(quote.receivedAt).toLocaleTimeString("fi-FI"), reason: result.reasons.join("; ") });
    }
    return { accepted: true, result: result };
  }

  function selectInterval(value) {
    activeInterval = value;
    document.querySelectorAll("[data-interval]").forEach(function (button) {
      button.classList.toggle("active", button.getAttribute("data-interval") === value);
    });
    if (chart) chart.applyOptions({ timeScale: { secondsVisible: value === "1S" || value === "5S" } });
    if (snapshot) {
      var bars = barsForSelectedInterval(snapshot);
      if (bars.length) drawBars(bars);
      else setStatus("Valittu " + value + ": varmennettuja XTrend-kynttilöitä ei ole saatavilla.", "warning");
    } else {
      setStatus("Valittu " + value + ". Odotetaan XTrendin omaa kynttilähistoriaa; Binance-kynttilöitä ei käytetä.", "warning");
    }
  }

  document.querySelectorAll("[data-interval]").forEach(function (button) {
    button.addEventListener("click", function () { selectInterval(button.getAttribute("data-interval")); });
  });
  $("refreshSource").addEventListener("click", function () {
    setStatus("XTrend-lähdettä ei ole vielä kytketty. Sovellus ei yritä hakea eikä esittää muuta markkinadataa XTrend-hintana.", "warning");
  });
  createChart();
  showUnavailable();
  addLog({ signal: "WAIT", symbol: "BTCUSD", time: "—", reason: "XTrend-markkinasyöte puuttuu" });
  window.XTrendQuickModeUI = Object.freeze({ acceptSnapshot: acceptSnapshot, selectInterval: selectInterval });
})();
