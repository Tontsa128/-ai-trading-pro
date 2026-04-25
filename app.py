# -*- coding: utf-8 -*-
import streamlit as st
import pandas as pd
import numpy as np
import yfinance as yf
import plotly.graph_objects as go
from datetime import datetime

st.set_page_config(
    page_title="AI Treidiapuri V10 PRO",
    layout="wide",
    initial_sidebar_state="expanded"
)

# -----------------------------
# STYLE
# -----------------------------
st.markdown("""
<style>
.stApp {
    background: #07111f;
    color: white;
}
.big-card {
    padding: 28px;
    border-radius: 28px;
    text-align: center;
    font-size: 34px;
    font-weight: 900;
    margin-bottom: 18px;
}
.buy-ready {
    background: linear-gradient(90deg,#bbf7d0,#22c55e);
    color: #052e16;
}
.sell-ready {
    background: linear-gradient(90deg,#fecaca,#ef4444);
    color: #450a0a;
}
.wait-card {
    background: linear-gradient(90deg,#fef3c7,#facc15);
    color: #422006;
}
.info-box {
    background:#0f172a;
    padding:18px;
    border-radius:18px;
    border:1px solid #334155;
}
</style>
""", unsafe_allow_html=True)

# -----------------------------
# SIDEBAR
# -----------------------------
st.sidebar.title("AI Treidiapuri V10 PRO")

symbol = st.sidebar.selectbox(
    "Valitse kohde",
    ["BTC-USD", "ETH-USD", "EURUSD=X", "GC=F", "AAPL", "TSLA", "NVDA"],
    index=0
)

period = st.sidebar.selectbox(
    "Historia",
    ["1d", "5d", "7d", "1mo", "3mo"],
    index=1
)

interval = st.sidebar.selectbox(
    "Aikaväli",
    ["1m", "2m", "5m", "15m", "30m", "1h"],
    index=2
)

demo_start = st.sidebar.number_input("Demoraha €", value=1000.0, step=100.0)
trade_amount = st.sidebar.number_input("Yhden kaupan koko €", value=100.0, step=10.0)

refresh = st.sidebar.button("Päivitä nyt")

# -----------------------------
# DATA
# -----------------------------
@st.cache_data(ttl=30)
def load_data(symbol, period, interval):
    df = yf.download(
        symbol,
        period=period,
        interval=interval,
        progress=False,
        auto_adjust=False
    )

    if df.empty:
        return pd.DataFrame()

    if isinstance(df.columns, pd.MultiIndex):
        df.columns = df.columns.get_level_values(0)

    df = df.dropna()
    return df

df = load_data(symbol, period, interval)

if df.empty or len(df) < 60:
    st.error("Dataa ei saatu tarpeeksi. Kokeile eri aikaväliä, esimerkiksi 5m / 7d.")
    st.stop()

# -----------------------------
# INDICATORS
# -----------------------------
df["EMA5"] = df["Close"].ewm(span=5, adjust=False).mean()
df["EMA9"] = df["Close"].ewm(span=9, adjust=False).mean()
df["EMA21"] = df["Close"].ewm(span=21, adjust=False).mean()
df["EMA50"] = df["Close"].ewm(span=50, adjust=False).mean()
df["EMA100"] = df["Close"].ewm(span=100, adjust=False).mean()

delta = df["Close"].diff()
gain = delta.clip(lower=0)
loss = -delta.clip(upper=0)
avg_gain = gain.rolling(14).mean()
avg_loss = loss.rolling(14).mean()
rs = avg_gain / avg_loss
df["RSI"] = 100 - (100 / (1 + rs))

df["Volume_Avg"] = df["Volume"].rolling(20).mean()
df["Support"] = df["Low"].rolling(30).min()
df["Resistance"] = df["High"].rolling(30).max()

df["Momentum"] = df["Close"].pct_change(5) * 100

latest = df.iloc[-1]
prev = df.iloc[-2]

price = float(latest["Close"])
ema5 = float(latest["EMA5"])
ema9 = float(latest["EMA9"])
ema21 = float(latest["EMA21"])
ema50 = float(latest["EMA50"])
ema100 = float(latest["EMA100"])
rsi = float(latest["RSI"])
support = float(latest["Support"])
resistance = float(latest["Resistance"])
momentum = float(latest["Momentum"])
volume = float(latest["Volume"])
volume_avg = float(latest["Volume_Avg"])

# -----------------------------
# AI SCORING
# -----------------------------
buy_score = 0
sell_score = 0
reasons = []

