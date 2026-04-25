# -*- coding: utf-8 -*-

from datetime import datetime
import requests
import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import streamlit as st


# =========================================================
# AI TRADING PRO V24 — DESKTOP PRO
# =========================================================
# Opetustyökalu. Ei tee oikeita kauppoja eikä ole sijoitusneuvo.
# =========================================================


st.set_page_config(
    page_title="AI Trading Pro v24",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown("""
<style>
.block-container {padding-top:0.35rem;padding-left:1rem;padding-right:1rem;}
h1 {font-size:1.55rem!important;}
.signal{
    border-radius:18px;
    padding:18px;
    font-size:31px;
    font-weight:900;
    text-align:center;
    margin:10px 0 14px 0;
}
.buy{background:linear-gradient(90deg,#15803d,#22c55e);color:white;}
.quickbuy{background:linear-gradient(90deg,#064e3b,#10b981);color:white;}
.sell{background:linear-gradient(90deg,#991b1b,#ef4444);color:white;}
.quicksell{background:linear-gradient(90deg,#7f1d1d,#dc2626);color:white;}
.watchbuy{background:linear-gradient(90deg,#dcfce7,#86efac);color:#052e16;}
.watchsell{background:linear-gradient(90deg,#fee2e2,#fca5a5);color:#450a0a;}
.wait{background:linear-gradient(90deg,#facc15,#ca8a04);color:#111827;}
.notrade{background:linear-gradient(90deg,#334155,#94a3b8);color:white;}
.card{
    background:#111936;
    border:1px solid #26345e;
    border-radius:16px;
    padding:16px;
    color:white;
    margin-bottom:12px;
}
.good{color:#22c55e;font-weight:900;}
.bad{color:#ef4444;font-weight:900;}
.warn{color:#facc15;font-weight:900;}
.small{font-size:0.9rem;color:#cbd5e1;}
</style>
""", unsafe_allow_html=True)


SYMBOLS = {
    "BTC / USDT": "BTCUSDT",
    "ETH / USDT": "ETHUSDT",
    "SOL / USDT": "SOLUSDT",
    "BNB / USDT": "BNBUSDT",
    "XRP / USDT": "XRPUSDT",
    "DOGE / USDT": "DOGEUSDT",
}

ENTRY_INTERVALS = ["1m", "3m", "5m", "15m"]


def init_state():
    defaults = {
        "chart_df": None,
        "chart_key": "",
        "last_signal": "ODOTA",
        "last_score": 0,
        "last_data_error": "",
        "show_ema": True,
        "show_vwap": True,
        "show_levels": True,
        "show_bollinger": False,
        "show_macd_rsi": True,
        "show_volume": True,
        "live_on": True,
        "signals_memory": [],
    }
    for k, v in defaults.items():
        if k not in st.session_state:
            st.session_state[k] = v


init_state()


# =========================================================
# SIDEBAR
# =========================================================

st.sidebar.title("⚙️ AI Trading Pro v24")
selected_name = st.sidebar.selectbox("Kohde", list(SYMBOLS.keys()), index=0)
symbol = SYMBOLS[selected_name]

entry_tf = st.sidebar.radio("Entry-aikaväli", ENTRY_INTERVALS, index=0)
refresh_seconds = st.sidebar.radio("Live-päivitys", [1, 2, 3, 5, 10], index=1)
candle_limit = st.sidebar.slider("Kynttilöitä kaaviossa", 100, 400, 220, 10)

st.sidebar.divider()
st.session_state.show_ema = st.sidebar.checkbox("EMA9/21/50/100", value=st.session_state.show_ema)
st.session_state.show_vwap = st.sidebar.checkbox("VWAP", value=st.session_state.show_vwap)
st.session_state.show_levels = st.sidebar.checkbox("Support / Resistance", value=st.session_state.show_levels)
st.session_state.show_bollinger = st.sidebar.checkbox("Bollinger", value=st.session_state.show_bollinger)
st.session_state.show_macd_rsi = st.sidebar.checkbox("MACD + RSI", value=st.session_state.show_macd_rsi)
st.session_state.show_volume = st.sidebar.checkbox("Volyymi", value=st.session_state.show_volume)
st.session_state.live_on = st.sidebar.toggle("Live päällä", value=st.session_state.live_on)

if st.sidebar.button("🔄 Resetoi data"):
    st.session_state.chart_df = None
    st.session_state.last_signal = "ODOTA"
    st.session_state.last_score = 0
    st.session_state.last_data_error = ""
    st.rerun()

if st.sidebar.button("🧠 Tyhjennä AI-muisti"):
    st.session_state.signals_memory = []
    st.rerun()


current_key = f"{symbol}_{entry_tf}_{candle_limit}"
if st.session_state.chart_key != current_key:
    st.session_state.chart_key = current_key
    st.session_state.chart_df = None
    st.session_state.last_signal = "ODOTA"
    st.session_state.last_score = 0
    st.session_state.last_data_error = ""


# =========================================================
# DATA
# =========================================================

@st.cache_data(ttl=1, show_spinner=False)
def get_klines(symbol_code, interval_code, limit_count):
    base_urls = [
        "https://data-api.binance.vision",
        "https://api.binance.com",
        "https://api1.binance.com",
        "https://api2.binance.com",
        "https://api3.binance.com",
        "https://api4.binance.com",
    ]

    last_error = ""

    for base_url in base_urls:
        try:
            url = f"{base_url}/api/v3/klines"
            params = {
                "symbol": symbol_code,
                "interval": interval_code,
                "limit": int(limit_count),
            }

            r = requests.get(
                url,
                params=params,
                timeout=8,
                headers={"User-Agent": "Mozilla/5.0", "Accept": "application/json"},
            )

            if r.status_code != 200:
                last_error = f"{base_url} {r.status_code}: {r.text[:120]}"
                continue

            raw = r.json()
            if not isinstance(raw, list) or len(raw) == 0:
                last_error = f"{base_url}: tyhjä data"
                continue

            rows = []
            for k in raw:
                rows.append({
                    "Date": pd.to_datetime(k[0], unit="ms", utc=True),
                    "Open": float(k[1]),
                    "High": float(k[2]),
                    "Low": float(k[3]),
                    "Close": float(k[4]),
                    "Volume": float(k[5]),
                })

            return pd.DataFrame(rows).set_index("Date")

        except Exception as e:
            last_error = str(e)

    raise RuntimeError(f"Binance-dataa ei saatu: {last_error}")


def make_demo_data(limit_count, base_price):
    now = pd.Timestamp.utcnow().floor("min")
    idx = pd.date_range(end=now, periods=limit_count, freq="min")
    price = float(base_price)
    rows = []

    for _ in idx:
        o = price
        price *= 1 + np.random.normal(0, 0.0012)
        c = price
        h = max(o, c) * (1 + abs(np.random.normal(0, 0.0008)))
        l = min(o, c) * (1 - abs(np.random.normal(0, 0.0008)))
        v = abs(np.random.normal(100, 25))
        rows.append([o, h, l, c, v])

    return pd.DataFrame(rows, index=idx, columns=["Open", "High", "Low", "Close", "Volume"])


def load_or_update_chart_data():
    try:
        if st.session_state.chart_df is None:
            st.session_state.chart_df = get_klines(symbol, entry_tf, max(candle_limit + 220, 420))
            st.session_state.last_data_error = ""
            return "Binance live OHLC"

        latest = get_klines(symbol, entry_tf, 5)
        combined = pd.concat([st.session_state.chart_df, latest])
        combined = combined[~combined.index.duplicated(keep="last")]
        combined = combined.sort_index()
        combined = combined.tail(max(candle_limit + 220, 420))

        st.session_state.chart_df = combined
        st.session_state.last_data_error = ""
        return "Binance live OHLC"

    except Exception as e:
        st.session_state.last_data_error = str(e)

        if st.session_state.chart_df is None or len(st.session_state.chart_df) < 100:
            base = 78000 if "BTC" in symbol else 3500
            st.session_state.chart_df = make_demo_data(max(candle_limit + 220, 420), base)
            return "Demo-varadata"

        return "Vanha data käytössä"


# =========================================================
# INDICATORS
# =========================================================

def rsi(close, period=14):
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return (100 - (100 / (1 + rs))).fillna(50).clip(0, 100)


def add_indicators(df):
    df = df.copy()

    df["EMA9"] = df["Close"].ewm(span=9, adjust=False).mean()
    df["EMA21"] = df["Close"].ewm(span=21, adjust=False).mean()
    df["EMA50"] = df["Close"].ewm(span=50, adjust=False).mean()
    df["EMA100"] = df["Close"].ewm(span=100, adjust=False).mean()

    df["RSI"] = rsi(df["Close"])

    ema12 = df["Close"].ewm(span=12, adjust=False).mean()
    ema26 = df["Close"].ewm(span=26, adjust=False).mean()
    df["MACD"] = ema12 - ema26
    df["MACD_SIGNAL"] = df["MACD"].ewm(span=9, adjust=False).mean()
    df["MACD_HIST"] = df["MACD"] - df["MACD_SIGNAL"]

    tr1 = df["High"] - df["Low"]
    tr2 = (df["High"] - df["Close"].shift()).abs()
    tr3 = (df["Low"] - df["Close"].shift()).abs()
    df["ATR"] = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1).rolling(14, min_periods=5).mean()
    df["ATR"] = df["ATR"].fillna(tr1.mean())

    df["VOL_MA"] = df["Volume"].rolling(20, min_periods=5).mean()

    typical = (df["High"] + df["Low"] + df["Close"]) / 3
    volume_sum = df["Volume"].replace(0, np.nan).cumsum()
    df["VWAP"] = (typical * df["Volume"]).cumsum() / volume_sum
    df["VWAP"] = df["VWAP"].ffill().bfill()

    df["SMA20"] = df["Close"].rolling(20, min_periods=5).mean()
    df["STD20"] = df["Close"].rolling(20, min_periods=5).std().fillna(0)
    df["BB_UPPER"] = df["SMA20"] + 2 * df["STD20"]
    df["BB_LOWER"] = df["SMA20"] - 2 * df["STD20"]

    return df


