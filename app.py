# -*- coding: utf-8 -*-

import math
from datetime import datetime

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st
import yfinance as yf


# ============================================================
# SIVUN ASETUKSET
# ============================================================

st.set_page_config(
    page_title="AI Trading Pro",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="expanded"
)


# ============================================================
# TYYLIT
# ============================================================

st.markdown("""
<style>
.main {
    background-color: #0b1020;
}
.block-container {
    padding-top: 1.5rem;
}
.big-title {
    font-size: 34px;
    font-weight: 800;
    color: #ffffff;
}
.subtitle {
    color: #b8c1d9;
    font-size: 16px;
}
.signal-buy {
    background: linear-gradient(90deg,#064e3b,#16a34a);
    padding: 22px;
    border-radius: 18px;
    color: white;
    font-size: 30px;
    font-weight: 800;
    text-align: center;
}
.signal-sell {
    background: linear-gradient(90deg,#7f1d1d,#dc2626);
    padding: 22px;
    border-radius: 18px;
    color: white;
    font-size: 30px;
    font-weight: 800;
    text-align: center;
}
.signal-wait {
    background: linear-gradient(90deg,#713f12,#eab308);
    padding: 22px;
    border-radius: 18px;
    color: black;
    font-size: 30px;
    font-weight: 800;
    text-align: center;
}
.info-card {
    background-color: #111827;
    border: 1px solid #263244;
    padding: 18px;
    border-radius: 16px;
    color: #e5e7eb;
}
.small-text {
    color: #9ca3af;
    font-size: 13px;
}
</style>
""", unsafe_allow_html=True)


# ============================================================
# SYMBOLIT
# ============================================================

SYMBOLIT = {
    "Bitcoin / USD": "BTC-USD",
    "Ethereum / USD": "ETH-USD",
    "EUR / USD": "EURUSD=X",
    "GBP / USD": "GBPUSD=X",
    "USD / JPY": "JPY=X",
    "Kulta": "GC=F",
    "Hopea": "SI=F",
    "Öljy WTI": "CL=F",
    "Nasdaq": "^IXIC",
    "S&P 500": "^GSPC",
    "Tesla": "TSLA",
    "Apple": "AAPL",
    "Nvidia": "NVDA",
}

AIKAVALIT = {
    "1 minuutti": "1m",
    "5 minuuttia": "5m",
    "15 minuuttia": "15m",
    "30 minuuttia": "30m",
    "1 tunti": "1h",
    "1 päivä": "1d",
}

PERIODIT = {
    "1 päivä": "1d",
    "5 päivää": "5d",
    "1 kuukausi": "1mo",
    "3 kuukautta": "3mo",
    "6 kuukautta": "6mo",
    "1 vuosi": "1y",
}


# ============================================================
# DATAHAKU
# ============================================================

@st.cache_data(ttl=30, show_spinner=False)
def hae_data(symboli: str, periodi: str, interval: str) -> pd.DataFrame:
    try:
        df = yf.download(
            symboli,
            period=periodi,
            interval=interval,
            progress=False,
            auto_adjust=True,
            threads=False,
        )

        if df is None or df.empty:
            return pd.DataFrame()

        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)

        tarvittavat = ["Open", "High", "Low", "Close"]
        for col in tarvittavat:
            if col not in df.columns:
                return pd.DataFrame()

        df = df.dropna()
        return df

    except Exception:
        return pd.DataFrame()


# ============================================================
# INDIKAATTORIT
# ============================================================

def laske_rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)

    avg_gain = gain.rolling(period).mean()
    avg_loss = loss.rolling(period).mean()

    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))
    return rsi.fillna(50)


