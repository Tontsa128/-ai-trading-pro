# -*- coding: utf-8 -*-

from datetime import datetime, timezone
import time
import requests
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st


st.set_page_config(
    page_title="AI Trading Pro v16",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="collapsed"
)

st.markdown("""
<style>
.block-container {
    padding-top:0.25rem;
    padding-left:0.55rem;
    padding-right:0.55rem;
}
h1 {
    font-size:1.15rem!important;
    margin-bottom:0.2rem;
}
[data-testid="stMetricValue"] {
    font-size:1rem!important;
}
.signal-buy {
    background:linear-gradient(90deg,#16a34a,#22c55e);
    border-radius:14px;
    padding:14px;
    font-size:24px;
    font-weight:900;
    text-align:center;
    color:white;
    margin-top:6px;
    margin-bottom:8px;
}
.signal-prebuy {
    background:linear-gradient(90deg,#bbf7d0,#22c55e);
    border-radius:14px;
    padding:14px;
    font-size:22px;
    font-weight:900;
    text-align:center;
    color:#052e16;
    margin-top:6px;
    margin-bottom:8px;
}
.signal-sell {
    background:linear-gradient(90deg,#dc2626,#ef4444);
    border-radius:14px;
    padding:14px;
    font-size:24px;
    font-weight:900;
    text-align:center;
    color:white;
    margin-top:6px;
    margin-bottom:8px;
}
.signal-presell {
    background:linear-gradient(90deg,#fecaca,#ef4444);
    border-radius:14px;
    padding:14px;
    font-size:22px;
    font-weight:900;
    text-align:center;
    color:#450a0a;
    margin-top:6px;
    margin-bottom:8px;
}
.signal-wait {
    background:linear-gradient(90deg,#facc15,#ca8a04);
    border-radius:14px;
    padding:14px;
    font-size:23px;
    font-weight:900;
    text-align:center;
    color:black;
    margin-top:6px;
    margin-bottom:8px;
}
.card {
    background:#111936;
    border:1px solid #26345e;
    border-radius:14px;
    padding:12px;
    color:white;
    margin-bottom:10px;
}
.good {
    color:#22c55e;
    font-weight:800;
}
.bad {
    color:#ef4444;
    font-weight:800;
}
.warn {
    color:#facc15;
    font-weight:800;
}
.stButton button {
    font-weight:900;
    border-radius:12px;
}
</style>
""", unsafe_allow_html=True)


SYMBOLS = {
    "BTC / USDT": {"binance": "BTCUSDT", "coingecko": "bitcoin", "base": 78000},
    "ETH / USDT": {"binance": "ETHUSDT", "coingecko": "ethereum", "base": 3500},
    "SOL / USDT": {"binance": "SOLUSDT", "coingecko": "solana", "base": 150},
    "BNB / USDT": {"binance": "BNBUSDT", "coingecko": "binancecoin", "base": 600},
    "XRP / USDT": {"binance": "XRPUSDT", "coingecko": "ripple", "base": 0.55},
    "DOGE / USDT": {"binance": "DOGEUSDT", "coingecko": "dogecoin", "base": 0.15},
}

TIMEFRAMES = {
    "1S": 1,
    "5S": 5,
    "15S": 15,
    "30S": 30,
    "1M": 60,
}


def init_state():
    defaults = {
        "ticks": [],
        "last_symbol": None,
        "sim_price": None,
        "chart_type": "Kynttilät",
        "show_ema": True,
        "show_sma": False,
        "show_bollinger": False,
        "show_levels": True,
        "drawing_tools": False,
    }
    for k, v in defaults.items():
        if k not in st.session_state:
            st.session_state[k] = v


init_state()


st.sidebar.title("⚙️ Asetukset")

selected_name = st.sidebar.selectbox("Kohde", list(SYMBOLS.keys()), index=0)
selected = SYMBOLS[selected_name]
symbol = selected["binance"]
coingecko_id = selected["coingecko"]

tf_name = st.sidebar.radio("Kynttiläaika", list(TIMEFRAMES.keys()), index=1)
bucket_seconds = TIMEFRAMES[tf_name]

candle_count = st.sidebar.slider("Näytettävät kynttilät", 30, 160, 80, 10)

st.sidebar.divider()

st.session_state.chart_type = st.sidebar.radio(
    "Kaaviotyyppi",
    ["Kynttilät", "Viiva", "Alue"],
    index=["Kynttilät", "Viiva", "Alue"].index(st.session_state.chart_type)
)

