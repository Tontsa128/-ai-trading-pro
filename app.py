# -*- coding: utf-8 -*-

from datetime import datetime
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st
import yfinance as yf
from streamlit_autorefresh import st_autorefresh


# ============================================================
# ASETUKSET
# ============================================================

st.set_page_config(
    page_title="AI Trading Pro",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="expanded"
)


# ============================================================
# TYYLI
# ============================================================

st.markdown("""
<style>
.block-container {
    padding-top: 0.4rem;
    padding-bottom: 0.5rem;
}
h1 {
    font-size: 1.7rem !important;
    margin-bottom: 0.1rem !important;
}
h2, h3 {
    margin-top: 0.3rem !important;
}
.signal-main {
    width: 100%;
    height: 86px;
    border-radius: 24px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 42px;
    font-weight: 950;
    letter-spacing: 1px;
    box-shadow: 0 0 28px rgba(0,0,0,0.42);
    margin-top: 6px;
    margin-bottom: 12px;
    border: 2px solid rgba(255,255,255,0.35);
}
.card {
    background: #101827;
    border: 1px solid #273244;
    border-radius: 18px;
    padding: 14px;
    color: #e5e7eb;
}
.small-text {
    font-size: 13px;
    color: #9ca3af;
}
</style>
""", unsafe_allow_html=True)


# ============================================================
# VALINNAT
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


# ============================================================
# DATA
# ============================================================

@st.cache_data(ttl=15, show_spinner=False)
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

        pakolliset = ["Open", "High", "Low", "Close"]
        for col in pakolliset:
            if col not in df.columns:
                return pd.DataFrame()

        df = df[pakolliset].copy()

        for col in pakolliset:
            df[col] = pd.to_numeric(df[col], errors="coerce")

        df = df.dropna()
        return df

    except Exception:
        return pd.DataFrame()


# ============================================================
# INDIKAATTORIT
# ============================================================

def laske_rsi(close, period=14):
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)

    avg_gain = gain.rolling(period).mean()
    avg_loss = loss.rolling(period).mean()

    rs = avg_gain / avg_loss.replace(0, np.nan)
    rsi = 100 - (100 / (1 + rs))

    return rsi.fillna(50)


def lisaa_indikaattorit(df):
    df = df.copy()

    df["EMA9"] = df["Close"].ewm(span=9, adjust=False).mean()
    df["EMA21"] = df["Close"].ewm(span=21, adjust=False).mean()
    df["EMA50"] = df["Close"].ewm(span=50, adjust=False).mean()
    df["EMA200"] = df["Close"].ewm(span=200, adjust=False).mean()

    df["RSI"] = laske_rsi(df["Close"], 14)

    df["MA20"] = df["Close"].rolling(20).mean()
    df["STD20"] = df["Close"].rolling(20).std()
    df["BB_UPPER"] = df["MA20"] + 2 * df["STD20"]
    df["BB_LOWER"] = df["MA20"] - 2 * df["STD20"]

    df["MOMENTUM"] = df["Close"].pct_change(5) * 100
    df["VOLATILITY"] = df["Close"].pct_change().rolling(20).std() * 100

    return df.dropna()


# ============================================================
# KYNTTILÄKUVIOT
# ============================================================

def body(row):
    return abs(row["Close"] - row["Open"])


def candle_range(row):
    return max(row["High"] - row["Low"], 0.0000001)


def is_green(row):
    return row["Close"] > row["Open"]


def is_red(row):
    return row["Close"] < row["Open"]


