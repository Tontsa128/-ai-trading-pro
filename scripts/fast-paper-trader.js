"use strict";

// Short-horizon PAPER research worker. No private API keys or order endpoints.
const fs = require("node:fs");
const path = require("node:path");
const { parseBinanceMessage, normalizeTickerQuote, WEBSOCKET_BASES, buildCombinedStreamUrl } = require("./market-feed");

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
const INTERVAL_SECONDS = Number(process.env.FAST_INTERVAL_SECONDS || 5);
const SESSION_SECONDS = Number(process.env.FAST_SESSION_SECONDS || 240);
const FEE_PCT = 0.10;       // per side, deliberately conservative
const SLIPPAGE_PCT = 0.05;  // per side estimate
const MAX_POSITION_PCT = 10;
const MAX_OPEN_POSITIONS = 3;
const MIN_EDGE_PCT = 0.35;  // must clear estimated round-trip costs plus a small buffer
const STOP_PCT = 0.40;
const TARGET_PCT = 0.65;
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const STATE_PATH = path.join(DATA_DIR, "fast-paper-state-" + INTERVAL_SECONDS + "s.json");
const REPORT_PATH = path.join(DATA_DIR, "fast-paper-latest-" + INTERVAL_SECONDS + "s.json");
const REPORTS_DIR = path.join(DATA_DIR, "fast-reports", INTERVAL_SECONDS + "s");
const LEARNER_PATH = path.join(DATA_DIR, "learner-data.ndjson");
const MODEL_PATH = path.join(DATA_DIR, "learner-model.json");
const startedAt = Date.now();
const endAt = startedAt + SESSION_SECONDS * 1000;
const symbols = new Map();
let socket;
let reconnectTimer;
let stopTimer;
let quoteTimer;
let stopping = false;
let socketOpen = false;
let socketMessages = 0;
let socketErrors = 0;
let consecutiveSocketFailures = 0;
let websocketDisabled = false;
let lastSocketFailureAt = null;
let lastWebSocketEndpoint = null;
let lastConnectedWebSocketEndpoint = null;
const websocketEndpointsTried = [];
let restPolls = 0;
let restPollErrors = 0;
let lastSocketMessageAt = null;
let lastRestError = null;
let quotePollBusy = false;
let nonTradeBarsSkipped = 0;

if (![5, 15].includes(INTERVAL_SECONDS)) {
  console.error("FAST_INTERVAL_SECONDS must be 5 or 15.");
  process.exit(2);
}
if (!Number.isFinite(SESSION_SECONDS) || SESSION_SECONDS < 30 || SESSION_SECONDS > 300) {
  console.error("FAST_SESSION_SECONDS must be between 30 and 300 seconds.");
  process.exit(2);
}

function blankState() {
  return { schema: 1, mode: "paper", intervalSeconds: INTERVAL_SECONDS, initialCash: 1000,
    cash: 1000, positions: {}, trades: [], sessions: [], lastSessionAt: null, pendingExamples: {} };
}
function readState() {
  if (!fs.existsSync(STATE_PATH)) return blankState();
  const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  if (s.schema !== 1 || s.mode !== "paper" || !Number.isFinite(s.cash) ||
      !s.positions || !Array.isArray(s.trades) || !Array.isArray(s.sessions)) {
    throw new Error("Unsafe/invalid fast paper state; refusing to trade.");
  }
  s.pendingExamples = s.pendingExamples || {};
  return s;
}
const state = readState();
state.positions ||= {};
state.trades ||= [];
state.sessions ||= [];
state.initialCash ||= 1000;
state.pendingExamples ||= {};
const errors = [];
const events = [];
const barMs = INTERVAL_SECONDS * 1000;

// Append a labeled training example line to the learner NDJSON file safely.
function appendLearnerExample(example) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const line = JSON.stringify(example) + "\n";
    fs.appendFileSync(LEARNER_PATH, line, { encoding: "utf8" });
  } catch (e) {
    console.warn("Failed to append learner example:", e && e.message);
  }
}