st.session_state.show_ema = st.sidebar.checkbox("EMA9 / EMA21", value=st.session_state.show_ema)
st.session_state.show_sma = st.sidebar.checkbox("SMA20", value=st.session_state.show_sma)
st.session_state.show_bollinger = st.sidebar.checkbox("Bollinger", value=st.session_state.show_bollinger)
st.session_state.show_levels = st.sidebar.checkbox("Support / resistance", value=st.session_state.show_levels)

st.sidebar.divider()

st.session_state.drawing_tools = st.sidebar.toggle(
    "Piirtoviivat päälle",
    value=st.session_state.drawing_tools
)

if st.sidebar.button("🧹 Tyhjennä kaavio"):
    st.session_state.ticks = []
    st.session_state.sim_price = None
    st.rerun()

if st.session_state.last_symbol != symbol:
    st.session_state.ticks = []
    st.session_state.last_symbol = symbol
    st.session_state.sim_price = None


@st.cache_data(ttl=1, show_spinner=False)
def get_binance_price(symbol_code):
    urls = [
        f"https://api.binance.com/api/v3/ticker/price?symbol={symbol_code}",
        f"https://api1.binance.com/api/v3/ticker/price?symbol={symbol_code}",
        f"https://api2.binance.com/api/v3/ticker/price?symbol={symbol_code}",
        f"https://api3.binance.com/api/v3/ticker/price?symbol={symbol_code}",
    ]
    for url in urls:
        try:
            r = requests.get(url, timeout=4, headers={"User-Agent": "Mozilla/5.0"})
            r.raise_for_status()
            return float(r.json()["price"]), "Binance live"
        except Exception:
            pass
    raise RuntimeError("Binance ei vastannut")


@st.cache_data(ttl=8, show_spinner=False)
def get_coingecko_price(coin_id):
    url = "https://api.coingecko.com/api/v3/simple/price"
    params = {"ids": coin_id, "vs_currencies": "usd"}
    r = requests.get(url, params=params, timeout=5, headers={"User-Agent": "Mozilla/5.0"})
    r.raise_for_status()
    data = r.json()
    return float(data[coin_id]["usd"]), "CoinGecko varahaku"


def get_demo_price(base_price):
    if st.session_state.sim_price is None:
        st.session_state.sim_price = float(base_price)
    st.session_state.sim_price *= 1 + np.random.normal(0, 0.0009)
    return float(st.session_state.sim_price), "Demo-simulaatio"


def get_price():
    try:
        return get_binance_price(symbol)
    except Exception:
        try:
            price, source = get_coingecko_price(coingecko_id)
            if st.session_state.sim_price is None:
                st.session_state.sim_price = price
            st.session_state.sim_price *= 1 + np.random.normal(0, 0.00045)
            return float(st.session_state.sim_price), source + " + harjoitusliike"
        except Exception:
            return get_demo_price(selected["base"])


def seed_ticks(price, bucket):
    if len(st.session_state.ticks) >= 140:
        return

    now = int(time.time())
    p = float(price)
    total_seconds = max(420, bucket * 180)
    ticks = []

    for i in range(total_seconds, 0, -1):
        p *= 1 + np.random.normal(0, 0.00035)
        t = now - i
        ticks.append({
            "time": t,
            "datetime": datetime.fromtimestamp(t, tz=timezone.utc),
            "price": float(p),
        })

    st.session_state.ticks = ticks


def add_tick(price):
    now = int(time.time())
    price = float(price)

    if st.session_state.ticks:
        last_price = float(st.session_state.ticks[-1]["price"])

        if abs(price - last_price) / max(abs(last_price), 0.000001) < 0.000001:
            price = last_price * (1 + np.random.normal(0, 0.00025))

        if st.session_state.ticks[-1]["time"] == now:
            now += 1

    st.session_state.ticks.append({
        "time": now,
        "datetime": datetime.fromtimestamp(now, tz=timezone.utc),
        "price": float(price),
    })

    if len(st.session_state.ticks) > 6000:
        st.session_state.ticks = st.session_state.ticks[-6000:]


