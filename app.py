# -*- coding: utf-8 -*-

import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st
import yfinance as yf
from streamlit_autorefresh import st_autorefresh
from datetime import datetime


st.set_page_config(
    page_title="AI Trading Pro",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="expanded"
)


st.markdown("""
<style>
.block-container {
    padding-top: 0.6rem;
    padding-bottom: 1rem;
}
h1, h2, h3 {
    margin-top: 0rem;
}
.signal-box {
    width: 100%;
    height: 74px;
    border-radius: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 34px;
    font-weight: 900;
    box-shadow: 0 0 25px rgba(0,0,0,0.35);
    margin-top: 4px;
    margin-bottom: 12px;
}
.info-card {
    background-color: #111827;
    border: 1px solid #263244;
    padding: 14px;
    border-radius: 16px;
    color: #e5e7eb;
}
.small {
    font-size: 13px;
    color: #9ca3af;
}
</style>
""", unsafe_allow_html=True)


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
    "2 minuuttia": "2m",
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


@st.cache_data(ttl=20, show_spinner=False)
def hae_data(symboli, periodi, interval):
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

        df = df[["Open", "High", "Low", "Close"]].dropna()
        return df

    except Exception:
        return pd.DataFrame()


def rsi(close, period=14):
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)

    avg_gain = gain.rolling(period).mean()
    avg_loss = loss.rolling(period).mean()

    rs = avg_gain / avg_loss.replace(0, np.nan)
    value = 100 - (100 / (1 + rs))
    return value.fillna(50)


def lisaa_indikaattorit(df):
    df = df.copy()

    df["EMA9"] = df["Close"].ewm(span=9, adjust=False).mean()
    df["EMA21"] = df["Close"].ewm(span=21, adjust=False).mean()
    df["EMA50"] = df["Close"].ewm(span=50, adjust=False).mean()

    df["RSI"] = rsi(df["Close"], 14)

    df["MA20"] = df["Close"].rolling(20).mean()
    df["STD20"] = df["Close"].rolling(20).std()
    df["BB_UPPER"] = df["MA20"] + 2 * df["STD20"]
    df["BB_LOWER"] = df["MA20"] - 2 * df["STD20"]

    df["MOMENTUM"] = df["Close"].pct_change(5) * 100
    df["VOLATILITY"] = df["Close"].pct_change().rolling(20).std() * 100

    return df.dropna()


def tunnista_kynttilakuvio(df):
    if len(df) < 3:
        return "Ei tarpeeksi dataa", 0

    c = df.iloc[-1]
    p = df.iloc[-2]

    body = abs(c["Close"] - c["Open"])
    candle_range = c["High"] - c["Low"]

    if candle_range == 0:
        return "Ei selvää kuviota", 0

    upper_shadow = c["High"] - max(c["Close"], c["Open"])
    lower_shadow = min(c["Close"], c["Open"]) - c["Low"]

    if body / candle_range < 0.12:
        return "Doji — markkina epäröi", 0

    if lower_shadow > body * 2 and upper_shadow < body:
        return "Hammer — mahdollinen nousukäännös", 12

    if upper_shadow > body * 2 and lower_shadow < body:
        return "Shooting Star — mahdollinen laskukäännös", -12

    if p["Close"] < p["Open"] and c["Close"] > c["Open"] and c["Close"] > p["Open"]:
        return "Bullish Engulfing — vahva ostokuvio", 18

    if p["Close"] > p["Open"] and c["Close"] < c["Open"] and c["Close"] < p["Open"]:
        return "Bearish Engulfing — vahva myyntikuvio", -18

    return "Ei vahvaa kynttiläkuviota", 0