near_resistance = price >= resistance * 0.985
near_support = price <= support * 1.015

volume_ok = volume > volume_avg
trend_up = ema5 > ema9 > ema21
trend_down = ema5 < ema9 < ema21

# BUY CONDITIONS
if trend_up:
    buy_score += 20
    reasons.append("Lyhyt trendi on ylöspäin: EMA5 > EMA9 > EMA21")

if price > ema50:
    buy_score += 15
    reasons.append("Hinta on EMA50 yläpuolella")

if price > ema100:
    buy_score += 10
    reasons.append("Hinta on EMA100 yläpuolella")

if 45 <= rsi <= 68:
    buy_score += 15
    reasons.append("RSI on ostolle terveellä alueella")

if momentum > 0:
    buy_score += 10
    reasons.append("Momentum tukee nousua")

if volume_ok:
    buy_score += 10
    reasons.append("Volyymi tukee liikettä")

if near_support:
    buy_score += 10
    reasons.append("Hinta on lähellä tukitasoa")

if near_resistance:
    buy_score -= 25
    reasons.append("Varoitus: hinta on lähellä vastustasoa")

# SELL CONDITIONS
if trend_down:
    sell_score += 25
    reasons.append("Lyhyt trendi on alaspäin: EMA5 < EMA9 < EMA21")

if price < ema50:
    sell_score += 15
    reasons.append("Hinta on EMA50 alapuolella")

if price < ema100:
    sell_score += 10
    reasons.append("Hinta on EMA100 alapuolella")

if rsi > 72:
    sell_score += 15
    reasons.append("RSI on ylikuumentunut")

if momentum < 0:
    sell_score += 10
    reasons.append("Momentum heikkenee")

if near_resistance:
    sell_score += 15
    reasons.append("Hinta on vastustason lähellä")

if volume_ok and price < prev["Close"]:
    sell_score += 10
    reasons.append("Laskeva kynttilä vahvalla volyymilla")

buy_score = max(0, min(100, buy_score))
sell_score = max(0, min(100, sell_score))

# -----------------------------
# SIGNAL
# -----------------------------
if buy_score >= 75 and buy_score > sell_score:
    signal = "OSTA"
    confidence = buy_score
    card_class = "buy-ready"
elif buy_score >= 55 and buy_score > sell_score:
    signal = "▲ VALMISTAUTUU OSTOON"
    confidence = buy_score
    card_class = "buy-ready"
elif sell_score >= 75 and sell_score > buy_score:
    signal = "MYY"
    confidence = sell_score
    card_class = "sell-ready"
elif sell_score >= 55 and sell_score > buy_score:
    signal = "▼ VALMISTAUTUU MYYNTIIN"
    confidence = sell_score
    card_class = "sell-ready"
else:
    signal = "ODOTA"
    confidence = max(buy_score, sell_score)
    card_class = "wait-card"

# Fake breakout warning
fake_breakout = False
if price > resistance * 0.995 and volume < volume_avg:
    fake_breakout = True
    signal = "ODOTA — MAHDOLLINEN FAKE BREAKOUT"
    confidence = 50
    card_class = "wait-card"

# -----------------------------
# TOP SIGNAL CARD
# -----------------------------
st.markdown(
    f"""
    <div class="big-card {card_class}">
        {signal}<br>
        {confidence:.0f}%
    </div>
    """,
    unsafe_allow_html=True
)

# -----------------------------
# CHART
# -----------------------------
fig = go.Figure()

fig.add_trace(go.Candlestick(
    x=df.index,
    open=df["Open"],
    high=df["High"],
    low=df["Low"],
    close=df["Close"],
    name="Kynttilät",
    increasing_line_color="#00ff88",
    decreasing_line_color="#ff4d4d"
))

fig.add_trace(go.Scatter(x=df.index, y=df["EMA5"], mode="lines", name="EMA5"))
fig.add_trace(go.Scatter(x=df.index, y=df["EMA9"], mode="lines", name="EMA9"))
fig.add_trace(go.Scatter(x=df.index, y=df["EMA21"], mode="lines", name="EMA21"))
fig.add_trace(go.Scatter(x=df.index, y=df["EMA50"], mode="lines", name="EMA50"))
fig.add_trace(go.Scatter(x=df.index, y=df["EMA100"], mode="lines", name="EMA100"))

fig.add_hline(
    y=resistance,
    line_dash="dash",
    annotation_text="RESISTANCE",
    annotation_position="right"
)

fig.add_hline(
    y=support,
    line_dash="dot",
    annotation_text="SUPPORT",
    annotation_position="right"
)