def ticks_to_candles(bucket):
    if len(st.session_state.ticks) < 20:
        return pd.DataFrame()

    df = pd.DataFrame(st.session_state.ticks)
    df["bucket"] = (df["time"] // bucket) * bucket

    candles = df.groupby("bucket").agg(
        Open=("price", "first"),
        High=("price", "max"),
        Low=("price", "min"),
        Close=("price", "last"),
    ).reset_index()

    candles["Date"] = pd.to_datetime(candles["bucket"], unit="s", utc=True)
    candles = candles.set_index("Date")
    return candles[["Open", "High", "Low", "Close"]]


def rsi(close, period=14):
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)

    avg_gain = gain.rolling(period, min_periods=3).mean()
    avg_loss = loss.rolling(period, min_periods=3).mean()

    rs = avg_gain / avg_loss.replace(0, np.nan)
    return (100 - (100 / (1 + rs))).fillna(50).clip(0, 100)


def add_indicators(df):
    if df.empty:
        return df

    df = df.copy()
    df["EMA9"] = df["Close"].ewm(span=9, adjust=False).mean()
    df["EMA21"] = df["Close"].ewm(span=21, adjust=False).mean()
    df["SMA20"] = df["Close"].rolling(20, min_periods=3).mean()
    df["STD20"] = df["Close"].rolling(20, min_periods=3).std().fillna(0)
    df["BB_UPPER"] = df["SMA20"] + 2 * df["STD20"]
    df["BB_LOWER"] = df["SMA20"] - 2 * df["STD20"]
    df["RSI"] = rsi(df["Close"])
    df["MOMENTUM"] = df["Close"].pct_change(3).fillna(0) * 100
    df["VOLATILITY"] = ((df["High"] - df["Low"]) / df["Close"]).fillna(0) * 100
    return df


def is_green(row):
    return row["Close"] > row["Open"]


def is_red(row):
    return row["Close"] < row["Open"]


def swing_levels(df, lookback=40):
    if df.empty or len(df) < 10:
        return None, None

    recent = df.tail(lookback)
    support = float(recent["Low"].min())
    resistance = float(recent["High"].max())
    return support, resistance


def candle_ai(df):
    score = 0
    notes = []

    if len(df) < 4:
        return 0, ["Kerätään kynttilädataa."]

    c = df.iloc[-1]
    p = df.iloc[-2]
    p2 = df.iloc[-3]

    body = abs(c["Close"] - c["Open"])
    rng = max(c["High"] - c["Low"], 0.00000001)
    upper = c["High"] - max(c["Open"], c["Close"])
    lower = min(c["Open"], c["Close"]) - c["Low"]

    if body / rng < 0.12:
        notes.append("Doji: markkina epäröi, ei vahvaa suuntaa.")

    if lower > body * 2.0 and is_green(c):
        score += 14
        notes.append("Hammer: ostajat puolustivat alhaalta.")

    if upper > body * 2.0 and is_red(c):
        score -= 14
        notes.append("Shooting Star: myyjät torjuivat nousun.")

    if is_red(p) and is_green(c) and c["Close"] > p["Open"]:
        score += 20
        notes.append("Bullish Engulfing: ostajat ottivat kynttilän haltuun.")

    if is_green(p) and is_red(c) and c["Close"] < p["Open"]:
        score -= 20
        notes.append("Bearish Engulfing: myyjät ottivat kynttilän haltuun.")

    if is_red(p2) and is_red(p) and is_green(c) and c["Close"] > p["Close"]:
        score += 12
        notes.append("Mahdollinen Morning Star -tyyppinen käännös.")

    if is_green(p2) and is_green(p) and is_red(c) and c["Close"] < p["Close"]:
        score -= 12
        notes.append("Mahdollinen Evening Star -tyyppinen käännös.")

    if not notes:
        notes.append("Ei selvää yksittäistä kynttiläkuviota juuri nyt.")

    return score, notes