def tunnista_kynttilat(df):
    signals = []
    score = 0

    if len(df) < 5:
        return score, ["Dataa liian vähän kynttiläkuvioihin."]

    c = df.iloc[-1]
    p = df.iloc[-2]
    p2 = df.iloc[-3]

    b = body(c)
    r = candle_range(c)

    upper = c["High"] - max(c["Open"], c["Close"])
    lower = min(c["Open"], c["Close"]) - c["Low"]

    # Doji
    if b / r < 0.12:
        signals.append("Doji: markkina epäröi, odota vahvistusta.")

    # Hammer
    if lower > b * 2.2 and upper < b * 1.2:
        score += 22
        signals.append("Hammer: mahdollinen BUY-käännös.")

    # Inverted hammer
    if upper > b * 2.2 and lower < b * 1.2 and is_green(c):
        score += 12
        signals.append("Inverted Hammer: mahdollinen nousukäännös.")

    # Shooting star
    if upper > b * 2.2 and lower < b * 1.2 and is_red(c):
        score -= 22
        signals.append("Shooting Star: mahdollinen SELL-käännös.")

    # Bullish engulfing
    if is_red(p) and is_green(c) and c["Close"] > p["Open"] and c["Open"] < p["Close"]:
        score += 32
        signals.append("Bullish Engulfing: vahva BUY-kuvio.")

    # Bearish engulfing
    if is_green(p) and is_red(c) and c["Open"] > p["Close"] and c["Close"] < p["Open"]:
        score -= 32
        signals.append("Bearish Engulfing: vahva SELL-kuvio.")

    # Morning star
    if is_red(p2) and body(p) < body(p2) * 0.55 and is_green(c) and c["Close"] > ((p2["Open"] + p2["Close"]) / 2):
        score += 30
        signals.append("Morning Star: vahva BUY-käännös.")

    # Evening star
    if is_green(p2) and body(p) < body(p2) * 0.55 and is_red(c) and c["Close"] < ((p2["Open"] + p2["Close"]) / 2):
        score -= 30
        signals.append("Evening Star: vahva SELL-käännös.")

    # Three white soldiers
    if is_green(df.iloc[-3]) and is_green(df.iloc[-2]) and is_green(df.iloc[-1]):
        if df.iloc[-1]["Close"] > df.iloc[-2]["Close"] > df.iloc[-3]["Close"]:
            score += 24
            signals.append("Three White Soldiers: vahva nousujatko.")

    # Three black crows
    if is_red(df.iloc[-3]) and is_red(df.iloc[-2]) and is_red(df.iloc[-1]):
        if df.iloc[-1]["Close"] < df.iloc[-2]["Close"] < df.iloc[-3]["Close"]:
            score -= 24
            signals.append("Three Black Crows: vahva laskujatko.")

    # Tweezer top
    if abs(c["High"] - p["High"]) / c["Close"] < 0.0015 and is_green(p) and is_red(c):
        score -= 16
        signals.append("Tweezer Top: mahdollinen SELL.")

    # Tweezer bottom
    if abs(c["Low"] - p["Low"]) / c["Close"] < 0.0015 and is_red(p) and is_green(c):
        score += 16
        signals.append("Tweezer Bottom: mahdollinen BUY.")

    if not signals:
        signals.append("Ei vahvaa kynttiläkuviota juuri nyt.")

    return score, signals


# ============================================================
# AI-SIGNAALI
# ============================================================

def tee_ennuste(df):
    if len(df) < 60:
        return {
            "signal": "ODOTA",
            "confidence": 50,
            "score": 0,
            "reason": "Dataa on liian vähän.",
            "details": ["Vaihda historia 5 päivää tai kynttiläväli 5 minuuttia."]
        }

    last = df.iloc[-1]
    prev = df.iloc[-2]

    score = 0
    details = []

    # EMA 9/21 crossover
    if prev["EMA9"] <= prev["EMA21"] and last["EMA9"] > last["EMA21"]:
        score += 30
        details.append("EMA9 ylitti EMA21:n ylöspäin: BUY-vahvistus.")

    if prev["EMA9"] >= prev["EMA21"] and last["EMA9"] < last["EMA21"]:
        score -= 30
        details.append("EMA9 alitti EMA21:n alaspäin: SELL-vahvistus.")

    # EMA trend
    if last["EMA9"] > last["EMA21"] > last["EMA50"]:
        score += 30
        details.append("EMA9 > EMA21 > EMA50: nousutrendi.")
    elif last["EMA9"] < last["EMA21"] < last["EMA50"]:
        score -= 30
        details.append("EMA9 < EMA21 < EMA50: laskutrendi.")
    else:
        details.append("EMA-trendi on epäselvä.")

    # Price above/below EMA
    if last["Close"] > last["EMA9"] and last["Close"] > last["EMA21"]:
        score += 12
        details.append("Hinta sulkeutui EMA9 ja EMA21 yläpuolelle.")
    elif last["Close"] < last["EMA9"] and last["Close"] < last["EMA21"]:
        score -= 12
        details.append("Hinta sulkeutui EMA9 ja EMA21 alapuolelle.")

    # RSI
    if last["RSI"] < 30:
        score += 16
        details.append("RSI alle 30: ylimyyty, BUY mahdollinen.")
    elif last["RSI"] > 70:
        score -= 16
        details.append("RSI yli 70: yliostettu, SELL mahdollinen.")
    elif 45 <= last["RSI"] <= 62:
        score += 5
        details.append("RSI terveellä alueella.")

    # Momentum
    if last["MOMENTUM"] > 0.25:
        score += 16
        details.append("Momentum nouseva.")
    elif last["MOMENTUM"] < -0.25:
        score -= 16
        details.append("Momentum laskeva.")
    else:
        details.append("Momentum neutraali.")

    # Bollinger
    if last["Close"] < last["BB_LOWER"]:
        score += 12
        details.append("Hinta Bollinger-alarajan alla: mahdollinen BUY-palautus.")
    elif last["Close"] > last["BB_UPPER"]:
        score -= 12
        details.append("Hinta Bollinger-ylärajan päällä: mahdollinen SELL-palautus.")

    candle_score, candle_details = tunnista_kynttilat(df)
    score += candle_score
    details.extend(candle_details)

    score = int(max(-100, min(100, score)))
    confidence = int(min(96, max(45, 50 + abs(score) * 0.46)))

    if score >= 24:
        signal = "OSTA"
        reason = "BUY-paine on vahvempi kuin SELL-paine."
    elif score <= -24:
        signal = "MYY"
        reason = "SELL-paine on vahvempi kuin BUY-paine."
    else:
        signal = "ODOTA"
        reason = "Ei tarpeeksi varmaa paikkaa. Odota parempaa vahvistusta."

    return {
        "signal": signal,
        "confidence": confidence,
        "score": score,
        "reason": reason,
        "details": details
    }