# =========================================================
# MARKET CONTEXT
# =========================================================

def trend_of(df):
    last = df.iloc[-1]
    price = float(last.Close)

    if price > last.EMA50 and last.EMA50 > last.EMA100:
        return "NOUSU"
    if price < last.EMA50 and last.EMA50 < last.EMA100:
        return "LASKU"
    return "EPÄSELVÄ"


@st.cache_data(ttl=15, show_spinner=False)
def higher_timeframe_bias_cached(symbol_code):
    details = {}

    for tf in ["5m", "15m", "1h", "4h"]:
        try:
            raw = get_klines(symbol_code, tf, 180)
            df = add_indicators(raw)
            closed = df.iloc[:-1].copy() if len(df) > 30 else df.copy()
            details[tf] = trend_of(closed)
        except Exception:
            details[tf] = "?"

    bull = sum(1 for v in details.values() if v == "NOUSU")
    bear = sum(1 for v in details.values() if v == "LASKU")

    if bull >= 3:
        return "VAHVA NOUSU", details
    if bear >= 3:
        return "VAHVA LASKU", details
    if bull >= 2:
        return "NOUSU", details
    if bear >= 2:
        return "LASKU", details
    return "EPÄSELVÄ", details


def support_resistance(df, lookback=120):
    recent = df.tail(lookback)
    support = float(recent["Low"].quantile(0.08))
    resistance = float(recent["High"].quantile(0.92))
    midpoint = float(recent["Close"].median())
    return support, resistance, midpoint


