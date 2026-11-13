"use strict";

const { WS_URL, DEFAULT_MAX_AGE_MS, createWebSocketAuthMessage, createWebSocketSubscribeMessage, parseWebSocketMessage, parseWebSocketRateUpdates } = require("./etoro-market-feed");

/**
 * Managed eToro market-data socket.
 * Public instrument topics can be subscribed without credentials. If both keys
 * are supplied, Authenticate is sent before subscriptions. No private topic or
 * trading/order operation is supported.
 */
function createEtoroStream(options = {}) {
  const WebSocketImpl = options.WebSocket || globalThis.WebSocket;
  if (typeof WebSocketImpl !== "function") throw new Error("A WebSocket implementation is required.");
  const instrumentIds = options.instrumentIds;
  if (!Array.isArray(instrumentIds) || !instrumentIds.length ||
      instrumentIds.some(id => !Number.isSafeInteger(Number(id)) || Number(id) <= 0)) {
    throw new TypeError("Valid eToro instrument IDs are required.");
  }
  const apiKey = options.apiKey || process.env.ETORO_API_KEY;
  const userKey = options.userKey || process.env.ETORO_USER_KEY;
  const maxQuoteAgeMs = options.maxQuoteAgeMs == null ? DEFAULT_MAX_AGE_MS : Number(options.maxQuoteAgeMs);
  if (!Number.isFinite(maxQuoteAgeMs) || maxQuoteAgeMs < 0) throw new RangeError("Invalid eToro WebSocket quote age limit.");
  const instrumentIdSet = new Set(instrumentIds.map(Number));
  const latestQuoteByInstrument = new Map();
  if (Boolean(apiKey) !== Boolean(userKey)) throw new Error("Both eToro API credentials must be supplied together.");
  const url = options.url || WS_URL;
  if (url !== WS_URL && options.allowCustomUrl !== true) throw new Error("Only the official eToro WebSocket URL is allowed.");
  const onMessage = typeof options.onMessage === "function" ? options.onMessage : () => {};
  const onStatus = typeof options.onStatus === "function" ? options.onStatus : () => {};
  const onError = typeof options.onError === "function" ? options.onError : () => {};
  const schedule = options.setTimeout || setTimeout;
  const cancel = options.clearTimeout || clearTimeout;
  const maxReconnectDelayMs = options.maxReconnectDelayMs ?? 30000;
  const baseReconnectDelayMs = options.baseReconnectDelayMs ?? 1000;
  let socket = null, reconnectTimer = null, stopped = false, attempts = 0;

  function send(payload) {
    if (!socket || socket.readyState !== 1) throw new Error("eToro WebSocket is not open.");
    socket.send(JSON.stringify(payload));
  }

  function connect() {
    if (stopped) return;
    onStatus({ state: "CONNECTING", attempt: attempts });
    try { socket = new WebSocketImpl(url); }
    catch (error) { onError(error); scheduleReconnect(); return; }

    socket.onopen = () => {
      if (stopped) return socket.close();
      try {
        if (apiKey && userKey) send(createWebSocketAuthMessage(apiKey, userKey));
        send(createWebSocketSubscribeMessage(instrumentIds, true));
        onStatus({ state: "CONNECTED", authenticated: Boolean(apiKey), instrumentIds: [...instrumentIds] });
      } catch (error) {
        onError(error);
        socket.close();
      }
    };
    socket.onmessage = event => {
      const raw = event && event.data !== undefined ? event.data : event;
      const control = parseWebSocketMessage(raw);
      if (!control) return; // Includes eToro's binary heartbeat frame.
      if (control.success === false) {
        onError(new Error(control.errorMessage || control.errorCode || "eToro WebSocket request rejected."));
        return;
      }
      if (control.operation || control.success !== undefined) return; // Control acknowledgement.
      const quotes = parseWebSocketRateUpdates(raw, Date.now(), maxQuoteAgeMs);
      for (const quote of quotes) {
        if (!instrumentIdSet.has(quote.instrumentId)) continue;
        const previous = latestQuoteByInstrument.get(quote.instrumentId);
        // Do not let duplicate or older exchange timestamps overwrite a newer quote.
        if (previous && quote.timestamp <= previous.timestamp) continue;
        latestQuoteByInstrument.set(quote.instrumentId, quote);
        attempts = 0; // A validated fresh quote proves the connection is healthy.
        onMessage(quote);
      }
    };
    socket.onerror = event => onError(event instanceof Error ? event : new Error("eToro WebSocket transport error."));
    socket.onclose = () => {
      socket = null;
      if (!stopped) scheduleReconnect();
      else onStatus({ state: "STOPPED" });
    };
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer !== null) return;
    attempts += 1;
    const delay = Math.min(maxReconnectDelayMs, baseReconnectDelayMs * (2 ** Math.min(attempts - 1, 10)));
    onStatus({ state: "RECONNECTING", attempt: attempts, delayMs: delay });
    reconnectTimer = schedule(() => { reconnectTimer = null; connect(); }, delay);
  }

  function start() {
    if (stopped) throw new Error("A stopped eToro stream cannot be restarted.");
    if (!socket && reconnectTimer === null) connect();
    return api;
  }

  function stop() {
    stopped = true;
    if (reconnectTimer !== null) { cancel(reconnectTimer); reconnectTimer = null; }
    if (socket) {
      const current = socket;
      socket = null;
      current.close();
    }
    onStatus({ state: "STOPPED" });
  }

  const api = Object.freeze({ start, stop, getState: () => ({
    state: stopped ? "STOPPED" : socket ? "CONNECTED_OR_CONNECTING" : reconnectTimer !== null ? "RECONNECTING" : "DISCONNECTED",
    reconnectAttempt: attempts
  }) });
  if (options.autoStart !== false) start();
  return api;
}

module.exports = { createEtoroStream };