def pattern_ai(df):
    score = 0
    notes = []

    if len(df) < 25:
        return 0, ["Kuviotunnistus kerää vielä dataa."]

    recent = df.tail(40).copy()
    close = recent["Close"]

    high1 = recent["High"].iloc[-25:-12].max()
    high2 = recent["High"].iloc[-12:].max()
    low1 = recent["Low"].iloc[-25:-12].min()
    low2 = recent["Low"].iloc[-12:].min()

    price_now = float(close.iloc[-1])
    tolerance = 0.004

    if abs(low1 - low2) / max(price_now, 0.000001) < tolerance and price_now > recent["Close"].iloc[-8:].mean():
        score += 14
        notes.append("Double Bottom -tyyppinen W-pohja mahdollinen: ostajat puolustavat samaa aluetta.")

    if abs(high1 - high2) / max(price_now, 0.000001) < tolerance and price_now < recent["Close"].iloc[-8:].mean():
        score -= 14
        notes.append("Double Top -tyyppinen M-huippu mahdollinen: nousu torjutaan samalta alueelta.")

    lows = recent["Low"].tail(18).values
    highs = recent["High"].tail(18).values

    if len(lows) >= 18:
        low_slope = np.polyfit(range(len(lows)), lows, 1)[0]
        high_slope = np.polyfit(range(len(highs)), highs, 1)[0]

        if low_slope > 0 and abs(high_slope) < abs(low_slope) * 0.45:
            score += 12
            notes.append("Ascending Triangle: nousevat pohjat painavat kohti vastusta.")

        if high_slope < 0 and abs(low_slope) < abs(high_slope) * 0.45:
            score -= 12
            notes.append("Descending Triangle: laskevat huiput painavat kohti tukea.")

        if low_slope > 0 and high_slope > 0 and price_now > recent["Close"].tail(18).mean():
            score += 8
            notes.append("Bullish Flag / jatkokuviota muistuttava rakenne.")

        if low_slope < 0 and high_slope < 0 and price_now < recent["Close"].tail(18).mean():
            score -= 8
            notes.append("Bearish Flag / jatkokuviota muistuttava rakenne.")

    if not notes:
        notes.append("Ei vahvaa isoa kuviota juuri nyt.")

    return score, notes


def ai_signal(df):
    if df.empty or len(df) < 5:
        return {
            "level": "ODOTA",
            "direction": "NEUTRAALI",
            "confidence": 45,
            "score": 0,
            "entry": None,
            "stop": None,
            "target": None,
            "notes": ["Kerätään dataa. Paina hetken päästä Päivitä analyysi."],
        }

    last = df.iloc[-1]
    prev = df.iloc[-2]
    price = float(last["Close"])

    score = 0
    notes = []
    buy_conf = 0
    sell_conf = 0

    if prev["EMA9"] <= prev["EMA21"] and last["EMA9"] > last["EMA21"]:
        score += 26
        buy_conf += 1
        notes.append("EMA9 ylitti EMA21:n ylöspäin: mahdollinen ostosignaali.")

    if prev["EMA9"] >= prev["EMA21"] and last["EMA9"] < last["EMA21"]:
        score -= 26
        sell_conf += 1
        notes.append("EMA9 alitti EMA21:n alaspäin: mahdollinen myyntisignaali.")

    if last["EMA9"] > last["EMA21"]:
        score += 12
        buy_conf += 1
        notes.append("EMA9 on EMA21:n yläpuolella: lyhyt trendi tukee nousua.")

    if last["EMA9"] < last["EMA21"]:
        score -= 12
        sell_conf += 1
        notes.append("EMA9 on EMA21:n alapuolella: lyhyt trendi tukee laskua.")

    if price > last["EMA9"] and price > last["EMA21"]:
        score += 10
        buy_conf += 1
        notes.append("Hinta on molempien EMA-viivojen yläpuolella.")

    if price < last["EMA9"] and price < last["EMA21"]:
        score -= 10
        sell_conf += 1
        notes.append("Hinta on molempien EMA-viivojen alapuolella.")

    if last["RSI"] < 30:
        score += 10
        buy_conf += 1
        notes.append("RSI alle 30: ylimyyty alue, mahdollinen nousukäännös.")
    elif last["RSI"] > 70:
        score -= 10
        sell_conf += 1
        notes.append("RSI yli 70: yliostettu alue, mahdollinen laskukäännös.")
    else:
        notes.append(f"RSI {last['RSI']:.1f}: neutraalimpi alue.")

    if last["MOMENTUM"] > 0:
        score += 7
        buy_conf += 1
        notes.append("Momentum positiivinen.")
    elif last["MOMENTUM"] < 0:
        score -= 7
        sell_conf += 1
        notes.append("Momentum negatiivinen.")

    c_score, c_notes = candle_ai(df)
    p_score, p_notes = pattern_ai(df)

    score += c_score + p_score
    notes.extend(c_notes)
    notes.extend(p_notes)

    if c_score + p_score > 0:
        buy_conf += 1
    elif c_score + p_score < 0:
        sell_conf += 1

    support, resistance = swing_levels(df)

    if support and resistance:
        if price > resistance * 0.999:
            score += 8
            buy_conf += 1
            notes.append("Hinta painaa vastustason lähelle: breakout-riski ylöspäin.")
        elif price < support * 1.001:
            score -= 8
            sell_conf += 1
            notes.append("Hinta painaa tukitason lähelle: breakdown-riski alaspäin.")
        else:
            notes.append("Hinta on tuen ja vastuksen välissä.")

    score = int(max(-100, min(100, score)))
    confidence = int(min(96, max(45, 50 + abs(score) * 0.46)))

    if score >= 60 and buy_conf >= 4:
        level = "VAHVA OSTA"
        direction = "OSTA"
    elif score >= 28 and buy_conf >= 3:
        level = "VALMISTAUTUU OSTOON"
        direction = "OSTA"
    elif score <= -60 and sell_conf >= 4:
        level = "VAHVA MYY"
        direction = "MYY"
    elif score <= -28 and sell_conf >= 3:
        level = "VALMISTAUTUU MYYNTIIN"
        direction = "MYY"
    else:
        level = "ODOTA"
        direction = "NEUTRAALI"

    entry = price
    stop = None
    target = None

    if support and resistance:
        risk = max(abs(price - support), price * 0.0015)

        if direction == "OSTA":
            stop = support
            target = price + risk * 1.6

        elif direction == "MYY":
            stop = resistance
            target = price - abs(resistance - price) * 1.6

    return {
        "level": level,
        "direction": direction,
        "confidence": confidence,
        "score": score,
        "entry": entry,
        "stop": stop,
        "target": target,
        "notes": notes,
    }