def market_structure(df, lookback=40):
    recent = df.tail(lookback)
    highs = recent["High"]
    lows = recent["Low"]

    last_high = highs.iloc[-1]
    prev_high = highs.iloc[:-1].max()
    last_low = lows.iloc[-1]
    prev_low = lows.iloc[:-1].min()

    close = recent["Close"].iloc[-1]
    close_prev = recent["Close"].iloc[-6]

    if close > close_prev and last_high >= prev_high * 0.999:
        return "HH / nousurakenne"
    if close < close_prev and last_low <= prev_low * 1.001:
        return "LL / laskurakenne"
    if close > close_prev:
        return "nouseva korjaus"
    if close < close_prev:
        return "laskeva korjaus"
    return "sivuttaisrakenne"


def is_range_market(df):
    recent = df.tail(45)
    price = float(df.Close.iloc[-1])
    range_pct = (recent.High.max() - recent.Low.min()) / price
    ema_spread = abs(df.EMA50.iloc[-1] - df.EMA100.iloc[-1]) / price
    return range_pct < 0.0045 and ema_spread < 0.0022


# =========================================================
# PATTERNS
# =========================================================

def candle_power_scale(df_live):
    c = df_live.iloc[-1]
    body = abs(c.Close - c.Open)
    rng = max(c.High - c.Low, 1e-9)
    body_ratio = body / rng

    if c.Close > c.Open:
        side = "BUYERS"
        if body_ratio > 0.80:
            return side, 1, "Ostajat täysin kontrollissa"
        if body_ratio > 0.60:
            return side, 2, "Ostajat vahvoja"
        if body_ratio > 0.40:
            return side, 3, "Ostajat niskan päällä"
        if body_ratio > 0.22:
            return side, 4, "Ostajat hieman vahvempia"
        return side, 5, "Epäröinti, mutta vihreä"

    if c.Close < c.Open:
        side = "SELLERS"
        if body_ratio > 0.80:
            return side, 1, "Myyjät täysin kontrollissa"
        if body_ratio > 0.60:
            return side, 2, "Myyjät vahvoja"
        if body_ratio > 0.40:
            return side, 3, "Myyjät niskan päällä"
        if body_ratio > 0.22:
            return side, 4, "Myyjät hieman vahvempia"
        return side, 5, "Epäröinti, mutta punainen"

    return "NEUTRAL", 6, "Tasapaino / doji"


