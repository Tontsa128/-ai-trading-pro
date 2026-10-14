# -*- coding: utf-8 -*-

from datetime import datetime
from zoneinfo import ZoneInfo
import time
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from rahasampo.data_quality import has_sufficient_timeframe_data, select_closed_candles, validate_ohlcv
from rahasampo.decision import classify_score
from rahasampo.cross_exchange import get_spot_price_check
from rahasampo.market_data import fetch_binance_klines


# ============================================================
# RAHASAMPO RADAR V27 PRO — RESEARCH PREVIEW
# Opetustyökalu / treidausavustaja.
# Ei sijoitusneuvo. Ei tee oikeita kauppoja.
# ============================================================

APP_TZ = "Europe/Helsinki"

st.set_page_config(
    page_title="Rahasampo Radar V27 PRO",
    page_icon="💰",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown("""
<style>
.block-container {padding-top:0.25rem;padding-left:0.8rem;padding-right:0.8rem;}
h1 {font-size:1.45rem!important;}
[data-testid="stMetricValue"] {font-size:1.15rem!important;}
.signal{
    border-radius:18px;
    padding:18px;
    font-size:34px;
    font-weight:900;
    text-align:center;
    margin:8px 0 12px 0;
    letter-spacing:0.5px;
}
.buy{background:linear-gradient(90deg,#047857,#22c55e);color:white;}
.sell{background:linear-gradient(90deg,#991b1b,#ef4444);color:white;}
.watchbuy{background:linear-gradient(90deg,#dcfce7,#86efac);color:#052e16;}
.watchsell{background:linear-gradient(90deg,#fee2e2,#fca5a5);color:#450a0a;}
.wait{background:linear-gradient(90deg,#facc15,#d97706);color:#111827;}
.notrade{background:linear-gradient(90deg,#334155,#94a3b8);color:white;}
.card{
    background:#111936;
    border:1px solid #26345e;
    border-radius:16px;
    padding:14px;
    color:white;
    margin-bottom:10px;
}
.good{color:#22c55e;font-weight:800;}
.bad{color:#ef4444;font-weight:800;}
.neutral{color:#facc15;font-weight:800;}
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

TIMEFRAMES = ["1m", "3m", "5m", "15m"]


def now_local():
    return datetime.now(ZoneInfo(APP_TZ)).strftime("%H:%M:%S")


def init_state():
    defaults = {
        "df": None,
        "key": "",
        "memory": [],
        "last_error": "",
        "last_level": "ODOTA",
        "last_score": 0,
        "cross_exchange_check": None,
    }
    for k, v in defaults.items():
        if k not in st.session_state:
            st.session_state[k] = v


init_state()


# ============================================================
# SIDEBAR
# ============================================================

st.sidebar.title("💰 Rahasampo Radar V27 PRO")

selected_name = st.sidebar.selectbox("Kohde", list(SYMBOLS.keys()), index=0)
symbol = SYMBOLS[selected_name]

tf = st.sidebar.radio("Aikaväli", TIMEFRAMES, index=0)
refresh = st.sidebar.radio("Live-päivitys", [2, 3, 5, 10], index=0)
candles = st.sidebar.slider("Kynttilöitä", 80, 300, 170, 10)

st.sidebar.divider()

show_fast = st.sidebar.checkbox("EMA9 / EMA21", True)
show_slow = st.sidebar.checkbox("EMA50 / EMA100", True)
show_vwap = st.sidebar.checkbox("VWAP (UTC-session, vain täydellä datalla)", False)
show_levels = st.sidebar.checkbox("Support / Resistance", True)
show_patterns = st.sidebar.checkbox("Pattern-merkinnät", True)
live_on = st.sidebar.toggle("Live päällä", True)

st.sidebar.divider()

if st.sidebar.button("🔄 Resetoi data"):
    st.session_state.df = None
    st.session_state.memory = []
    st.session_state.last_error = ""
    st.rerun()

new_key = f"{symbol}_{tf}_{candles}"
if st.session_state.key != new_key:
    st.session_state.key = new_key
    st.session_state.df = None
    st.session_state.last_error = ""


# ============================================================
# DATA
# ============================================================

LIVE_DATA_SOURCE = "Binance live OHLC + Bybit spot price cross-check"


@st.cache_data(ttl=5, show_spinner=False)
def cached_spot_price_check(symbol_code):
    """Cache public cross-exchange tickers briefly to avoid needless API load."""
    result = get_spot_price_check(symbol_code)
    return {
        "ok": result.ok,
        "primary_price": result.primary_price,
        "reference_price": result.reference_price,
        "deviation_pct": result.deviation_pct,
        "checked_at_utc": result.checked_at_utc,
        "message": result.message,
    }


@st.cache_data(ttl=2, show_spinner=False)
def get_klines(symbol_code, interval_code, limit_count):
    return fetch_binance_klines(
        symbol_code,
        interval_code,
        int(limit_count),
        timezone_name=APP_TZ,
        total_timeout_seconds=8.0,
        request_timeout_seconds=2.0,
    )


def load_data():
    """Fetch and validate live candles; cached data never powers live signals."""
    st.session_state.cross_exchange_check = None
    try:
        if st.session_state.df is None:
            candidate = get_klines(symbol, tf, max(candles + 230, 420))
        else:
            latest = get_klines(symbol, tf, 10)
            candidate = pd.concat([st.session_state.df, latest])
            candidate = candidate[~candidate.index.duplicated(keep="last")]
            candidate = candidate.sort_index().tail(max(candles + 230, 420))

        valid, errors = validate_ohlcv(candidate, timeframe=tf, min_rows=120)
        if not valid:
            raise RuntimeError("; ".join(errors))

        cross_check = cached_spot_price_check(symbol)
        st.session_state.cross_exchange_check = cross_check
        if not cross_check["ok"]:
            raise RuntimeError(cross_check["message"])

        st.session_state.df = candidate
        st.session_state.last_error = ""
        return candidate.copy(), LIVE_DATA_SOURCE

    except Exception as exc:
        st.session_state.last_error = str(exc)
        if st.session_state.df is not None:
            return st.session_state.df.copy(), "DATA FAIL — cached data only; signals disabled"
        return pd.DataFrame(columns=["Open", "High", "Low", "Close", "Volume"]), "DATA FAIL — no valid live data"


# ============================================================
# INDICATORS
# ============================================================

def rsi(close, period=14):
    """Wilder-style RSI with explicit all-gain/all-loss/flat edge cases."""
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    result = 100 - (100 / (1 + rs))
    result = result.mask((avg_loss == 0) & (avg_gain > 0), 100.0)
    result = result.mask((avg_gain == 0) & (avg_loss > 0), 0.0)
    result = result.mask((avg_gain == 0) & (avg_loss == 0), 50.0)
    return result.clip(0, 100)


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

    tr = pd.concat([
        df["High"] - df["Low"],
        (df["High"] - df["Close"].shift()).abs(),
        (df["Low"] - df["Close"].shift()).abs(),
    ], axis=1).max(axis=1)

    df["ATR"] = tr.rolling(14, min_periods=14).mean()
    df["VOL_MA"] = df["Volume"].rolling(20, min_periods=20).mean()

    # UTC-session VWAP is valid only when the loaded data contains that session's first bar.
    # Missing session starts stay NaN rather than displaying a misleading partial-session value.
    typical = (df["High"] + df["Low"] + df["Close"]) / 3
    index_utc = df.index.tz_localize("UTC") if df.index.tz is None else df.index.tz_convert("UTC")
    session_key = pd.Series(index_utc.normalize(), index=df.index)
    cumulative_pv = (typical * df["Volume"]).groupby(session_key).cumsum()
    cumulative_volume = df["Volume"].groupby(session_key).cumsum().replace(0, np.nan)
    df["VWAP"] = cumulative_pv / cumulative_volume
    for session_start in session_key.unique():
        session_mask = session_key == session_start
        if index_utc[session_mask.to_numpy()].min() != session_start:
            df.loc[session_mask, "VWAP"] = np.nan
    df["VWAP"] = df["VWAP"].groupby(session_key).ffill()

    return df


@st.cache_data(ttl=20, show_spinner=False)
def higher_tf_bias(symbol_code):
    result = {}

    for htf in ["5m", "15m", "1h", "4h"]:
        try:
            raw = get_klines(symbol_code, htf, 180)
            valid, errors = validate_ohlcv(raw, timeframe=htf, min_rows=110)
            if not valid:
                raise RuntimeError("; ".join(errors))

            closed = select_closed_candles(raw, htf)
            if len(closed) < 110:
                raise RuntimeError("Not enough verified closed higher-timeframe candles.")

            d = add_indicators(closed)
            last = d.iloc[-1]

            if last.Close > last.EMA50 > last.EMA100:
                result[htf] = "NOUSU"
            elif last.Close < last.EMA50 < last.EMA100:
                result[htf] = "LASKU"
            else:
                result[htf] = "EPÄSELVÄ"

        except Exception:
            result[htf] = "?"

    bull = sum(v == "NOUSU" for v in result.values())
    bear = sum(v == "LASKU" for v in result.values())

    # Require three valid, aligned timeframes. Missing feeds count as unknown.
    valid_count = sum(v in ("NOUSU", "LASKU", "EPÄSELVÄ") for v in result.values())
    if valid_count < 3:
        return "EPÄSELVÄ", result
    if bull >= 3:
        return "VAHVA NOUSU", result
    if bear >= 3:
        return "VAHVA LASKU", result
    if bull >= 2 and bear == 0:
        return "NOUSU", result
    if bear >= 2 and bull == 0:
        return "LASKU", result

    return "EPÄSELVÄ", result


# ============================================================
# PATTERN ENGINE
# ============================================================

def support_resistance(df):
    d = df.tail(120)
    return (
        float(d["Low"].quantile(0.08)),
        float(d["High"].quantile(0.92)),
        float(d["Close"].median()),
    )


def range_filter(df):
    d = df.tail(50)
    price = float(df.Close.iloc[-1])
    range_pct = (d.High.max() - d.Low.min()) / price
    ema_gap = abs(df.EMA50.iloc[-1] - df.EMA100.iloc[-1]) / price
    return range_pct < 0.0026 and ema_gap < 0.0013


def market_structure(df):
    d = df.tail(35)

    high_now = d.High.tail(8).max()
    high_prev = d.High.iloc[:-8].tail(12).max()
    low_now = d.Low.tail(8).min()
    low_prev = d.Low.iloc[:-8].tail(12).min()

    if high_now > high_prev and low_now > low_prev:
        return "HH/HL nousurakenne", 16

    if high_now < high_prev and low_now < low_prev:
        return "LH/LL laskurakenne", -16

    if high_now > high_prev and low_now < low_prev:
        return "Laaja volatiliteetti / epäselvä", 0

    return "RANGE / sivuttaisrakenne", 0


def candle_power(df):
    c = df.iloc[-1]
    body = abs(c.Close - c.Open)
    rng = max(c.High - c.Low, 1e-9)
    ratio = body / rng

    if c.Close > c.Open:
        if ratio > 0.78:
            return "BUYERS 1", 16, "Ostajat hallitsevat kynttilää täysin"
        if ratio > 0.55:
            return "BUYERS 2", 11, "Ostajat vahvoja"
        if ratio > 0.32:
            return "BUYERS 3", 6, "Ostajat hieman vahvempia"
        return "BUYERS 4", 2, "Vihreä, mutta epävarma"

    if c.Close < c.Open:
        if ratio > 0.78:
            return "SELLERS 1", -16, "Myyjät hallitsevat kynttilää täysin"
        if ratio > 0.55:
            return "SELLERS 2", -11, "Myyjät vahvoja"
        if ratio > 0.32:
            return "SELLERS 3", -6, "Myyjät hieman vahvempia"
        return "SELLERS 4", -2, "Punainen, mutta epävarma"

    return "NEUTRAL", 0, "Doji / tasapaino"


def candle_pattern_score(df):
    if len(df) < 8:
        return 0, []

    score = 0
    notes = []

    c = df.iloc[-1]
    p = df.iloc[-2]
    p2 = df.iloc[-3]

    body = abs(c.Close - c.Open)
    rng = max(c.High - c.Low, 1e-9)
    upper = c.High - max(c.Open, c.Close)
    lower = min(c.Open, c.Close) - c.Low

    green = c.Close > c.Open
    red = c.Close < c.Open
    p_green = p.Close > p.Open
    p_red = p.Close < p.Open

    short_trend_up = df.Close.tail(8).mean() > df.Close.tail(20).mean()
    short_trend_down = df.Close.tail(8).mean() < df.Close.tail(20).mean()

    if body / rng < 0.12:
        notes.append("Doji / markkina epäröi")

    if green and body / rng > 0.70:
        score += 18
        notes.append("Bullish Marubozu / vahva vihreä momentum")

    if red and body / rng > 0.70:
        score -= 18
        notes.append("Bearish Marubozu / vahva punainen momentum")

    if green and lower > body * 2 and short_trend_down:
        score += 20
        notes.append("Hammer laskun jälkeen → bullish reversal")

    if red and upper > body * 2 and short_trend_up:
        score -= 20
        notes.append("Shooting Star nousun jälkeen → bearish reversal")

    if p_red and green and c.Close > p.Open and c.Open <= p.Close:
        score += 24
        notes.append("Bullish Engulfing")

    if p_green and red and c.Close < p.Open and c.Open >= p.Close:
        score -= 24
        notes.append("Bearish Engulfing")

    if p2.Close < p2.Open and abs(p.Close - p.Open) < abs(p2.Close - p2.Open) * 0.55 and green:
        score += 18
        notes.append("Morning Star -tyyppinen nousukäännös")

    if p2.Close > p2.Open and abs(p.Close - p.Open) < abs(p2.Close - p2.Open) * 0.55 and red:
        score -= 18
        notes.append("Evening Star -tyyppinen laskukäännös")

    last3 = df.tail(3)

    if all(last3["Close"] > last3["Open"]) and last3["Close"].is_monotonic_increasing:
        score += 18
        notes.append("Three White Soldiers / ostajat painavat")

    if all(last3["Close"] < last3["Open"]) and last3["Close"].is_monotonic_decreasing:
        score -= 18
        notes.append("Three Black Crows / myyjät painavat")

    return score, notes


def detect_triangle(df):
    if len(df) < 40:
        return "Ei tarpeeksi dataa", 0, None

    d = df.tail(35).copy()
    x = np.arange(len(d))

    highs = d["High"].values
    lows = d["Low"].values

    high_slope, high_intercept = np.polyfit(x, highs, 1)
    low_slope, low_intercept = np.polyfit(x, lows, 1)

    price = float(d.Close.iloc[-1])
    atr = max(float(d.ATR.iloc[-1]), price * 0.001)

    flat_limit = atr * 0.018
    slope_strength = atr * 0.025

    resistance_line = high_slope * x[-1] + high_intercept
    support_line = low_slope * x[-1] + low_intercept

    breakout_up = d.Close.iloc[-1] > resistance_line + atr * 0.15
    breakout_down = d.Close.iloc[-1] < support_line - atr * 0.15

    triangle_type = "Ei kolmiota"
    score = 0

    if high_slope < -slope_strength and low_slope > slope_strength:
        triangle_type = "Symmetrinen kolmio"
        if breakout_up:
            score = 24
            triangle_type += " + breakout ylös"
        elif breakout_down:
            score = -24
            triangle_type += " + breakdown alas"
        else:
            score = 4

    elif abs(high_slope) < flat_limit and low_slope > slope_strength:
        triangle_type = "Nouseva kolmio"
        if breakout_up:
            score = 30
            triangle_type += " + breakout ylös"
        else:
            score = 14

    elif high_slope < -slope_strength and abs(low_slope) < flat_limit:
        triangle_type = "Laskeva kolmio"
        if breakout_down:
            score = -30
            triangle_type += " + breakdown alas"
        else:
            score = -14

    lines = {
        "resistance_line": resistance_line,
        "support_line": support_line,
        "high_slope": high_slope,
        "low_slope": low_slope,
    }

    return triangle_type, score, lines


def smart_money_score(df):
    if len(df) < 40:
        return 0, []

    score = 0
    notes = []

    c = df.iloc[-1]
    p = df.iloc[-2]
    prior = df.iloc[-30:-1]

    recent_high = prior.High.max()
    recent_low = prior.Low.min()

    if c.Low < recent_low and c.Close > p.Close:
        score += 18
        notes.append("Liquidity sweep alhaalla → ostajat puolustivat")

    if c.High > recent_high and c.Close < p.Close:
        score -= 18
        notes.append("Liquidity sweep ylhäällä → myyjät puolustivat")

    if p.Close < recent_high and c.Close > recent_high:
        score += 16
        notes.append("Breakout yli likviditeetin")

    if p.Close > recent_low and c.Close < recent_low:
        score -= 16
        notes.append("Breakdown alle likviditeetin")

    return score, notes


def live_reaction(df):
    if len(df) < 30:
        return 0, "EI", []

    c = df.iloc[-1]
    prev = df.iloc[:-1]

    price = float(c.Close)
    body = abs(c.Close - c.Open)
    atr = max(float(df.ATR.iloc[-2]), price * 0.001)
    vol_ma = max(float(df.VOL_MA.iloc[-2]), 1e-9)

    green = c.Close > c.Open
    red = c.Close < c.Open

    score = 0
    notes = []

    if green:
        if body > atr * 0.22:
            score += 24
            notes.append("Live-vihreä kynttilä vahvistuu")
        if body > atr * 0.48:
            score += 18
            notes.append("Live-vihreä kynttilä erittäin vahva")
        if c.Close > c.EMA9:
            score += 10
            notes.append("Hinta EMA9 yläpuolella")
        if c.Close > c.EMA21:
            score += 10
            notes.append("Hinta EMA21 yläpuolella")
        if c.High >= prev.High.tail(8).max():
            score += 14
            notes.append("Uusi lyhyen aikavälin huippu / breakout")
        if c.Volume > vol_ma:
            score += 8
            notes.append("Volyymi tukee nousua")

    if red:
        if body > atr * 0.22:
            score -= 24
            notes.append("Live-punainen kynttilä vahvistuu")
        if body > atr * 0.48:
            score -= 18
            notes.append("Live-punainen kynttilä erittäin vahva")
        if c.Close < c.EMA9:
            score -= 10
            notes.append("Hinta EMA9 alapuolella")
        if c.Close < c.EMA21:
            score -= 10
            notes.append("Hinta EMA21 alapuolella")
        if c.Low <= prev.Low.tail(8).min():
            score -= 14
            notes.append("Uusi lyhyen aikavälin pohja / breakdown")
        if c.Volume > vol_ma:
            score -= 8
            notes.append("Volyymi tukee laskua")

    if score >= 30:
        return score, "NOPEA OSTA", notes
    if score <= -30:
        return score, "NOPEA MYY", notes

    return score, "EI", notes


# ============================================================
# AI ENGINE
# ============================================================

def ai_engine(df):
    live = df.iloc[-1]
    closed = df.iloc[:-1].copy()

    price = float(live.Close)
    score = 0
    notes = []

    bias, details = higher_tf_bias(symbol)
    htf_data_ok = has_sufficient_timeframe_data(details, minimum_valid=3)
    support, resistance, mid = support_resistance(closed)

    if bias == "VAHVA NOUSU":
        score += 18
        notes.append("Isompi aikaväli: vahva nousu")
    elif bias == "NOUSU":
        score += 12
        notes.append("Isompi aikaväli: nousu")
    elif bias == "VAHVA LASKU":
        score -= 18
        notes.append("Isompi aikaväli: vahva lasku")
    elif bias == "LASKU":
        score -= 12
        notes.append("Isompi aikaväli: lasku")
    else:
        notes.append("Isompi aikaväli epäselvä")

    structure, structure_score = market_structure(closed)
    score += structure_score
    notes.append(f"Market structure: {structure}")

    if price > live.EMA9 > live.EMA21:
        score += 14
        notes.append("Nopea EMA9/21 bullish")

    if price < live.EMA9 < live.EMA21:
        score -= 14
        notes.append("Nopea EMA9/21 bearish")

    if price > live.EMA50:
        score += 7
        notes.append("Hinta EMA50 yläpuolella")

    if price < live.EMA50:
        score -= 7
        notes.append("Hinta EMA50 alapuolella")

    if price > live.EMA100:
        score += 7
        notes.append("Hinta EMA100 yläpuolella")

    if price < live.EMA100:
        score -= 7
        notes.append("Hinta EMA100 alapuolella")

    if pd.notna(live.VWAP):
        if price > live.VWAP:
            score += 4
            notes.append("Hinta täyden UTC-session VWAP:n yläpuolella")
        else:
            score -= 4
            notes.append("Hinta täyden UTC-session VWAP:n alapuolella")
    else:
        notes.append("VWAP ohitettiin: täyttä UTC-session dataa ei ole ladattu")

    if live.RSI < 30:
        score += 10
        notes.append(f"RSI {live.RSI:.1f}: ylimyyty")
    elif live.RSI > 70:
        score -= 10
        notes.append(f"RSI {live.RSI:.1f}: yliostettu")
    else:
        notes.append(f"RSI {live.RSI:.1f}: neutraali")

    if live.MACD > live.MACD_SIGNAL and live.MACD_HIST > 0:
        score += 9
        notes.append("MACD bullish")

    if live.MACD < live.MACD_SIGNAL and live.MACD_HIST < 0:
        score -= 9
        notes.append("MACD bearish")

    power_name, power_score, power_note = candle_power(df)
    score += power_score
    notes.append(f"Candle power: {power_name} — {power_note}")

    pattern_score, pattern_notes = candle_pattern_score(closed)
    score += pattern_score
    notes.extend(pattern_notes)

    triangle_name, triangle_score, triangle_lines = detect_triangle(closed)
    score += triangle_score
    notes.append(f"Kolmio: {triangle_name}")

    sm_score, sm_notes = smart_money_score(closed)
    score += sm_score
    notes.extend(sm_notes)

    live_score, alert, live_notes = live_reaction(df)
    # A single candle may confirm momentum, but cannot force a buy/sell label.
    bounded_live_score = int(np.clip(live_score, -18, 18))
    score += bounded_live_score
    notes.extend(live_notes)
    if bounded_live_score != live_score:
        notes.append(f"Kynttilämomentin vaikutusta rajattiin: {live_score:+d} → {bounded_live_score:+d}")
    if alert in ("NOPEA OSTA", "NOPEA MYY"):
        notes.append(f"Nopea kynttilähälytys on vain vahvistava havainto: {alert}")

    no_trade = range_filter(closed)
    if no_trade:
        notes.append("Markkinan range-suodatin aktiivinen: trendisignaali estetty.")

    final = int(max(-100, min(100, score)))
    level = classify_score(
        final,
        range_blocked=no_trade,
        higher_timeframe_data_ok=htf_data_ok,
    )
    if not htf_data_ok:
        final = 0
        notes.append("Ylempien aikavälien data puutteellinen: signaali estetty.")

    atr = max(float(live.ATR), price * 0.001)

    if "OSTA" in level:
        stop = price - atr * 1.25
        target = price + atr * 2.2
        direction = "OSTA"
    elif "MYY" in level:
        stop = price + atr * 1.25
        target = price - atr * 2.2
        direction = "MYY"
    else:
        stop = None
        target = None
        direction = "ODOTA"

    rr = None
    if stop is not None and target is not None:
        rr = abs(target - price) / abs(price - stop)

    return {
        "level": level,
        "score": final,
        "price": price,
        "support": support,
        "resistance": resistance,
        "mid": mid,
        "bias": bias,
        "details": details,
        "notes": notes[:28],
        "stop": stop,
        "target": target,
        "rr": rr,
        "direction": direction,
        "structure": structure,
        "triangle": triangle_name,
        "triangle_lines": triangle_lines,
        "power": power_name,
    }


# ============================================================
# UI
# ============================================================

def signal_box(ai):
    level = ai["level"]
    if "OSTA" in level and "TARKKAILU" not in level:
        cls = "buy"
    elif "MYY" in level and "TARKKAILU" not in level:
        cls = "sell"
    elif "TARKKAILU OSTA" in level:
        cls = "watchbuy"
    elif "TARKKAILU MYY" in level:
        cls = "watchsell"
    elif "EI TREIDIÄ" in level:
        cls = "notrade"
    else:
        cls = "wait"

    st.markdown(
        f'<div class="signal {cls}">{level}<br>Score {ai["score"]:+d}/100</div>',
        unsafe_allow_html=True,
    )


def draw_chart(df, ai):
    d = df.tail(candles)

    fig = go.Figure()

    fig.add_trace(go.Candlestick(
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
        whiskerwidth=0.7,
    ))

    if show_fast:
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA9, name="EMA9", mode="lines", line=dict(color="#38bdf8", width=1.5)))
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA21, name="EMA21", mode="lines", line=dict(color="#fb7185", width=1.5)))

    if show_slow:
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA50, name="EMA50", mode="lines", line=dict(color="#facc15", width=2.3)))
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA100, name="EMA100", mode="lines", line=dict(color="#c084fc", width=2.3)))

    if show_vwap:
        fig.add_trace(go.Scatter(x=d.index, y=d.VWAP, name="VWAP (UTC-session)", mode="lines", line=dict(color="#22d3ee", width=2)))

    if show_levels:
        fig.add_hline(y=ai["support"], line_dash="dot", line_color="#22c55e")
        fig.add_hline(y=ai["resistance"], line_dash="dot", line_color="#ef4444")
        fig.add_hline(y=ai["mid"], line_dash="dot", line_color="#64748b")

    fig.add_hline(y=ai["price"], line_dash="dash", line_color="#facc15")

    if ai["stop"] is not None and ai["target"] is not None:
        fig.add_hline(y=ai["stop"], line_dash="dash", line_color="#ef4444")
        fig.add_hline(y=ai["target"], line_dash="dash", line_color="#22c55e")

    if show_patterns and ai["triangle_lines"]:
        x0 = d.index[0]
        x1 = d.index[-1]
        fig.add_hline(y=ai["triangle_lines"]["resistance_line"], line_dash="dash", line_color="#ef4444")
        fig.add_hline(y=ai["triangle_lines"]["support_line"], line_dash="dash", line_color="#22c55e")

    fig.update_layout(
        title=f"{selected_name} — Rahasampo Radar V27 PRO",
        height=780,
        template="plotly_dark",
        paper_bgcolor="#070d1c",
        plot_bgcolor="#070d1c",
        margin=dict(l=8, r=8, t=48, b=8),
        xaxis_rangeslider_visible=False,
        legend=dict(orientation="h", y=1.04, x=0),
        uirevision=f"v26_{symbol}_{tf}",
    )

    fig.update_xaxes(rangeslider_visible=False)

    st.plotly_chart(
        fig,
        use_container_width=True,
        config={"scrollZoom": True, "responsive": True},
    )


def remember(ai):
    if ai["level"] in ["ODOTA", "EI TREIDIÄ"]:
        return

    item = {
        "Aika": now_local(),
        "Kohde": selected_name,
        "Signaali": ai["level"],
        "Hinta": round(ai["price"], 4),
        "Score": ai["score"],
        "Signaalivahvuus": ai["score"],
        "Pattern": ai["triangle"],
        "Structure": ai["structure"],
    }

    if st.session_state.memory and st.session_state.memory[-1]["Signaali"] == item["Signaali"]:
        return

    st.session_state.memory.append(item)
    st.session_state.memory = st.session_state.memory[-60:]


def run_app():
    st.title("💰 Rahasampo Radar V27 PRO — Research Preview")
    raw, source = load_data()

    if source != LIVE_DATA_SOURCE:
        st.error(source)
        st.warning("NO TRADE — kelvollista live-dataa ei ole vahvistettu. Välimuistia ei käytetä signaalin muodostamiseen.")
        if st.session_state.last_error:
            st.caption(f"Viimeisin datavirhe: {st.session_state.last_error}")
        cross_check = st.session_state.cross_exchange_check
        if cross_check:
            st.caption(f"Ristiintarkistus: {cross_check.get('message', 'ei tietoa')}")
        return

    valid, data_errors = validate_ohlcv(raw, timeframe=tf, min_rows=120)
    if not valid:
        st.error("DATA FAIL — signaalin muodostaminen estetty.")
        for error in data_errors:
            st.write(f"• {error}")
        return

    closed_raw = select_closed_candles(raw, tf)
    if len(closed_raw) < 120:
        st.error("NO TRADE — suljettuja kynttilöitä ei ole tarpeeksi luotettavaan analyysiin.")
        return

    # Chart may show the forming candle; signal calculations use closed bars only.
    df = add_indicators(raw)
    signal_df = add_indicators(closed_raw)
    ai = ai_engine(signal_df)
    remember(ai)

    signal_box(ai)

    c1, c2, c3, c4, c5 = st.columns(5)
    c1.metric("Hinta", f"{ai['price']:,.4f}")
    c2.metric("Score", f"{ai['score']} / 100")
    c3.metric("Trend", ai["bias"])
    c4.metric("Candle", ai["power"])
    c5.metric("Päivitetty", now_local())

    cross_check = st.session_state.cross_exchange_check or {}
    deviation = cross_check.get("deviation_pct")
    cross_status = f"Binance/Bybit ero {deviation:.3f}%" if deviation is not None else "Binance/Bybit ristiintarkistus OK"
    st.caption(f"{source} | {cross_status} | TF: {tf} | Päivitys {refresh}s | signaali viimeisestä suljetusta kynttilästä | ajat Suomen ajassa")

    if st.session_state.last_error:
        st.warning(f"Datavaroitus: {st.session_state.last_error}")

    draw_chart(df, ai)

    a, b, c, d = st.columns(4)

    with a:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("🎯 Entry / Stop / Target")
        st.write(f"Nykyhinta: **{ai['price']:,.4f}**")
        st.write(f"Support: **{ai['support']:,.4f}**")
        st.write(f"Resistance: **{ai['resistance']:,.4f}**")
        if ai["stop"] is not None:
            st.write(f"Stop: **{ai['stop']:,.4f}**")
            st.write(f"Target: **{ai['target']:,.4f}**")
            st.write(f"RR: **1:{ai['rr']:.2f}**")
        else:
            st.write("Ei vielä selkeää entryä.")
        st.markdown("</div>", unsafe_allow_html=True)

    with b:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("📊 Moniaikaväli")
        for k, v in ai["details"].items():
            st.write(f"{k}: **{v}**")
        st.write(f"Iso suunta: **{ai['bias']}**")
        st.markdown("</div>", unsafe_allow_html=True)

    with c:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("📐 Kuviot")
        st.write(f"Kolmio: **{ai['triangle']}**")
        st.write(f"Rakenne: **{ai['structure']}**")
        st.write(f"Candle power: **{ai['power']}**")
        st.markdown("</div>", unsafe_allow_html=True)

    with d:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("🧪 V27 tutkimustyökalut")
        st.write("Käsin merkittävät win/loss-arviot on poistettu. Triple-barrier-luokitin ja satunnaisbaseline ovat testattavia tutkimusmoduuleja.")
        st.write("Historiallinen signaaliseuranta ja mallin koulutus kytketään käyttöliittymään vasta, kun niiden tulokset on erikseen testattu.")
        st.markdown("</div>", unsafe_allow_html=True)

    with st.expander("🧠 Miksi AI sanoo näin?"):
        for n in ai["notes"]:
            st.write("• " + n)

    with st.expander("🧠 AI-muisti / signaalit"):
        if st.session_state.memory:
            st.dataframe(pd.DataFrame(st.session_state.memory), use_container_width=True, hide_index=True)
        else:
            st.info("Ei vielä signaaleja.")

    with st.expander("🧪 Tutkimusmoduulien tila"):
        st.write("Triple-barrier: automaattiset TP/SL/aikaraja-merkinnät; ratkaisematon aikahorisontti jää merkitsemättä.")
        st.write("Satunnaisbaseline: kiinteä seed, ATR-pohjaiset stop- ja tavoitesäännöt sekä kulumalli.")
        st.write("Tutkimusmoduulit eivät vielä todista strategian kannattavuutta. Vertailu edellyttää tallennettua historiallista signaalisarjaa ja koskematonta testijaksoa.")

    st.warning("Opetustyökalu. Ei tee oikeita kauppoja eikä ole sijoitusneuvo.")


run_app()

if live_on:
    time.sleep(refresh)
    st.rerun()
