/* Live signal freshness guard. Market data only; no execution or exchange orders. */
(function (root) {
  "use strict";

  var MAX_TRADE_AGE_MS = 5000;
  var MAX_BOOK_AGE_MS = 3000;
  var MAX_SPREAD_PCT = 0.15;

  function gateReason(state, nowMs) {
    var now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (!state || !Number.isFinite(state.tradePrice) || state.tradePrice <= 0) {
      return "Viimeisin WebSocket-kauppahinta puuttuu";
    }
    if (!Number.isFinite(state.lastTradeAt) || state.lastTradeAt <= 0) {
      return "Odotetaan ensimmäistä WebSocket-kauppatapahtumaa";
    }
    var tradeAge = now - state.lastTradeAt;
    if (!Number.isFinite(tradeAge) || tradeAge < 0 || tradeAge > MAX_TRADE_AGE_MS) {
      return "WebSocket-kauppahinta vanhentunut";
    }
    if (!Number.isFinite(state.bid) || !Number.isFinite(state.ask) ||
        state.bid <= 0 || state.ask <= 0 || state.ask < state.bid) {
      return "Tuore ostotarjous/myyntitarjous puuttuu tai on virheellinen";
    }
    if (!Number.isFinite(state.lastBookAt) || state.lastBookAt <= 0) {
      return "Odotetaan tuoretta order book -tarjousta";
    }
    var bookAge = now - state.lastBookAt;
    if (!Number.isFinite(bookAge) || bookAge < 0 || bookAge > MAX_BOOK_AGE_MS) {
      return "Osto-/myyntitarjous vanhentunut";
    }
    var midpoint = (state.bid + state.ask) / 2;
    if (!(midpoint > 0)) return "Osto-/myyntihajontaa ei voi validoida";
    var spreadPct = (state.ask - state.bid) / midpoint * 100;
    if (!Number.isFinite(spreadPct) || spreadPct > MAX_SPREAD_PCT) {
      return "Osto-/myyntihajonta ylittää 0,15 %";
    }
    return null;
  }

  function apply(signal, state, nowMs) {
    if (!signal) return null;
    var reason = gateReason(state, nowMs);
    var result = Object.assign({}, signal, {
      gateReason: reason,
      actionable: !reason && signal.side !== "WAIT"
    });
    if (reason) result.side = "WAIT";
    return result;
  }

  var api = {
    gateReason: gateReason,
    apply: apply,
    limits: Object.freeze({
      tradeAgeMs: MAX_TRADE_AGE_MS,
      bookAgeMs: MAX_BOOK_AGE_MS,
      spreadPct: MAX_SPREAD_PCT
    })
  };
  root.LiveSignalGuards = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof window !== "undefined" ? window : globalThis);