def candle_patterns(df):
    score = 0
    found = []

    if len(df) < 6:
        return score, found

    c = df.iloc[-1]
    p = df.iloc[-2]
    p2 = df.iloc[-3]

    def green(x): return x.Close > x.Open
    def red(x): return x.Close < x.Open
    def body(x): return abs(x.Close - x.Open)
    def rng(x): return max(x.High - x.Low, 1e-9)
    def upper(x): return x.High - max(x.Open, x.Close)
    def lower(x): return min(x.Open, x.Close) - x.Low

    if body(c) / rng(c) < 0.10:
        found.append("Doji / epäröinti")

    if body(c) / rng(c) < 0.18 and lower(c) > rng(c) * 0.55 and upper(c) < rng(c) * 0.20:
        score += 10
        found.append("Dragonfly Doji / bullish käännös")

    if body(c) / rng(c) < 0.18 and upper(c) > rng(c) * 0.55 and lower(c) < rng(c) * 0.20:
        score -= 10
        found.append("Gravestone Doji / bearish käännös")

    if lower(c) > body(c) * 2.0 and green(c):
        score += 12
        found.append("Hammer / ostajat puolustivat pohjaa")

    if upper(c) > body(c) * 2.0 and red(c):
        score -= 12
        found.append("Shooting Star / myyjät torjuivat nousun")

    if red(p) and green(c) and c.Close > p.Open and c.Open < p.Close:
        score += 18
        found.append("Bullish Engulfing")

    if green(p) and red(c) and c.Close < p.Open and c.Open > p.Close:
        score -= 18
        found.append("Bearish Engulfing")

    if red(p) and green(c) and c.Open > p.Close and c.Close < p.Open:
        score += 9
        found.append("Bullish Harami")

    if green(p) and red(c) and c.Open < p.Close and c.Close > p.Open:
        score -= 9
        found.append("Bearish Harami")

    if green(c) and body(c) / rng(c) > 0.82:
        score += 15
        found.append("Bullish Marubozu / vahva ostokynttilä")

    if red(c) and body(c) / rng(c) > 0.82:
        score -= 15
        found.append("Bearish Marubozu / vahva myyntikynttilä")

    if red(p2) and body(p) / rng(p) < 0.30 and green(c) and c.Close > ((p2.Open + p2.Close) / 2):
        score += 20
        found.append("Morning Star / bullish reversal")

    if green(p2) and body(p) / rng(p) < 0.30 and red(c) and c.Close < ((p2.Open + p2.Close) / 2):
        score -= 20
        found.append("Evening Star / bearish reversal")

    last3 = df.tail(3)
    if all(last3["Close"] > last3["Open"]) and last3["Close"].is_monotonic_increasing:
        score += 18
        found.append("Three White Soldiers / bullish continuation")

    if all(last3["Close"] < last3["Open"]) and last3["Close"].is_monotonic_decreasing:
        score -= 18
        found.append("Three Black Crows / bearish continuation")

    if abs(c.Low - p.Low) / max(c.Close, 1e-9) < 0.001 and green(c):
        score += 8
        found.append("Tweezer Bottom -tyyppinen tuki")

    if abs(c.High - p.High) / max(c.Close, 1e-9) < 0.001 and red(c):
        score -= 8
        found.append("Tweezer Top -tyyppinen vastus")

    return score, found


def smart_money_logic(df):
    score = 0
    notes = []

    if len(df) < 30:
        return score, notes

    c = df.iloc[-1]
    p = df.iloc[-2]

    prior = df.iloc[-25:-1]
    recent_high = prior["High"].max()
    recent_low = prior["Low"].min()

    if c.Low < recent_low and c.Close > p.Close:
        score += 16
        notes.append("Liquidity sweep alhaalla → ostajat aktivoitu")

    if c.High > recent_high and c.Close < p.Close:
        score -= 16
        notes.append("Liquidity sweep ylhäällä → myyjät aktivoitu")

    if p.Close < recent_high and c.Close > recent_high:
        score += 12
        notes.append("Breakout ylös")

    if p.Close > recent_low and c.Close < recent_low:
        score -= 12
        notes.append("Breakout alas")

    if c.High > recent_high and c.Close < recent_high:
        score -= 12
        notes.append("Fake breakout ylhäällä / trap")

    if c.Low < recent_low and c.Close > recent_low:
        score += 12
        notes.append("Fake breakdown alhaalla / trap")

    if len(df) > 4:
        c2 = df.iloc[-3]
        if c2.High < c.Low:
            score += 8
            notes.append("Bullish FVG / fair value gap")

        if c2.Low > c.High:
            score -= 8
            notes.append("Bearish FVG / fair value gap")

    return score, notes


