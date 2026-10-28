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
  var n = function (v) { if (v == null || v === "") return null; var x = Number(v); return Number.isFinite(x) ? x : null; };
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
    var momentumText = s && Number.isFinite(s.momentum) ? (s.momentum >= 0 ? "+" : "") + num(s.momentum, 3) + "%" : "—";
    return '<div class="metric"><small>' + tf + ' · live-signaali</small><strong class="' + cls + '">' + label + '</strong><div class="sub" style="font-size:12px;margin-top:5px">' + points + gateText + '<br>EMA ' + (s && s.ema || "—") + ' · RSI ' + num(s && s.rsi, 1) + ' · momentum ' + momentumText + '</div></div>';
  }

  // The canonical engine is the only source of BUY/SELL/WAIT decisions.
  // Higher-timeframe candles are fetched from the real market endpoint; no timeframe is duplicated.
  function scoreFor(bars, livePrice, higherBars, timeframe) {
    if (!Array.isArray(bars) || bars.length < 220 || !window.TradingEngine ||
        !Array.isArray(higherBars) || higherBars.length !== 2 ||
        higherBars.some(function (series) { return !Array.isArray(series) || series.length < 220; })) {
      return { score: null, side: "WAIT", actionable: false,
        gateReason: "DATA FAIL: tarvitaan vähintään 220 kynttilää pää- ja molemmilta suuremmilta aikaväleiltä" };
    }
    var live = n(livePrice);
    if (live === null || live <= 0 || !Number.isFinite(state.lastTradeAt) || state.lastTradeAt <= 0 ||
        !Number.isFinite(state.bid) || !Number.isFinite(state.ask) || state.bid <= 0 || state.ask < state.bid) {
      return { score: null, side: "WAIT", actionable: false,
        gateReason: "Odotetaan tuoretta Binance-kauppahintaa ja bid/ask-tarjousta" };
    }
    try {
      var enriched = TradingEngine.enrich(bars);
      var main = TradingEngine.analyzeSeries(enriched);
      var higher = higherBars.map(function (series) {
        return TradingEngine.analyzeSeries(TradingEngine.enrich(series));
      });
      var signal = TradingEngine.evaluateSignal(main, higher, {
        price: live, closeTime: state.lastTradeAt, bid: state.bid, ask: state.ask
      }, {
        historical: false, capital: 1000, riskPct: 0.5, maxExposurePct: 25,
        feePct: 0.1, slippagePct: 0.05
      });
      var score = signal.total > 0 ? Math.round(signal.passed / signal.total * 100) : null;
      var side = signal.direction || "WAIT";
      var result = {
        score: score, side: side, rsi: main.bar.rsi, adx: main.bar.adx,
        ema: main.bar.ema9 > main.bar.ema21 ? "9>21" : "9<21",
        momentum: Number.isFinite(enriched[enriched.length - 2].close) && enriched[enriched.length - 2].close > 0
          ? (live / enriched[enriched.length - 2].close - 1) * 100 : null,
        timeframe: timeframe || null, reason: signal.reason,
        blockingReasons: signal.blockingReasons, riskReward: signal.riskReward,
        stop: signal.stop, target: signal.target, qty: signal.qty,
        actionable: false
      };
      if (side === "WAIT" && signal.blockingReasons && signal.blockingReasons.length) {
        result.gateReason = signal.blockingReasons[0];
      }
      return result;
    } catch (error) {
      return { score: null, side: "WAIT", actionable: false,
        gateReason: "DATA FAIL: tekninen arvio epäonnistui (" + String(error && error.message || error) + ")" };
    }
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

  async function getBars(tf, requestedSymbol) {
    var symbol = requestedSymbol || state.symbol;
    var r = await fetch("/api/market?endpoint=klines&symbol=" + encodeURIComponent(symbol) + "&interval=" + encodeURIComponent(tf) + "&limit=500", { cache: "no-store" });
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
    var symbol = state.symbol;
    try {
      var bars = await getBars(interval, symbol);
      if (symbol === state.symbol && interval === state.interval) {
        state.chartBars = bars;
        renderLiveChart();
      }
    } catch (e) {
      if (symbol === state.symbol && interval === state.interval) {
        state.chartBars = [];
        state.chartLive = null;
        renderLiveChart();
        var el = $("liveMeta");
        if (el) el.textContent = "Kaavion " + interval + " / " + symbol + " datan haku epäonnistui: " + e.message;
      }
    }
  }

  function renderLiveChart() {
    var target = $("chart");
    if (!target) return;
    var sourceBars = Array.isArray(state.chartBars) ? state.chartBars : [];
    if (sourceBars.length < 2) {
      target.innerHTML = '<div class="status error">Valitun aikavälin (' + esc(state.interval) + ') oikeaa kynttilädataa ei ole saatavilla. Kaavio ei korvaa puuttuvaa dataa toisella aikavälillä.</div>';
      return;
    }
    var countEl = $("chartCount"), count = Math.max(80, Math.min(500, Number(countEl && countEl.value) || 150));
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
    var sig = gatedScore(state.lastScores && (state.lastScores[state.interval] || state.lastScores["5m"]));
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
    var base = gatedScore(scores[state.interval] || scores["5m"] || scores["1m"] || scoreFor(state.bars, livePrice));
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
    var sp = $("spread"); if (sp) { var validBook = Number.isFinite(state.bid) && Number.isFinite(state.ask) && state.bid > 0 && state.ask >= state.bid; sp.textContent = validBook ? num((state.ask - state.bid) / ((state.ask + state.bid) / 2) * 100, 4) + "%" : "—"; }
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
    var validBook = Number.isFinite(state.bid) && Number.isFinite(state.ask) && state.bid > 0 && state.ask >= state.bid;
    $("liveMeta").textContent = "Hinta " + price(state.tradePrice || state.live && state.live.close) + " USDT · bid " + price(state.bid) + " · ask " + price(state.ask) + " · spread " + (validBook ? num((state.ask - state.bid) / ((state.ask + state.bid) / 2) * 100, 4) + "%" : "—") + " · kauppatapahtumia " + state.trades + " · WS-uudelleenyhdistämisiä " + state.reconnects + (gateReason ? " · SIGNAALIT ESTETTY: " + gateReason : " · dataportti OK");
    updateMainMetrics(displayScores);
  }

  async function refreshTicker() {
    var symbol = state.symbol;
    try {
      var r = await fetch("/api/market?endpoint=ticker24hr&symbol=" + encodeURIComponent(symbol), { cache: "no-store" });
      if (r.ok) {
        var d = await r.json();
        if (symbol === state.symbol) state.tickerChange = n(d.priceChangePercent);
      }
    } catch (e) {}
  }

  async function refreshScalpScores() {
    var symbol = state.symbol;
    var scores = {};
    var timeframes = ["1m", "3m", "5m", "15m", "1h", "4h"];
    var barsByTf = {};
    // Fetch each real Binance timeframe once. A missing higher timeframe blocks the signal.
    for (var i = 0; i < timeframes.length; i++) {
      if (symbol !== state.symbol) return;
      var tf = timeframes[i];
      try {
        barsByTf[tf] = await getBars(tf, symbol);
      } catch (e) {
        barsByTf[tf] = null;
      }
    }
    if (symbol !== state.symbol) return;
    if (barsByTf["1m"]) state.bars = barsByTf["1m"];
    var higherByTf = {
      "1m": ["3m", "15m"],
      "3m": ["15m", "1h"],
      "5m": ["15m", "1h"],
      "15m": ["1h", "4h"]
    };
    ["1m", "3m", "5m", "15m"].forEach(function (tf) {
      var required = higherByTf[tf].map(function (higherTf) { return barsByTf[higherTf]; });
      scores[tf] = barsByTf[tf] && required.every(function (series) { return Array.isArray(series); })
        ? scoreFor(barsByTf[tf], state.tradePrice, required, tf)
        : { score: null, side: "WAIT", actionable: false,
            gateReason: "DATA FAIL: pää- tai suuremman aikavälin Binance-data puuttuu" };
    });
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
    var socket = state.ws;
    socket.onopen = function () {
      if (state.ws !== socket) return;
      var el = $("liveState"); if (el) { el.textContent = "● LIVE"; el.className = "pill good"; }
    };
    socket.onmessage = function (ev) {
      if (state.ws !== socket) return;
      try {
        var wrap = JSON.parse(ev.data), d = wrap.data || wrap;
        if (d.e === "trade") { state.tradePrice = n(d.p); state.lastTradeAt = Date.now(); state.trades++; }
        // Binance bookTicker stream payloads may omit the event-type field; identify them by bid/ask fields too.
        if (d.e === "bookTicker" || (d.s === state.symbol && d.b != null && d.a != null && d.B != null && d.A != null && d.p == null)) {
          var bid = n(d.b), ask = n(d.a);
          if (bid !== null && ask !== null && bid > 0 && ask >= bid) {
            state.bid = bid; state.ask = ask; state.lastBookAt = Date.now();
          }
        }
        if (d.e === "kline") { var k = d.k; var candle = { time: n(k.t), closeTime: n(k.T), open: n(k.o), high: n(k.h), low: n(k.l), close: n(k.c), volume: n(k.v) }; if (k.i === "1m") state.live = candle; if (k.i === state.interval) state.chartLive = candle; }
        // WebSocket ticks refresh the freshness gate only; direction remains from the
        // canonical engine's latest closed-candle + higher-timeframe evaluation.
        updateUi(state.lastScores || {}); renderLiveChart();
      } catch (e) {}
    };
    socket.onerror = function () {
      if (state.ws !== socket) return;
      state.wsEndpoint++;
      try { socket.close(); } catch (e) {}
    };
    socket.onclose = function () {
      if (state.ws !== socket) return;
      state.ws = null;
      scheduleWs();
    };
  }

  async function boot() {
    injectUi();
    var symbolEl = $("symbol"), intervalEl = $("interval"), countEl = $("chartCount");
    if (symbolEl) symbolEl.addEventListener("change", function () {
      stopWs();
      state.symbol = symbolEl.value; state.tradePrice = null; state.tickerChange = null; state.live = null; state.chartLive = null; state.chartBars = []; state.bars = [];
      var chartTarget = $("chart"); if (chartTarget) chartTarget.innerHTML = '<div class="status">Haetaan uuden valuuttaparin kynttilädataa…</div>';
      state.lastTradeAt = 0; state.lastBookAt = 0; state.bid = null; state.ask = null; state.lastScores = {};
      refreshTicker(); refreshScalpScores(); loadChartBars().then(function () {
        if (state.symbol === symbolEl.value) startWs();
      });
    });
    if (intervalEl) intervalEl.addEventListener("change", function () {
      stopWs();
      state.interval = intervalEl.value; state.chartLive = null; state.chartBars = [];
      loadChartBars().then(function () {
        if (state.interval === intervalEl.value) startWs();
      });
    });
    if (countEl) countEl.addEventListener("change", renderLiveChart);
    state.symbol = symbolEl ? symbolEl.value : "BTCUSDT";
    state.interval = intervalEl ? intervalEl.value : "5m";
    try { state.bars = await getBars("1m"); await loadChartBars(); } catch (e) { var st = $("status"); if (st) { st.textContent = "Reaaliaikaisen datan alustaminen epäonnistui: " + e.message; st.className = "status error"; } }
    await refreshTicker();
    await refreshScalpScores();
    startWs();
    setInterval(refreshScalpScores, 10000);
    setInterval(refreshTicker, 10000);
    setInterval(loadChartBars, 30000);
    setInterval(function () {
      updateUi(state.lastScores || {});
      renderLiveChart();
    }, 1000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot); else boot();
})();