def tee_ennuste(df):
    if len(df) < 60:
        return "ODOTA", 50, 0, "Dataa on liian vähän.", []

    last = df.iloc[-1]
    prev = df.iloc[-2]

    score = 0
    details = []

    if last["EMA9"] > last["EMA21"] > last["EMA50"]:
        score += 32
        details.append("EMA9 > EMA21 > EMA50: nousutrendi vahva.")
    elif last["EMA9"] < last["EMA21"] < last["EMA50"]:
        score -= 32
        details.append("EMA9 < EMA21 < EMA50: laskutrendi vahva.")
    else:
        details.append("EMA-trendi ei ole täysin selvä.")

    if prev["EMA9"] <= prev["EMA21"] and last["EMA9"] > last["EMA21"]:
        score += 24
        details.append("EMA9 ylitti EMA21:n ylöspäin.")
    elif prev["EMA9"] >= prev["EMA21"] and last["EMA9"] < last["EMA21"]:
        score -= 24
        details.append("EMA9 alitti EMA21:n alaspäin.")

    if last["RSI"] < 30:
        score += 15
        details.append("RSI alle 30: ylimyyty, nousukäännös mahdollinen.")
    elif last["RSI"] > 70:
        score -= 15
        details.append("RSI yli 70: yliostettu, laskukäännös mahdollinen.")
    elif 45 <= last["RSI"] <= 60:
        score += 5
        details.append("RSI terveellä alueella.")

    if last["MOMENTUM"] > 0.25:
        score += 16
        details.append("Momentum positiivinen.")
    elif last["MOMENTUM"] < -0.25:
        score -= 16
        details.append("Momentum negatiivinen.")
    else:
        details.append("Momentum vielä rauhallinen.")

    if last["Close"] < last["BB_LOWER"]:
        score += 10
        details.append("Hinta Bollinger-alarajan lähellä.")
    elif last["Close"] > last["BB_UPPER"]:
        score -= 10
        details.append("Hinta Bollinger-ylärajan lähellä.")

    kuvio, kuvio_score = tunnista_kynttilakuvio(df)
    score += kuvio_score
    details.append("Kynttiläkuvio: " + kuvio)

    score = max(-100, min(100, score))
    confidence = int(min(95, max(45, 50 + abs(score) * 0.47)))

    if score >= 25:
        signal = "OSTA"
        reason = "Nousupaine on nyt vahvempi kuin laskupaine."
    elif score <= -25:
        signal = "MYY"
        reason = "Laskupaine on nyt vahvempi kuin nousupaine."
    else:
        signal = "ODOTA"
        reason = "Signaali ei ole vielä tarpeeksi selvä."

    return signal, confidence, int(score), reason, details


def nayta_signaalipalkki(signal, confidence):
    vahvuus = int(confidence)

    if signal == "OSTA":
        bg = f"linear-gradient(90deg, #bbf7d0 0%, #22c55e {vahvuus}%, #052e16 100%)"
        text = "🟢 OSTA"
        color = "white"
    elif signal == "MYY":
        bg = f"linear-gradient(90deg, #fecaca 0%, #ef4444 {vahvuus}%, #450a0a 100%)"
        text = "🔴 MYY"
        color = "white"
    else:
        bg = "linear-gradient(90deg, #fef3c7 0%, #eab308 55%, #713f12 100%)"
        text = "🟡 ODOTA"
        color = "black"

    st.markdown(f"""
    <div class="signal-box" style="background:{bg}; color:{color};">
        {text} — {vahvuus} %
    </div>
    """, unsafe_allow_html=True)


def piirra_kaavio(df, nimi):
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

    fig.add_trace(go.Scatter(x=df.index, y=df["EMA9"], mode="lines", name="EMA 9", line=dict(width=1.4)))
    fig.add_trace(go.Scatter(x=df.index, y=df["EMA21"], mode="lines", name="EMA 21", line=dict(width=1.4)))
    fig.add_trace(go.Scatter(x=df.index, y=df["EMA50"], mode="lines", name="EMA 50", line=dict(width=1.4)))
    fig.add_trace(go.Scatter(x=df.index, y=df["BB_UPPER"], mode="lines", name="Bollinger ylä", line=dict(width=1, dash="dot")))
    fig.add_trace(go.Scatter(x=df.index, y=df["BB_LOWER"], mode="lines", name="Bollinger ala", line=dict(width=1, dash="dot")))

    fig.update_layout(
        title=f"{nimi} — kynttiläkaavio",
        height=460,
        template="plotly_dark",
        xaxis_rangeslider_visible=False,
        margin=dict(l=10, r=10, t=45, b=10),
        legend=dict(orientation="h", y=1.08, x=0),
    )

    st.plotly_chart(fig, use_container_width=True)