def live_reaction_score(df_live):
    if len(df_live) < 30:
        return 0, "EI", []

    c = df_live.iloc[-1]
    prior = df_live.iloc[:-1]
    price = float(c.Close)

    body = abs(c.Close - c.Open)
    atr = max(float(df_live.ATR.iloc[-2]), price * 0.001)
    vol_ma = max(float(df_live.VOL_MA.iloc[-2]), 1e-9)

    red = c.Close < c.Open
    green = c.Close > c.Open

    strong_body = body > atr * 0.45
    very_strong_body = body > atr * 0.75
    volume_boost = c.Volume > vol_ma * 1.15

    new_lower_low = c.Low < prior.Low.tail(8).min()
    new_higher_high = c.High > prior.High.tail(8).max()

    score = 0
    notes = []

    if red and strong_body:
        score -= 18
        notes.append("Live-punainen kynttilä on vahva.")
    if red and very_strong_body:
        score -= 12
        notes.append("Live-punainen body on erittäin iso suhteessa ATR:ään.")
    if red and price < c.EMA9:
        score -= 8
        notes.append("Live-hinta putosi EMA9 alle.")
    if red and price < c.EMA21:
        score -= 8
        notes.append("Live-hinta putosi EMA21 alle.")
    if red and new_lower_low:
        score -= 10
        notes.append("Live teki uuden alemman low’n.")
    if red and volume_boost:
        score -= 8
        notes.append("Punaisessa liikkeessä volyymi kasvaa.")

    if green and strong_body:
        score += 18
        notes.append("Live-vihreä kynttilä on vahva.")
    if green and very_strong_body:
        score += 12
        notes.append("Live-vihreä body on erittäin iso suhteessa ATR:ään.")
    if green and price > c.EMA9:
        score += 8
        notes.append("Live-hinta nousi EMA9 yli.")
    if green and price > c.EMA21:
        score += 8
        notes.append("Live-hinta nousi EMA21 yli.")
    if green and new_higher_high:
        score += 10
        notes.append("Live teki uuden korkeamman high’n.")
    if green and volume_boost:
        score += 8
        notes.append("Vihreässä liikkeessä volyymi kasvaa.")

    if score <= -34:
        return score, "NOPEA MYY-VAROITUS", notes
    if score >= 34:
        return score, "NOPEA OSTA-VAROITUS", notes

    return score, "EI", notes


# =========================================================
# AI ENGINE
# =========================================================

def raw_signal_from_score(score):
    if score >= 55:
        return "VAHVA OSTA"
    if score >= 36:
        return "OSTA"
    if score >= 18:
        return "TARKKAILU OSTA"
    if score <= -55:
        return "VAHVA MYY"
    if score <= -36:
        return "MYY"
    if score <= -18:
        return "TARKKAILU MYY"
    return "ODOTA"


def apply_signal_hysteresis(raw_level, score):
    last = st.session_state.last_signal
    last_score = st.session_state.last_score

    if raw_level == "ODOTA" and last != "ODOTA" and abs(score) >= 12:
        return last

    if "OSTA" in last and "MYY" in raw_level and score > -30:
        return last

    if "MYY" in last and "OSTA" in raw_level and score < 30:
        return last

    if abs(score - last_score) < 6 and last != "ODOTA":
        return last

    return raw_level