def signal_box(ai):
    level = ai["level"]
    conf = ai["confidence"]

    if level == "VAHVA OSTA":
        html = f'<div class="signal-buy">▲ VAHVA OSTA — {conf}%</div>'
    elif level == "VALMISTAUTUU OSTOON":
        html = f'<div class="signal-prebuy">▲ VALMISTAUTUU OSTOON — {conf}%</div>'
    elif level == "VAHVA MYY":
        html = f'<div class="signal-sell">▼ VAHVA MYY — {conf}%</div>'
    elif level == "VALMISTAUTUU MYYNTIIN":
        html = f'<div class="signal-presell">▼ VALMISTAUTUU MYYNTIIN — {conf}%</div>'
    else:
        html = f'<div class="signal-wait">● ODOTA — {conf}%</div>'

    st.markdown(html, unsafe_allow_html=True)


def draw_chart(df, ai, name, count):
    if df.empty or len(df) < 3:
        st.warning("Kaavio kerää vielä dataa.")
        return

    df_plot = df.tail(count).copy()
    x = df_plot.index

    fig = go.Figure()

    if st.session_state.chart_type == "Kynttilät":
        fig.add_trace(go.Candlestick(
            x=x,
            open=df_plot["Open"],
            high=df_plot["High"],
            low=df_plot["Low"],
            close=df_plot["Close"],
            name="Kynttilät",
            increasing_line_color="#00ff66",
            decreasing_line_color="#ff3344",
            increasing_fillcolor="#00ff66",
            decreasing_fillcolor="#ff3344",
            whiskerwidth=0.75,
        ))
    elif st.session_state.chart_type == "Viiva":
        fig.add_trace(go.Scatter(
            x=x,
            y=df_plot["Close"],
            mode="lines",
            name="Hinta",
            line=dict(width=3, color="#00ff66"),
        ))
    else:
        fig.add_trace(go.Scatter(
            x=x,
            y=df_plot["Close"],
            mode="lines",
            fill="tozeroy",
            name="Hinta",
            line=dict(width=2, color="#00ff66"),
        ))

    if st.session_state.show_ema:
        fig.add_trace(go.Scatter(x=x, y=df_plot["EMA9"], mode="lines", name="EMA9", line=dict(width=2, color="#60a5fa")))
        fig.add_trace(go.Scatter(x=x, y=df_plot["EMA21"], mode="lines", name="EMA21", line=dict(width=2, color="#f87171")))

    if st.session_state.show_sma:
        fig.add_trace(go.Scatter(x=x, y=df_plot["SMA20"], mode="lines", name="SMA20", line=dict(width=2, color="#facc15")))

    if st.session_state.show_bollinger:
        fig.add_trace(go.Scatter(x=x, y=df_plot["BB_UPPER"], mode="lines", name="BB ylä", line=dict(width=1, color="#a78bfa")))
        fig.add_trace(go.Scatter(x=x, y=df_plot["BB_LOWER"], mode="lines", name="BB ala", line=dict(width=1, color="#a78bfa")))

    support, resistance = swing_levels(df)

    if st.session_state.show_levels and support and resistance:
        fig.add_hline(y=support, line_dash="dot", line_color="#22c55e", annotation_text="SUPPORT", annotation_position="bottom left")
        fig.add_hline(y=resistance, line_dash="dot", line_color="#ef4444", annotation_text="RESISTANCE", annotation_position="top left")

    if ai["entry"]:
        fig.add_hline(y=ai["entry"], line_dash="dash", line_color="#facc15", annotation_text="ENTRY / NYKYHINTA", annotation_position="top left")

    if ai["stop"]:
        fig.add_hline(y=ai["stop"], line_dash="dash", line_color="#ef4444", annotation_text="STOP", annotation_position="bottom left")

    if ai["target"]:
        fig.add_hline(y=ai["target"], line_dash="dash", line_color="#22c55e", annotation_text="TARGET", annotation_position="top left")

    dragmode = "drawline" if st.session_state.drawing_tools else "pan"

    fig.update_layout(
        title=f"{name} — AI KAAVIO",
        height=420,
        template="plotly_dark",
        paper_bgcolor="#070d1c",
        plot_bgcolor="#070d1c",
        xaxis_rangeslider_visible=False,
        margin=dict(l=5, r=5, t=42, b=5),
        legend=dict(orientation="h", y=1.04, x=0),
        dragmode=dragmode,
        newshape=dict(line_color="#facc15", line_width=2),
        xaxis=dict(showgrid=True, nticks=5, tickformat="%H:%M:%S"),
        yaxis=dict(showgrid=True),
    )

    config = {
        "displayModeBar": st.session_state.drawing_tools,
        "responsive": True,
        "scrollZoom": False,
        "doubleClick": "reset",
    }

    if st.session_state.drawing_tools:
        config["modeBarButtonsToAdd"] = ["drawline", "drawopenpath", "drawrect", "eraseshape"]

    st.plotly_chart(fig, use_container_width=True, config=config)


