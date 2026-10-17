"use strict";
(function () {
  const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
  const BASES = [
    "wss://data-stream.binance.vision:443",
    "wss://stream.binance.com:443",
    "wss://stream.binance.com:9443"
  ];
  const MAX_PRICE_AGE_MS = 5000;
  const MAX_QUOTE_AGE_MS = 3000;
  const SOCKET_IDLE_TIMEOUT_MS = 15000;
  let socket = null;
  let reconnectTimer = null;
  let publishTimer = null;
  let watchdogTimer = null;
  let connectTimer = null;
  let stopped = false;
  let baseIndex = 0;
  let lastSocketMessageAt = null;
  let connectionErrors = 0;
  const state = new Map(SYMBOLS.map(symbol => [symbol, {
    symbol, price: null, bid: null, ask: null,
    priceExchangeTime: null, priceReceivedAt: null, quoteReceivedAt: null,
    connected: false, source: null
  }]));

  function ageMs(at, now = Date.now()) {
    if (!Number.isFinite(at) || at > now) return Infinity;
    return Math.max(0, now - at);
  }
  function isFresh(q, now = Date.now()) {
    return !!q && q.connected &&
      ageMs(q.priceReceivedAt, now) <= MAX_PRICE_AGE_MS &&
      ageMs(q.quoteReceivedAt, now) <= MAX_QUOTE_AGE_MS &&
      q.price > 0 && q.bid > 0 && q.ask >= q.bid;
  }
  function emit() {
    const snapshot = {};
    for (const [symbol, q] of state) {
      const now = Date.now();
      snapshot[symbol] = {
        ...q,
        fresh: isFresh(q, now),
        priceAgeMs: ageMs(q.priceReceivedAt, now),
        quoteAgeMs: ageMs(q.quoteReceivedAt, now),
        ageMs: Math.max(ageMs(q.priceReceivedAt, now), ageMs(q.quoteReceivedAt, now)),
        spreadPct: q.bid > 0 && q.ask >= q.bid
          ? (q.ask - q.bid) / ((q.ask + q.bid) / 2) * 100
          : NaN
      };
    }
    window.dispatchEvent(new CustomEvent("market-live-update", { detail: snapshot }));
  }
  function streamUrl(base) {
    const streams = SYMBOLS.flatMap(symbol => {
      const key = symbol.toLowerCase();
      return [key + "@trade", key + "@bookTicker"];
    });
    return base + "/stream?streams=" + streams.join("/");
  }
  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      baseIndex = (baseIndex + 1) % BASES.length;
      connect();
    }, Math.min(10000, 1000 * Math.max(1, connectionErrors)));
  }
  function disconnectCurrent() {
    const current = socket;
    socket = null;
    for (const q of state.values()) q.connected = false;
    if (connectTimer) clearTimeout(connectTimer);
    connectTimer = null;
    if (current) {
      try { current.onopen = current.onmessage = current.onerror = current.onclose = null; current.close(); } catch (_) {}
    }
  }
  function connect() {
    if (stopped) return;
    const base = BASES[baseIndex % BASES.length];
    try {
      const current = new WebSocket(streamUrl(base));
      socket = current;
      connectTimer = setTimeout(() => {
        if (socket === current && current.readyState !== WebSocket.OPEN && !stopped) {
          connectionErrors += 1;
          window.dispatchEvent(new CustomEvent("market-live-error", { detail: { endpoint: base, message: "WebSocket connection timed out" } }));
          disconnectCurrent();
          scheduleReconnect();
        }
      }, 10000);
      current.onopen = () => {
        if (socket !== current || stopped) return;
        connectionErrors = 0;
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        lastSocketMessageAt = Date.now();
        for (const q of state.values()) q.connected = true;
        window.dispatchEvent(new CustomEvent("market-live-open", { detail: { endpoint: base } }));
        emit();
      };
      current.onmessage = event => {
        if (socket !== current || stopped) return;
        let envelope;
        try { envelope = JSON.parse(event.data); } catch (_) { return; }
        const data = envelope && (envelope.data || envelope);
        if (!data || typeof data.s !== "string") return;
        const q = state.get(data.s.toUpperCase());
        if (!q) return;
        const now = Date.now();
        lastSocketMessageAt = now;
        if (data.e === "trade" || (data.p != null && data.T != null)) {
          const price = Number(data.p);
          const exchangeTime = Number(data.T);
          const quantity = Number(data.q);
          if (price > 0 && Number.isFinite(price) && Number.isFinite(exchangeTime) &&
              ageMs(exchangeTime, now) <= MAX_PRICE_AGE_MS &&
              (data.q == null || (Number.isFinite(quantity) && quantity >= 0))) {
            q.price = price;
            q.priceExchangeTime = exchangeTime;
            q.priceReceivedAt = now;
            q.source = "Binance Spot WebSocket";
          }
        }
        if (data.b != null && data.a != null) {
          const bid = Number(data.b), ask = Number(data.a);
          if (Number.isFinite(bid) && Number.isFinite(ask) && bid > 0 && ask >= bid) {
            q.bid = bid;
            q.ask = ask;
            q.quoteReceivedAt = now;
          }
        }
      };
      current.onerror = () => {
        if (socket !== current || stopped) return;
        connectionErrors += 1;
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        window.dispatchEvent(new CustomEvent("market-live-error", { detail: { endpoint: base } }));
        try { current.close(); } catch (_) {}
      };
      current.onclose = () => {
        if (socket !== current || stopped) return;
        socket = null;
        if (connectTimer) clearTimeout(connectTimer);
        connectTimer = null;
        for (const q of state.values()) q.connected = false;
        window.dispatchEvent(new CustomEvent("market-live-close", { detail: { endpoint: base } }));
        scheduleReconnect();
      };
    } catch (error) {
      connectionErrors += 1;
      window.dispatchEvent(new CustomEvent("market-live-error", { detail: { message: String(error) } }));
      scheduleReconnect();
    }
  }

  window.RahasampoLiveMarket = {
    symbols: SYMBOLS.slice(),
    get(symbol) {
      const q = state.get(String(symbol).toUpperCase());
      if (!q) return null;
      const now = Date.now();
      return {
        ...q,
        fresh: isFresh(q, now),
        priceAgeMs: ageMs(q.priceReceivedAt, now),
        quoteAgeMs: ageMs(q.quoteReceivedAt, now),
        ageMs: Math.max(ageMs(q.priceReceivedAt, now), ageMs(q.quoteReceivedAt, now)),
        spreadPct: q.bid > 0 && q.ask >= q.bid
          ? (q.ask - q.bid) / ((q.ask + q.bid) / 2) * 100
          : NaN
      };
    },
    isFresh(symbol) {
      return isFresh(state.get(String(symbol).toUpperCase()));
    },
    stop() {
      stopped = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (publishTimer) clearInterval(publishTimer);
      if (watchdogTimer) clearInterval(watchdogTimer);
      disconnectCurrent();
    }
  };

  connect();
  // Coalesce high-frequency exchange events into a predictable four UI updates per second.
  publishTimer = setInterval(emit, 250);
  // Detect half-open/stalled sockets as well as explicit close/error events.
  watchdogTimer = setInterval(() => {
    if (stopped || !socket || socket.readyState !== WebSocket.OPEN) return;
    if (lastSocketMessageAt != null && Date.now() - lastSocketMessageAt > SOCKET_IDLE_TIMEOUT_MS) {
      connectionErrors += 1;
      window.dispatchEvent(new CustomEvent("market-live-stale", { detail: { idleMs: Date.now() - lastSocketMessageAt } }));
      disconnectCurrent();
      scheduleReconnect();
    }
  }, 2000);
})();