def ai_engine(df_closed, df_live, big_bias, details):
    last = df_closed.iloc[-1]
    prev = df_closed.iloc[-2]
    live = df_live.iloc[-1]

    price = float(live.Close)
    score = 0
    reasons = []

    support, resistance, midpoint = support_resistance(df_closed)
    structure = market_structure(df_closed)
    range_market = is_range_market(df_closed)

    # Multi-timeframe
    if big_bias == "VAHVA NOUSU":
        score += 18
        reasons.append("Moniaikaväli: vahva nousu.")
    elif big_bias == "NOUSU":
        score += 12
        reasons.append("Moniaikaväli: nousu.")
    elif big_bias == "VAHVA LASKU":
        score -= 18
        reasons.append("Moniaikaväli: vahva lasku.")
    elif big_bias == "LASKU":
        score -= 12
        reasons.append("Moniaikaväli: lasku.")
    else:
        reasons.append("Moniaikaväli: epäselvä.")

    # Market structure
    if "nousu" in structure or "HH" in structure:
        score += 8
        reasons.append(f"Rakenne: {structure}")
    elif "lasku" in structure or "LL" in structure:
        score -= 8
        reasons.append(f"Rakenne: {structure}")
    else:
        reasons.append(f"Rakenne: {structure}")

    # EMA
    if prev.EMA50 <= prev.EMA100 and last.EMA50 > last.EMA100:
        score += 22
        reasons.append("Golden Cross: EMA50 ylitti EMA100:n.")

    if prev.EMA50 >= prev.EMA100 and last.EMA50 < last.EMA100:
        score -= 22
        reasons.append("Death Cross: EMA50 alitti EMA100:n.")

    if price > last.EMA50 > last.EMA100:
        score += 14
        reasons.append("Hinta EMA50/EMA100 yläpuolella.")

    if price < last.EMA50 < last.EMA100:
        score -= 14
        reasons.append("Hinta EMA50/EMA100 alapuolella.")

    if price > last.EMA9 > last.EMA21:
        score += 8
        reasons.append("Nopea EMA9/21 bullish.")

    if price < last.EMA9 < last.EMA21:
        score -= 8
        reasons.append("Nopea EMA9/21 bearish.")

    # VWAP
    if price > last.VWAP:
        score += 7
        reasons.append("Hinta VWAP yläpuolella.")
    else:
        score -= 7
        reasons.append("Hinta VWAP alapuolella.")

    # Support / resistance
    if price > resistance * 0.998:
        score += 8
        reasons.append("Hinta lähellä vastusta / breakout-mahdollisuus.")
    if price < support * 1.002:
        score -= 8
        reasons.append("Hinta lähellä tukea / breakdown-riski.")

    # RSI
    if last.RSI < 30:
        score += 10
        reasons.append(f"RSI {last.RSI:.1f}: ylimyyty.")
    elif last.RSI > 70:
        score -= 10
        reasons.append(f"RSI {last.RSI:.1f}: yliostettu.")
    else:
        reasons.append(f"RSI {last.RSI:.1f}: neutraali.")

    # MACD
    if last.MACD > last.MACD_SIGNAL and last.MACD_HIST > 0:
        score += 10
        reasons.append("MACD bullish.")
    if last.MACD < last.MACD_SIGNAL and last.MACD_HIST < 0:
        score -= 10
        reasons.append("MACD bearish.")

    # Volume
    if last.Volume > last.VOL_MA * 1.25:
        score *= 1.08
        reasons.append("Volyymi normaalia suurempi.")

    # Candles
    pattern_score, pattern_notes = candle_patterns(df_closed)
    score += pattern_score
    reasons.extend(pattern_notes)

    # Smart money
    sm_score, sm_notes = smart_money_logic(df_closed)
    score += sm_score
    reasons.extend(sm_notes)

    # Candle power
    power_side, power_level, power_text = candle_power_scale(df_live)
    reasons.append(f"Candle strength {power_level}: {power_text}")

    # Live reaction
    live_score, live_alert, live_notes = live_reaction_score(df_live)
    score += live_score * 0.55
    reasons.extend(live_notes)

    # Filters
    no_trade = False
    if range_market:
        score *= 0.62
        no_trade = True
        reasons.append("NO TRADE FILTER: markkina on sivuttaisessa rangessa.")

    if big_bias in ["VAHVA NOUSU", "NOUSU"] and score < -28:
        score *= 0.65
        reasons.append("Myynti isoa nousutrendiä vastaan: varmuutta leikataan.")

    if big_bias in ["VAHVA LASKU", "LASKU"] and score > 28:
        score *= 0.65
        reasons.append("Osto isoa laskutrendiä vastaan: varmuutta leikataan.")

    final_score = int(max(-100, min(100, score)))

    raw_level = raw_signal_from_score(final_score)
    level = apply_signal_hysteresis(raw_level, final_score)

    if no_trade and abs(final_score) < 42:
        level = "EI TREIDIÄ"

    if live_alert == "NOPEA MYY-VAROITUS" and final_score <= -12:
        level = "NOPEA MYY-VAROITUS"

    if live_alert == "NOPEA OSTA-VAROITUS" and final_score >= 12:
        level = "NOPEA OSTA-VAROITUS"

    if "OSTA" in level:
        direction = "OSTA"
    elif "MYY" in level:
        direction = "MYY"
    else:
        direction = "ODOTA"

    st.session_state.last_signal = level
    st.session_state.last_score = final_score

    confidence = int(min(94, max(45, 50 + abs(final_score) * 0.42)))

    atr = max(float(last.ATR), price * 0.001)

    if direction == "OSTA":
        stop = price - atr * 1.35
        target = price + atr * 2.4
    elif direction == "MYY":
        stop = price + atr * 1.35
        target = price - atr * 2.4
    else:
        stop = None
        target = None

    risk_reward = None
    if stop is not None and target is not None:
        risk = abs(price - stop)
        reward = abs(target - price)
        risk_reward = reward / risk if risk > 0 else None

    return {
        "level": level,
        "direction": direction,
        "score": final_score,
        "confidence": confidence,
        "price": price,
        "support": support,
        "resistance": resistance,
        "midpoint": midpoint,
        "stop": stop,
        "target": target,
        "rr": risk_reward,
        "big_bias": big_bias,
        "details": details,
        "structure": structure,
        "power_side": power_side,
        "power_level": power_level,
        "power_text": power_text,
        "notes": reasons[:22],
    }


def remember_signal(ai):
    if ai["level"] in ["ODOTA", "EI TREIDIÄ"]:
        return

    memory = st.session_state.signals_memory
    if memory and memory[-1]["time"] == datetime.now().strftime("%H:%M"):
        return

    memory.append({
        "time": datetime.now().strftime("%H:%M"),
        "symbol": selected_name,
        "signal": ai["level"],
        "price": round(ai["price"], 6),
        "score": ai["score"],
        "confidence": ai["confidence"],
    })

    st.session_state.signals_memory = memory[-30:]


