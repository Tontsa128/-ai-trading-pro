/* Rahasampo live market layer: Binance Spot public market data. No exchange orders. */
(function () {
  "use strict";

  var state = {
    ws: null, wsTimer: null, symbol: "BTCUSDT", interval: "5m",
    bars: [], chartBars: [], chartLive: null, live: null, bid: null, ask: null, tradePrice: null,
    lastTradeAt: 0, lastBookAt: 0, lastScores: {}, trades: 0, reconnects: 0, wsEndpoint: 0,
    tradeSource: "NONE", bookSource: "NONE", chartSource: "REST", lastRestCandleAt: 0, decision: null, decisionError: "Odotetaan ensimmäistä täyttä markkina-analyysiä.",
    restFallbackBusy: false, restError: null, tickerChange: null, startedAt: Date.now()
  };
  var WS_ENDPOINTS = [
    "wss://stream.binance.com:9443/stream?streams=",
    "wss://data-stream.binance.vision/stream?streams="
  ];
  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) { return String(s == null ? "" : s).replace(/[&<>\"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]; }); };
  var n = function (v) { if (v == null || v === "") return null; var x = Number(v); return Number.isFinite(x) ? x : null; };
  var num = function (v, d) { var x = n(v); return x === null ? "—" : new Intl.NumberFormat("fi-FI", { minimumFractionDigits: d, maximumFractionDigits: d }).format(x).replace(/^-/, "−"); };
  var price = function (v) { var x = n(v); return x === null ? "—" : x < 1 ? num(x, 6) : num(x, 2); };

  function injectUi() {
    var chart = $("chart");
    if (!chart || $("liveScalpPanel")) return;
    var p = document.createElement("div");
    p.id = "liveScalpPanel";
    p.className = "panel";
    p.style.margin = "12px 0";
    p.innerHTML = '<div class="section-title"><div><strong>Live-signaalit</strong><div class="sub">Aikaväli 1–15 min · päivittyy reaaliajassa</div></div><span id="liveState" class="pill">YHDISTETÄÄN</span></div>' +
      '<div id="liveScalpCards" class="metrics"></div>' +
      '<div class="sub" id="liveMeta">Yhdistetään Binance Spot -markkinadataan…</div>';
    chart.parentNode.insertBefore(p, chart);
  }

  function cardHtml(tf, s) {
    var side = s && s.side || "WAIT";
    var cls = side === "BUY" ? "good" : side === "SELL" ? "bad" : "neutral";
    var label = side === "BUY" ? "NOUSUPAINE" : side === "SELL" ? "LASKUPAINE" : "EI SELKEÄÄ SUUNTAA";
    var rawScore = s && Number.isFinite(s.score) ? s.score : null;
    var blocked = !!(s && s.gateReason);
    var points = blocked ? "Suuntatieto estetty: reaaliaikaisen datan turvaehto ei täyty." :
      rawScore === null ? "Teknistä suuntapistettä ei voida laskea." :
      "Tekninen suuntapiste " + num(side === "SELL" ? 100 - rawScore : rawScore, 0) + "/100. Ei kaupankäyntisignaali.";
    var momentumText = s && Number.isFinite(s.momentum) ? (s.momentum >= 0 ? "+" : "") + s.momentum.toLocaleString("fi-FI", {minimumFractionDigits:3,maximumFractionDigits:3}) + " %" : "—";
    var rsiValue = s && Number.isFinite(s.rsi) ? s.rsi.toLocaleString("fi-FI", {minimumFractionDigits:1,maximumFractionDigits:1}) : "—";
    var rsiText = "RSI " + rsiValue;
    var emaText = s && s.ema === "9<21" ? "EMA 9 alle EMA 21" : s && s.ema === "9>21" ? "EMA 9 yli EMA 21" : "EMA-suhde ei saatavilla";
    return '<div class="metric"><small>' + tf + ' · tekninen suunta</small><strong class="' + cls + '">' + label + '</strong><div class="sub" style="font-size:12px;margin-top:5px">' + points + '<br>' + emaText + ' · ' + rsiText + ' · momentti ' + momentumText + '</div></div>';
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
    var live = n(livePrice), mom = live !== null && live > 0 && p.close > 0 ? (live / p.close - 1) * 100 : null;
    if (mom !== null) score += Math.max(-7, Math.min(7, mom * 40));
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

  async function getBars(tf, requestedSymbol) {
    var symbol = requestedSymbol || state.symbol;
    var r = await fetch("/api/market?endpoint=klines&symbol=" + encodeURIComponent(symbol) + "&interval=" + encodeURIComponent(tf) + "&limit=500", { cache: "no-store" });
    if (!r.ok) throw new Error("Kynttilädatan haku HTTP " + r.status);
    var raw = await r.json();
    return TradingEngine.enrich(TradingEngine.parseKlines(raw, Date.now()));
  }

  function intervalMilliseconds(interval) {
    var units = { "1m": 60000, "3m": 180000, "5m": 300000, "15m": 900000,
      "1h": 3600000, "4h": 14400000, "1d": 86400000 };
    return units[interval] || 0;
  }

  async function fetchMarketJson(endpoint, symbol, interval) {
    var query = "endpoint=" + encodeURIComponent(endpoint) + "&symbol=" + encodeURIComponent(symbol);
    if (interval) query += "&interval=" + encodeURIComponent(interval) + "&limit=3";
    var response = await fetch("/api/market?" + query, { cache: "no-store" });
    if (!response.ok) throw new Error("Binance REST-varayhteys HTTP " + response.status);
    return response.json();
  }

  // REST is a real-data fallback, not synthetic data. It only takes over when
  // the corresponding WebSocket event stream has gone stale.
  async function refreshRestFallback() {
    if (state.restFallbackBusy) return;
    var now = Date.now(), symbol = state.symbol, interval = state.interval;
    var needTrade = !state.lastTradeAt || now - state.lastTradeAt > 2500;
    var needBook = !state.lastBookAt || now - state.lastBookAt > 1500;
    var needCandle = !state.lastRestCandleAt || now - state.lastRestCandleAt > 4000;
    if (!needTrade && !needBook && !needCandle) return;
    state.restFallbackBusy = true;
    var tasks = [];

    if (needTrade) {
      tasks.push(fetchMarketJson("ticker24hr", symbol).then(function (data) {
        if (symbol !== state.symbol) return;
        var p = n(data && data.lastPrice), closeTime = n(data && data.closeTime), receivedAt = Date.now();
        var age = closeTime === null ? Infinity : receivedAt - closeTime;
        if (p === null || p <= 0 || !Number.isFinite(age) || age < -1000 || age > 5000) {
          throw new Error("Binance REST-kauppahinta puuttuu tai on vanhentunut.");
        }
        if (!state.lastTradeAt || Date.now() - state.lastTradeAt > 2500) {
          state.tradePrice = p;
          state.lastTradeAt = receivedAt;
          state.tradeSource = "REST";
        }
        state.restError = null;
      }).catch(function (error) {
        state.restError = error && error.message ? error.message : "REST-kauppahinnan haku epäonnistui.";
      }));
    }

    if (needBook) {
      tasks.push(fetchMarketJson("bookTicker", symbol).then(function (data) {
        if (symbol !== state.symbol) return;
        var bid = n(data && data.bidPrice), ask = n(data && data.askPrice);
        if (bid === null || ask === null || bid <= 0 || ask < bid) {
          throw new Error("Binance REST order book -tarjous puuttuu tai on virheellinen.");
        }
        if (!state.lastBookAt || Date.now() - state.lastBookAt > 1500) {
          state.bid = bid;
          state.ask = ask;
          state.lastBookAt = Date.now();
          state.bookSource = "REST";
        }
      }).catch(function (error) {
        state.restError = error && error.message ? error.message : "REST order book -haku epäonnistui.";
      }));
    }

    if (needCandle) {
      tasks.push(fetchMarketJson("klines", symbol, interval).then(function (rows) {
        if (symbol !== state.symbol || interval !== state.interval) return;
        state.lastRestCandleAt = Date.now();
        var ms = intervalMilliseconds(interval);
        if (!Array.isArray(rows) || !ms || !rows.length) return;
        var k = rows[rows.length - 1];
        if (!Array.isArray(k) || k.length < 7) return;
        var live = {
          time: n(k[0]), open: n(k[1]), high: n(k[2]), low: n(k[3]),
          close: n(k[4]), volume: n(k[5]), closeTime: n(k[6])
        };
        var valid = [live.time, live.open, live.high, live.low, live.close, live.volume, live.closeTime].every(Number.isFinite) &&
          live.time % ms === 0 && live.closeTime === live.time + ms - 1 && live.closeTime >= Date.now() &&
          Math.min(live.open, live.high, live.low, live.close) > 0 && live.volume >= 0 &&
          live.high >= Math.max(live.open, live.close, live.low) &&
          live.low <= Math.min(live.open, live.close, live.high);
        var lastClosed = state.chartBars[state.chartBars.length - 1];
        if (!valid || !lastClosed || lastClosed.time + ms !== live.time) return;
        var enriched = TradingEngine.enrich(state.chartBars.concat([live]));
        state.chartLive = enriched[enriched.length - 1];
        state.chartSource = "REST";
        renderLiveChart();
      }).catch(function (error) {
        state.restError = error && error.message ? error.message : "REST-kynttilähaun varayhteys epäonnistui.";
      }));
    }

    try {
      await Promise.all(tasks);
      if (symbol === state.symbol) {
        updateUi(state.lastScores || {});
        renderLiveChart();
      }
    } finally {
      state.restFallbackBusy = false;
    }
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
    try {
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
    var out = ['<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + w + ' ' + h + '" style="width:100%;height:100%;min-height:360px;display:block;background:#101d30;border-radius:10px" preserveAspectRatio="none" role="img" aria-label="' + esc(state.symbol) + ' reaaliaikainen kynttiläkaavio">', '<rect width="100%" height="100%" fill="#101d30"/>'];
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
    var sig = state.decision, gateReason = currentGateReason();
    if (sig && !gateReason && sig.direction !== "WAIT") {
      var sc = sig.direction === "BUY" ? '#28d7a0' : '#ff647c', txt = sig.direction === "BUY" ? "OSTA · SPOT" : "MYY / KEVENNÄ", yy2 = y(state.tradePrice || (state.live && state.live.close) || sig.entry);
      out.push('<line x1="' + l + '" y1="' + yy2.toFixed(1) + '" x2="' + (w - r) + '" y2="' + yy2.toFixed(1) + '" stroke="' + sc + '" stroke-width="2" stroke-dasharray="7 4"/>');
      out.push('<rect x="' + (w - r - 100) + '" y="' + Math.max(t, yy2 - 18).toFixed(1) + '" width="96" height="22" rx="8" fill="' + sc + '"/><text x="' + (w - r - 52) + '" y="' + Math.max(t + 15, yy2 - 3).toFixed(1) + '" text-anchor="middle" fill="#07111f" font-size="11" font-weight="900">' + txt + '</text>');
    }
    [0, Math.floor((d.length - 1) / 2), d.length - 1].forEach(function (k) { var dt = new Date(d[k].time), lab = dt.toLocaleString('fi-FI', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); out.push('<text x="' + x(k).toFixed(1) + '" y="' + (h - 12) + '" text-anchor="middle" fill="#a8bdd7" font-size="11">' + esc(lab) + '</text>'); });
    out.push('</svg>');
    target.innerHTML = out.join('');
    } catch (error) {
      console.error("Rahasampo live chart rendering failed:", error);
      target.innerHTML = '<div class="status error">Kaavion piirto epäonnistui: ' + esc(error && error.message ? error.message : String(error)) + '</div>';
      var meta = $("liveMeta");
      if (meta) meta.textContent = "Kaavion piirto epäonnistui. Tarkista selaimen konsolivirheet.";
    }
  }

  function updateMainMetrics() {
    var livePrice = state.tradePrice || (state.live && state.live.close);
    if (livePrice !== null && livePrice !== undefined) {
      var pe = $("price"); if (pe) pe.textContent = price(livePrice);
    }
    if (state.tickerChange !== null) {
      var ce = $("change"); if (ce) { ce.textContent = (state.tickerChange >= 0 ? "+" : "") + num(state.tickerChange, 2) + "%"; ce.className = state.tickerChange >= 0 ? "good" : "bad"; }
    }
    var decision = state.decision;
    var gateReason = currentGateReason();
    var sig = $("signal"), summary = $("summary"), passed = $("passed");
    var checklist = $("checklist"), timeframes = $("timeframes"), levels = $("levels");
    var riskPlan = $("riskPlan"), riskExample = $("riskExample"), timestamp = $("timestamp"), rsi = $("rsi"), adx = $("adx");

    if (!decision || !decision.main || !decision.main.bar) {
      if (sig) { sig.textContent = "ODOTA"; sig.className = "signal wait"; }
      if (summary) summary.textContent = "Uutta kaupankäyntipäätöstä ei ole laskettu: " + (state.decisionError || "markkinadata puuttuu.");
      if (passed) passed.textContent = "Tekniset ehdot — · data —";
      if (riskExample) riskExample.style.display = "none";
      if (checklist) checklist.textContent = "Tarkistuslista ei ole voimassa ilman tuoretta, täydellistä markkina-analyysiä.";
      if (timeframes) timeframes.textContent = "Aikavälivahvistusta ei ole saatavilla.";
      if (levels) levels.textContent = "Tukia, vastuksia tai indikaattoreita ei näytetä ilman vahvistettua dataa.";
      if (riskPlan) riskPlan.innerHTML = '<div class="signal wait">ODOTA</div><p>Uutta riskisuunnitelmaa ei ole käytettävissä.</p>';
      if (timestamp) timestamp.textContent = "Analyysiä ei päivitetty";
      if (rsi) rsi.textContent = "—";
      if (adx) adx.textContent = "—";
    } else {
      var bar = decision.main.bar;
      var direction = gateReason ? "WAIT" : decision.direction;
      if (sig) {
        sig.textContent = direction === "BUY" ? "OSTA · SPOT" :
          direction === "SELL" ? "MYY / KEVENNÄ" :
          gateReason ? "ODOTA · " + gateReason : "ODOTA";
        sig.className = "signal " + (direction === "BUY" ? "buy" : direction === "SELL" ? "sell" : "wait");
      }
      if (summary) summary.textContent = gateReason ? "SIGNAALI ESTETTY: " + gateReason :
        decision.reason + (decision.blockingReasons && decision.blockingReasons.length ? " Estävät ehdot: " + decision.blockingReasons.join(" · ") : "");
      if (passed) {
        var dataChecks = (decision.checklist || []).filter(function (x) { return x.group === "Data OK"; });
        var technicalChecks = (decision.checklist || []).filter(function (x) { return x.group !== "Data OK"; });
        passed.textContent = "Tekniset " + technicalChecks.filter(function (x) { return x.ok; }).length + " / " + technicalChecks.length + " · data " + dataChecks.filter(function (x) { return x.ok; }).length + " / " + dataChecks.length;
      }
      if (riskExample) riskExample.style.display = gateReason || direction === "WAIT" ? "none" : "block";
      if (rsi) rsi.textContent = num(bar.rsi, 1);
      if (adx) adx.textContent = num(bar.adx, 1);
      if (timestamp) timestamp.textContent = "Viimeisin suljettu kynttilä " + new Date(bar.closeTime).toLocaleString("fi-FI");
      if (checklist) checklist.innerHTML = (decision.checklist || []).map(function (item) {
        return '<div class="check"><span class="check-mark ' + (item.ok ? "yes" : "no") + '">' + (item.ok ? "✓" : "×") +
          '</span><span>' + esc(item.name) + (item.detail ? '<small class="sub" style="display:block;margin-top:3px">' + esc(item.detail) + '</small>' : "") + '</span></div>';
      }).join("");
      if (timeframes) {
        var rows = [{name:state.interval + " (valittu)",bias:decision.main.checks.bias}];
        var confirm4h = decision.higher && decision.higher[1];
        var confirm1d = decision.higher && decision.higher[2];
        if (state.interval !== "4h" && confirm4h) rows.push({name:"4 h (vahvistus)",bias:confirm4h.checks.bias});
        if (state.interval !== "1d" && confirm1d) rows.push({name:"1 d (vahvistus)",bias:confirm1d.checks.bias});
        timeframes.innerHTML = rows.map(function (item) {
          var label = item.bias === "bull" ? "NOUSU" : item.bias === "bear" ? "LASKU" : "EPÄSELVÄ";
          var cls = item.bias === "bull" ? "good" : item.bias === "bear" ? "bad" : "neutral";
          return '<div class="kv"><span>' + esc(item.name) + '</span><strong class="' + cls + '">' + label + '</strong></div>';
        }).join("");
      }
      if (levels) levels.innerHTML =
        '<div class="kv"><span>Tuki (30 edellistä suljettua kynttilää)</span><strong>' + price(decision.main.support) + '</strong></div>' +
        '<div class="kv"><span>Vastus (30 edellistä suljettua kynttilää)</span><strong>' + price(decision.main.resistance) + '</strong></div>' +
        '<div class="kv"><span>ATR (14)</span><strong>' + price(bar.atr) + '</strong></div>' +
        '<div class="kv"><span>Volyymi / 20 kynttilän keskiarvo</span><strong>' + num(bar.volumeRatio, 2) + "×</strong></div>" +
        '<div class="kv"><span>Markkinahinnan ikä</span><strong>' + num(Math.max(0, decision.priceAgeMs / 1000), 1) + " s</strong></div>";
      if (riskPlan) {
        if (gateReason || direction === "WAIT") {
          riskPlan.innerHTML = '<div class="signal wait">Ei kauppaa</div><p>' + esc(gateReason || "Kaikki hyväksytyt kaupankäyntiehdot eivät täyty.") + '</p><p class="sub">Positiota ei ehdoteta ODOTA-tilassa.</p>';
        } else if (direction === "BUY") {
          riskPlan.innerHTML = '<div class="signal buy">OSTA · SPOT</div>' +
            '<div class="kv"><span>Avaushinta (markkinahinta)</span><strong>' + price(decision.entry) + '</strong></div>' +
            '<div class="kv"><span>Stop-loss (arvio)</span><strong>' + price(decision.stop) + '</strong></div>' +
            '<div class="kv"><span>Tavoite (arvio)</span><strong>' + price(decision.target) + '</strong></div>' +
            '<div class="kv"><span>Arvioitu määrä</span><strong>' + num(decision.qty, 6) + '</strong></div>' +
            '<div class="kv"><span>Arvioitu riski</span><strong>' + num(decision.estimatedLoss, 2) + ' USDT</strong></div>' +
            '<div class="kv"><span>Arvioitu tuotto</span><strong>' + num(decision.estimatedGain, 2) + ' USDT</strong></div>';
        } else {
          riskPlan.innerHTML = '<div class="signal sell">MYY / KEVENNÄ · SPOT</div><p>Myynti koskee vain jo omistamaasi omaisuutta. Sovellus ei avaa short-positiota eikä keksi myytävää määrää.</p>' +
            '<div class="kv"><span>Viitehinta</span><strong>' + price(decision.entry) + '</strong></div>' +
            '<div class="kv"><span>Stop-taso (arvio)</span><strong>' + price(decision.stop) + '</strong></div>' +
            '<div class="kv"><span>Tavoitetaso (arvio)</span><strong>' + price(decision.target) + '</strong></div>';
        }
      }
    }
    var sp = $("spread");
    if (sp) {
      var validBook = Number.isFinite(state.bid) && Number.isFinite(state.ask) && state.bid > 0 && state.ask >= state.bid;
      sp.textContent = validBook ? num((state.ask - state.bid) / ((state.ask + state.bid) / 2) * 100, 4) + "%" : "—";
    }
  }

  function updateUi(scores) {
    injectUi();
    var displayScores = {};
    ["1m", "3m", "5m", "15m"].forEach(function (tf) { displayScores[tf] = gatedScore(scores[tf]); });
    $("liveScalpCards").innerHTML = ["1m", "3m", "5m", "15m"].map(function (tf) { return cardHtml(tf, displayScores[tf]); }).join("");
    var age = state.lastTradeAt ? Math.max(0, (Date.now() - state.lastTradeAt) / 1000) : Infinity;
    var gateReason = currentGateReason();
    $("liveState").textContent = gateReason ? "SIGNAALI ESTETTY" : age < 3 ? (state.tradeSource === "WEBSOCKET" ? "● LIVE · WS" : "● LIVE · REST-varayhteys") : "YHTEYS HILJAINEN";
    $("liveState").className = "pill " + (!gateReason && age < 3 ? "good" : "bad");
    var validBook = Number.isFinite(state.bid) && Number.isFinite(state.ask) && state.bid > 0 && state.ask >= state.bid;
    $("liveMeta").textContent = "Hinta " + price(state.tradePrice || state.live && state.live.close) + " USDT · bid " + price(state.bid) + " · ask " + price(state.ask) + " · spread " + (validBook ? num((state.ask - state.bid) / ((state.ask + state.bid) / 2) * 100, 4) + "%" : "—") + " · kynttiläsnapshot " + (Number.isFinite(state.snapshotCloseTime) ? new Date(state.snapshotCloseTime).toLocaleTimeString("fi-FI") : "odottaa dataa") + " · hinta " + state.tradeSource + " · order book " + state.bookSource + " · kauppatapahtumia " + state.trades + " · WS-uudelleenyhdistämisiä " + state.reconnects + (state.restError ? " · REST-varoitus: " + state.restError : "") + (gateReason ? " · SIGNAALIT ESTETTY: " + gateReason : " · dataportti OK");
    updateMainMetrics();
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
    var symbol = state.symbol, selectedInterval = state.interval;
    var scalpTimeframes = ["1m", "3m", "5m", "15m"];
    var allTimeframes = Array.from(new Set(scalpTimeframes.concat([selectedInterval, "1h", "4h", "1d"])));
    var fetched = await Promise.all(allTimeframes.map(async function (tf) {
      try { return { tf: tf, bars: await getBars(tf, symbol), error: null }; }
      catch (error) { return { tf: tf, bars: null, error: error }; }
    }));
    if (symbol !== state.symbol || selectedInterval !== state.interval) return;
    var byTimeframe = {};
    fetched.forEach(function (item) { byTimeframe[item.tf] = item; });

    // Short-term cards show technical direction only, never trading instructions.
    var latestScalpCloses = scalpTimeframes.map(function (tf) {
      var item = byTimeframe[tf];
      return item && item.bars && item.bars.length ? item.bars[item.bars.length - 1].closeTime : NaN;
    }).filter(Number.isFinite);
    var scalpSnapshot = latestScalpCloses.length ? Math.min.apply(null, latestScalpCloses) : NaN;
    var scores = {};
    scalpTimeframes.forEach(function (tf) {
      var item = byTimeframe[tf];
      if (!item || !item.bars || !Number.isFinite(scalpSnapshot)) { scores[tf] = null; return; }
      var aligned = item.bars.filter(function (bar) { return bar.closeTime <= scalpSnapshot; });
      scores[tf] = aligned.length >= 60 ? scoreFor(aligned, state.tradePrice) : null;
      if (tf === "1m") state.bars = item.bars;
    });

    // The main dashboard decision always comes from the canonical 14-check engine.
    try {
      var mainItem = byTimeframe[selectedInterval];
      if (!mainItem || !mainItem.bars || mainItem.bars.length < 220) {
        throw new Error("Valitulta aikaväliltä ei saatu 220 kelvollista sulkeutunutta kynttilää.");
      }
      var mainCloseTime = mainItem.bars[mainItem.bars.length - 1].closeTime;
      var mainBars = mainItem.bars.filter(function (bar) { return bar.closeTime <= mainCloseTime; });
      var higher = ["1h", "4h", "1d"].map(function (tf) {
        var item = byTimeframe[tf];
        if (!item || !item.bars) throw new Error(tf + "-vahvistusdata puuttuu.");
        var aligned = item.bars.filter(function (bar) { return bar.closeTime <= mainCloseTime; });
        if (aligned.length < 220) throw new Error(tf + "-vahvistukseen tarvitaan vähintään 220 sulkeutunutta kynttilää.");
        return TradingEngine.analyzeSeries(aligned);
      });
      var tickerAndBook = await Promise.all([
        fetchMarketJson("ticker24hr", symbol),
        fetchMarketJson("bookTicker", symbol)
      ]);
      if (symbol !== state.symbol || selectedInterval !== state.interval) return;
      var ticker = tickerAndBook[0], book = tickerAndBook[1];
      var marketPrice = n(ticker && ticker.lastPrice), closeTime = n(ticker && ticker.closeTime);
      var bid = n(book && book.bidPrice), ask = n(book && book.askPrice);
      if (marketPrice === null || marketPrice <= 0 || closeTime === null ||
          bid === null || ask === null || bid <= 0 || ask < bid) {
        throw new Error("Binancen reaaliaikainen hinta tai order book ei ole kelvollinen.");
      }
      var options = {
        capital: Math.max(0, n($("capital") && $("capital").value) || 0),
        riskPct: n($("riskPct") && $("riskPct").value) || 0.5,
        maxExposurePct: n($("exposurePct") && $("exposurePct").value) || 25,
        feePct: Math.max(0, n($("feePct") && $("feePct").value) || 0),
        slippagePct: Math.max(0, n($("slippagePct") && $("slippagePct").value) || 0)
      };
      var main = TradingEngine.analyzeSeries(mainBars);
      state.decision = TradingEngine.evaluateSignal(main, higher, {
        price: marketPrice, closeTime: closeTime, bid: bid, ask: ask
      }, options);
      state.decisionError = null;
      state.snapshotCloseTime = mainCloseTime;
    } catch (error) {
      state.decision = null;
      state.decisionError = error && error.message ? error.message : "Täydellistä reaaliaikaista analyysiä ei voitu laskea.";
    }
    if (symbol !== state.symbol || selectedInterval !== state.interval) return;
    state.lastScores = scores;
    updateUi(scores);
    renderLiveChart();
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
        if (d.e === "trade") { state.tradePrice = n(d.p); state.lastTradeAt = Date.now(); state.tradeSource = "WEBSOCKET"; state.trades++; }
        // Binance bookTicker stream payloads may omit the event-type field; identify them by bid/ask fields too.
        if (d.e === "bookTicker" || (d.s === state.symbol && d.b != null && d.a != null && d.B != null && d.A != null && d.p == null)) {
          var bid = n(d.b), ask = n(d.a);
          if (bid !== null && ask !== null && bid > 0 && ask >= bid) {
            state.bid = bid; state.ask = ask; state.lastBookAt = Date.now(); state.bookSource = "WEBSOCKET";
          }
        }
        if (d.e === "kline") { var k = d.k; var candle = { time: n(k.t), closeTime: n(k.T), open: n(k.o), high: n(k.h), low: n(k.l), close: n(k.c), volume: n(k.v) }; if (k.i === "1m") state.live = candle; if (k.i === state.interval) state.chartLive = candle; }
        var quick = scoreFor(state.bars, state.tradePrice);
        state.lastScores = Object.assign({}, state.lastScores || {}, { "1m": quick });
        updateUi(state.lastScores);
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
    refreshRestFallback();
    setInterval(refreshRestFallback, 2000);
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
