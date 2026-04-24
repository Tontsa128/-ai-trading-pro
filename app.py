# -*- coding: utf-8 -*-

from datetime import datetime, timezone
import time
import requests
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st


st.set_page_config(
    page_title="AI Trading Pro v15",
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
h1 {font-size:1.15rem!important; margin-bottom:0.2rem;}
[data-testid="stMetricValue"] {font-size:1rem!important;}
.trade-top{
    background:#111936;
    border:1px solid #26345e;
    border-radius:14px;
    padding:10px;
    color:white;
    margin-bottom:8px;
}
.card,.trade-panel{
    background:#111936;
    border:1px solid #26345e;
    border-radius:14px;
    padding:12px;
    color:white;
}
.buy-box{
    background:linear-gradient(90deg,#16a34a,#22c55e);
    border-radius:14px;
    padding:14px;
    font-size:23px;
    font-weight:900;
    text-align:center;
    color:white;
    margin-top:6px;
}
.prebuy-box{
    background:linear-gradient(90deg,#bbf7d0,#22c55e);
    border-radius:14px;
    padding:14px;
    font-size:21px;
    font-weight:900;
    text-align:center;
    color:#052e16;
    margin-top:6px;
}
.sell-box{
    background:linear-gradient(90deg,#dc2626,#ef4444);
    border-radius:14px;
    padding:14px;
    font-size:23px;
    font-weight:900;
    text-align:center;
    color:white;
    margin-top:6px;
}
.presell-box{
    background:linear-gradient(90deg,#fecaca,#ef4444);
    border-radius:14px;
    padding:14px;
    font-size:21px;
    font-weight:900;
    text-align:center;
    color:#450a0a;
    margin-top:6px;
}
.wait-box{
    background:linear-gradient(90deg,#facc15,#ca8a04);
    border-radius:14px;
    padding:13px;
    font-size:22px;
    font-weight:900;
    text-align:center;
    color:black;
    margin-top:6px;
}
.stButton button {
    font-weight:800;
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
        "demo_balance": 1000.0,
        "open_trade": None,
        "trade_history": [],
        "ticks": [],
        "last_symbol": None,
        "sim_price": None,
        "chart_type": "Kynttilät",
        "show_ema": True,
        "show_sma": False,
        "show_bollinger": False,
        "drawing_tools": False,
        "live_running": True,
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

refresh_seconds = st.sidebar.radio("Live-päivitys", [1, 2, 5], index=0)
candle_count = st.sidebar.slider("Näytettävät kynttilät", 30, 160, 80, 10)

st.sidebar.divider()
st.session_state.chart_type = st.sidebar.radio(
    "Kaaviotyyppi",
    ["Kynttilät", "Viiva", "Alue"],
    index=["Kynttilät", "Viiva", "Alue"].index(st.session_state.chart_type)
)

st.session_state.show_ema = st.sidebar.checkbox("Näytä EMA9 / EMA21", value=st.session_state.show_ema)
st.session_state.show_sma = st.sidebar.checkbox("Näytä SMA20", value=st.session_state.show_sma)
st.session_state.show_bollinger = st.sidebar.checkbox("Näytä Bollinger-viivat", value=st.session_state.show_bollinger)

st.sidebar.divider()
st.session_state.drawing_tools = st.sidebar.toggle(
    "Piirtoviivat päälle",
    value=st.session_state.drawing_tools
)

st.session_state.live_running = st.sidebar.toggle(
    "Live päällä",
    value=st.session_state.live_running
)

if st.sidebar.button("🧹 Tyhjennä kaavio"):
    st.session_state.ticks = []
    st.session_state.sim_price = None
    st.rerun()

if st.session_state.last_symbol != symbol:
    st.session_state.ticks = []
    st.session_state.open_trade = None
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


@st.cache_data(ttl=6, show_spinner=False)
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
    if len(st.session_state.ticks) >= 120:
        return

    now = int(time.time())
    p = float(price)
    total_seconds = max(360, bucket * 160)
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
    return df


def is_green(row):
    return row["Close"] > row["Open"]


def is_red(row):
    return row["Close"] < row["Open"]


def candle_ai(df):
    score = 0
    notes = []

    if len(df) < 3:
        return 0, ["Kerätään vielä kynttilädataa."]

    c = df.iloc[-1]
    p = df.iloc[-2]

    body = abs(c["Close"] - c["Open"])
    rng = max(c["High"] - c["Low"], 0.00000001)
    upper = c["High"] - max(c["Open"], c["Close"])
    lower = min(c["Open"], c["Close"]) - c["Low"]

    if body / rng < 0.12:
        notes.append("Doji: markkina epäröi.")

    if lower > body * 2.0 and is_green(c):
        score += 18
        notes.append("Hammer: ostajat puolustavat alhaalla.")

    if upper > body * 2.0 and is_red(c):
        score -= 18
        notes.append("Shooting Star: myyjät painavat ylhäällä.")

    if is_red(p) and is_green(c) and c["Close"] > p["Open"]:
        score += 24
        notes.append("Bullish Engulfing: BUY-kuvio.")

    if is_green(p) and is_red(c) and c["Close"] < p["Open"]:
        score -= 24
        notes.append("Bearish Engulfing: SELL-kuvio.")

    if not notes:
        notes.append("Ei vahvaa kynttiläkuviota juuri nyt.")

    return score, notes


def ai_signal(df):
    if df.empty or len(df) < 5:
        return {
            "signal": "ODOTA",
            "level": "ODOTA",
            "confidence": 45,
            "score": 0,
            "notes": ["Kerätään dataa. Odota hetki."],
        }

    last = df.iloc[-1]
    prev = df.iloc[-2]

    score = 0
    notes = []
    buy_conf = 0
    sell_conf = 0

    if prev["EMA9"] <= prev["EMA21"] and last["EMA9"] > last["EMA21"]:
        score += 30
        buy_conf += 1
        notes.append("EMA9 ylitti EMA21:n ylöspäin.")

    if prev["EMA9"] >= prev["EMA21"] and last["EMA9"] < last["EMA21"]:
        score -= 30
        sell_conf += 1
        notes.append("EMA9 alitti EMA21:n alaspäin.")

    if last["EMA9"] > last["EMA21"]:
        score += 16
        buy_conf += 1
        notes.append("EMA9 on EMA21:n yläpuolella.")

    if last["EMA9"] < last["EMA21"]:
        score -= 16
        sell_conf += 1
        notes.append("EMA9 on EMA21:n alapuolella.")

    if last["Close"] > last["EMA9"] and last["Close"] > last["EMA21"]:
        score += 12
        buy_conf += 1
        notes.append("Hinta on EMA9/EMA21 yläpuolella.")

    if last["Close"] < last["EMA9"] and last["Close"] < last["EMA21"]:
        score -= 12
        sell_conf += 1
        notes.append("Hinta on EMA9/EMA21 alapuolella.")

    if last["RSI"] < 30:
        score += 12
        buy_conf += 1
        notes.append("RSI alle 30: ylimyyty.")
    elif last["RSI"] > 70:
        score -= 12
        sell_conf += 1
        notes.append("RSI yli 70: yliostettu.")

    if last["MOMENTUM"] > 0:
        score += 8
        buy_conf += 1
        notes.append("Momentum positiivinen.")
    elif last["MOMENTUM"] < 0:
        score -= 8
        sell_conf += 1
        notes.append("Momentum negatiivinen.")

    c_score, c_notes = candle_ai(df)
    score += c_score
    notes.extend(c_notes)

    if c_score > 0:
        buy_conf += 1
    elif c_score < 0:
        sell_conf += 1

    score = int(max(-100, min(100, score)))
    confidence = int(min(96, max(45, 50 + abs(score) * 0.5)))

    if score >= 55 and buy_conf >= 3:
        level = "VAHVA OSTA"
        signal = "OSTA"
    elif score >= 25 and buy_conf >= 2:
        level = "VALMISTAUTUU OSTOON"
        signal = "OSTA"
    elif score <= -55 and sell_conf >= 3:
        level = "VAHVA MYY"
        signal = "MYY"
    elif score <= -25 and sell_conf >= 2:
        level = "VALMISTAUTUU MYYNTIIN"
        signal = "MYY"
    else:
        level = "ODOTA"
        signal = "ODOTA"

    return {
        "signal": signal,
        "level": level,
        "confidence": confidence,
        "score": score,
        "notes": notes,
    }


def open_demo_trade(side, price, amount):
    if st.session_state.open_trade is not None:
        st.toast("Sulje ensin nykyinen harjoituskauppa.")
        return

    if amount > st.session_state.demo_balance:
        st.toast("Demo-saldo ei riitä.")
        return

    st.session_state.demo_balance -= amount
    st.session_state.open_trade = {
        "side": side,
        "entry": float(price),
        "amount": float(amount),
        "opened": datetime.now().strftime("%H:%M:%S"),
        "symbol": selected_name,
    }


def close_demo_trade(price):
    trade = st.session_state.open_trade
    if trade is None:
        return

    entry = trade["entry"]
    amount = trade["amount"]

    if trade["side"] == "BUY":
        pnl_pct = (price - entry) / entry
    else:
        pnl_pct = (entry - price) / entry

    pnl = amount * pnl_pct
    st.session_state.demo_balance += amount + pnl

    st.session_state.trade_history.insert(0, {
        "Aika": datetime.now().strftime("%H:%M:%S"),
        "Kohde": trade["symbol"],
        "Suunta": trade["side"],
        "Sisään": round(entry, 6),
        "Ulos": round(price, 6),
        "Panos": round(amount, 2),
        "Tulos $": round(pnl, 4),
        "Tulos %": round(pnl_pct * 100, 4),
    })

    st.session_state.open_trade = None


def current_open_pnl(price):
    trade = st.session_state.open_trade
    if trade is None:
        return 0.0, 0.0

    if trade["side"] == "BUY":
        pnl_pct = (price - trade["entry"]) / trade["entry"]
    else:
        pnl_pct = (trade["entry"] - price) / trade["entry"]

    return trade["amount"] * pnl_pct, pnl_pct * 100


def signal_box(ai):
    level = ai["level"]
    conf = ai["confidence"]

    if level == "VAHVA OSTA":
        html = f'<div class="buy-box">▲ VAHVA OSTA — {conf}%</div>'
    elif level == "VALMISTAUTUU OSTOON":
        html = f'<div class="prebuy-box">▲ VALMISTAUTUU OSTOON — {conf}%</div>'
    elif level == "VAHVA MYY":
        html = f'<div class="sell-box">▼ VAHVA MYY — {conf}%</div>'
    elif level == "VALMISTAUTUU MYYNTIIN":
        html = f'<div class="presell-box">▼ VALMISTAUTUU MYYNTIIN — {conf}%</div>'
    else:
        html = f'<div class="wait-box">● ODOTA — {conf}%</div>'

    st.markdown(html, unsafe_allow_html=True)


def draw_chart(df, name, count, open_trade=None):
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
        fig.add_trace(go.Scatter(
            x=x,
            y=df_plot["EMA9"],
            mode="lines",
            name="EMA9",
            line=dict(width=2, color="#60a5fa"),
        ))
        fig.add_trace(go.Scatter(
            x=x,
            y=df_plot["EMA21"],
            mode="lines",
            name="EMA21",
            line=dict(width=2, color="#f87171"),
        ))

    if st.session_state.show_sma:
        fig.add_trace(go.Scatter(
            x=x,
            y=df_plot["SMA20"],
            mode="lines",
            name="SMA20",
            line=dict(width=2, color="#facc15"),
        ))

    if st.session_state.show_bollinger:
        fig.add_trace(go.Scatter(
            x=x,
            y=df_plot["BB_UPPER"],
            mode="lines",
            name="BB ylä",
            line=dict(width=1, color="#a78bfa"),
        ))
        fig.add_trace(go.Scatter(
            x=x,
            y=df_plot["BB_LOWER"],
            mode="lines",
            name="BB ala",
            line=dict(width=1, color="#a78bfa"),
        ))

    if open_trade is not None:
        fig.add_hline(
            y=open_trade["entry"],
            line_dash="dash",
            line_color="#facc15",
            annotation_text=f"ENTRY {open_trade['side']}",
            annotation_position="top left",
        )

    dragmode = "drawline" if st.session_state.drawing_tools else "pan"

    fig.update_layout(
        title=f"{name} — LIVE KAAVIO",
        height=430,
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
        config["modeBarButtonsToAdd"] = [
            "drawline",
            "drawopenpath",
            "drawrect",
            "eraseshape",
        ]

    st.plotly_chart(fig, use_container_width=True, config=config)


def run_tick_update():
    price, source = get_price()
    seed_ticks(price, bucket_seconds)
    add_tick(price)
    candles = ticks_to_candles(bucket_seconds)
    df = add_indicators(candles)
    return price, source, df


run_every_value = f"{refresh_seconds}s" if st.session_state.live_running else None


@st.fragment(run_every=run_every_value)
def live_area():
    price, source, df = run_tick_update()
    ai = ai_signal(df)
    open_pnl, open_pnl_pct = current_open_pnl(price)

    st.title("📈 AI Trading Pro v15")

    m1, m2, m3, m4, m5 = st.columns(5)
    m1.metric("Kohde", selected_name)
    m2.metric("Hinta", f"{price:,.4f}")
    m3.metric("Saldo", f"${st.session_state.demo_balance:,.2f}")
    m4.metric("Avoin P/L", f"${open_pnl:,.4f}", f"{open_pnl_pct:.3f}%")
    m5.metric("AI", f"{ai['score']} / 100")

    st.caption(f"Datalähde: {source} | Päivitetty: {datetime.now().strftime('%H:%M:%S')}")

    st.markdown('<div class="trade-top">', unsafe_allow_html=True)
    c1, c2, c3, c4 = st.columns([1, 1, 1, 1])

    with c1:
        amount = st.number_input("Panos $", min_value=1.0, value=10.0, step=1.0, key="top_amount")

    with c2:
        if st.button("▲ OSTA", use_container_width=True, key="top_buy"):
            open_demo_trade("BUY", price, amount)
            st.rerun()

    with c3:
        if st.button("▼ MYY", use_container_width=True, key="top_sell"):
            open_demo_trade("SELL", price, amount)
            st.rerun()

    with c4:
        if st.session_state.open_trade:
            if st.button("✅ SULJE", use_container_width=True, key="top_close"):
                close_demo_trade(price)
                st.rerun()
        else:
            st.write("Ei avointa")

    if st.session_state.open_trade:
        t = st.session_state.open_trade
        st.write(
            f"Avoin: **{t['side']}** | Sisään: **{t['entry']:,.4f}** | "
            f"Panos: **${t['amount']:.2f}** | P/L: **${open_pnl:.4f} / {open_pnl_pct:.3f}%**"
        )

    st.markdown("</div>", unsafe_allow_html=True)

    signal_box(ai)

    draw_chart(df, selected_name, candle_count, st.session_state.open_trade)

    with st.expander("🎮 Lisää demo-rahaa / asetukset"):
        add_money = st.number_input("Lisää leikkirahaa", min_value=0.0, value=0.0, step=100.0)
        if st.button("➕ Lisää saldoon", use_container_width=True):
            st.session_state.demo_balance += add_money
            st.rerun()

    col_a, col_b = st.columns([1, 1])

    with col_a:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("🧠 Miksi botti näyttää näin?")
        for note in ai["notes"][:8]:
            st.write("• " + note)
        st.markdown("</div>", unsafe_allow_html=True)

    with col_b:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("📊 Live-info")
        st.write(f"Kynttiläaika: **{tf_name}**")
        st.write(f"Päivitys: **{refresh_seconds}s**")
        st.write(f"Kynttilöitä muistissa: **{len(df)}**")
        st.write(f"Kaaviotyyppi: **{st.session_state.chart_type}**")
        st.write(f"Piirtoviivat: **{'Päällä' if st.session_state.drawing_tools else 'Pois'}**")
        st.markdown("</div>", unsafe_allow_html=True)

    st.subheader("📜 Harjoituskauppojen historia")
    if st.session_state.trade_history:
        hist = pd.DataFrame(st.session_state.trade_history)
        st.dataframe(hist, use_container_width=True, hide_index=True)
    else:
        st.info("Ei vielä suljettuja harjoituskauppoja.")

    st.warning("Demotyökalu. Ei tee oikeita kauppoja eikä ole sijoitusneuvo.")


live_area()