# =========================================================
# UI
# =========================================================

def signal_box(ai):
    level = ai["level"]
    conf = ai["confidence"]

    if level == "NOPEA OSTA-VAROITUS":
        cls, icon = "quickbuy", "⚡▲"
    elif level == "NOPEA MYY-VAROITUS":
        cls, icon = "quicksell", "⚡▼"
    elif level == "VAHVA OSTA":
        cls, icon = "buy", "▲"
    elif level == "OSTA":
        cls, icon = "buy", "▲"
    elif level == "TARKKAILU OSTA":
        cls, icon = "watchbuy", "▲"
    elif level == "VAHVA MYY":
        cls, icon = "sell", "▼"
    elif level == "MYY":
        cls, icon = "sell", "▼"
    elif level == "TARKKAILU MYY":
        cls, icon = "watchsell", "▼"
    elif level == "EI TREIDIÄ":
        cls, icon = "notrade", "■"
    else:
        cls, icon = "wait", "●"

    st.markdown(
        f'<div class="signal {cls}">{icon} {level}<br>{conf}%</div>',
        unsafe_allow_html=True,
    )


def draw_chart(df_live, ai):
    d = df_live.tail(candle_limit).copy()

    rows = 4 if st.session_state.show_macd_rsi and st.session_state.show_volume else 1
    row_heights = [0.58, 0.14, 0.14, 0.14] if rows == 4 else [1.0]

    fig = make_subplots(
        rows=rows,
        cols=1,
        shared_xaxes=True,
        vertical_spacing=0.025,
        row_heights=row_heights,
    )

    fig.add_trace(
        go.Candlestick(
            x=d.index,
            open=d.Open,
            high=d.High,
            low=d.Low,
            close=d.Close,
            name="Kynttilät",
            increasing_line_color="#00ff66",
            decreasing_line_color="#ff3344",
            increasing_fillcolor="#00ff66",
            decreasing_fillcolor="#ff3344",
            whiskerwidth=0.8,
        ),
        row=1,
        col=1,
    )

    if st.session_state.show_ema:
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA9, mode="lines", name="EMA9", line=dict(width=1.3, color="#38bdf8")), row=1, col=1)
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA21, mode="lines", name="EMA21", line=dict(width=1.3, color="#fb7185")), row=1, col=1)
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA50, mode="lines", name="EMA50", line=dict(width=2.2, color="#facc15")), row=1, col=1)
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA100, mode="lines", name="EMA100", line=dict(width=2.2, color="#c084fc")), row=1, col=1)

    if st.session_state.show_vwap:
        fig.add_trace(go.Scatter(x=d.index, y=d.VWAP, mode="lines", name="VWAP", line=dict(width=2.2, color="#22d3ee")), row=1, col=1)

    if st.session_state.show_bollinger:
        fig.add_trace(go.Scatter(x=d.index, y=d.BB_UPPER, mode="lines", name="BB ylä", line=dict(width=1, color="#94a3b8")), row=1, col=1)
        fig.add_trace(go.Scatter(x=d.index, y=d.BB_LOWER, mode="lines", name="BB ala", line=dict(width=1, color="#94a3b8")), row=1, col=1)

    if st.session_state.show_levels:
        fig.add_hline(y=ai["support"], line_dash="dot", line_color="#22c55e", row=1, col=1)
        fig.add_hline(y=ai["resistance"], line_dash="dot", line_color="#ef4444", row=1, col=1)
        fig.add_hline(y=ai["midpoint"], line_dash="dot", line_color="#64748b", row=1, col=1)

    fig.add_hline(y=ai["price"], line_dash="dash", line_color="#facc15", row=1, col=1)

    if ai["direction"] != "ODOTA" and ai["stop"] is not None and ai["target"] is not None:
        fig.add_hline(y=ai["stop"], line_dash="dash", line_color="#ef4444", row=1, col=1)
        fig.add_hline(y=ai["target"], line_dash="dash", line_color="#22c55e", row=1, col=1)

    if rows == 4:
        fig.add_trace(go.Bar(x=d.index, y=d.Volume, name="Volyymi"), row=2, col=1)
        fig.add_trace(go.Scatter(x=d.index, y=d.MACD, mode="lines", name="MACD", line=dict(width=1.5)), row=3, col=1)
        fig.add_trace(go.Scatter(x=d.index, y=d.MACD_SIGNAL, mode="lines", name="MACD Signal", line=dict(width=1.5)), row=3, col=1)
        fig.add_trace(go.Bar(x=d.index, y=d.MACD_HIST, name="MACD Hist"), row=3, col=1)
        fig.add_trace(go.Scatter(x=d.index, y=d.RSI, mode="lines", name="RSI", line=dict(width=2)), row=4, col=1)
        fig.add_hline(y=70, line_dash="dot", line_color="#ef4444", row=4, col=1)
        fig.add_hline(y=30, line_dash="dot", line_color="#22c55e", row=4, col=1)

    fig.update_layout(
        title=f"{selected_name} — V24 PRO LIVE",
        height=920 if rows == 4 else 680,
        template="plotly_dark",
        paper_bgcolor="#070d1c",
        plot_bgcolor="#070d1c",
        xaxis_rangeslider_visible=False,
        margin=dict(l=10, r=10, t=52, b=10),
        legend=dict(orientation="h", y=1.02, x=0),
        uirevision="desktop_v24",
    )

    fig.update_xaxes(rangeslider_visible=False)
    st.plotly_chart(fig, use_container_width=True, config={"scrollZoom": True, "responsive": True})