# ============================================================
# NÄYTTÖ
# ============================================================

def nayta_signaali(signal, confidence):
    if signal == "OSTA":
        bg = f"linear-gradient(90deg, #bbf7d0 0%, #22c55e {confidence}%, #064e3b 100%)"
        text = "BUY / OSTA"
        color = "white"
    elif signal == "MYY":
        bg = f"linear-gradient(90deg, #fecaca 0%, #ef4444 {confidence}%, #7f1d1d 100%)"
        text = "SELL / MYY"
        color = "white"
    else:
        bg = "linear-gradient(90deg, #fef3c7 0%, #eab308 58%, #92400e 100%)"
        text = "WAIT / ODOTA"
        color = "black"

    st.markdown(f"""
    <div class="signal-main" style="background:{bg}; color:{color};">
        {text} — {confidence}%
    </div>
    """, unsafe_allow_html=True)


def piirra_kynttilakaavio(df, nimi):
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
        increasing_fillcolor="#22c55e",
        decreasing_fillcolor="#ef4444",
    ))

    fig.add_trace(go.Scatter(
        x=df.index,
        y=df["EMA9"],
        mode="lines",
        name="EMA 9",
        line=dict(width=1.5, color="#3b82f6")
    ))

    fig.add_trace(go.Scatter(
        x=df.index,
        y=df["EMA21"],
        mode="lines",
        name="EMA 21",
        line=dict(width=1.5, color="#ef4444")
    ))

    fig.add_trace(go.Scatter(
        x=df.index,
        y=df["EMA50"],
        mode="lines",
        name="EMA 50",
        line=dict(width=1.2, color="#a855f7")
    ))

    fig.add_trace(go.Scatter(
        x=df.index,
        y=df["BB_UPPER"],
        mode="lines",
        name="Bollinger ylä",
        line=dict(width=1, dash="dot", color="#f59e0b")
    ))

    fig.add_trace(go.Scatter(
        x=df.index,
        y=df["BB_LOWER"],
        mode="lines",
        name="Bollinger ala",
        line=dict(width=1, dash="dot", color="#06b6d4")
    ))

    fig.update_layout(
        title=f"{nimi} — KYNTTILÄKAAVIO",
        height=430,
        template="plotly_dark",
        xaxis_rangeslider_visible=False,
        margin=dict(l=8, r=8, t=45, b=8),
        legend=dict(
            orientation="h",
            yanchor="bottom",
            y=1.02,
            xanchor="left",
            x=0
        ),
    )

    st.plotly_chart(fig, use_container_width=True)


