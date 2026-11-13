/* UI adapter for the isolated XTrend Quick Mode page. No market feed is assumed. */
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var chart = null, candles = null, ema9 = null, ema20 = null, ema21 = null, bbUpper = null, bbMiddle = null, bbLower = null;
  var activeInterval = "1M";
  var snapshot = null;
  var log = [];

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
    ema9 = chart.addSeries(LightweightCharts.LineSeries, { color: "#4fc3f7", lineWidth: 1, title: "EMA 9" });
    ema20 = chart.addSeries(LightweightCharts.LineSeries, { color: "#ffd166", lineWidth: 1, title: "EMA 20" });
    ema21 = chart.addSeries(LightweightCharts.LineSeries, { color: "#a78bfa", lineWidth: 1, title: "EMA 21" });
    bbUpper = chart.addSeries(LightweightCharts.LineSeries, { color: "#52769d", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, title: "BB upper" });
    bbMiddle = chart.addSeries(LightweightCharts.LineSeries, { color: "#718ba9", lineWidth: 1, title: "BB middle" });
    bbLower = chart.addSeries(LightweightCharts.LineSeries, { color: "#52769d", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, title: "BB lower" });
    setStatus("Kaavio valmis. Odotetaan varmennettua XTrend-hintasyötettä; tyhjää kaaviota ei täytetä esimerkkihinnoilla.", "warning");
  }
  function showUnavailable() {
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
  function acceptSnapshot(data, config) {
    if (!data || !data.quote || data.quote.source !== "XTREND") {
      setStatus("Virheellinen lähde: vain varmennettu XTrend-syöte hyväksytään.", "error");
      showUnavailable();
      return { accepted: false };
    }
    var result = XTrendQuickMode.evaluate(data, config || {});
    snapshot = data;
    var quote = data.quote;
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
    if (result.signal !== "WAIT" || !log.length || log[0].signal !== result.signal) {
      addLog({ signal: result.signal, symbol: result.symbol, time: new Date(quote.receivedAt).toLocaleTimeString("fi-FI"), reason: result.reasons.join("; ") });
    }
    return { accepted: true, result: result };
  }

  function selectInterval(value) {
    activeInterval = value;
    document.querySelectorAll("[data-interval]").forEach(function (button) {
      button.classList.toggle("active", button.getAttribute("data-interval") === value);
    });
    if (chart) chart.applyOptions({ timeScale: { secondsVisible: value === "1S" || value === "5S" } });
    setStatus("Valittu " + value + ". Tarvitaan XTrendin oma " + value + " -historia; Binance-kynttilöitä ei käytetä tässä näkymässä.", "warning");
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