def laske_indikaattorit(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()

    close = df["Close"]

    df["EMA9"] = close.ewm(span=9, adjust=False).mean()
    df["EMA21"] = close.ewm(span=21, adjust=False).mean()
    df["EMA50"] = close.ewm(span=50, adjust=False).mean()

    df["RSI"] = laske_rsi(close, 14)

    df["MA20"] = close.rolling(20).mean()
    df["STD20"] = close.rolling(20).std()
    df["BB_UPPER"] = df["MA20"] + 2 * df["STD20"]
    df["BB_LOWER"] = df["MA20"] - 2 * df["STD20"]

    df["MOMENTUM"] = close.pct_change(5) * 100
    df["VOLATILITY"] = close.pct_change().rolling(20).std() * 100

    return df.dropna()


# ============================================================
# AI-ENNUSTE
# ============================================================

def tee_ai_ennuste(df: pd.DataFrame):
    if df.empty or len(df) < 60:
        return {
            "signal": "ODOTA",
            "confidence": 50,
            "score": 0,
            "reason": "Dataa on liian vähän luotettavaan arvioon.",
            "details": []
        }

    last = df.iloc[-1]
    prev = df.iloc[-2]

    score = 0
    details = []

    # Trendisuunta
    if last["EMA9"] > last["EMA21"] > last["EMA50"]:
        score += 30
        details.append("EMA-trendi on nouseva.")
    elif last["EMA9"] < last["EMA21"] < last["EMA50"]:
        score -= 30
        details.append("EMA-trendi on laskeva.")
    else:
        details.append("EMA-trendi on epäselvä.")

    # EMA-risteys
    if prev["EMA9"] <= prev["EMA21"] and last["EMA9"] > last["EMA21"]:
        score += 25
        details.append("Nopea EMA ylitti hitaan EMA:n ylöspäin.")
    elif prev["EMA9"] >= prev["EMA21"] and last["EMA9"] < last["EMA21"]:
        score -= 25
        details.append("Nopea EMA alitti hitaan EMA:n alaspäin.")

    # RSI
    if last["RSI"] < 30:
        score += 18
        details.append("RSI kertoo ylimyydystä tilanteesta.")
    elif last["RSI"] > 70:
        score -= 18
        details.append("RSI kertoo yliostetusta tilanteesta.")
    elif 45 <= last["RSI"] <= 60:
        score += 5
        details.append("RSI on terveellä alueella.")

    # Momentum
    if last["MOMENTUM"] > 0.35:
        score += 15
        details.append("Momentum on vahvasti positiivinen.")
    elif last["MOMENTUM"] < -0.35:
        score -= 15
        details.append("Momentum on vahvasti negatiivinen.")
    else:
        details.append("Momentum on rauhallinen.")

    # Bollinger
    if last["Close"] < last["BB_LOWER"]:
        score += 10
        details.append("Hinta on Bollinger-alarajan lähellä.")
    elif last["Close"] > last["BB_UPPER"]:
        score -= 10
        details.append("Hinta on Bollinger-ylärajan lähellä.")

    score = max(-100, min(100, score))
    confidence = min(95, max(50, 50 + abs(score) * 0.45))

    if score >= 35:
        signal = "OSTA"
        reason = "Nousupaine on teknisesti vahvempi kuin laskupaine."
    elif score <= -35:
        signal = "MYY"
        reason = "Laskupaine on teknisesti vahvempi kuin nousupaine."
    else:
        signal = "ODOTA"
        reason = "Markkina ei anna vielä tarpeeksi selvää signaalia."

    return {
        "signal": signal,
        "confidence": round(confidence),
        "score": round(score),
        "reason": reason,
        "details": details
    }


# ============================================================
# KAAVIO
# ============================================================

def piirra_kaavio(df: pd.DataFrame, nimi: str):
    fig = go.Figure()

    fig.add_trace(go.Candlestick(
        x=df.index,
        open=df["Open"],
        high=df["High"],
        low=df["Low"],
        close=df["Close"],
        name="Kynttilät",
        increasing_line_color="#22c55e",
        decreasing_line_color="#ef4444",
    ))

    fig.add_trace(go.Scatter(
        x=df.index,
        y=df["EMA9"],
        mode="lines",
        name="EMA 9",
        line=dict(width=1.5)
    ))

    fig.add_trace(go.Scatter(
        x=df.index,
        y=df["EMA21"],
        mode="lines",
        name="EMA 21",
        line=dict(width=1.5)
    ))

    fig.add_trace(go.Scatter(
        x=df.index,
        y=df["EMA50"],
        mode="lines",
        name="EMA 50",
        line=dict(width=1.5)
    ))

    fig.add_trace(go.Scatter(
        x=df.index,
        y=df["BB_UPPER"],
        mode="lines",
        name="Bollinger ylä",
        line=dict(width=1, dash="dot")
    ))

    fig.add_trace(go.Scatter(
        x=df.index,
        y=df["BB_LOWER"],
        mode="lines",
        name="Bollinger ala",
        line=dict(width=1, dash="dot")
    ))

    fig.update_layout(
        title=f"{nimi} — reaaliaikainen kynttiläkaavio",
        height=700,
        template="plotly_dark",
        xaxis_rangeslider_visible=False,
        margin=dict(l=20, r=20, t=60, b=20),
        legend=dict(orientation="h", y=1.02, x=0),
    )

    st.plotly_chart(fig, use_container_width=True)


def piirra_rsi(df: pd.DataFrame):
    fig = go.Figure()

    fig.add_trace(go.Scatter(
        x=df.index,
        y=df["RSI"],
        mode="lines",
        name="RSI"
    ))

    fig.add_hline(y=70, line_dash="dash")
    fig.add_hline(y=30, line_dash="dash")
    fig.add_hline(y=50, line_dash="dot")

    fig.update_layout(
        title="RSI — yliostettu / ylimyyty",
        height=260,
        template="plotly_dark",
        margin=dict(l=20, r=20, t=50, b=20),
    )

    st.plotly_chart(fig, use_container_width=True)


# ============================================================
# KÄYTTÖLIITTYMÄ
# ============================================================

st.markdown('<div class="big-title">📈 AI Trading Pro — Ammattimainen treidausavustaja</div>', unsafe_allow_html=True)
st.markdown(
    '<div class="subtitle">Nopea kurssikaavio, tekninen analyysi, AI-signaali ja selkokielinen opastus. Ei automaattitreidausta.</div>',
    unsafe_allow_html=True
)

st.sidebar.title("⚙️ Asetukset")

valittu_nimi = st.sidebar.selectbox(
    "Valitse kohde",
    list(SYMBOLIT.keys()),
    index=0
)

symboli = SYMBOLIT[valittu_nimi]

periodi_nimi = st.sidebar.selectbox(
    "Valitse historia",
    list(PERIODIT.keys()),
    index=1
)

interval_nimi = st.sidebar.selectbox(
    "Valitse kynttiläväli",
    list(AIKAVALIT.keys()),
    index=1
)

periodi = PERIODIT[periodi_nimi]
interval = AIKAVALIT[interval_nimi]

st.sidebar.divider()

paivita = st.sidebar.button("🔄 Päivitä nyt")

st.sidebar.markdown("""
### Vinkki
Nopeimmat näkymät:

- Bitcoin: 1m / 5m
- EUR/USD: 5m / 15m
- Osakkeet: 15m / 1h

Jos data ei näy, vaihda aikaväli pidemmäksi.
""")

if paivita:
    st.cache_data.clear()


# ============================================================
# DATA
# ============================================================

with st.spinner("Haetaan markkinadataa..."):
    raw_df = hae_data(symboli, periodi, interval)

if raw_df.empty:
    st.error("Dataa ei saatu haettua. Kokeile toista kohdetta, pidempää historiaa tai hitaampaa aikaväliä.")
    st.stop()

df = laske_indikaattorit(raw_df)

if df.empty or len(df) < 60:
    st.warning("Dataa on liian vähän indikaattoreihin. Vaihda pidempi historia tai hitaampi kynttiläväli.")
    st.stop()

ennuste = tee_ai_ennuste(df)

last = df.iloc[-1]
previous = df.iloc[-2]
price = last["Close"]
change = ((last["Close"] - previous["Close"]) / previous["Close"]) * 100


# ============================================================
# YLÄMITTARIT
# ============================================================

col1, col2, col3, col4 = st.columns(4)

col1.metric("Kohde", valittu_nimi)
col2.metric("Viimeisin hinta", f"{price:,.4f}")
col3.metric("Muutos", f"{change:.2f} %")
col4.metric("AI-varmuus", f"{ennuste['confidence']} %")


# ============================================================
# SIGNAALI
# ============================================================

st.divider()

if ennuste["signal"] == "OSTA":
    st.markdown(
        f'<div class="signal-buy">🟢 AI-SIGNAALI: OSTA / NOUSUVAHVA — {ennuste["confidence"]} %</div>',
        unsafe_allow_html=True
    )
elif ennuste["signal"] == "MYY":
    st.markdown(
        f'<div class="signal-sell">🔴 AI-SIGNAALI: MYY / LASKUVAHVA — {ennuste["confidence"]} %</div>',
        unsafe_allow_html=True
    )
else:
    st.markdown(
        f'<div class="signal-wait">🟡 AI-SIGNAALI: ODOTA — {ennuste["confidence"]} %</div>',
        unsafe_allow_html=True
    )

st.markdown("")

a, b = st.columns([2, 1])

with a:
    st.markdown('<div class="info-card">', unsafe_allow_html=True)
    st.subheader("🧠 AI-analyysi")
    st.write(ennuste["reason"])
    st.write(f"Tekninen pistemäärä: **{ennuste['score']} / 100**")

    for kohta in ennuste["details"]:
        st.write("• " + kohta)

    st.markdown('</div>', unsafe_allow_html=True)

with b:
    st.markdown('<div class="info-card">', unsafe_allow_html=True)
    st.subheader("📌 Tärkeät arvot")
    st.write(f"RSI: **{last['RSI']:.1f}**")
    st.write(f"EMA 9: **{last['EMA9']:.4f}**")
    st.write(f"EMA 21: **{last['EMA21']:.4f}**")
    st.write(f"EMA 50: **{last['EMA50']:.4f}**")
    st.write(f"Momentum: **{last['MOMENTUM']:.2f} %**")
    st.markdown('</div>', unsafe_allow_html=True)


# ============================================================
# KAAVIOT
# ============================================================

st.divider()

piirra_kaavio(df, valittu_nimi)
piirra_rsi(df)


# ============================================================
# OPETUS
# ============================================================

st.divider()

st.subheader("🎓 Mitä botti katsoo?")

op1, op2, op3 = st.columns(3)

with op1:
    st.markdown("""
    ### EMA-trendi
    Jos EMA 9 on EMA 21:n ja EMA 50:n yläpuolella, lyhyt trendi on vahva.

    **Hyvä ostolle:**  
    EMA9 > EMA21 > EMA50
    """)

with op2:
    st.markdown("""
    ### RSI
    RSI kertoo onko markkina yliostettu tai ylimyyty.

    - Alle 30 = ylimyyty
    - Yli 70 = yliostettu
    - 45–60 = usein terve alue
    """)

with op3:
    st.markdown("""
    ### Momentum
    Momentum kertoo onko liike vahvistumassa.

    Jos momentum on positiivinen ja EMA tukee sitä, noususignaali vahvistuu.
    """)


# ============================================================
# RISKIHUOMAUTUS
# ============================================================

st.divider()

st.warning(
    "Tämä ohjelma on treidausavustaja ja opetustyökalu. Se ei ole sijoitusneuvo eikä takaa voittoa. "
    "Älä koskaan sijoita rahaa, jota et voi menettää."
)

st.markdown(
    f'<div class="small-text">Päivitetty: {datetime.now().strftime("%d.%m.%Y %H:%M:%S")}</div>',
    unsafe_allow_html=True
)
