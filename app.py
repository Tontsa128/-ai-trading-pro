# -*- coding: utf-8 -*-

from datetime import datetime
import requests
import numpy as np
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots
import streamlit as st


st.set_page_config(
    page_title="AI Trading Pro v22 Desktop",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown("""
<style>
.block-container {padding-top:0.4rem;padding-left:1rem;padding-right:1rem;}
h1 {font-size:1.5rem!important;}
.signal{
    border-radius:18px;
    padding:18px;
    font-size:30px;
    font-weight:900;
    text-align:center;
    margin:10px 0 14px 0;
}
.buy{background:linear-gradient(90deg,#15803d,#22c55e);color:white;}
.prebuy{background:linear-gradient(90deg,#bbf7d0,#22c55e);color:#052e16;}
.watchbuy{background:linear-gradient(90deg,#dcfce7,#86efac);color:#052e16;}
.quickbuy{background:linear-gradient(90deg,#064e3b,#10b981);color:white;}
.sell{background:linear-gradient(90deg,#991b1b,#ef4444);color:white;}
.presell{background:linear-gradient(90deg,#fecaca,#ef4444);color:#450a0a;}
.watchsell{background:linear-gradient(90deg,#fee2e2,#fca5a5);color:#450a0a;}
.quicksell{background:linear-gradient(90deg,#7f1d1d,#dc2626);color:white;}
.wait{background:linear-gradient(90deg,#facc15,#ca8a04);color:#111827;}
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
        "show_ema9_21": True,
        "show_ema50_100": True,
        "show_levels": True,
        "show_bollinger": False,
        "show_macd_rsi": True,
        "live_on": True,
    }
    for k, v in defaults.items():
        if k not in st.session_state:
            st.session_state[k] = v


init_state()


st.sidebar.title("⚙️ AI Trading Pro v22")
selected_name = st.sidebar.selectbox("Kohde", list(SYMBOLS.keys()), index=0)
symbol = SYMBOLS[selected_name]

entry_tf = st.sidebar.radio("Entry-aikaväli", ENTRY_INTERVALS, index=0)
refresh_seconds = st.sidebar.radio("Live-päivitys", [1, 2, 3, 5, 10], index=1)
candle_limit = st.sidebar.slider("Kynttilöitä kaaviossa", 80, 350, 180, 10)

st.sidebar.divider()
st.session_state.show_ema9_21 = st.sidebar.checkbox("EMA9 / EMA21", value=st.session_state.show_ema9_21)
st.session_state.show_ema50_100 = st.sidebar.checkbox("EMA50 / EMA100", value=st.session_state.show_ema50_100)
st.session_state.show_levels = st.sidebar.checkbox("Support / Resistance", value=st.session_state.show_levels)
st.session_state.show_bollinger = st.sidebar.checkbox("Bollinger", value=st.session_state.show_bollinger)
st.session_state.show_macd_rsi = st.sidebar.checkbox("MACD + RSI paneelit", value=st.session_state.show_macd_rsi)
st.session_state.live_on = st.sidebar.toggle("Live päällä", value=st.session_state.live_on)

if st.sidebar.button("🔄 Resetoi data"):
    st.session_state.chart_df = None
    st.session_state.last_signal = "ODOTA"
    st.session_state.last_score = 0
    st.session_state.last_data_error = ""
    st.rerun()


current_key = f"{symbol}_{entry_tf}_{candle_limit}"
if st.session_state.chart_key != current_key:
    st.session_state.chart_key = current_key
    st.session_state.chart_df = None
    st.session_state.last_signal = "ODOTA"
    st.session_state.last_score = 0
    st.session_state.last_data_error = ""


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
            st.session_state.chart_df = get_klines(symbol, entry_tf, max(candle_limit + 180, 320))
            st.session_state.last_data_error = ""
            return "Binance live OHLC"

        latest = get_klines(symbol, entry_tf, 5)
        combined = pd.concat([st.session_state.chart_df, latest])
        combined = combined[~combined.index.duplicated(keep="last")]
        combined = combined.sort_index()
        combined = combined.tail(max(candle_limit + 180, 320))

        st.session_state.chart_df = combined
        st.session_state.last_data_error = ""
        return "Binance live OHLC"

    except Exception as e:
        st.session_state.last_data_error = str(e)

        if st.session_state.chart_df is None or len(st.session_state.chart_df) < 80:
            base = 78000 if "BTC" in symbol else 3500
            st.session_state.chart_df = make_demo_data(max(candle_limit + 180, 320), base)
            return "Demo-varadata"

        return "Vanha data käytössä"


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
    df["SMA20"] = df["Close"].rolling(20, min_periods=5).mean()
    df["STD20"] = df["Close"].rolling(20, min_periods=5).std().fillna(0)
    df["BB_UPPER"] = df["SMA20"] + 2 * df["STD20"]
    df["BB_LOWER"] = df["SMA20"] - 2 * df["STD20"]

    return df


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

    for tf in ["15m", "1h", "4h"]:
        try:
            raw = get_klines(symbol_code, tf, 180)
            df = add_indicators(raw)
            closed = df.iloc[:-1].copy() if len(df) > 30 else df.copy()
            details[tf] = trend_of(closed)
        except Exception:
            details[tf] = "?"

    bull = sum(1 for v in details.values() if v == "NOUSU")
    bear = sum(1 for v in details.values() if v == "LASKU")

    if bull >= 2:
        return "NOUSU", details
    if bear >= 2:
        return "LASKU", details
    return "EPÄSELVÄ", details


def support_resistance(df, lookback=100):
    recent = df.tail(lookback)
    support = float(recent["Low"].quantile(0.08))
    resistance = float(recent["High"].quantile(0.92))
    return support, resistance


def is_range_market(df):
    recent = df.tail(35)
    price = float(df.Close.iloc[-1])
    range_pct = (recent.High.max() - recent.Low.min()) / price
    ema_spread = abs(df.EMA50.iloc[-1] - df.EMA100.iloc[-1]) / price
    return range_pct < 0.0045 and ema_spread < 0.0022


def candle_score(df):
    score = 0
    notes = []

    if len(df) < 5:
        return score, ["Kynttilöitä liian vähän."]

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
        notes.append("Doji: epäröintiä.")

    if lower > body * 2.0 and green:
        score += 12
        notes.append("Hammer: ostajat puolustivat pohjaa.")

    if upper > body * 2.0 and red:
        score -= 12
        notes.append("Shooting Star: myyjät torjuivat nousun.")

    if prev_red and green and c.Close > p.Open:
        score += 16
        notes.append("Bullish Engulfing / vahva ostokynttilä.")

    if prev_green and red and c.Close < p.Open:
        score -= 16
        notes.append("Bearish Engulfing / vahva myyntikynttilä.")

    if p2.Close < p2.Open and p.Close < p.Open and green:
        score += 9
        notes.append("Mahdollinen käännös ylös.")

    if p2.Close > p2.Open and p.Close > p.Open and red:
        score -= 9
        notes.append("Mahdollinen käännös alas.")

    return score, notes


def live_reaction_score(df_live):
    """
    Nopea scalping-varoitus juuri muodostuvasta kynttilästä.
    Tämä ei korvaa varsinaista sulkeutuneen kynttilän signaalia.
    """
    if len(df_live) < 30:
        return 0, "EI", []

    c = df_live.iloc[-1]
    p = df_live.iloc[-2]

    price = float(c.Close)
    body = abs(c.Close - c.Open)
    candle_range = max(c.High - c.Low, 1e-9)
    atr = max(float(df_live.ATR.iloc[-2]), price * 0.001)
    volume_ma = max(float(df_live.VOL_MA.iloc[-2]), 1e-9)

    score = 0
    notes = []

    red = c.Close < c.Open
    green = c.Close > c.Open

    strong_body = body > atr * 0.45
    very_strong_body = body > atr * 0.75
    volume_boost = c.Volume > volume_ma * 1.15

    new_lower_low = c.Low < df_live.Low.tail(8).iloc[:-1].min()
    new_higher_high = c.High > df_live.High.tail(8).iloc[:-1].max()

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


def raw_signal_from_score(score):
    if score >= 50:
        return "VAHVA OSTA"
    if score >= 32:
        return "OSTA"
    if score >= 18:
        return "TARKKAILU OSTA"
    if score <= -50:
        return "VAHVA MYY"
    if score <= -32:
        return "MYY"
    if score <= -18:
        return "TARKKAILU MYY"
    return "ODOTA"


def apply_signal_hysteresis(raw_level, score):
    last = st.session_state.last_signal
    last_score = st.session_state.last_score

    if raw_level == "ODOTA" and last != "ODOTA" and abs(score) >= 12:
        return last

    if "OSTA" in last and "MYY" in raw_level and score > -28:
        return last

    if "MYY" in last and "OSTA" in raw_level and score < 28:
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
    notes = []

    range_market = is_range_market(df_closed)

    if big_bias == "NOUSU":
        score += 12
        notes.append("Iso trendi tukee ostosuuntaa.")
    elif big_bias == "LASKU":
        score -= 12
        notes.append("Iso trendi tukee myyntisuuntaa.")
    else:
        notes.append("Iso trendi epäselvä.")

    if prev.EMA50 <= prev.EMA100 and last.EMA50 > last.EMA100:
        score += 22
        notes.append("Golden Cross: EMA50 ylitti EMA100:n.")

    if prev.EMA50 >= prev.EMA100 and last.EMA50 < last.EMA100:
        score -= 22
        notes.append("Death Cross: EMA50 alitti EMA100:n.")

    if price > last.EMA50 > last.EMA100:
        score += 18
        notes.append("Hinta EMA50/EMA100 yläpuolella.")

    if price < last.EMA50 < last.EMA100:
        score -= 18
        notes.append("Hinta EMA50/EMA100 alapuolella.")

    if last.EMA9 > last.EMA21:
        score += 8
        notes.append("EMA9 > EMA21: lyhyt ostopaine.")

    if last.EMA9 < last.EMA21:
        score -= 8
        notes.append("EMA9 < EMA21: lyhyt myyntipaine.")

    support, resistance = support_resistance(df_closed)

    if price > resistance * 0.998:
        score += 10
        notes.append("Hinta lähellä vastusta / breakout-mahdollisuus.")

    if price < support * 1.002:
        score -= 10
        notes.append("Hinta lähellä tukea / breakdown-riski.")

    if last.RSI < 30:
        score += 10
        notes.append(f"RSI {last.RSI:.1f}: ylimyyty.")
    elif last.RSI > 70:
        score -= 10
        notes.append(f"RSI {last.RSI:.1f}: yliostettu.")
    else:
        notes.append(f"RSI {last.RSI:.1f}: neutraali.")

    if last.MACD > last.MACD_SIGNAL:
        score += 8
        notes.append("MACD ostava.")

    if last.MACD < last.MACD_SIGNAL:
        score -= 8
        notes.append("MACD myyvä.")

    c_score, c_notes = candle_score(df_closed)
    score += c_score
    notes.extend(c_notes)

    if last.Volume > last.VOL_MA * 1.25:
        score *= 1.08
        notes.append("Volyymi normaalia suurempi.")

    if range_market:
        score *= 0.65
        notes.append("Range-filteri: sivuttaisliike pienentää varmuutta.")

    if big_bias == "NOUSU" and score < -25:
        score *= 0.65
        notes.append("Myynti isoa nousutrendiä vastaan: varmuutta leikataan.")

    if big_bias == "LASKU" and score > 25:
        score *= 0.65
        notes.append("Osto isoa laskutrendiä vastaan: varmuutta leikataan.")

    live_score, live_alert, live_notes = live_reaction_score(df_live)

    final_score = int(max(-100, min(100, score + live_score * 0.55)))
    raw_level = raw_signal_from_score(final_score)
    level = apply_signal_hysteresis(raw_level, final_score)

    # Live-varoitus saa mennä normaalin signaalin yli, jotta punainen/vihreä nopea liike ei jää huomaamatta.
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

    confidence = int(min(92, max(45, 50 + abs(final_score) * 0.42)))

    atr = max(float(last.ATR), price * 0.001)

    if direction == "OSTA":
        stop = price - atr * 1.25
        target = price + atr * 2.2
    elif direction == "MYY":
        stop = price + atr * 1.25
        target = price - atr * 2.2
    else:
        stop = None
        target = None

    all_notes = notes + live_notes

    return {
        "level": level,
        "direction": direction,
        "score": final_score,
        "closed_score": int(score),
        "live_score": int(live_score),
        "confidence": confidence,
        "price": price,
        "support": support,
        "resistance": resistance,
        "stop": stop,
        "target": target,
        "big_bias": big_bias,
        "details": details,
        "notes": all_notes[:18],
    }


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
        cls, icon = "prebuy", "▲"
    elif level == "TARKKAILU OSTA":
        cls, icon = "watchbuy", "▲"
    elif level == "VAHVA MYY":
        cls, icon = "sell", "▼"
    elif level == "MYY":
        cls, icon = "presell", "▼"
    elif level == "TARKKAILU MYY":
        cls, icon = "watchsell", "▼"
    else:
        cls, icon = "wait", "●"

    st.markdown(
        f'<div class="signal {cls}">{icon} {level}<br>{conf}%</div>',
        unsafe_allow_html=True,
    )


def draw_chart(df_live, ai):
    d = df_live.tail(candle_limit).copy()

    rows = 3 if st.session_state.show_macd_rsi else 1
    row_heights = [0.68, 0.16, 0.16] if st.session_state.show_macd_rsi else [1.0]

    fig = make_subplots(
        rows=rows,
        cols=1,
        shared_xaxes=True,
        vertical_spacing=0.03,
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

    if st.session_state.show_ema9_21:
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA9, mode="lines", name="EMA9", line=dict(width=1.5, color="#38bdf8")), row=1, col=1)
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA21, mode="lines", name="EMA21", line=dict(width=1.5, color="#fb7185")), row=1, col=1)

    if st.session_state.show_ema50_100:
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA50, mode="lines", name="EMA50", line=dict(width=2.5, color="#facc15")), row=1, col=1)
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA100, mode="lines", name="EMA100", line=dict(width=2.5, color="#c084fc")), row=1, col=1)

    if st.session_state.show_bollinger:
        fig.add_trace(go.Scatter(x=d.index, y=d.BB_UPPER, mode="lines", name="BB ylä", line=dict(width=1, color="#94a3b8")), row=1, col=1)
        fig.add_trace(go.Scatter(x=d.index, y=d.BB_LOWER, mode="lines", name="BB ala", line=dict(width=1, color="#94a3b8")), row=1, col=1)

    if st.session_state.show_levels:
        fig.add_hline(y=ai["support"], line_dash="dot", line_color="#22c55e", row=1, col=1)
        fig.add_hline(y=ai["resistance"], line_dash="dot", line_color="#ef4444", row=1, col=1)

    fig.add_hline(y=ai["price"], line_dash="dash", line_color="#facc15", row=1, col=1)

    if ai["direction"] != "ODOTA":
        fig.add_hline(y=ai["stop"], line_dash="dash", line_color="#ef4444", row=1, col=1)
        fig.add_hline(y=ai["target"], line_dash="dash", line_color="#22c55e", row=1, col=1)

    if st.session_state.show_macd_rsi:
        fig.add_trace(go.Scatter(x=d.index, y=d.MACD, mode="lines", name="MACD", line=dict(width=1.5)), row=2, col=1)
        fig.add_trace(go.Scatter(x=d.index, y=d.MACD_SIGNAL, mode="lines", name="MACD Signal", line=dict(width=1.5)), row=2, col=1)
        fig.add_trace(go.Bar(x=d.index, y=d.MACD_HIST, name="MACD Hist"), row=2, col=1)

        fig.add_trace(go.Scatter(x=d.index, y=d.RSI, mode="lines", name="RSI", line=dict(width=2)), row=3, col=1)
        fig.add_hline(y=70, line_dash="dot", line_color="#ef4444", row=3, col=1)
        fig.add_hline(y=30, line_dash="dot", line_color="#22c55e", row=3, col=1)

    fig.update_layout(
        title=f"{selected_name} — V22 DESKTOP PRO LIVE",
        height=820 if st.session_state.show_macd_rsi else 650,
        template="plotly_dark",
        paper_bgcolor="#070d1c",
        plot_bgcolor="#070d1c",
        xaxis_rangeslider_visible=False,
        margin=dict(l=10, r=10, t=48, b=10),
        legend=dict(orientation="h", y=1.02, x=0),
        uirevision="desktop_v22",
    )

    fig.update_xaxes(rangeslider_visible=False)
    st.plotly_chart(fig, use_container_width=True, config={"scrollZoom": True, "responsive": True})


def render_app():
    source = load_or_update_chart_data()
    df_live = add_indicators(st.session_state.chart_df)

    df_closed = df_live.iloc[:-1].copy() if len(df_live) > 30 else df_live.copy()

    big_bias, details = higher_timeframe_bias_cached(symbol)
    ai = ai_engine(df_closed, df_live, big_bias, details)

    st.title("📈 AI Trading Pro v22 Desktop")

    m1, m2, m3, m4, m5, m6 = st.columns(6)
    m1.metric("Kohde", selected_name)
    m2.metric("Hinta", f"{ai['price']:,.4f}")
    m3.metric("AI-score", f"{ai['score']} / 100")
    m4.metric("Suljettu score", ai["closed_score"])
    m5.metric("Live score", ai["live_score"])
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
        if ai["direction"] != "ODOTA":
            st.write(f"Stop: **{ai['stop']:,.4f}**")
            st.write(f"Target: **{ai['target']:,.4f}**")
        else:
            st.write("Ei vielä selkeää paikkaa.")
        st.markdown("</div>", unsafe_allow_html=True)

    with middle:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("📊 Moniaikaväli")
        st.write(f"15m: **{ai['details']['15m']}**")
        st.write(f"1h: **{ai['details']['1h']}**")
        st.write(f"4h: **{ai['details']['4h']}**")
        st.write(f"Iso trendi: **{ai['big_bias']}**")
        st.markdown("</div>", unsafe_allow_html=True)

    with right:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("🧠 Miksi AI näyttää näin?")
        for n in ai["notes"]:
            st.write("• " + n)
        st.markdown("</div>", unsafe_allow_html=True)

    st.warning("Opetustyökalu. Ei tee oikeita kauppoja eikä ole sijoitusneuvo.")


run_every = f"{refresh_seconds}s" if st.session_state.live_on else None


@st.fragment(run_every=run_every)
def live_fragment():
    render_app()


live_fragment()
