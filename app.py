# -*- coding: utf-8 -*-

from datetime import datetime
import requests
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st


st.set_page_config(
    page_title="AI Trading Pro v18",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="collapsed",
)

st.markdown("""
<style>
.block-container {padding-top:0.25rem;padding-left:0.45rem;padding-right:0.45rem;}
h1 {font-size:1.1rem!important;margin-bottom:0.1rem;}
[data-testid="stMetricValue"] {font-size:0.95rem!important;}
.signal{
    border-radius:16px;
    padding:14px;
    font-size:23px;
    font-weight:900;
    text-align:center;
    margin:8px 0;
}
.buy{background:linear-gradient(90deg,#15803d,#22c55e);color:white;}
.prebuy{background:linear-gradient(90deg,#bbf7d0,#22c55e);color:#052e16;}
.sell{background:linear-gradient(90deg,#b91c1c,#ef4444);color:white;}
.presell{background:linear-gradient(90deg,#fecaca,#ef4444);color:#450a0a;}
.wait{background:linear-gradient(90deg,#facc15,#ca8a04);color:#111827;}
.no{background:linear-gradient(90deg,#64748b,#94a3b8);color:#020617;}
.card{
    background:#111936;
    border:1px solid #26345e;
    border-radius:14px;
    padding:12px;
    color:white;
    margin-bottom:10px;
}
.good{color:#22c55e;font-weight:800;}
.bad{color:#ef4444;font-weight:800;}
.warn{color:#facc15;font-weight:800;}
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

INTERVALS = {
    "1m": "1m",
    "3m": "3m",
    "5m": "5m",
    "15m": "15m",
}

def init_state():
    defaults = {
        "chart_type": "Kynttilät",
        "show_ema_fast": True,
        "show_ema_pro": True,
        "show_bollinger": False,
        "show_levels": True,
        "show_macd": False,
        "drawing_tools": False,
        "live_on": True,
    }
    for key, value in defaults.items():
        if key not in st.session_state:
            st.session_state[key] = value

init_state()


st.sidebar.title("⚙️ Asetukset")

selected_name = st.sidebar.selectbox("Kohde", list(SYMBOLS.keys()), index=0)
symbol = SYMBOLS[selected_name]

entry_tf = st.sidebar.radio("Entry-aikaväli", list(INTERVALS.keys()), index=2)
refresh_seconds = st.sidebar.radio("Live-päivitys", [3, 5, 10, 15], index=1)
candle_limit = st.sidebar.slider("Kynttilöitä", 120, 400, 220, 20)

st.sidebar.divider()

st.session_state.chart_type = st.sidebar.radio(
    "Kaaviotyyppi",
    ["Kynttilät", "Viiva"],
    index=["Kynttilät", "Viiva"].index(st.session_state.chart_type),
)

st.session_state.show_ema_fast = st.sidebar.checkbox("EMA 9 / 21", value=st.session_state.show_ema_fast)
st.session_state.show_ema_pro = st.sidebar.checkbox("EMA 50 / 100", value=st.session_state.show_ema_pro)
st.session_state.show_bollinger = st.sidebar.checkbox("Bollinger", value=st.session_state.show_bollinger)
st.session_state.show_levels = st.sidebar.checkbox("Support / Resistance", value=st.session_state.show_levels)
st.session_state.show_macd = st.sidebar.checkbox("MACD-paneeli", value=st.session_state.show_macd)
st.session_state.drawing_tools = st.sidebar.toggle("Piirtoviivat päälle", value=st.session_state.drawing_tools)
st.session_state.live_on = st.sidebar.toggle("Live päällä", value=st.session_state.live_on)


@st.cache_data(ttl=3, show_spinner=False)
def get_klines(symbol_code, interval_code, limit_count):
    url = "https://api.binance.com/api/v3/klines"
    params = {"symbol": symbol_code, "interval": interval_code, "limit": limit_count}
    r = requests.get(url, params=params, timeout=7, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    raw = r.json()

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


def demo_data(limit_count, base_price):
    now = pd.Timestamp.utcnow().floor("min")
    idx = pd.date_range(end=now, periods=limit_count, freq="min")
    price = base_price
    rows = []

    for _ in idx:
        o = price
        price = price * (1 + np.random.normal(0, 0.001))
        c = price
        h = max(o, c) * (1 + abs(np.random.normal(0, 0.0008)))
        l = min(o, c) * (1 - abs(np.random.normal(0, 0.0008)))
        v = abs(np.random.normal(100, 25))
        rows.append([o, h, l, c, v])

    return pd.DataFrame(rows, index=idx, columns=["Open", "High", "Low", "Close", "Volume"])


def load_data(symbol_code, interval_code, limit_count):
    try:
        return get_klines(symbol_code, interval_code, limit_count), "Binance live OHLC"
    except Exception:
        base = 78000 if "BTC" in symbol_code else 3500
        return demo_data(limit_count, base), "Demo-varadata"


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

    df["SMA20"] = df["Close"].rolling(20, min_periods=5).mean()
    df["STD20"] = df["Close"].rolling(20, min_periods=5).std().fillna(0)
    df["BB_UPPER"] = df["SMA20"] + 2 * df["STD20"]
    df["BB_LOWER"] = df["SMA20"] - 2 * df["STD20"]

    df["RSI"] = rsi(df["Close"])

    ema12 = df["Close"].ewm(span=12, adjust=False).mean()
    ema26 = df["Close"].ewm(span=26, adjust=False).mean()
    df["MACD"] = ema12 - ema26
    df["MACD_SIGNAL"] = df["MACD"].ewm(span=9, adjust=False).mean()
    df["MACD_HIST"] = df["MACD"] - df["MACD_SIGNAL"]

    low14 = df["Low"].rolling(14, min_periods=5).min()
    high14 = df["High"].rolling(14, min_periods=5).max()
    df["STOCH"] = ((df["Close"] - low14) / (high14 - low14).replace(0, np.nan) * 100).fillna(50)

    tr1 = df["High"] - df["Low"]
    tr2 = (df["High"] - df["Close"].shift()).abs()
    tr3 = (df["Low"] - df["Close"].shift()).abs()
    df["ATR"] = pd.concat([tr1, tr2, tr3], axis=1).max(axis=1).rolling(14, min_periods=5).mean()
    df["ATR"] = df["ATR"].fillna(tr1.mean())

    df["VOL_MA"] = df["Volume"].rolling(20, min_periods=5).mean()
    df["BODY"] = (df["Close"] - df["Open"]).abs()
    df["RANGE"] = (df["High"] - df["Low"]).replace(0, np.nan)

    return df


def market_trend(df):
    last = df.iloc[-1]
    price = last.Close

    if price > last.EMA50 > last.EMA100:
        return "NOUSU"
    if price < last.EMA50 < last.EMA100:
        return "LASKU"
    return "EPÄSELVÄ"


def higher_timeframe_bias(symbol_code):
    results = {}

    for tf in ["15m", "1h", "4h"]:
        df, _ = load_data(symbol_code, tf, 180)
        df = add_indicators(df)
        results[tf] = market_trend(df)

    bull = sum(1 for v in results.values() if v == "NOUSU")
    bear = sum(1 for v in results.values() if v == "LASKU")

    if bull >= 2:
        bias = "NOUSU"
    elif bear >= 2:
        bias = "LASKU"
    else:
        bias = "EPÄSELVÄ"

    return bias, results


def support_resistance(df, lookback=80):
    recent = df.tail(lookback)
    support = float(recent["Low"].quantile(0.08))
    resistance = float(recent["High"].quantile(0.92))
    return support, resistance


def detect_range(df):
    recent = df.tail(40)
    price = float(df.Close.iloc[-1])

    high = recent.High.max()
    low = recent.Low.min()
    range_pct = (high - low) / price

    ema_spread = abs(df.EMA50.iloc[-1] - df.EMA100.iloc[-1]) / price
    close_mid = recent.Close.std() / price

    if range_pct < 0.006 and ema_spread < 0.0025 and close_mid < 0.0025:
        return True, "Sivuttaisliike: hinta on kapeassa rangessa ja EMA50/EMA100 lähellä toisiaan."

    return False, "Markkina ei ole selvässä kapeassa rangessa."


def candle_ai(df):
    score = 0
    notes = []

    if len(df) < 5:
        return score, ["Kynttilädataa liian vähän."]

    c = df.iloc[-1]
    p = df.iloc[-2]
    p2 = df.iloc[-3]

    body = abs(c.Close - c.Open)
    rng = max(c.High - c.Low, 1e-9)
    upper = c.High - max(c.Open, c.Close)
    lower = min(c.Open, c.Close) - c.Low

    green = c.Close > c.Open
    red = c.Close < c.Open
    prev_green = p.Close > p.Open
    prev_red = p.Close < p.Open

    if body / rng < 0.12:
        notes.append("Doji: markkina epäröi.")
    if lower > body * 2.2 and green:
        score += 12
        notes.append("Hammer: ostajat puolustivat pohjaa.")
    if upper > body * 2.2 and red:
        score -= 12
        notes.append("Shooting Star: myyjät torjuivat nousun.")
    if prev_red and green and c.Close > p.Open and c.Open < p.Close:
        score += 18
        notes.append("Bullish Engulfing: vahva ostokynttilä.")
    if prev_green and red and c.Close < p.Open and c.Open > p.Close:
        score -= 18
        notes.append("Bearish Engulfing: vahva myyntikynttilä.")
    if p2.Close < p2.Open and p.Close < p.Open and green and c.Close > p.Open:
        score += 14
        notes.append("Morning Star -tyyppinen käännös.")
    if p2.Close > p2.Open and p.Close > p.Open and red and c.Close < p.Open:
        score -= 14
        notes.append("Evening Star -tyyppinen käännös.")

    last3 = df.tail(3)
    if (last3.Close > last3.Open).all():
        score += 8
        notes.append("Kolme vihreää kynttilää: ostajat hallitsevat lyhyttä liikettä.")
    if (last3.Close < last3.Open).all():
        score -= 8
        notes.append("Kolme punaista kynttilää: myyjät hallitsevat lyhyttä liikettä.")

    return score, notes


def ema_strategy_ai(df):
    score = 0
    notes = []

    last = df.iloc[-1]
    prev = df.iloc[-2]
    price = float(last.Close)
    atr = max(float(last.ATR), price * 0.001)

    if prev.EMA50 <= prev.EMA100 and last.EMA50 > last.EMA100:
        score += 22
        notes.append("Golden Cross: EMA50 ylitti EMA100:n ylöspäin.")
    if prev.EMA50 >= prev.EMA100 and last.EMA50 < last.EMA100:
        score -= 22
        notes.append("Death Cross: EMA50 alitti EMA100:n alaspäin.")

    dist_ema50 = abs(price - last.EMA50)
    dist_ema100 = abs(price - last.EMA100)

    near_ema50 = dist_ema50 <= atr * 0.8
    near_ema100 = dist_ema100 <= atr * 0.8

    if price > last.EMA50 > last.EMA100 and (near_ema50 or near_ema100):
        score += 18
        notes.append("Nousutrendi + hinta lähellä EMA50/EMA100-tukialuetta.")

    if price < last.EMA50 < last.EMA100 and (near_ema50 or near_ema100):
        score -= 18
        notes.append("Laskutrendi + hinta lähellä EMA50/EMA100-vastusta.")

    if last.EMA9 > last.EMA21 and price > last.EMA9:
        score += 10
        notes.append("Nopea EMA9/EMA21 tukee ostosuuntaa.")
    if last.EMA9 < last.EMA21 and price < last.EMA9:
        score -= 10
        notes.append("Nopea EMA9/EMA21 tukee myyntisuuntaa.")

    return score, notes


def structure_ai(df):
    score = 0
    notes = []

    recent = df.tail(70)
    price = float(df.Close.iloc[-1])

    support, resistance = support_resistance(df)

    if price > resistance:
        score += 14
        notes.append("Breakout: hinta on rikkonut vastusalueen.")
    elif price > resistance * 0.997:
        score += 8
        notes.append("Hinta painaa vastuksen lähellä — breakout mahdollinen.")

    if price < support:
        score -= 14
        notes.append("Breakdown: hinta on rikkonut tukialueen.")
    elif price < support * 1.003:
        score -= 8
        notes.append("Hinta painaa tuen lähellä — breakdown mahdollinen.")

    highs = recent.High.tail(28).values
    lows = recent.Low.tail(28).values

    h_slope = np.polyfit(range(len(highs)), highs, 1)[0]
    l_slope = np.polyfit(range(len(lows)), lows, 1)[0]

    if l_slope > 0 and abs(h_slope) < abs(l_slope) * 0.65:
        score += 12
        notes.append("Ascending Triangle: nousevat pohjat painavat kohti vastusta.")

    if h_slope < 0 and abs(l_slope) < abs(h_slope) * 0.65:
        score -= 12
        notes.append("Descending Triangle: laskevat huiput painavat kohti tukea.")

    first_low = recent.Low.iloc[-55:-30].min()
    second_low = recent.Low.iloc[-30:].min()
    first_high = recent.High.iloc[-55:-30].max()
    second_high = recent.High.iloc[-30:].max()

    if abs(first_low - second_low) / price < 0.004 and price > recent.Close.tail(12).mean():
        score += 12
        notes.append("Double Bottom / W-pohja mahdollinen.")

    if abs(first_high - second_high) / price < 0.004 and price < recent.Close.tail(12).mean():
        score -= 12
        notes.append("Double Top / M-huippu mahdollinen.")

    return score, notes


def risk_model(df, direction):
    last = df.iloc[-1]
    price = float(last.Close)
    atr = max(float(last.ATR), price * 0.001)

    if direction == "OSTA":
        stop = price - atr * 1.25
        target = price + atr * 2.5
    elif direction == "MYY":
        stop = price + atr * 1.25
        target = price - atr * 2.5
    else:
        stop = None
        target = None

    return price, stop, target


def ai_engine(df, big_bias, big_details):
    last = df.iloc[-1]
    prev = df.iloc[-2]

    price = float(last.Close)
    score = 0
    notes = []
    buy_factors = 0
    sell_factors = 0

    is_range, range_note = detect_range(df)

    if is_range:
        notes.append(range_note)

    if big_bias == "NOUSU":
        score += 14
        buy_factors += 1
        notes.append("Iso kuva 15m/1h/4h tukee nousua.")
    elif big_bias == "LASKU":
        score -= 14
        sell_factors += 1
        notes.append("Iso kuva 15m/1h/4h tukee laskua.")
    else:
        notes.append("Iso kuva on epäselvä — AI vähentää varmuutta.")

    e_score, e_notes = ema_strategy_ai(df)
    c_score, c_notes = candle_ai(df)
    s_score, s_notes = structure_ai(df)

    score += e_score + c_score + s_score
    notes.extend(e_notes)
    notes.extend(c_notes)
    notes.extend(s_notes)

    if e_score + c_score + s_score > 0:
        buy_factors += 2
    if e_score + c_score + s_score < 0:
        sell_factors += 2

    if last.RSI < 30:
        score += 9
        buy_factors += 1
        notes.append(f"RSI {last.RSI:.1f}: ylimyyty, ostokäännös mahdollinen.")
    elif last.RSI > 70:
        score -= 9
        sell_factors += 1
        notes.append(f"RSI {last.RSI:.1f}: yliostettu, myyntikäännös mahdollinen.")
    else:
        notes.append(f"RSI {last.RSI:.1f}: neutraali.")

    if last.MACD > last.MACD_SIGNAL and last.MACD_HIST > prev.MACD_HIST:
        score += 11
        buy_factors += 1
        notes.append("MACD vahvistuu ylöspäin.")
    if last.MACD < last.MACD_SIGNAL and last.MACD_HIST < prev.MACD_HIST:
        score -= 11
        sell_factors += 1
        notes.append("MACD heikkenee alaspäin.")

    if last.STOCH < 20:
        score += 6
        buy_factors += 1
        notes.append("Stochastic alle 20: ylimyyty.")
    elif last.STOCH > 80:
        score -= 6
        sell_factors += 1
        notes.append("Stochastic yli 80: yliostettu.")

    if last.Volume > last.VOL_MA * 1.3:
        score = score * 1.08
        notes.append("Volyymi on normaalia suurempi — signaalille lisäpainoa.")

    if big_bias == "NOUSU" and score < 0:
        score *= 0.55
        notes.append("Myyntisignaali on isoa nousutrendiä vastaan — varmuutta leikataan.")
    if big_bias == "LASKU" and score > 0:
        score *= 0.55
        notes.append("Ostosignaali on isoa laskutrendiä vastaan — varmuutta leikataan.")

    if is_range:
        score *= 0.45
        notes.append("NO TRADE FILTER: sivuttaisliike heikentää signaalia.")

    score = int(max(-100, min(100, score)))
    confidence = int(min(94, max(42, 50 + abs(score) * 0.42)))

    if is_range and abs(score) < 55:
        level = "ÄLÄ TREIDAA"
        direction = "ODOTA"
    elif score >= 64 and buy_factors >= 4 and big_bias != "LASKU":
        level = "VAHVA OSTA"
        direction = "OSTA"
    elif score >= 34 and buy_factors >= 3 and big_bias != "LASKU":
        level = "VALMISTAUTUU OSTOON"
        direction = "OSTA"
    elif score <= -64 and sell_factors >= 4 and big_bias != "NOUSU":
        level = "VAHVA MYY"
        direction = "MYY"
    elif score <= -34 and sell_factors >= 3 and big_bias != "NOUSU":
        level = "VALMISTAUTUU MYYNTIIN"
        direction = "MYY"
    else:
        level = "ODOTA"
        direction = "ODOTA"

    entry, stop, target = risk_model(df, direction)

    if direction in ["OSTA", "MYY"]:
        risk = abs(entry - stop)
        reward = abs(target - entry)
        rr = reward / risk if risk > 0 else 0

        if rr < 2:
            level = "ODOTA"
            direction = "ODOTA"
            notes.append("Riski/tuotto alle 1:2 — AI hylkää treidin.")
    else:
        rr = None

    support, resistance = support_resistance(df)

    return {
        "level": level,
        "direction": direction,
        "score": score,
        "confidence": confidence,
        "price": entry,
        "stop": stop,
        "target": target,
        "rr": rr,
        "support": support,
        "resistance": resistance,
        "big_bias": big_bias,
        "big_details": big_details,
        "range": is_range,
        "notes": notes[:18],
    }


def signal_box(ai):
    level = ai["level"]
    conf = ai["confidence"]

    if level == "VAHVA OSTA":
        cls, icon = "buy", "▲"
    elif level == "VALMISTAUTUU OSTOON":
        cls, icon = "prebuy", "▲"
    elif level == "VAHVA MYY":
        cls, icon = "sell", "▼"
    elif level == "VALMISTAUTUU MYYNTIIN":
        cls, icon = "presell", "▼"
    elif level == "ÄLÄ TREIDAA":
        cls, icon = "no", "■"
    else:
        cls, icon = "wait", "●"

    st.markdown(
        f'<div class="signal {cls}">{icon} {level}<br>{conf}%</div>',
        unsafe_allow_html=True,
    )


def draw_chart(df, ai):
    d = df.tail(candle_limit)
    fig = go.Figure()

    if st.session_state.chart_type == "Kynttilät":
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
        ))
    else:
        fig.add_trace(go.Scatter(
            x=d.index,
            y=d.Close,
            mode="lines",
            name="Hinta",
            line=dict(width=3, color="#00ff66"),
        ))

    if st.session_state.show_ema_fast:
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA9, mode="lines", name="EMA9", line=dict(width=2, color="#60a5fa")))
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA21, mode="lines", name="EMA21", line=dict(width=2, color="#f87171")))

    if st.session_state.show_ema_pro:
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA50, mode="lines", name="EMA50", line=dict(width=2, color="#facc15")))
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA100, mode="lines", name="EMA100", line=dict(width=2, color="#c084fc")))

    if st.session_state.show_bollinger:
        fig.add_trace(go.Scatter(x=d.index, y=d.BB_UPPER, mode="lines", name="BB ylä", line=dict(width=1, color="#94a3b8")))
        fig.add_trace(go.Scatter(x=d.index, y=d.BB_LOWER, mode="lines", name="BB ala", line=dict(width=1, color="#94a3b8")))

    if st.session_state.show_levels:
        fig.add_hline(y=ai["support"], line_dash="dot", line_color="#22c55e", annotation_text="SUPPORT")
        fig.add_hline(y=ai["resistance"], line_dash="dot", line_color="#ef4444", annotation_text="RESISTANCE")

    fig.add_hline(y=ai["price"], line_dash="dash", line_color="#facc15", annotation_text="NYKYHINTA")

    if ai["stop"] is not None and ai["direction"] != "ODOTA":
        fig.add_hline(y=ai["stop"], line_dash="dash", line_color="#ef4444", annotation_text="STOP")
    if ai["target"] is not None and ai["direction"] != "ODOTA":
        fig.add_hline(y=ai["target"], line_dash="dash", line_color="#22c55e", annotation_text="TARGET")

    fig.update_layout(
        title=f"{selected_name} — AI PRO KAAVIO",
        height=430,
        template="plotly_dark",
        paper_bgcolor="#070d1c",
        plot_bgcolor="#070d1c",
        xaxis_rangeslider_visible=False,
        margin=dict(l=5, r=5, t=42, b=5),
        legend=dict(orientation="h", y=1.04, x=0),
        dragmode="drawline" if st.session_state.drawing_tools else "pan",
        newshape=dict(line_color="#facc15", line_width=2),
    )

    config = {
        "displayModeBar": st.session_state.drawing_tools,
        "scrollZoom": False,
        "responsive": True,
    }

    if st.session_state.drawing_tools:
        config["modeBarButtonsToAdd"] = ["drawline", "drawopenpath", "drawrect", "eraseshape"]

    st.plotly_chart(fig, use_container_width=True, config=config)


def macd_panel(df):
    d = df.tail(candle_limit)
    fig = go.Figure()
    fig.add_trace(go.Scatter(x=d.index, y=d.MACD, mode="lines", name="MACD"))
    fig.add_trace(go.Scatter(x=d.index, y=d.MACD_SIGNAL, mode="lines", name="Signal"))
    fig.add_trace(go.Bar(x=d.index, y=d.MACD_HIST, name="Histogrammi"))

    fig.update_layout(
        height=230,
        template="plotly_dark",
        paper_bgcolor="#070d1c",
        plot_bgcolor="#070d1c",
        margin=dict(l=5, r=5, t=25, b=5),
    )

    st.plotly_chart(fig, use_container_width=True)


def render_app():
    df_raw, source = load_data(symbol, entry_tf, candle_limit)
    df = add_indicators(df_raw)

    big_bias, big_details = higher_timeframe_bias(symbol)
    ai = ai_engine(df, big_bias, big_details)

    st.title("📈 AI Trading Pro v18")

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Kohde", selected_name)
    c2.metric("Hinta", f"{ai['price']:,.4f}")
    c3.metric("AI-score", f"{ai['score']} / 100")
    c4.metric("Iso trendi", ai["big_bias"])

    st.caption(
        f"Datalähde: {source} | Entry TF: {entry_tf} | Päivitetty: {datetime.now().strftime('%H:%M:%S')} | Live {refresh_seconds}s"
    )

    signal_box(ai)
    draw_chart(df, ai)

    if st.session_state.show_macd:
        macd_panel(df)

    left, right = st.columns([1, 1])

    with left:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("🎯 Entry / Stop / Target")
        st.write(f"Nykyhinta: **{ai['price']:,.4f}**")
        st.write(f"Support: **{ai['support']:,.4f}**")
        st.write(f"Resistance: **{ai['resistance']:,.4f}**")

        if ai["direction"] != "ODOTA" and ai["stop"] is not None:
            st.write(f"Stop loss: **{ai['stop']:,.4f}**")
            st.write(f"Target: **{ai['target']:,.4f}**")
            st.write(f"Riski/tuotto: **1:{ai['rr']:.2f}**")
        else:
            st.write("Ei selkeää treidipaikkaa. AI odottaa vahvistusta.")

        st.markdown("</div>", unsafe_allow_html=True)

    with right:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("🧠 Miksi AI näyttää näin?")
        st.write(f"15m: **{ai['big_details']['15m']}** | 1h: **{ai['big_details']['1h']}** | 4h: **{ai['big_details']['4h']}**")
        for note in ai["notes"]:
            st.write("• " + note)
        st.markdown("</div>", unsafe_allow_html=True)

    with st.expander("📚 AI:n koulutusmuisti / PRO-säännöt"):
        st.write("""
**AI:n tärkeimmät säännöt:**

1. Treidiä ei oteta trendiä vastaan.
2. 15m / 1h / 4h antaa ison kuvan suunnan.
3. Entry haetaan 1m / 3m / 5m / 15m kaaviosta.
4. EMA50 ja EMA100 ovat tärkeät tuki- ja vastusalueet.
5. Golden Cross = EMA50 ylittää EMA100.
6. Death Cross = EMA50 alittaa EMA100.
7. Pelkkä EMA-risteys ei riitä, tarvitaan vahvistus.
8. Support / resistance -testi saa enemmän painoa kuin pelkkä risti.
9. Range-markkinassa AI antaa ÄLÄ TREIDAA.
10. RSI yli 70 = yliostettu, RSI alle 30 = ylimyyty.
11. MACD vahvistaa trendin voimaa.
12. Volyymin kasvu vahvistaa signaalia.
13. Kynttiläkuviot: Hammer, Doji, Engulfing, Morning Star, Evening Star.
14. Rakenteet: Double Top, Double Bottom, Ascending Triangle, Descending Triangle.
15. Stop loss ja target lasketaan ATR:n mukaan.
16. Riski/tuotto pitää olla vähintään 1:2.
17. AI ei yritä treidata jokaista liikettä.
18. Paras signaali = trendi + EMA-tuki/vastus + kynttilävahvistus + volyymi + järkevä riski.
        """)

    st.warning("Opetustyökalu. Ei tee oikeita kauppoja eikä ole sijoitusneuvo.")


run_every = f"{refresh_seconds}s" if st.session_state.live_on else None

@st.fragment(run_every=run_every)
def live_fragment():
    render_app()

live_fragment()
