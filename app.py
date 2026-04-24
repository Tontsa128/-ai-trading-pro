# -*- coding: utf-8 -*-

from datetime import datetime
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st
import yfinance as yf
from streamlit_autorefresh import st_autorefresh


st.set_page_config(
    page_title="AI Trading Pro v12",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="expanded"
)


st.markdown("""
<style>
.block-container {
    padding-top: 0.3rem;
    padding-left: 0.6rem;
    padding-right: 0.6rem;
}
h1 {
    font-size: 1.45rem !important;
    margin-bottom: 0.1rem !important;
}
.signal-main {
    width: 100%;
    min-height: 58px;
    border-radius: 18px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 24px;
    font-weight: 950;
    letter-spacing: 0.5px;
    box-shadow: 0 0 18px rgba(0,0,0,0.35);
    margin-top: 6px;
    margin-bottom: 8px;
    border: 1px solid rgba(255,255,255,0.35);
    text-align: center;
}
.card {
    background: #101827;
    border: 1px solid #273244;
    border-radius: 14px;
    padding: 12px;
    color: #e5e7eb;
}
.small-text {
    font-size: 12px;
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


@st.cache_data(ttl=10, show_spinner=False)
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

    df["RSI"] = laske_rsi(df["Close"], 14)

    df["MA20"] = df["Close"].rolling(20).mean()
    df["STD20"] = df["Close"].rolling(20).std()
    df["BB_UPPER"] = df["MA20"] + 2 * df["STD20"]
    df["BB_LOWER"] = df["MA20"] - 2 * df["STD20"]

    df["MOMENTUM"] = df["Close"].pct_change(5) * 100
    df["VOLATILITY"] = df["Close"].pct_change().rolling(20).std() * 100

    return df.dropna()


def is_green(row):
    return row["Close"] > row["Open"]


def is_red(row):
    return row["Close"] < row["Open"]


def body(row):
    return abs(row["Close"] - row["Open"])


def candle_range(row):
    return max(row["High"] - row["Low"], 0.0000001)


def tunnista_kynttilat(df):
    score = 0
    details = []

    if len(df) < 5:
        return 0, ["Dataa liian vähän kynttiläkuvioihin."]

    c = df.iloc[-1]
    p = df.iloc[-2]
    p2 = df.iloc[-3]

    b = body(c)
    r = candle_range(c)
    upper = c["High"] - max(c["Open"], c["Close"])
    lower = min(c["Open"], c["Close"]) - c["Low"]

    if b / r < 0.12:
        details.append("Doji: markkina epäröi.")

    if lower > b * 2.2 and upper < b * 1.2:
        score += 20
        details.append("Hammer: BUY-käännös mahdollinen.")

    if upper > b * 2.2 and lower < b * 1.2 and is_red(c):
        score -= 20
        details.append("Shooting Star: SELL-käännös mahdollinen.")

    if is_red(p) and is_green(c) and c["Close"] > p["Open"] and c["Open"] < p["Close"]:
        score += 30
        details.append("Bullish Engulfing: vahva BUY-kuvio.")

    if is_green(p) and is_red(c) and c["Open"] > p["Close"] and c["Close"] < p["Open"]:
        score -= 30
        details.append("Bearish Engulfing: vahva SELL-kuvio.")

    if is_red(p2) and body(p) < body(p2) * 0.6 and is_green(c):
        if c["Close"] > ((p2["Open"] + p2["Close"]) / 2):
            score += 28
            details.append("Morning Star: BUY-käännös.")

    if is_green(p2) and body(p) < body(p2) * 0.6 and is_red(c):
        if c["Close"] < ((p2["Open"] + p2["Close"]) / 2):
            score -= 28
            details.append("Evening Star: SELL-käännös.")

    if is_green(df.iloc[-3]) and is_green(df.iloc[-2]) and is_green(df.iloc[-1]):
        if df.iloc[-1]["Close"] > df.iloc[-2]["Close"] > df.iloc[-3]["Close"]:
            score += 22
            details.append("Three White Soldiers: nousu vahvistuu.")

    if is_red(df.iloc[-3]) and is_red(df.iloc[-2]) and is_red(df.iloc[-1]):
        if df.iloc[-1]["Close"] < df.iloc[-2]["Close"] < df.iloc[-3]["Close"]:
            score -= 22
            details.append("Three Black Crows: lasku vahvistuu.")

    if not details:
        details.append("Ei vahvaa kynttiläkuviota juuri nyt.")

    return score, details


def tee_ennuste(df):
    if len(df) < 60:
        return {
            "signal": "ODOTA",
            "level": "ODOTA",
            "confidence": 50,
            "score": 0,
            "reason": "Dataa on liian vähän.",
            "details": ["Valitse historia 5 päivää ja kynttiläväli 1 minuutti tai 5 minuuttia."]
        }

    last = df.iloc[-1]
    prev = df.iloc[-2]

    score = 0
    details = []
    confirmations_buy = 0
    confirmations_sell = 0

    if prev["EMA9"] <= prev["EMA21"] and last["EMA9"] > last["EMA21"]:
        score += 30
        confirmations_buy += 1
        details.append("EMA9 ylitti EMA21:n ylöspäin.")

    if prev["EMA9"] >= prev["EMA21"] and last["EMA9"] < last["EMA21"]:
        score -= 30
        confirmations_sell += 1
        details.append("EMA9 alitti EMA21:n alaspäin.")

    if last["EMA9"] > last["EMA21"] > last["EMA50"]:
        score += 28
        confirmations_buy += 1
        details.append("EMA-trendi on nouseva.")

    elif last["EMA9"] < last["EMA21"] < last["EMA50"]:
        score -= 28
        confirmations_sell += 1
        details.append("EMA-trendi on laskeva.")
    else:
        details.append("EMA-trendi on vielä epäselvä.")

    if last["Close"] > last["EMA9"] and last["Close"] > last["EMA21"]:
        score += 12
        confirmations_buy += 1
        details.append("Hinta on EMA9 ja EMA21 yläpuolella.")

    elif last["Close"] < last["EMA9"] and last["Close"] < last["EMA21"]:
        score -= 12
        confirmations_sell += 1
        details.append("Hinta on EMA9 ja EMA21 alapuolella.")

    if last["RSI"] < 30:
        score += 14
        confirmations_buy += 1
        details.append("RSI alle 30: ylimyyty.")
    elif last["RSI"] > 70:
        score -= 14
        confirmations_sell += 1
        details.append("RSI yli 70: yliostettu.")
    elif 45 <= last["RSI"] <= 62:
        score += 4
        details.append("RSI on terveellä alueella.")

    if last["MOMENTUM"] > 0.20:
        score += 14
        confirmations_buy += 1
        details.append("Momentum on positiivinen.")
    elif last["MOMENTUM"] < -0.20:
        score -= 14
        confirmations_sell += 1
        details.append("Momentum on negatiivinen.")
    else:
        details.append("Momentum neutraali.")

    candle_score, candle_details = tunnista_kynttilat(df)
    score += candle_score

    if candle_score > 0:
        confirmations_buy += 1
    elif candle_score < 0:
        confirmations_sell += 1

    details.extend(candle_details)

    score = int(max(-100, min(100, score)))
    confidence = int(min(96, max(45, 50 + abs(score) * 0.46)))

    if score >= 55 and confirmations_buy >= 3:
        signal = "OSTA"
        level = "VAHVA OSTA"
        reason = "Useampi BUY-vahvistus on samaan aikaan päällä."
    elif score >= 25 and confirmations_buy >= 2:
        signal = "OSTA"
        level = "VALMISTAUTUU OSTOON"
        reason = "BUY-paine kasvaa, mutta odota vielä vahvistusta."
    elif score <= -55 and confirmations_sell >= 3:
        signal = "MYY"
        level = "VAHVA MYY"
        reason = "Useampi SELL-vahvistus on samaan aikaan päällä."
    elif score <= -25 and confirmations_sell >= 2:
        signal = "MYY"
        level = "VALMISTAUTUU MYYNTIIN"
        reason = "SELL-paine kasvaa, mutta odota vielä vahvistusta."
    else:
        signal = "ODOTA"
        level = "ODOTA"
        reason = "Ei tarpeeksi varmaa paikkaa."

    return {
        "signal": signal,
        "level": level,
        "confidence": confidence,
        "score": score,
        "reason": reason,
        "details": details
    }


def nayta_signaali(ennuste):
    signal = ennuste["signal"]
    level = ennuste["level"]
    confidence = ennuste["confidence"]

    if level == "VAHVA OSTA":
        bg = f"linear-gradient(90deg, #86efac 0%, #22c55e 60%, #064e3b 100%)"
        text = "🟢 VAHVA BUY / OSTA"
        color = "white"
    elif level == "VALMISTAUTUU OSTOON":
        bg = f"linear-gradient(90deg, #dcfce7 0%, #86efac 65%, #22c55e 100%)"
        text = "🟢 VALMISTAUTUU OSTOON"
        color = "#052e16"
    elif level == "VAHVA MYY":
        bg = f"linear-gradient(90deg, #fca5a5 0%, #ef4444 60%, #7f1d1d 100%)"
        text = "🔴 VAHVA SELL / MYY"
        color = "white"
    elif level == "VALMISTAUTUU MYYNTIIN":
        bg = f"linear-gradient(90deg, #fee2e2 0%, #fca5a5 65%, #ef4444 100%)"
        text = "🔴 VALMISTAUTUU MYYNTIIN"
        color = "#450a0a"
    else:
        bg = "linear-gradient(90deg, #fef3c7 0%, #facc15 55%, #ca8a04 100%)"
        text = "🟡 WAIT / ODOTA"
        color = "black"

    st.markdown(f"""
    <div class="signal-main" style="background:{bg}; color:{color};">
        {text} — {confidence}%
    </div>
    """, unsafe_allow_html=True)


def piirra_kynttilakaavio(df, nimi, kynttilamaara):
    df_plot = df.tail(kynttilamaara).copy()

    fig = go.Figure()

    fig.add_trace(go.Candlestick(
        x=df_plot.index.astype(str),
        open=df_plot["Open"],
        high=df_plot["High"],
        low=df_plot["Low"],
        close=df_plot["Close"],
        name="Kynttilät",
        increasing_line_color="#00ff66",
        decreasing_line_color="#ff3333",
        increasing_fillcolor="#00ff66",
        decreasing_fillcolor="#ff3333",
        whiskerwidth=0.9,
    ))

    fig.add_trace(go.Scatter(
        x=df_plot.index.astype(str),
        y=df_plot["EMA9"],
        mode="lines",
        name="EMA 9",
        line=dict(width=2, color="#3b82f6")
    ))

    fig.add_trace(go.Scatter(
        x=df_plot.index.astype(str),
        y=df_plot["EMA21"],
        mode="lines",
        name="EMA 21",
        line=dict(width=2, color="#ef4444")
    ))

    fig.update_layout(
        title=f"{nimi} — KYNTTILÄKAAVIO",
        height=520,
        template="plotly_dark",
        xaxis_rangeslider_visible=False,
        dragmode="pan",
        margin=dict(l=5, r=5, t=50, b=10),
        legend=dict(
            orientation="h",
            yanchor="bottom",
            y=1.02,
            xanchor="left",
            x=0,
            font=dict(size=11)
        ),
        xaxis=dict(
            type="category",
            showgrid=True,
            nticks=7
        ),
        yaxis=dict(
            showgrid=True,
            fixedrange=False
        )
    )

    st.plotly_chart(fig, use_container_width=True)


def piirra_rsi(df, kynttilamaara):
    df_plot = df.tail(kynttilamaara).copy()

    fig = go.Figure()

    fig.add_trace(go.Scatter(
        x=df_plot.index.astype(str),
        y=df_plot["RSI"],
        mode="lines",
        name="RSI",
        line=dict(width=2)
    ))

    fig.add_hline(y=70, line_dash="dash")
    fig.add_hline(y=50, line_dash="dot")
    fig.add_hline(y=30, line_dash="dash")

    fig.update_layout(
        title="RSI",
        height=190,
        template="plotly_dark",
        margin=dict(l=5, r=5, t=38, b=8),
        xaxis=dict(type="category", nticks=6)
    )

    st.plotly_chart(fig, use_container_width=True)


st.title("📈 AI Trading Pro v12")
st.caption("Selkeä mobiilinäkymä, isot kynttilät, EMA9/EMA21, BUY/SELL/WAIТ ja kynttiläkuviot.")

st.sidebar.title("⚙️ Asetukset")

valittu_nimi = st.sidebar.selectbox("Kohde", list(SYMBOLIT.keys()), index=0)
symboli = SYMBOLIT[valittu_nimi]

periodi_nimi = st.sidebar.selectbox("Historia", list(PERIODIT.keys()), index=1)
interval_nimi = st.sidebar.selectbox("Kynttiläväli", list(AIKAVALIT.keys()), index=0)

kynttilamaara = st.sidebar.slider("Näytettävät kynttilät", 30, 150, 70, 10)

refresh_seconds = st.sidebar.selectbox(
    "Live-päivitys",
    [5, 10, 15, 30, 60],
    index=0
)

periodi = PERIODIT[periodi_nimi]
interval = AIKAVALIT[interval_nimi]

st_autorefresh(
    interval=refresh_seconds * 1000,
    key=f"live_refresh_{symboli}_{interval}_{periodi}"
)

if st.sidebar.button("🔄 Tyhjennä välimuisti / päivitä"):
    st.cache_data.clear()
    st.rerun()

st.sidebar.warning(
    "YFinance ei anna oikeaa 1s/5s kynttilädataa. "
    "Nopein järkevä kynttiläväli on 1 minuutti. "
    "Sivu voi silti päivittyä 5 sekunnin välein."
)

with st.spinner("Haetaan markkinadataa..."):
    raw_df = hae_data(symboli, periodi, interval)

if raw_df.empty:
    st.error("Dataa ei saatu. Kokeile Bitcoin / 5 päivää / 1 minuutti.")
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
c3.metric("Viime kynttilä", f"{muutos:.3f} %")
c4.metric("AI-score", f"{ennuste['score']} / 100")

nayta_signaali(ennuste)

st.caption(f"Viimeisin data: {df.index[-1]} | Päivitetty sivulla: {datetime.now().strftime('%H:%M:%S')}")

piirra_kynttilakaavio(df, valittu_nimi, kynttilamaara)

st.markdown('<div class="card">', unsafe_allow_html=True)
st.subheader("🧠 AI-analyysi")
st.write(f"**{ennuste['reason']}**")
st.write(f"Varmuus: **{ennuste['confidence']} %**")
st.write(f"RSI: **{last['RSI']:.1f}**")
st.write(f"Momentum: **{last['MOMENTUM']:.3f} %**")
st.write(f"Volatiliteetti: **{last['VOLATILITY']:.3f} %**")
st.markdown("</div>", unsafe_allow_html=True)

st.subheader("🕯️ Miksi botti päätyi tähän?")
for d in ennuste["details"][:12]:
    st.write("• " + d)

piirra_rsi(df, kynttilamaara)

st.divider()

st.subheader("🎓 Sisäänrakennetut kuviot")
st.write(
    "Hammer, Shooting Star, Bullish Engulfing, Bearish Engulfing, Morning Star, "
    "Evening Star, Three White Soldiers ja Three Black Crows."
)

st.info(
    "Paras aloitusasetus: Bitcoin / USD — Historia 5 päivää — Kynttiläväli 1 minuutti — Näytettävät kynttilät 70."
)

st.warning(
    "Tämä on opetukseen ja päätöksenteon tueksi tehty ohjelma. "
    "Se ei ole sijoitusneuvo eikä takaa voittoa."
)