def piirra_rsi(df):
    fig = go.Figure()

    fig.add_trace(go.Scatter(
        x=df.index,
        y=df["RSI"],
        mode="lines",
        name="RSI",
        line=dict(width=2)
    ))

    fig.add_hline(y=70, line_dash="dash")
    fig.add_hline(y=50, line_dash="dot")
    fig.add_hline(y=30, line_dash="dash")

    fig.update_layout(
        title="RSI",
        height=210,
        template="plotly_dark",
        margin=dict(l=8, r=8, t=38, b=8),
    )

    st.plotly_chart(fig, use_container_width=True)


# ============================================================
# APP
# ============================================================

st.title("📈 AI Trading Pro")
st.caption("Kynttiläkaavio, EMA9/EMA21, RSI, Bollinger, BUY/SELL/WAIТ-signaali ja kynttiläkuviot.")

st.sidebar.title("⚙️ Asetukset")

valittu_nimi = st.sidebar.selectbox("Kohde", list(SYMBOLIT.keys()), index=0)
symboli = SYMBOLIT[valittu_nimi]

periodi_nimi = st.sidebar.selectbox("Historia", list(PERIODIT.keys()), index=1)
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

if st.sidebar.button("🔄 Tyhjennä välimuisti / päivitä"):
    st.cache_data.clear()
    st.rerun()

st.sidebar.warning(
    "Huom: yfinance ei anna oikeaa 1s/5s kynttilädataa. "
    "Nopein kynttiläväli on yleensä 1 minuutti. "
    "Sivu päivittyy silti 5 sekunnin välein."
)

with st.spinner("Haetaan markkinadataa..."):
    raw_df = hae_data(symboli, periodi, interval)

if raw_df.empty:
    st.error("Dataa ei saatu haettua. Kokeile: Bitcoin / 5 päivää / 1 minuutti tai 5 minuuttia.")
    st.stop()

df = lisaa_indikaattorit(raw_df)

if df.empty or len(df) < 60:
    st.warning("Dataa on liian vähän. Valitse Historia: 5 päivää ja Kynttiläväli: 1 minuutti tai 5 minuuttia.")
    st.stop()

ennuste = tee_ennuste(df)

last = df.iloc[-1]
prev = df.iloc[-2]
muutos = ((last["Close"] - prev["Close"]) / prev["Close"]) * 100

c1, c2, c3, c4 = st.columns(4)
c1.metric("Kohde", valittu_nimi)
c2.metric("Hinta", f"{last['Close']:,.4f}")
c3.metric("Viime kynttilä", f"{muutos:.2f} %")
c4.metric("AI-score", f"{ennuste['score']} / 100")

nayta_signaali(ennuste["signal"], ennuste["confidence"])

left, right = st.columns([1.45, 1])

with left:
    piirra_kynttilakaavio(df, valittu_nimi)

with right:
    st.markdown('<div class="card">', unsafe_allow_html=True)
    st.subheader("🧠 AI-analyysi")
    st.write(f"**{ennuste['reason']}**")
    st.write(f"Varmuus: **{ennuste['confidence']} %**")
    st.write(f"RSI: **{last['RSI']:.1f}**")
    st.write(f"Momentum: **{last['MOMENTUM']:.2f} %**")
    st.write(f"Volatiliteetti: **{last['VOLATILITY']:.2f} %**")
    st.markdown("</div>", unsafe_allow_html=True)

    st.subheader("🕯️ Kynttilä- ja trendiohje")
    for d in ennuste["details"][:10]:
        st.write("• " + d)

piirra_rsi(df)

st.divider()

st.subheader("🎓 Sisäänrakennetut kuviot")
st.write(
    "Botti tunnistaa nyt: Hammer, Inverted Hammer, Shooting Star, Bullish Engulfing, "
    "Bearish Engulfing, Morning Star, Evening Star, Three White Soldiers, "
    "Three Black Crows, Tweezer Top ja Tweezer Bottom."
)

st.info(
    "Paras aloitusasetus: Bitcoin / USD — Historia 5 päivää — Kynttiläväli 1 minuutti — Live-päivitys 5 sekuntia."
)

st.warning(
    "Tämä on opetukseen ja päätöksenteon tueksi tehty ohjelma. "
    "Se ei ole sijoitusneuvo eikä takaa voittoa."
)

st.caption(f"Päivitetty: {datetime.now().strftime('%d.%m.%Y %H:%M:%S')}")
