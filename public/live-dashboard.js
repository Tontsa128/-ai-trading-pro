/* Rahasampo live market layer: Binance Spot public market data. No exchange orders. */
(function () {
  "use strict";

  var state = {
    ws: null, wsTimer: null, symbol: "BTCUSDT", interval: "5m",
    bars: [], chartBars: [], chartLive: null, live: null, bid: null, ask: null, tradePrice: null,
    lastTradeAt: 0, lastBookAt: 0, lastScores: {}, trades: 0, reconnects: 0, wsEndpoint: 0,
    tickerChange: null, startedAt: Date.now()
  };
  var WS_ENDPOINTS = [
    "wss://stream.binance.com:9443/stream?streams=",
    "wss://data-stream.binance.vision/stream?streams="
  ];
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>\"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); };
  var n = function (v) { var x = Number(v); return Number.isFinite(x) ? x : null; };
  var num = function (v, d) { var x = n(v); return x === null ? "—" : x.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d }); };
  var price = function (v) { var x = n(v); return x === null ? "—" : x < 1 ? num(x, 6) : num(x, 2); };

  function injectUi() {
    var chart = $("chart");
    if (!chart || $("liveScalpPanel")) return;
    var p = document.createElement("div");
    p.id = "liveScalpPanel";
    p.className = "panel";
    p.style.margin = "12px 0";
    p.innerHTML = '<div class="section-title"><div><strong>⚡ Pikatreidaus live-paneeli</strong><div class="sub">1m · 3m · 5m · 15m · reaaliaikainen kauppavirta + kynttilä</div></div><span id="liveState" class="pill">YHDISTETÄÄN</span></div>' +
      '<div id="liveScalpCards" class="metrics"></div>' +
      '<div class="sub" id="liveMeta">Yhdistetään Binance Spot -markkinadataan…</div>';
    chart.parentNode.insertBefore(p, chart);
  }

  function cardHtml(tf, s) {
    var side = s && s.side || "WAIT";
    var cls = side === "BUY" ? "good" : side === "SELL" ? "bad" : "neutral";
    var label = side === "BUY" ? "OSTA" : side === "SELL" ? "MYY / KEVENNÄ" : "ODOTA";
    var rawScore = s && Number.isFinite(s.score) ? s.score : null;
    var directionalPoints = rawScore === null ? null : side === "SELL" ? 100 - rawScore : rawScore;
    var points = rawScore === null ? "Tekniset pisteet eivät saatavilla" :
      side === "WAIT" ? "Ei toimintarajaa · tekninen raakaskoori " + num(rawScore, 0) + "/100 · ei voittotodennäköisyys" :
      "Suunnan tekniset pisteet " + num(directionalPoints, 0) + "/100 · ei voittotodennäköisyys";
    var gateText = s && s.gateReason ? '<br><strong>Signaali estetty:</strong> ' + esc(s.gateReason) : "";
    return '<div class="metric"><small>' + tf + ' · live-signaali</small><strong class="' + cls + '">' + label + '</strong><div class="sub" style="font-size:12px;margin-top:5px">' + points + gateText + '<br>EMA ' + (s && s.ema || "—") + ' · RSI ' + num(s && s.rsi, 1) + ' · momentum ' + (s && s.momentum >= 0 ? "+" : "") + num(s && s.momentum, 3) + '%</div></div>';
  }

  function scoreFor(bars, livePrice) {
    if (!Array.isArray(bars) || bars.length < 60 || !window.TradingEngine) return null;
    var e = TradingEngine.enrich(bars), b = e[e.length - 1], p = e[e.length - 2];
    if (!b || !p) return null;
    var score = 50;
    if (b.close > b.ema9) score += 8; else score -= 8;
    if (b.ema9 > b.ema21) score += 12; else score -= 12;
    if (b.close > b.ema50) score += 8; else score -= 8;
    if (b.macdHist > 0) score += 10; else score -= 10;
    if (Number.isFinite(b.adx)) score += b.adx >= 18 ? (b.pdi > b.mdi ? 8 : -8) : 0;
    if (Number.isFinite(b.rsi)) {
      if (b.rsi >= 50 && b.rsi <= 68) score += 7;
      else if (b.rsi >= 32 && b.rsi < 50) score -= 4;
      else if (b.rsi > 72) score -= 8;
      else if (b.rsi < 28) score += 5;
    }
    if (Number.isFinite(b.volumeRatio)) score += Math.max(-5, Math.min(5, (b.volumeRatio - 1) * 5));
    var live = n(livePrice), mom = live !== null && p.close > 0 ? (live / p.close - 1) * 100 : 0;
    score += Math.max(-7, Math.min(7, mom * 40));
    score = Math.max(1, Math.min(99, score));
    return { score: score, side: score >= 65 ? "BUY" : score <= 35 ? "SELL" : "WAIT", rsi: b.rsi, adx: b.adx, ema: b.ema9 > b.ema21 ? "9>21" : "9<21", momentum: mom };
  }

  function currentGateReason() {
    if (!window.LiveSignalGuards || typeof window.LiveSignalGuards.gateReason !== "function") {
      return "Live-datan turvatarkistus ei latautunut";
    }
    return window.LiveSignalGuards.gateReason(state, Date.now());
  }

  function gatedScore(score) {
    var reason = currentGateReason();
    if (!score) {
      return { score: null, side: "WAIT", gateReason: reason || "Teknistä pistemäärää ei voi laskea", actionable: false };
    }
    if (!window.LiveSignalGuards || typeof window.LiveSignalGuards.apply !== "function") {
      return Object.assign({}, score, { side: "WAIT", gateReason: reason, actionable: false });
    }
    return window.LiveSignalGuards.apply(score, state, Date.now());
  }

  async function getBars(tf) {
    var r = await fetch("/api/market?endpoint=klines&symbol=" + encodeURIComponent(state.symbol) + "&interval=" + tf + "&limit=250", { cache: "no-store" });
    if (!r.ok) throw new Error("Kynttilädatan haku HTTP " + r.status);
    var raw = await r.json();
    return TradingEngine.enrich(TradingEngine.parseKlines(raw, Date.now()));
  }

  function mergeLive(base, live) {
    var arr = (base || []).slice();
    if (!live) return arr;
    var last = arr[arr.length - 1];
    if (last && last.time === live.time) arr[arr.length - 1] = live;
    else if (last && live.time > last.time) arr.push(live);
    return arr;
  }

  async function loadChartBars() {
    var interval = state.interval || "5m";
    try {
      var bars = await getBars(interval);
      if (interval === state.interval) { state.chartBars = bars; renderLiveChart(); }
    } catch (e) {
      var el = $("liveMeta");
      if (el) el.textContent = "Kaavion " + interval + " datan haku epäonnistui: " + e.message;
    }
  }

  function renderLiveChart() {
    var target = $("chart");
    if (!target || state.bars.length < 2) return;
    var countEl = $("chartCount"), count = Math.max(80, Math.min(250, Number(countEl && countEl.value) || 150));
    var sourceBars = state.chartBars.length ? state.chartBars : state.bars;
    var d = mergeLive(sourceBars, state.chartLive).slice(-count), vals = [];
    d.forEach(function (x) {
      vals.push(+x.low, +x.high);
      [x.ema9, x.ema21, x.ema50, x.ema200].forEach(function (v) { if (Number.isFinite(v)) vals.push(v); });
    });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals), pad = (hi - lo) * 0.07 || Math.abs(hi) * 0.002 || 1;
    lo -= pad; hi += pad;
    var w = 1100, h = 430, l = 18, r = 86, t = 34, btm = 38, pw = w - l - r, ph = h - t - btm, step = pw / d.length, cw = Math.max(2, Math.min(11, step * 0.66));
    function x(k) { return l + step * (k + 0.5); }
    function y(v) { return t + (hi - v) / (hi - lo) * ph; }
    var out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" style="width:100%;height:auto;display:block;background:#101d30;border-radius:10px" role="img" aria-label="' + esc(state.symbol) + ' reaaliaikainen kynttiläkaavio">', '<rect width="100%" height="100%" fill="#101d30"/>'];
    for (var g = 0; g <= 6; g++) {
      var gy = t + ph * g / 6, pv = hi - (hi - lo) * g / 6;
      out.push('<line x1="' + l + '" y1="' + gy.toFixed(1) + '" x2="' + (w - r) + '" y2="' + gy.toFixed(1) + '" stroke="#263750"/>');
      out.push('<text x="' + (w - r + 7) + '" y="' + (gy + 4).toFixed(1) + '" fill="#a8bdd7" font-size="11">' + esc(price(pv)) + '</text>');
    }
    out.push('<text x="' + l + '" y="18" fill="#dce9fa" font-size="13" font-weight="700">' + esc(state.symbol) + ' · LIVE ' + esc(state.interval.toUpperCase()) + ' · ' + d.length + ' kynttilää</text>');
    d.forEach(function (v, k) {
      var op = +v.open, cl = +v.close, hh = +v.high, ll = +v.low, cx = x(k), c = cl >= op ? '#28d7a0' : '#ff647c';
      out.push('<line x1="' + cx.toFixed(1) + '" y1="' + y(hh).toFixed(1) + '" x2="' + cx.toFixed(1) + '" y2="' + y(ll).toFixed(1) + '" stroke="' + c + '" stroke-width="1.4"/>');
      var yy = Math.min(y(op), y(cl)), bh = Math.max(1, Math.abs(y(op) - y(cl)));
      out.push('<rect x="' + (cx - cw / 2).toFixed(1) + '" y="' + yy.toFixed(1) + '" width="' + cw.toFixed(1) + '" height="' + bh.toFixed(1) + '" fill="' + c + '" rx=".7"/>');
    });
    [["ema9", "#ffd166"], ["ema21", "#67b7ff"], ["ema50", "#c084fc"], ["ema200", "#fb7185"]].forEach(function (o) {
      var pts = [];
      d.forEach(function (v, k) { var q = Number(v[o[0]]); if (Number.isFinite(q)) pts.push(x(k).toFixed(1) + ',' + y(q).toFixed(1)); });
      if (pts.length > 1) out.push('<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + o[1] + '" stroke-width="' + (o[0] === 'ema200' ? 2 : 1.4) + '"/>');
    });
    var sig = gatedScore(scoreFor(state.bars, state.tradePrice || state.live && state.live.close));
    if (sig && sig.side !== "WAIT") {
      var sc = sig.side === "BUY" ? '#28d7a0' : '#ff647c', points = Math.round(sig.side === "BUY" ? sig.score : 100 - sig.score), txt = sig.side === "BUY" ? "OSTA" : "MYY", yy2 = y(state.tradePrice || state.live.close);
      out.push('<line x1="' + l + '" y1="' + yy2.toFixed(1) + '" x2="' + (w - r) + '" y2="' + yy2.toFixed(1) + '" stroke="' + sc + '" stroke-width="2" stroke-dasharray="7 4"/>');
      out.push('<rect x="' + (w - r - 100) + '" y="' + Math.max(t, yy2 - 18).toFixed(1) + '" width="96" height="22" rx="8" fill="' + sc + '"/><text x="' + (w - r - 52) + '" y="' + Math.max(t + 15, yy2 - 3).toFixed(1) + '" text-anchor="middle" fill="#07111f" font-size="11" font-weight="900">' + txt + ' ' + points + '/100p</text>');
    }
    [0, Math.floor((d.length - 1) / 2), d.length - 1].forEach(function (k) { var dt = new Date(d[k].time), lab = dt.toLocaleString('fi-FI', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); out.push('<text x="' + x(k).toFixed(1) + '" y="' + (h - 12) + '" text-anchor="middle" fill="#a8bdd7" font-size="11">' + esc(lab) + '</text>'); });
    out.push('</svg>');
    target.innerHTML = out.join('');
  }

  function updateMainMetrics(scores) {
    var livePrice = state.tradePrice || (state.live && state.live.close);
    if (livePrice !== null) {
      var pe = $("price"); if (pe) pe.textContent = price(livePrice);
    }
    if (state.tickerChange !== null) {
      var ce = $("change"); if (ce) { ce.textContent = (state.tickerChange >= 0 ? "+" : "") + num(state.tickerChange, 2) + "%"; ce.className = state.tickerChange >= 0 ? "good" : "bad"; }
    }
    var base = gatedScore(scores["1m"] || scoreFor(state.bars, livePrice));
    if (base) {
      var re = $("rsi"); if (re) re.textContent = num(base.rsi, 1);
      var ae = $("adx"); if (ae) ae.textContent = num(base.adx, 1);
      var sig = $("signal"); if (sig) {
        sig.textContent = base.side === "BUY" ? "OSTA · pisteet " + Math.round(base.score) + "/100" :
          base.side === "SELL" ? "MYY / KEVENNÄ · pisteet " + Math.round(100 - base.score) + "/100" :
          base.gateReason ? "ODOTA · " + base.gateReason : "ODOTA";
        sig.className = "signal " + (base.side === "BUY" ? "buy" : base.side === "SELL" ? "sell" : "wait");
      }
    }
    var sp = $("spread"); if (sp && state.bid !== null && state.ask !== null && state.bid > 0) sp.textContent = num((state.ask - state.bid) / state.bid * 100, 4) + "%";
  }

  function updateUi(scores) {
    injectUi();
    var displayScores = {};
    ["1m", "3m", "5m", "15m"].forEach(function (tf) { displayScores[tf] = gatedScore(scores[tf]); });
    $("liveScalpCards").innerHTML = ["1m", "3m", "5m", "15m"].map(function (tf) { return cardHtml(tf, displayScores[tf]); }).join("");
    var age = state.lastTradeAt ? Math.max(0, (Date.now() - state.lastTradeAt) / 1000) : Infinity;
    var gateReason = currentGateReason();
    $("liveState").textContent = gateReason ? "SIGNAALI ESTETTY" : age < 3 ? "● LIVE" : "YHTEYS HILJAINEN";
    $("liveState").className = "pill " + (!gateReason && age < 3 ? "good" : "bad");
    $("liveMeta").textContent = "Hinta " + price(state.tradePrice || state.live && state.live.close) + " USDT · bid " + price(state.bid) + " · ask " + price(state.ask) + " · spread " + (state.bid && state.ask ? num((state.ask - state.bid) / ((state.ask + state.bid) / 2) * 100, 4) + "%" : "—") + " · kauppatapahtumia " + state.trades + " · WS-uudelleenyhdistämisiä " + state.reconnects + (gateReason ? " · SIGNAALIT ESTETTY: " + gateReason : " · dataportti OK");
    updateMainMetrics(displayScores);
  }

  async function refreshTicker() {
    try {
      var r = await fetch("/api/market?endpoint=ticker24hr&symbol=" + encodeURIComponent(state.symbol), { cache: "no-store" });
      if (r.ok) { var d = await r.json(); state.tickerChange = n(d.priceChangePercent); }
    } catch (e) {}
  }

  async function refreshScalpScores() {
    var scores = {};
    for (var i = 0; i < 4; i++) {
      var tf = ["1m", "3m", "5m", "15m"][i];
      try {
        var bars = await getBars(tf);
        scores[tf] = scoreFor(bars, state.tradePrice);
        if (tf === "1m") state.bars = bars;
      } catch (e) { scores[tf] = null; }
    }
    state.lastScores = scores;
    updateUi(scores); renderLiveChart();
  }

  function stopWs() {
    if (state.wsTimer) clearTimeout(state.wsTimer);
    state.wsTimer = null;
    if (state.ws) { try { state.ws.onclose = null; state.ws.close(); } catch (e) {} state.ws = null; }
  }

  function scheduleWs() {
    if (state.wsTimer) return;
    state.reconnects++;
    state.wsTimer = setTimeout(function () { state.wsTimer = null; startWs(); }, 1500);
  }

  function startWs() {
    stopWs();
    var s = state.symbol.toLowerCase(), iv = state.interval || "5m";
    var base = WS_ENDPOINTS[state.wsEndpoint % WS_ENDPOINTS.length];
    var streams = s + "@trade/" + s + "@bookTicker/" + s + "@kline_" + iv;
    try { state.ws = new WebSocket(base + streams); } catch (e) { state.wsEndpoint++; scheduleWs(); return; }
    state.ws.onopen = function () { var el = $("liveState"); if (el) { el.textContent = "● LIVE"; el.className = "pill good"; } };
    state.ws.onmessage = function (ev) {
      try {
        var wrap = JSON.parse(ev.data), d = wrap.data || wrap;
        if (d.e === "trade") { state.tradePrice = n(d.p); state.lastTradeAt = Date.now(); state.trades++; }
        if (d.e === "bookTicker") { state.bid = n(d.b); state.ask = n(d.a); state.lastBookAt = Date.now(); }
        if (d.e === "kline") { var k = d.k; var candle = { time: n(k.t), closeTime: n(k.T), open: n(k.o), high: n(k.h), low: n(k.l), close: n(k.c), volume: n(k.v) }; if (k.i === "1m") state.live = candle; if (k.i === state.interval) state.chartLive = candle; }
        var quick = scoreFor(state.bars, state.tradePrice);
        state.lastScores = Object.assign({}, state.lastScores || {}, { "1m": quick });
        updateUi(state.lastScores); renderLiveChart();
      } catch (e) {}
    };
    state.ws.onerror = function () { state.wsEndpoint++; try { state.ws.close(); } catch (e) {} };
    state.ws.onclose = function () { scheduleWs(); };
  }

  async function boot() {
    injectUi();
    var symbolEl = $("symbol"), intervalEl = $("interval"), countEl = $("chartCount");
    if (symbolEl) symbolEl.addEventListener("change", function () {
      state.symbol = symbolEl.value; state.tradePrice = null; state.live = null; state.chartLive = null; state.chartBars = [];
      state.lastTradeAt = 0; state.lastBookAt = 0; state.bid = null; state.ask = null; state.lastScores = {};
      refreshTicker(); refreshScalpScores(); loadChartBars().then(startWs);
    });
    if (intervalEl) intervalEl.addEventListener("change", function () { state.interval = intervalEl.value; state.chartLive = null; state.chartBars = []; loadChartBars().then(startWs); });
    if (countEl) countEl.addEventListener("change", renderLiveChart);
    state.symbol = symbolEl ? symbolEl.value : "BTCUSDT";
    state.interval = intervalEl ? intervalEl.value : "5m";
    try { state.bars = await getBars("1m"); await loadChartBars(); } catch (e) { var st = $("status"); if (st) { st.textContent = "Reaaliaikaisen datan alustaminen epäonnistui: " + e.message; st.className = "status error"; } }
    await refreshTicker();
    await refreshScalpScores();
    startWs();
    setInterval(refreshScalpScores, 10000);
    setInterval(refreshTicker, 10000);
    setInterval(function () {
      updateUi(state.lastScores || {});
      renderLiveChart();
    }, 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