fig.add_hline(
    y=price,
    line_dash="dash",
    annotation_text="NYKYHINTA",
    annotation_position="right"
)

fig.update_layout(
    title=f"{symbol} — AI PRO KAAVIO",
    height=720,
    template="plotly_dark",
    xaxis_rangeslider_visible=False,
    margin=dict(l=10, r=10, t=60, b=10),
    legend=dict(orientation="h")
)

st.plotly_chart(fig, use_container_width=True)

# -----------------------------
# INFO PANELS
# -----------------------------
col1, col2, col3, col4 = st.columns(4)

col1.metric("Nykyhinta", f"{price:,.2f}")
col2.metric("RSI", f"{rsi:.1f}")
col3.metric("Osto-score", f"{buy_score:.0f}%")
col4.metric("Myynti-score", f"{sell_score:.0f}%")

col5, col6, col7 = st.columns(3)
col5.metric("Support", f"{support:,.2f}")
col6.metric("Resistance", f"{resistance:,.2f}")
col7.metric("Momentum 5 kynttilää", f"{momentum:.2f}%")

st.markdown("## AI:n perustelut")

with st.container():
    st.markdown('<div class="info-box">', unsafe_allow_html=True)

    if fake_breakout:
        st.warning("Mahdollinen fake breakout: hinta yrittää vastustason yli, mutta volyymi ei tue liikettä.")

    if near_resistance:
        st.warning("Hinta on lähellä vastustasoa. Osto on riskisempi juuri tässä kohdassa.")

    if near_support:
        st.success("Hinta on lähellä tukitasoa. Tämä voi olla parempi ostoseurannan alue.")

    for r in reasons[-8:]:
        st.write("• " + r)

    st.markdown('</div>', unsafe_allow_html=True)

# -----------------------------
# DEMO TRADING PANEL
# -----------------------------
st.markdown("## Demoharjoittelu")

if "cash" not in st.session_state:
    st.session_state.cash = demo_start
if "coins" not in st.session_state:
    st.session_state.coins = 0.0
if "last_buy_price" not in st.session_state:
    st.session_state.last_buy_price = 0.0

c1, c2, c3 = st.columns(3)

with c1:
    if st.button("Demo OSTA"):
        if st.session_state.cash >= trade_amount:
            qty = trade_amount / price
            st.session_state.cash -= trade_amount
            st.session_state.coins += qty
            st.session_state.last_buy_price = price
            st.success("Demo-osto tehty")
        else:
            st.error("Ei tarpeeksi demoraha saldoa")

with c2:
    if st.button("Demo MYY"):
        sell_qty = trade_amount / price
        if st.session_state.coins >= sell_qty:
            st.session_state.coins -= sell_qty
            st.session_state.cash += trade_amount
            st.success("Demo-myynti tehty")
        else:
            st.error("Ei tarpeeksi positiota myyntiin")

with c3:
    if st.button("Nollaa demo"):
        st.session_state.cash = demo_start
        st.session_state.coins = 0.0
        st.session_state.last_buy_price = 0.0
        st.success("Demo nollattu")

position_value = st.session_state.coins * price
total_value = st.session_state.cash + position_value
profit = total_value - demo_start

d1, d2, d3, d4 = st.columns(4)
d1.metric("Käteinen", f"{st.session_state.cash:.2f} €")
d2.metric("Omistus", f"{st.session_state.coins:.6f}")
d3.metric("Position arvo", f"{position_value:.2f} €")
d4.metric("Tulos", f"{profit:.2f} €")

# -----------------------------
# EDUCATION TEXT
# -----------------------------
st.markdown("## Opetus")

if signal.startswith("▲"):
    st.info("AI näkee nousun valmistumista, mutta vielä ei välttämättä ole paras ostopaikka. Odota vahvistusta: vihreä kynttilä, EMA5 yli EMA9 ja volyymi mukaan.")
elif signal == "OSTA":
    st.success("Ostosignaali on vahva. Riskinä on silti äkillinen käännös, joten stop-loss kannattaa ajatella supportin alle.")
elif "MYY" in signal:
    st.error("Myyntipaine kasvaa. Tämä voi tarkoittaa laskun jatkumista tai voittojen kotiuttamista.")
else:
    st.warning("Markkina ei ole tarpeeksi selvä. Paras päätös on odottaa vahvempaa signaalia.")

st.caption(f"Päivitetty: {datetime.now().strftime('%d.%m.%Y %H:%M:%S')}")
