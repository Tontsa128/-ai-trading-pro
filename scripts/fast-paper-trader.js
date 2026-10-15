"use strict";

// Short-horizon PAPER research worker. No private API keys or order endpoints.
const fs = require("node:fs");
const path = require("node:path");

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
const STATE_PATH = path.join(DATA_DIR, "fast-paper-state.json");
const REPORT_PATH = path.join(DATA_DIR, "fast-paper-latest.json");
const REPORTS_DIR = path.join(DATA_DIR, "fast-reports");
const startedAt = Date.now();
const endAt = startedAt + SESSION_SECONDS * 1000;
const symbols = new Map();
let socket;
let reconnectTimer;
let stopTimer;
let stopping = false;

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

async function json(url) {
  const hosts = ["https://data-api.binance.vision", "https://api1.binance.com", "https://api.binance.com"];
  let last;
  for (const host of hosts) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
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
function addTrade(s, price, qty, ts) {
  if (!(price > 0) || !(qty >= 0) || !Number.isFinite(ts)) return;
  const time = bucket(ts);
  let b = s.bars[s.bars.length - 1];
  if (!b || b.time !== time) {
    if (b && time > b.time) {
      s.bars.push({ ...b, closeTime: b.time + barMs - 1 });
      if (s.bars.length > 400) s.bars.shift();
      onClosedBar(s, s.bars[s.bars.length - 1]);
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
    else if (bar.high >= p.target) closePosition(s, "Take-profit (bar touched)", Math.max(p.target, bar.close), bar.closeTime);
    else if (fast !== null && slow !== null && fast < slow && momentum < 0) closePosition(s, "EMA reversal + negative momentum", bar.close, bar.closeTime);
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
    }
  }
}
function handleMessage(raw) {
  let msg;
  try { msg = JSON.parse(String(raw)); } catch { return; }
  const d = msg.data || msg;
  if (!d || !d.s) return;
  const s = symbols.get(d.s);
  if (!s) return;
  if (d.e === "trade" || (d.p && d.q && d.T)) addTrade(s, Number(d.p), Number(d.q), Number(d.T));
  else if (d.b && d.a) { s.bid = Number(d.b); s.ask = Number(d.a); }
}
function connect() {
  if (stopping || Date.now() >= endAt) return;
  const streams = SYMBOLS.flatMap(x => [x.toLowerCase() + "@trade", x.toLowerCase() + "@bookTicker"]);
  socket = new WebSocket("wss://stream.binance.com:9443/stream?streams=" + streams.join("/"));
  socket.addEventListener("message", e => handleMessage(e.data));
  socket.addEventListener("error", () => { try { socket.close(); } catch {} });
  socket.addEventListener("close", () => {
    if (!stopping && Date.now() < endAt) reconnectTimer = setTimeout(connect, 1500);
  });
}
async function seed(s) {
  const trades = await json("/api/v3/aggTrades?symbol=" + s.symbol + "&limit=1000");
  if (!Array.isArray(trades)) throw new Error("Invalid aggTrades response");
  for (const t of trades) addTrade(s, Number(t.p), Number(t.q), Number(t.T));
  // Discard the current unfinished bar but keep closed bars for indicator warm-up.
  const last = s.bars[s.bars.length - 1];
  if (last && last.closeTime === undefined) s.bars.pop();
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
  const report = {
    schema: 1, mode: "paper", source: "Binance public Spot WebSocket trade + bookTicker streams",
    intervalSeconds: INTERVAL_SECONDS, sessionStartedAt: new Date(startedAt).toISOString(),
    sessionEndedAt: new Date(now).toISOString(), requestedSessionSeconds: SESSION_SECONDS,
    symbols: SYMBOLS.map(symbol => {
      const s = symbols.get(symbol);
      return { symbol, price: s?.lastPrice ?? null, bid: s?.bid ?? null, ask: s?.ask ?? null,
        spreadPct: s?.bid > 0 && s?.ask >= s?.bid ? (s.ask - s.bid) / ((s.ask + s.bid) / 2) * 100 : null,
        closedBars: s?.bars.filter(b => b.closeTime !== undefined).length || 0,
        position: state.positions[symbol] || null };
    }),
    portfolio: { initialCash: state.initialCash, cash: state.cash, equity: equity(), realizedPnl,
      openPositions: Object.keys(state.positions).length, positions: state.positions },
    sessionTrades: events, errors,
    notes: [
      "Paper trading only: no private API keys and no real exchange orders.",
      "5/15-second bars are aggregated from public trade events; a session may end without any trades.",
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
    events: events.length, errors: errors.length, cash: state.cash, equity: report.portfolio.equity,
    realizedPnl, openPositions: report.portfolio.openPositions }, null, 2));
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
  await new Promise(resolve => {
    stopTimer = setTimeout(() => {
      stopping = true;
      clearTimeout(reconnectTimer);
      try { if (socket) socket.close(); } catch {}
      resolve();
    }, Math.max(1000, endAt - Date.now()));
  });
  writeReport();
  if (errors.length >= SYMBOLS.length) process.exitCode = 1;
}
main().catch(e => { console.error(e); process.exitCode = 1; });
process.on("SIGINT", () => { stopping = true; clearTimeout(stopTimer); clearTimeout(reconnectTimer); try { socket?.close(); } catch {} writeReport(); process.exit(130); });