def risk_text(ai):
    if ai["entry"] is None:
        return

    st.markdown('<div class="card">', unsafe_allow_html=True)
    st.subheader("🎯 AI entry / stop / target")

    st.write(f"Nykyhinta / Entry: **{ai['entry']:,.4f}**")

    if ai["stop"] and ai["target"]:
        st.write(f"Stop loss: **{ai['stop']:,.4f}**")
        st.write(f"Target: **{ai['target']:,.4f}**")
    else:
        st.write("Stop/target odottaa selkeämpää support/resistance-aluetta.")

    st.markdown("</div>", unsafe_allow_html=True)


st.title("📈 AI Trading Pro v16")

if st.button("🔄 Päivitä analyysi", use_container_width=True):
    st.rerun()

price, source = get_price()
seed_ticks(price, bucket_seconds)
add_tick(price)

candles = ticks_to_candles(bucket_seconds)
df = add_indicators(candles)
ai = ai_signal(df)

m1, m2, m3, m4 = st.columns(4)
m1.metric("Kohde", selected_name)
m2.metric("Hinta", f"{price:,.4f}")
m3.metric("AI-score", f"{ai['score']} / 100")
m4.metric("Suunta", ai["direction"])

st.caption(f"Datalähde: {source} | Päivitetty: {datetime.now().strftime('%H:%M:%S')}")

signal_box(ai)

draw_chart(df, ai, selected_name, candle_count)

risk_text(ai)

col_a, col_b = st.columns([1, 1])

with col_a:
    st.markdown('<div class="card">', unsafe_allow_html=True)
    st.subheader("🧠 Miksi AI näyttää näin?")
    for note in ai["notes"][:12]:
        st.write("• " + note)
    st.markdown("</div>", unsafe_allow_html=True)

with col_b:
    st.markdown('<div class="card">', unsafe_allow_html=True)
    st.subheader("📚 AI:n oppisäännöt")
    st.write("• EMA9 yli EMA21 = nousupaine")
    st.write("• EMA9 alle EMA21 = laskupaine")
    st.write("• Double Bottom = mahdollinen ostokäännös")
    st.write("• Double Top = mahdollinen myyntikäännös")
    st.write("• Ascending Triangle = breakout-riski ylös")
    st.write("• Descending Triangle = breakdown-riski alas")
    st.write("• Bullish/Bearish Flag = trendin jatkuminen")
    st.write("• Support / Resistance määrää stopin ja targetin")
    st.markdown("</div>", unsafe_allow_html=True)

st.warning("Tämä on opetustyökalu. Se ei tee oikeita kauppoja eikä ole sijoitusneuvo.")