def piirra_rsi(df):
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
        title="RSI",
        height=220,
        template="plotly_dark",
        margin=dict(l=10, r=10, t=40, b=10),
    )

    st.plotly_chart(fig, use_container_width=True)


st.title("📈 AI Trading Pro")
st.caption("Nopeampi live-päivitys, pienempi kaavio, AI-signaali ja kynttiläkuvioiden tunnistus.")

st.sidebar.title("⚙️ Asetukset")

valittu_nimi = st.sidebar.selectbox("Kohde", list(SYMBOLIT.keys()), index=0)
symboli = SYMBOLIT[valittu_nimi]

periodi_nimi = st.sidebar.selectbox("Historia", list(PERIODIT.keys()), index=0)
interval_nimi = st.sidebar.selectbox("Kynttiläväli", list(AIKAVALIT.keys()), index=0)

refresh_seconds = st.sidebar.selectbox(
    "Live-päivitys",
    [5, 10, 15, 30, 60],
    index=0
)

periodi = PERIODIT[periodi_nimi]
interval = AIKAVALIT[interval_nimi]

st_autorefresh(
    interval=refresh_seconds * 1000,
    key="live_refresh"
)

if st.sidebar.button("🔄 Päivitä / tyhjennä välimuisti"):
    st.cache_data.clear()
    st.rerun()

st.sidebar.info(
    "YFinance tukee käytännössä nopeimmillaan 1 minuutin kynttilöitä. "
    "Sivu voidaan silti päivittää 5 sekunnin välein."
)

with st.spinner("Haetaan markkinadataa..."):
    raw_df = hae_data(symboli, periodi, interval)

if raw_df.empty:
    st.error("Dataa ei saatu. Kokeile 5 päivää + 5 minuuttia tai muuta kohdetta.")
    st.stop()

df = lisaa_indikaattorit(raw_df)

if df.empty or len(df) < 60:
    st.warning("Dataa on liian vähän. Vaihda historiaksi 5 päivää tai kynttiläväliksi 5 minuuttia.")
    st.stop()

signal, confidence, score, reason, details = tee_ennuste(df)

last = df.iloc[-1]
prev = df.iloc[-2]
change = ((last["Close"] - prev["Close"]) / prev["Close"]) * 100

c1, c2, c3, c4 = st.columns(4)
c1.metric("Kohde", valittu_nimi)
c2.metric("Hinta", f"{last['Close']:,.4f}")
c3.metric("Viime muutos", f"{change:.2f} %")
c4.metric("AI-pisteet", f"{score} / 100")

nayta_signaalipalkki(signal, confidence)

left, right = st.columns([1.4, 1])

with left:
    piirra_kaavio(df, valittu_nimi)

with right:
    st.markdown('<div class="info-card">', unsafe_allow_html=True)
    st.subheader("🧠 Ennuste")
    st.write(f"**{reason}**")
    st.write(f"Varmuus: **{confidence} %**")
    st.write(f"RSI: **{last['RSI']:.1f}**")
    st.write(f"Momentum: **{last['MOMENTUM']:.2f} %**")
    st.write(f"Volatiliteetti: **{last['VOLATILITY']:.2f} %**")
    st.markdown("</div>", unsafe_allow_html=True)

    st.markdown("### Selitys")
    for d in details:
        st.write("• " + d)

piirra_rsi(df)

st.divider()

st.subheader("🎓 Botti seuraa näitä")
st.write(
    "EMA-trendiä, EMA-risteyksiä, RSI:tä, momentumia, Bollinger-rajoja ja kynttiläkuvioita "
    "kuten Doji, Hammer, Shooting Star, Bullish Engulfing ja Bearish Engulfing."
)

st.warning(
    "Tämä on opetukseen ja päätöksenteon tueksi tehty avustaja. "
    "Se ei ole sijoitusneuvo eikä takaa voittoa."
)

st.caption(f"Päivitetty: {datetime.now().strftime('%d.%m.%Y %H:%M:%S')}")
