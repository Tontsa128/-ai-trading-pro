"use strict";

// Short-horizon PAPER research worker. No private API keys or order endpoints.
const fs = require("node:fs");
const path = require("node:path");
const { parseBinanceMessage, normalizeTickerQuote, isFreshQuote, WEBSOCKET_BASES, buildCombinedStreamUrl } = require("./market-feed");

const SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT"];
const INTERVAL_SECONDS = Number(process.env.FAST_INTERVAL_SECONDS || 5);
const SESSION_SECONDS = Number(process.env.FAST_SESSION_SECONDS || 240);
const FEE_PCT = 0.10;       // per side, deliberately conservative
const SLIPPAGE_PCT = 0.05;  // per side estimate
const MAX_QUOTE_AGE_MS = 5000;
const MAX_POSITION_PCT = 10;
const MAX_OPEN_POSITIONS = 3;
const MIN_EDGE_PCT = 0.35;  // Momentum filter only; not expected return or proof that costs are covered.
const STOP_PCT = 0.40;
const TARGET_PCT = 0.65;
const ROOT = path.resolve(__dirname, "..");
const DATA_DIR = path.join(ROOT, "data");
const STATE_PATH = path.join(DATA_DIR, "fast-paper-state-" + INTERVAL_SECONDS + "s.json");
const REPORT_PATH = path.join(DATA_DIR, "fast-paper-latest-" + INTERVAL_SECONDS + "s.json");
const REPORTS_DIR = path.join(DATA_DIR, "fast-reports", INTERVAL_SECONDS + "s");
const startedAt = Date.now();
const endAt = startedAt + SESSION_SECONDS * 1000;
const symbols = new Map();
let socket;
let endpointIndex = 0;
let tradeMessages = 0;
let reconnectTimer;
let stopTimer;
let quoteTimer;
let stopping = false;
let socketOpen = false;
let websocketConnectedAtEnd = false;
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
    cash: 1000, positions: {}, trades: [], sessions: [], lastSessionAt: null };
}
function readState() {
  if (!fs.existsSync(STATE_PATH)) return blankState();
  const s = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
  if (s.schema !== 1 || s.mode !== "paper" || !Number.isFinite(s.cash) ||
      !s.positions || !Array.isArray(s.trades) || !Array.isArray(s.sessions)) {
    throw new Error("Unsafe/invalid fast paper state; refusing to trade.");
  }
  return s;
}
const state = readState();
state.positions ||= {};
state.trades ||= [];
state.sessions ||= [];
state.initialCash ||= 1000;
const errors = [];
const events = [];
const barMs = INTERVAL_SECONDS * 1000;