def render_app():
    source = load_or_update_chart_data()
    df_live = add_indicators(st.session_state.chart_df)
    df_closed = df_live.iloc[:-1].copy() if len(df_live) > 30 else df_live.copy()

    big_bias, details = higher_timeframe_bias_cached(symbol)
    ai = ai_engine(df_closed, df_live, big_bias, details)
    remember_signal(ai)

    st.title("📈 AI Trading Pro v24 PRO")

    m1, m2, m3, m4, m5, m6 = st.columns(6)
    m1.metric("Kohde", selected_name)
    m2.metric("Hinta", f"{ai['price']:,.4f}")
    m3.metric("AI-score", f"{ai['score']} / 100")
    m4.metric("Varmuus", f"{ai['confidence']}%")
    m5.metric("Candle power", f"{ai['power_side']} {ai['power_level']}")
    m6.metric("Trend", ai["big_bias"])

    st.caption(f"{source} | TF: {entry_tf} | Päivitetty: {datetime.now().strftime('%H:%M:%S')} | Live {refresh_seconds}s")

    if st.session_state.last_data_error:
        st.warning("Binance-haku ei juuri nyt onnistunut kaikista osoitteista. Käytetään vanhaa dataa tai demo-varadataa.")

    signal_box(ai)
    draw_chart(df_live, ai)

    left, middle, right = st.columns([1, 1, 1])

    with left:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("🎯 Entry / Stop / Target")
        st.write(f"Nykyhinta: **{ai['price']:,.4f}**")
        st.write(f"Support: **{ai['support']:,.4f}**")
        st.write(f"Resistance: **{ai['resistance']:,.4f}**")
        st.write(f"Rakenne: **{ai['structure']}**")

        if ai["direction"] != "ODOTA" and ai["stop"] is not None:
            st.write(f"Stop: **{ai['stop']:,.4f}**")
            st.write(f"Target: **{ai['target']:,.4f}**")
            if ai["rr"] is not None:
                st.write(f"Riski/tuotto: **1:{ai['rr']:.2f}**")
        else:
            st.write("Ei vielä selkeää entryä.")
        st.markdown("</div>", unsafe_allow_html=True)

    with middle:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("📊 Moniaikaväli")
        for tf, val in ai["details"].items():
            st.write(f"{tf}: **{val}**")
        st.write(f"Iso suunta: **{ai['big_bias']}**")
        st.write(f"Candle strength: **{ai['power_text']}**")
        st.markdown("</div>", unsafe_allow_html=True)

    with right:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("🧠 Miksi AI näyttää näin?")
        for n in ai["notes"]:
            st.write("• " + n)
        st.markdown("</div>", unsafe_allow_html=True)

    with st.expander("🧠 AI-muisti / viimeiset signaalit"):
        if st.session_state.signals_memory:
            mem_df = pd.DataFrame(st.session_state.signals_memory)
            st.dataframe(mem_df, use_container_width=True, hide_index=True)
        else:
            st.info("Ei vielä tallennettuja signaaleja.")

    with st.expander("📚 AI:n PRO-säännöt"):
        st.write("""
V24 käyttää:
- EMA9/21/50/100
- VWAP
- RSI
- MACD
- ATR
- volyymi
- support/resistance
- market structure
- liquidity sweep
- fake breakout / trap
- FVG
- candle strength 1–6
- Doji, Dragonfly, Gravestone, Hammer, Shooting Star
- Bullish/Bearish Engulfing
- Harami
- Marubozu
- Morning Star / Evening Star
- Three White Soldiers / Three Black Crows
- Tweezer Top / Bottom
- live reaction -kerros nopeisiin vihreisiin/punaisiin kynttilöihin
- no-trade filter sivuttaismarkkinaan
        """)

    st.warning("Opetustyökalu. Ei tee oikeita kauppoja eikä ole sijoitusneuvo.")


run_every = f"{refresh_seconds}s" if st.session_state.live_on else None


@st.fragment(run_every=run_every)
def live_fragment():
    render_app()


live_fragment()