function json(url, timeoutMs = 8000) {
  const hosts = ["https://data-api.binance.vision", "https://api1.binance.com", "https://api.binance.com"];
  let last;
  return (async () => {
    for (const host of hosts) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(host + url, { signal: controller.signal });
        clearTimeout(timeout);
        if (response.status === 418 || response.status === 429) throw new Error("Binance rate limit HTTP " + response.status);
        if (!response.ok) throw new Error("HTTP " + response.status + " from " + host + url);
        return await response.json();
      } catch (e) {
        clearTimeout(timeout); last = e;
        if (/rate limit/.test(String(e.message))) throw e;
      }
    }
    throw last || new Error("Market data unavailable");
  })();
}
function bucket(ts) { return Math.floor(ts / barMs) * barMs; }
function isEligibleEntryBar(bar) {
  return Boolean(bar && bar.hasTradeData === true && bar.hasRestFallback !== true &&
    Number.isFinite(bar.volume) && bar.volume > 0);
}
function hasCleanEntryHistory(bars, lookback = 81) {
  if (!Array.isArray(bars) || !Number.isInteger(lookback) || lookback < 1) return false;
  const closed = bars.filter(bar => bar && bar.closeTime !== undefined);
  return closed.length >= lookback && closed.slice(-lookback).every(isEligibleEntryBar);
}
function addTrade(s, price, qty, ts, feed = "websocket") {
  if (!(price > 0) || !(qty >= 0) || !Number.isFinite(ts)) return;
  const time = bucket(ts);
  let b = s.bars[s.bars.length - 1];
  if (b && time < b.time) return; // Ignore late/out-of-order events after reconnect.
  if (!b || b.time !== time) {
    if (b && time > b.time && b.closeTime === undefined) {
      b.closeTime = b.time + barMs - 1;
      onClosedBar(s, b);
    }
    b = { time, open: price, high: price, low: price, close: price, volume: qty,
        hasTradeData: feed === "websocket" && qty > 0, hasRestFallback: feed !== "websocket" };
    s.bars.push(b);
    if (s.bars.length > 401) s.bars.shift();
  } else {
    b.high = Math.max(b.high, price);
    b.low = Math.min(b.low, price);
    b.close = price;
    b.volume += qty;
    if (feed === "websocket" && qty > 0) b.hasTradeData = true;
    else if (feed !== "websocket") b.hasRestFallback = true;
  }
  s.lastPrice = price;
  s.lastUpdateAt = Date.now();
  s.lastFeed = feed;
  if (feed === "websocket") s.lastTradeAt = Date.now();
}
function ema(values, period) {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let out = values.slice(0, period).reduce((a, x) => a + x, 0) / period;
  for (let i = period; i < values.length; i++) out = values[i] * k + out * (1 - k);
  return out;
}
function pnlPosition(p, exit) {
  const fill = exit * (1 - SLIPPAGE_PCT / 100);
  const fee = fill * p.qty * FEE_PCT / 100;
  const proceeds = fill * p.qty - fee;
  return { fill, fee, proceeds, pnl: proceeds - p.costBasis };
}
function closePosition(s, reason, marketPrice, time) {
  const p = state.positions[s.symbol];
  if (!p) return;
  const out = pnlPosition(p, marketPrice);
  state.cash += out.proceeds;
  const trade = { symbol: s.symbol, side: "PAPER_SELL", intervalSeconds: INTERVAL_SECONDS,
    entryTime: p.entryTime, exitTime: new Date(time).toISOString(), entry: p.entry,
    exit: out.fill, qty: p.qty, costBasis: p.costBasis, proceeds: out.proceeds,
    feesEstimate: p.entryFee + out.fee, pnl: out.pnl, returnPct: out.pnl / p.costBasis * 100, reason, durationSeconds: (time - Date.parse(p.entryTime)) / 1000 };
  state.trades.push(trade);
  events.push(trade);

  // If there is a pending training example for this symbol, finalize it with the label computed from pnl.
  try {
    const pending = state.pendingExamples && state.pendingExamples[s.symbol];
    if (pending) {
      const label = out.pnl > 0 ? 1 : 0;
      const example = Object.assign({}, pending.features, { label: label, pnl: out.pnl, closedAt: new Date(time).toISOString() });
      appendLearnerExample(example);
      delete state.pendingExamples[s.symbol];
    }
  } catch (e) {
    console.warn("Failed to finalize training example:", e && e.message);
  }

  delete state.positions[s.symbol];
}
function onClosedBar(s, bar) {
  const closes = s.bars.filter(x => x.closeTime !== undefined).map(x => x.close);
  if (closes.length < 30) return;
  const fast = ema(closes.slice(-80), 9);
  const slow = ema(closes.slice(-80), 21);
  const prevFast = ema(closes.slice(-81, -1), 9);
  const prevSlow = ema(closes.slice(-81, -1), 21);
  const momentum = (closes[closes.length - 1] / closes[closes.length - 4] - 1) * 100;
  const spreadPct = s.bid > 0 && s.ask >= s.bid ? (s.ask - s.bid) / ((s.ask + s.bid) / 2) * 100 : null;
  const p = state.positions[s.symbol];
  if (p) {
    p.lastPrice = bar.close;
    if (bar.low <= p.stop) closePosition(s, "Stop-loss (bar touched; conservative)", Math.min(p.stop, bar.close), bar.closeTime);
    else if (bar.high >= p.target) closePosition(s, "Take-profit (bar touched)", p.target, bar.closeTime);
    else if (fast !== null && slow !== null && fast < slow && momentum < 0) closePosition(s, "EMA reversal + negative momentum", bar.close, bar.closeTime);
    return;
  }
  // REST samples can support monitoring, but cannot create valid 5s/15s entries.
  // Any candle containing REST samples is treated as degraded, even if one WS trade also arrived.
  // EMA(9/21) and momentum also consume recent prior candles. Reject a setup if
  // any candle in that entire lookback contains sampled REST prices or invalid volume.
  if (!isEligibleEntryBar(bar) || !hasCleanEntryHistory(s.bars, 81)) {
    nonTradeBarsSkipped += 1;
    return;
  }
  const crossUp = prevFast !== null && prevSlow !== null && prevFast <= prevSlow && fast > slow;
  const enoughEdge = momentum >= MIN_EDGE_PCT;
  const spreadOk = spreadPct !== null && spreadPct <= 0.08;
  if (crossUp && enoughEdge && spreadOk && Object.keys(state.positions).length < MAX_OPEN_POSITIONS) {
    const equity = state.cash + Object.values(state.positions).reduce((a, x) => a + x.qty * (x.lastPrice || x.entry), 0);
    const budget = Math.min(state.cash, equity * MAX_POSITION_PCT / 100);
    const fill = (s.ask || bar.close) * (1 + SLIPPAGE_PCT / 100);
    const qty = budget / (fill * (1 + FEE_PCT / 100));
    const fee = fill * qty * FEE_PCT / 100;
    const costBasis = fill * qty + fee;
    if (qty > 0 && costBasis <= state.cash && Number.isFinite(fill)) {
      state.cash -= costBasis;
      state.positions[s.symbol] = { qty, entry: fill, entryTime: new Date(bar.closeTime).toISOString(),
        costBasis, entryFee: fee, stop: fill * (1 - STOP_PCT / 100),
        target: fill * (1 + TARGET_PCT / 100), lastPrice: bar.close };
      const trade = { symbol: s.symbol, side: "PAPER_BUY", intervalSeconds: INTERVAL_SECONDS,
        entryTime: new Date(bar.closeTime).toISOString(), entry: fill, qty, costBasis, fee,
        stop: state.positions[s.symbol].stop, target: state.positions[s.symbol].target,
        reason: "5/15-second EMA cross + momentum; simulated only" };
      state.trades.push(trade); events.push(trade);

      // Create and persist a pending training example for this entry; it will be finalized when the position closes.
      try {
        const id = Date.now() + "-" + s.symbol + "-" + Math.floor(Math.random() * 100000);
        const features = {
          id: id,
          symbol: s.symbol,
          intervalSeconds: INTERVAL_SECONDS,
          entry: fill,
          fast: fast === null ? null : Number(fast.toFixed(8)),
          slow: slow === null ? null : Number(slow.toFixed(8)),
          fastMinusSlow: (fast !== null && slow !== null) ? Number((fast - slow).toFixed(8)) : null,
          momentum: Number(momentum.toFixed(6)),
          spreadPct: spreadPct === null ? null : Number(spreadPct.toFixed(6)),
          closedBars: s.bars.filter(x => x.closeTime !== undefined).length,
          createdAt: new Date().toISOString()
        };
        state.pendingExamples[s.symbol] = { id: id, features };
      } catch (e) {
        console.warn("Failed to create pending training example:", e && e.message);
      }
    }
  }
}
async function handleMessage(raw) {
  const event = parseBinanceMessage(raw);
  if (!event) return;
  const s = symbols.get(event.symbol);
  if (!s) return;
  const now = Date.now();
  socketMessages += 1;
  lastSocketMessageAt = now;
  if (event.type === "trade") {
    addTrade(s, event.price, event.qty, event.time, "websocket");
  } else if (event.type === "bookTicker") {
    s.bid = event.bid;
    s.ask = event.ask;
    s.lastUpdateAt = now;
    s.lastFeed = "websocket";
  }
}
function scheduleReconnect() {
  if (stopping || Date.now() >= endAt || websocketDisabled || reconnectTimer) return;
  if (consecutiveSocketFailures >= WEBSOCKET_BASES.length) {
    websocketDisabled = true;
    console.warn("Binance WebSocket failed three consecutive connections; REST live quotes remain active.");
    return;
  }
  const delayMs = Math.min(5000, 1000 * Math.max(1, consecutiveSocketFailures));
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delayMs);
}
function connect() {
  if (stopping || Date.now() >= endAt || websocketDisabled) return;
  const base = WEBSOCKET_BASES[consecutiveSocketFailures % WEBSOCKET_BASES.length];
  lastWebSocketEndpoint = base;
  if (!websocketEndpointsTried.includes(base)) websocketEndpointsTried.push(base);
  const currentSocket = new WebSocket(buildCombinedStreamUrl(base, SYMBOLS));
  socket = currentSocket;
  let errorCounted = false;
  let sawMarketMessage = false;
  function failConnection(reason) {
    if (errorCounted) return;
    errorCounted = true;
    socketErrors += 1;
    consecutiveSocketFailures += 1;
    lastSocketFailureAt = new Date().toISOString();
    socketOpen = false;
    console.warn("Binance WebSocket connection failure (" + consecutiveSocketFailures + "/" + WEBSOCKET_BASES.length + ") at " + base + ": " + reason);
    if (consecutiveSocketFailures >= WEBSOCKET_BASES.length) {
      websocketDisabled = true;
      console.warn("Binance WebSocket retries paused after all configured public endpoints failed; REST live quotes remain active.");
    }
    try { currentSocket.close(); } catch {}
    scheduleReconnect();
  }
  currentSocket.addEventListener("open", () => {
    if (socket === currentSocket) socketOpen = true;
    lastConnectedWebSocketEndpoint = base;
    console.log("Binance public market-data WebSocket connected: " + base);
  });
  currentSocket.addEventListener("message", e => {
    sawMarketMessage = true;
    consecutiveSocketFailures = 0;
    if (socket === currentSocket) socketOpen = true;
    handleMessage(e.data).catch(error => {
      socketErrors += 1;
      console.error("Unable to parse Binance WebSocket event:", String(error.message || error));
    });
  });
  currentSocket.addEventListener("error", () => {
    failConnection("WebSocket error event");
  });
  currentSocket.addEventListener("close", () => {
    if (socket === currentSocket) socketOpen = false;
    if (!sawMarketMessage && !errorCounted) {
      failConnection("socket closed before receiving market data");
      return;
    }
    if (!stopping && Date.now() < endAt && !websocketDisabled) scheduleReconnect();
  });
}
async function pollQuotes() {
  if (stopping || quotePollBusy || Date.now() >= endAt) return;
  quotePollBusy = true;
  try {
    await Promise.all([...symbols.values()].map(async s => {
      try {
        // A single-symbol 24h ticker includes last price and top-of-book bid/ask.
        const q = normalizeTickerQuote(await json("/api/v3/ticker/24hr?symbol=" + encodeURIComponent(s.symbol), 3500));
        const now = Date.now();
        if (!q) {
          restPollErrors += 1;
          lastRestError = "Binance quote contained invalid price or bid/ask values.";
          return;
        }
        s.bid = q.bid;
        s.ask = q.ask;
        restPolls += 1;
        s.lastUpdateAt = now;
        if (s.lastTradeAt && now - s.lastTradeAt <= 2500) {
          s.lastPrice = q.price;
          s.lastFeed = "websocket+restQuote";
        } else {
          // REST fallback advances a zero-volume sampled-price candle, never inventing trade volume.
          addTrade(s, q.price, 0, now, "restFallback");
        }
      } catch (error) {
        restPollErrors += 1;
        lastRestError = String(error.message || error);
      }
    }));
  } finally {
    quotePollBusy = false;
    if (!stopping && Date.now() < endAt) quoteTimer = setTimeout(pollQuotes, 2000);
  }
}
async function seed(s) {
  const rows = await json("/api/v3/klines?symbol=" + s.symbol + "&interval=1s&limit=1000");
  if (!Array.isArray(rows)) throw new Error("Invalid 1-second kline response");
  const grouped = new Map();
  for (const k of rows) {
    const ts = Number(k[0]), time = bucket(ts), closeTime = Number(k[6]);
    if (!Number.isFinite(ts) || closeTime >= Date.now() || time + barMs > Date.now()) continue;
    const open = Number(k[1]), high = Number(k[2]), low = Number(k[3]), close = Number(k[4]), volume = Number(k[5]);
    if (![open, high, low, close, volume].every(Number.isFinite) || Math.min(open, high, low, close) <= 0 || volume < 0) continue;
    const b = grouped.get(time);
    if (!b) grouped.set(time, { time, open, high, low, close, volume, closeTime: time + barMs - 1,
      hasTradeData: volume > 0, hasRestFallback: false });
    else {
      b.high = Math.max(b.high, high); b.low = Math.min(b.low, low); b.close = close; b.volume += volume;
      if (volume > 0) b.hasTradeData = true;
    }
  }
  s.bars = Array.from(grouped.values()).sort((a, b) => a.time - b.time).slice(-400);
  if (s.bars.length) s.lastPrice = s.bars[s.bars.length - 1].close;
}
function equity() {
  return state.cash + Object.entries(state.positions).reduce((sum, [symbol, p]) =>
    sum + p.qty * (symbols.get(symbol)?.lastPrice || p.lastPrice || p.entry), 0);
}
function writeReport() {
  fs.mkdirSync(DATA_DIR, { recursive: true }); fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const now = Date.now();
  for (const s of symbols.values()) {
    const p = state.positions[s.symbol];
    if (p && s.lastPrice) p.lastPrice = s.lastPrice;
  }
  const realizedPnl = state.trades.filter(t => Number.isFinite(t.pnl)).reduce((a, t) => a + t.pnl, 0);
  const feedMode = socketMessages > 0
    ? "Binance public Spot WebSocket + REST quote fallback"
    : "Binance public REST ticker fallback (no WebSocket market events received)";
  const reportErrors = errors.slice();
  if (restPollErrors > 0) reportErrors.push({ type: "rest-quote-polling", count: restPollErrors, lastError: lastRestError });
  const report = {
    schema: 2, mode: "paper", source: feedMode,
    intervalSeconds: INTERVAL_SECONDS, sessionStartedAt: new Date(startedAt).toISOString(),
    sessionEndedAt: new Date(now).toISOString(), requestedSessionSeconds: SESSION_SECONDS,
    feedStatus: {
      websocketConnectedAtEnd: socketOpen, websocketMessages: socketMessages,
      websocketErrors: socketErrors, consecutiveWebSocketFailures: consecutiveSocketFailures,
      websocketDisabled: websocketDisabled,
      websocketEndpointsTried: websocketEndpointsTried,
      lastWebSocketEndpoint: lastWebSocketEndpoint,
      lastConnectedWebSocketEndpoint: lastConnectedWebSocketEndpoint,
      lastWebSocketFailureAt: lastSocketFailureAt,
      lastWebSocketMessageAt: lastSocketMessageAt ? new Date(lastSocketMessageAt).toISOString() : null,
      restQuoteUpdates: restPolls, restQuoteErrors: restPollErrors, lastRestError,
      nonTradeBarsSkipped: nonTradeBarsSkipped
    },
    symbols: SYMBOLS.map(symbol => {
      const s = symbols.get(symbol);
      const lastUpdateAt = s?.lastUpdateAt || null;
      return { symbol, price: s?.lastPrice ?? null, bid: s?.bid ?? null, ask: s?.ask ?? null,
        spreadPct: s?.bid > 0 && s?.ask >= s?.bid ? (s.ask - s.bid) / ((s.ask + s.bid) / 2) * 100 : null,
        lastUpdateAt: lastUpdateAt ? new Date(lastUpdateAt).toISOString() : null,
        marketAgeMs: lastUpdateAt ? Math.max(0, now - lastUpdateAt) : null,
        feed: s?.lastFeed || "seed-history-only",
        closedBars: s?.bars.filter(b => b.closeTime !== undefined).length || 0,
        position: state.positions[symbol] || null };
    }),
    portfolio: { initialCash: state.initialCash, cash: state.cash, equity: equity(), realizedPnl,
      openPositions: Object.keys(state.positions).length, positions: state.positions },
    sessionTrades: events, errors: reportErrors,
    notes: [
      "Paper trading only: no private API keys and no real exchange orders.",
      "WebSocket events are preferred; REST ticker samples with zero synthetic volume are used only when symbol trade events are stale.",
      "New 5/15-second paper entries require a closed candle and a clean 81-candle trade-derived lookback. Historical exchange OHLCV candles may warm up indicators; REST ticker samples and any mixed-source lookback are rejected.",
      "REST fallback samples can help monitor an existing paper position, but do not count as trade-derived candles.",
      "5/15-second bars are aggregated from public trade events or sampled public REST prices when WS data is stale; sampled fallback volume is zero.",
      "Estimated fee 0.10% and slippage 0.05% per side; actual fills and costs can differ.",
      "The strategy is experimental, long-only, and not demonstrated profitable. Do not infer edge from a small sample.",
      "A 5-second/15-second strategy can lose to fees, spread, latency and adverse selection even when direction is correct."
    ]
  };
  const stamp = new Date(now).toISOString().replace(/[:.]/g, "-");
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + "\n");
  fs.writeFileSync(path.join(REPORTS_DIR, stamp + ".json"), JSON.stringify(report, null, 2) + "\n");
  state.sessions.push({ at: report.sessionStartedAt, endedAt: report.sessionEndedAt,
    intervalSeconds: INTERVAL_SECONDS, trades: events.length, errors: errors.length,
    equity: report.portfolio.equity, realizedPnl, openPositions: report.portfolio.openPositions });
  state.sessions = state.sessions.slice(-500);
  state.trades = state.trades.slice(-5000);
  state.lastSessionAt = report.sessionEndedAt;
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2) + "\n");
  console.log(JSON.stringify({ intervalSeconds: INTERVAL_SECONDS, symbols: SYMBOLS.length,
    paperTrades: events.length, websocketMessages: socketMessages, restQuoteUpdates: restPolls,
    restQuoteErrors: restPollErrors, websocketDisabled: websocketDisabled, nonTradeBarsSkipped: nonTradeBarsSkipped,
    websocketEndpointsTried: websocketEndpointsTried, lastConnectedWebSocketEndpoint: lastConnectedWebSocketEndpoint,
    errors: report.errors.length, cash: state.cash,
    equity: report.portfolio.equity, realizedPnl, openPositions: report.portfolio.openPositions,
    feedMode: report.source }, null, 2));
}
async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const symbol of SYMBOLS) symbols.set(symbol, { symbol, bars: [], bid: null, ask: null, lastPrice: null });
  for (const s of symbols.values()) {
    try { await seed(s); } catch (e) { errors.push({ symbol: s.symbol, error: String(e.message || e) }); }
  }
  if (![...symbols.values()].some(s => s.bars.length >= 30)) {
    throw new Error("Insufficient historical trade data to warm up the 5/15-second indicators.");
  }
  connect();
  // Poll immediately, then every 2s to keep prices and top-of-book current when WS is unavailable.
  void pollQuotes();
  await new Promise(resolve => {
    stopTimer = setTimeout(() => {
      stopping = true;
      clearTimeout(reconnectTimer);
      clearTimeout(quoteTimer);
      socketOpen = false;
      try { if (socket) socket.close(); } catch {}
      resolve();
    }, Math.max(1000, endAt - Date.now()));
  });
  writeReport();
  if (errors.length >= SYMBOLS.length) process.exitCode = 1;
}
if (require.main === module) {
  main().catch(e => { console.error(e); process.exitCode = 1; });
  process.on("SIGINT", () => { stopping = true; clearTimeout(stopTimer); clearTimeout(reconnectTimer); try { socket?.close(); } catch {} writeReport(); process.exit(130); });
}

module.exports = { isEligibleEntryBar, hasCleanEntryHistory };