async function json(url, timeoutMs = 8000) {
  const hosts = ["https://data-api.binance.vision", "https://api1.binance.com", "https://api.binance.com"];
  let last;
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
}
function bucket(ts) { return Math.floor(ts / barMs) * barMs; }
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
    b = { time, open: price, high: price, low: price, close: price, volume: qty };
    s.bars.push(b);
    if (s.bars.length > 401) s.bars.shift();
  } else {
    b.high = Math.max(b.high, price);
    b.low = Math.min(b.low, price);
    b.close = price;
    b.volume += qty;
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
    feesEstimate: p.entryFee + out.fee, pnl: out.pnl, returnPct: out.pnl / p.costBasis * 100,
    reason, durationSeconds: (time - Date.parse(p.entryTime)) / 1000 };
  state.trades.push(trade);
  events.push(trade);
  delete state.positions[s.symbol];
}
function onClosedBar(s, bar) {
  const closes = s.bars.filter(x => x.closeTime !== undefined).map(x => x.close);
  if (closes.length < 30) return;
  // Use the same full history for current and previous EMA values so rolling-window
  // re-seeding cannot create artificial crossovers at the 80-candle boundary.
  const fast = ema(closes, 9);
  const slow = ema(closes, 21);
  const priorCloses = closes.slice(0, -1);
  const prevFast = ema(priorCloses, 9);
  const prevSlow = ema(priorCloses, 21);
  const momentum = (closes[closes.length - 1] / closes[closes.length - 4] - 1) * 100;
  const spreadPct = s.bid > 0 && s.ask >= s.bid ? (s.ask - s.bid) / ((s.ask + s.bid) / 2) * 100 : null;
  const quoteFresh = isFreshQuote(s.lastQuoteAt, Date.now(), MAX_QUOTE_AGE_MS);
  const p = state.positions[s.symbol];
  if (p) {
    p.lastPrice = bar.close;
    if (bar.low <= p.stop) closePosition(s, "Stop-loss (bar touched; conservative)", Math.min(p.stop, bar.close), bar.closeTime);
    else if (bar.high >= p.target) closePosition(s, "Take-profit (bar touched)", p.target, bar.closeTime);
    else if (fast !== null && slow !== null && fast < slow && momentum < 0) closePosition(s, "EMA reversal + negative momentum", bar.close, bar.closeTime);
    return;
  }
  const crossUp = prevFast !== null && prevSlow !== null && prevFast <= prevSlow && fast > slow;
  const enoughEdge = momentum >= MIN_EDGE_PCT;
  const spreadOk = quoteFresh && spreadPct !== null && spreadPct <= 0.08;
  if (crossUp && enoughEdge && spreadOk && Object.keys(state.positions).length < MAX_OPEN_POSITIONS) {
    const equity = state.cash + Object.values(state.positions).reduce((a, x) => a + x.qty * (x.lastPrice || x.entry), 0);
    const budget = Math.min(state.cash, equity * MAX_POSITION_PCT / 100);
    const fill = (s.ask || bar.close) * (1 + SLIPPAGE_PCT / 100);
    const qty = budget / (fill * (1 + FEE_PCT / 100));
    const fee = fill * qty * FEE_PCT / 100;
    const costBasis = fill * qty + fee;
    if (qty > 0 && costBasis <= state.cash && Number.isFinite(fill)) {
      state.cash -= costBasis;
      // This decision is made only after the closed bar is observed; never timestamp the fill in the past.
      const entryTime = new Date(Math.max(Date.now(), bar.closeTime + 1)).toISOString();
      state.positions[s.symbol] = { qty, entry: fill, entryTime,
        costBasis, entryFee: fee, stop: fill * (1 - STOP_PCT / 100),
        target: fill * (1 + TARGET_PCT / 100), lastPrice: bar.close };
      const trade = { symbol: s.symbol, side: "PAPER_BUY", intervalSeconds: INTERVAL_SECONDS,
        entryTime, entry: fill, qty, costBasis, fee,
        stop: state.positions[s.symbol].stop, target: state.positions[s.symbol].target,
        reason: "5/15-second EMA cross + momentum; simulated only" };
      state.trades.push(trade); events.push(trade);
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
    tradeMessages += 1;
    addTrade(s, event.price, event.qty, event.time, "websocket");
  } else if (event.type === "bookTicker") {
    s.bid = event.bid;
    s.ask = event.ask;
    s.lastQuoteAt = now;
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
  const base = WEBSOCKET_BASES[endpointIndex % WEBSOCKET_BASES.length];
  lastWebSocketEndpoint = base;
  if (!websocketEndpointsTried.includes(base)) websocketEndpointsTried.push(base);
  let currentSocket;
  try { currentSocket = new WebSocket(buildCombinedStreamUrl(base, SYMBOLS)); }
  catch (error) {
    socketErrors += 1; consecutiveSocketFailures += 1; lastSocketFailureAt = new Date().toISOString();
    endpointIndex = (endpointIndex + 1) % WEBSOCKET_BASES.length;
    if (consecutiveSocketFailures >= WEBSOCKET_BASES.length) websocketDisabled = true;
    scheduleReconnect(); return;
  }
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
    endpointIndex = (endpointIndex + 1) % WEBSOCKET_BASES.length;
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
    if (!stopping && Date.now() < endAt && !websocketDisabled) {
      if (sawMarketMessage && !errorCounted) endpointIndex = (endpointIndex + 1) % WEBSOCKET_BASES.length;
      scheduleReconnect();
    }
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
        s.lastQuoteAt = now;
        restPolls += 1;
        s.lastUpdateAt = now;
        // REST quotes refresh reference price and bid/ask only; they never create trade candles.
        // Only genuine exchange trade events may advance the short-horizon strategy.
        s.lastPrice = q.price;
        s.lastFeed = s.lastTradeAt && now - s.lastTradeAt <= MAX_QUOTE_AGE_MS ? "websocket+restQuote" : "restQuoteOnly";
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
    if (!b) grouped.set(time, { time, open, high, low, close, volume, closeTime: time + barMs - 1 });
    else { b.high = Math.max(b.high, high); b.low = Math.min(b.low, low); b.close = close; b.volume += volume; }
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
  const feedMode = tradeMessages > 0
    ? "Binance public Spot trade WebSocket + REST bid/ask monitoring"
    : "REST quote-only fallback; no genuine trade events received";
  const reportErrors = errors.slice();
  if (restPollErrors > 0) reportErrors.push({ type: "rest-quote-polling", count: restPollErrors, lastError: lastRestError });
  const report = {
    schema: 2, mode: "paper", source: feedMode,
    intervalSeconds: INTERVAL_SECONDS, sessionStartedAt: new Date(startedAt).toISOString(),
    sessionEndedAt: new Date(now).toISOString(), requestedSessionSeconds: SESSION_SECONDS,
    feedStatus: {
      websocketConnectedAtEnd: websocketConnectedAtEnd, websocketMessages: socketMessages, websocketTradeMessages: tradeMessages,
      websocketErrors: socketErrors, consecutiveWebSocketFailures: consecutiveSocketFailures,
      websocketDisabled: websocketDisabled,
      websocketEndpointsTried: websocketEndpointsTried,
      lastWebSocketEndpoint: lastWebSocketEndpoint,
      lastConnectedWebSocketEndpoint: lastConnectedWebSocketEndpoint,
      lastWebSocketFailureAt: lastSocketFailureAt,
      lastWebSocketMessageAt: lastSocketMessageAt ? new Date(lastSocketMessageAt).toISOString() : null,
      restQuoteUpdates: restPolls, restQuoteErrors: restPollErrors, lastRestError
    },
    symbols: SYMBOLS.map(symbol => {
      const s = symbols.get(symbol);
      const lastUpdateAt = s?.lastUpdateAt || null;
      return { symbol, price: s?.lastPrice ?? null, bid: s?.bid ?? null, ask: s?.ask ?? null,
        spreadPct: s?.bid > 0 && s?.ask >= s?.bid ? (s.ask - s.bid) / ((s.ask + s.bid) / 2) * 100 : null,
        lastUpdateAt: lastUpdateAt ? new Date(lastUpdateAt).toISOString() : null,
        marketAgeMs: Number.isFinite(s?.lastTradeAt) ? Math.max(0, now - s.lastTradeAt) : null,
        updateAgeMs: lastUpdateAt ? Math.max(0, now - lastUpdateAt) : null,
        quoteAgeMs: Number.isFinite(s?.lastQuoteAt) ? Math.max(0, now - s.lastQuoteAt) : null,
        feed: s?.lastFeed || "seed-history-only",
        closedBars: s?.bars.filter(b => b.closeTime !== undefined).length || 0,
        position: state.positions[symbol] || null };
    }),
    portfolio: { initialCash: state.initialCash, cash: state.cash, equity: equity(), realizedPnl,
      openPositions: Object.keys(state.positions).length, positions: state.positions },
    sessionTrades: events, errors: reportErrors,
    notes: [
      "Paper trading only: no private API keys and no real exchange orders.",
      "Only genuine Binance public trade WebSocket events may create live 5/15-second bars or trigger strategy entries.",
      "REST ticker prices and bid/ask are reference/mark data only; they do not create synthetic candles or trading signals.",
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
    restQuoteErrors: restPollErrors, websocketDisabled: websocketDisabled,
    websocketEndpointsTried: websocketEndpointsTried, lastConnectedWebSocketEndpoint: lastConnectedWebSocketEndpoint,
    errors: report.errors.length, cash: state.cash,
    equity: report.portfolio.equity, realizedPnl, openPositions: report.portfolio.openPositions,
    feedMode: report.source }, null, 2));
}
async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const symbol of SYMBOLS) symbols.set(symbol, { symbol, bars: [], bid: null, ask: null, lastQuoteAt: null, lastPrice: null });
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
      websocketConnectedAtEnd = socketOpen;
      socketOpen = false;
      try { if (socket) socket.close(); } catch {}
      resolve();
    }, Math.max(1000, endAt - Date.now()));
  });
  writeReport();
  if (errors.length >= SYMBOLS.length) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
process.on("SIGINT", () => { stopping = true; clearTimeout(stopTimer); clearTimeout(reconnectTimer); websocketConnectedAtEnd = socketOpen; socketOpen = false; try { socket?.close(); } catch {} writeReport(); process.exit(130); });
