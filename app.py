# -*- coding: utf-8 -*-

from datetime import datetime
from zoneinfo import ZoneInfo
import requests
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

APP_TZ = "Europe/Helsinki"

st.set_page_config(
    page_title="Rahasampo Radar V25",
    page_icon="💰",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown("""
<style>
.block-container {padding-top:0.35rem;padding-left:1rem;padding-right:1rem;}
h1 {font-size:1.55rem!important;}
.signal{
    border-radius:20px;
    padding:22px;
    font-size:34px;
    font-weight:900;
    text-align:center;
    margin:10px 0 16px 0;
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
    padding:16px;
    color:white;
    margin-bottom:12px;
}
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
        "last_level": "ODOTA",
        "last_score": 0,
        "memory": [],
    }
    for k, v in defaults.items():
        if k not in st.session_state:
            st.session_state[k] = v


init_state()

st.sidebar.title("💰 Rahasampo Radar V25")
selected_name = st.sidebar.selectbox("Kohde", list(SYMBOLS.keys()), index=0)
symbol = SYMBOLS[selected_name]
tf = st.sidebar.radio("Aikaväli", TIMEFRAMES, index=0)
refresh = st.sidebar.radio("Live-päivitys", [1, 2, 3, 5], index=1)
candles = st.sidebar.slider("Kynttilöitä", 80, 300, 180, 10)

st.sidebar.divider()
show_fast = st.sidebar.checkbox("Näytä EMA9/21", True)
show_slow = st.sidebar.checkbox("Näytä EMA50/100", True)
show_vwap = st.sidebar.checkbox("Näytä VWAP", False)
show_levels = st.sidebar.checkbox("Support / Resistance", True)
live_on = st.sidebar.toggle("Live päällä", True)

if st.sidebar.button("🔄 Resetoi"):
    st.session_state.df = None
    st.session_state.memory = []
    st.rerun()

new_key = f"{symbol}_{tf}_{candles}"
if st.session_state.key != new_key:
    st.session_state.key = new_key
    st.session_state.df = None
    st.session_state.last_level = "ODOTA"
    st.session_state.last_score = 0


@st.cache_data(ttl=1, show_spinner=False)
def get_klines(symbol_code, interval_code, limit_count):
    urls = [
        "https://api.binance.com/api/v3/klines",
        "https://api1.binance.com/api/v3/klines",
        "https://api2.binance.com/api/v3/klines",
        "https://api3.binance.com/api/v3/klines",
        "https://data-api.binance.vision/api/v3/klines",
    ]

    last_error = ""

    for url in urls:
        try:
            r = requests.get(
                url,
                params={"symbol": symbol_code, "interval": interval_code, "limit": int(limit_count)},
                timeout=8,
                headers={"User-Agent": "Mozilla/5.0"},
            )
            if r.status_code != 200:
                last_error = r.text[:100]
                continue

            raw = r.json()
            rows = []
            for k in raw:
                rows.append({
                    "Date": pd.to_datetime(k[0], unit="ms", utc=True).tz_convert(APP_TZ),
                    "Open": float(k[1]),
                    "High": float(k[2]),
                    "Low": float(k[3]),
                    "Close": float(k[4]),
                    "Volume": float(k[5]),
                })

            return pd.DataFrame(rows).set_index("Date")

        except Exception as e:
            last_error = str(e)

    raise RuntimeError(last_error)


def load_data():
    if st.session_state.df is None:
        st.session_state.df = get_klines(symbol, tf, max(candles + 200, 420))
    else:
        latest = get_klines(symbol, tf, 8)
        df = pd.concat([st.session_state.df, latest])
        df = df[~df.index.duplicated(keep="last")]
        df = df.sort_index().tail(max(candles + 200, 420))
        st.session_state.df = df

    return st.session_state.df.copy()


def rsi(close, period=14):
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return (100 - (100 / (1 + rs))).fillna(50)


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

    df["ATR"] = tr.rolling(14, min_periods=5).mean().bfill()
    df["VOL_MA"] = df["Volume"].rolling(20, min_periods=5).mean().bfill()

    typical = (df["High"] + df["Low"] + df["Close"]) / 3
    df["VWAP"] = (typical * df["Volume"]).cumsum() / df["Volume"].replace(0, np.nan).cumsum()
    df["VWAP"] = df["VWAP"].ffill().bfill()
    return df


def higher_tf_bias(symbol_code):
    result = {}

    for htf in ["5m", "15m", "1h"]:
        try:
            d = add_indicators(get_klines(symbol_code, htf, 180))
            last = d.iloc[-2]
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

    if bull >= 2:
        return "NOUSU", result
    if bear >= 2:
        return "LASKU", result
    return "EPÄSELVÄ", result


def support_resistance(df):
    d = df.tail(120)
    return (
        float(d["Low"].quantile(0.08)),
        float(d["High"].quantile(0.92)),
        float(d["Close"].median()),
    )


def candle_pattern_score(df):
    if len(df) < 6:
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

    if body / rng < 0.12:
        notes.append("Doji / epäröinti")

    if green and lower > body * 2:
        score += 12
        notes.append("Hammer / ostajat puolustavat")

    if red and upper > body * 2:
        score -= 12
        notes.append("Shooting star / myyjät painavat")

    if p_red and green and c.Close > p.Open:
        score += 18
        notes.append("Bullish engulfing")

    if p_green and red and c.Close < p.Open:
        score -= 18
        notes.append("Bearish engulfing")

    if green and body / rng > 0.72:
        score += 18
        notes.append("Vahva vihreä momentum-kynttilä")

    if red and body / rng > 0.72:
        score -= 18
        notes.append("Vahva punainen momentum-kynttilä")

    if p2.Close < p2.Open and abs(p.Close - p.Open) < abs(p2.Close - p2.Open) * 0.5 and green:
        score += 14
        notes.append("Morning star -tyyppinen käännös")

    if p2.Close > p2.Open and abs(p.Close - p.Open) < abs(p2.Close - p2.Open) * 0.5 and red:
        score -= 14
        notes.append("Evening star -tyyppinen käännös")

    last3 = df.tail(3)
    if all(last3["Close"] > last3["Open"]) and last3["Close"].is_monotonic_increasing:
        score += 16
        notes.append("Three white soldiers / nousupaine")

    if all(last3["Close"] < last3["Open"]) and last3["Close"].is_monotonic_decreasing:
        score -= 16
        notes.append("Three black crows / myyntipaine")

    return score, notes


def live_reaction(df):
    c = df.iloc[-1]
    prev = df.iloc[:-1]
    price = float(c.Close)

    body = abs(c.Close - c.Open)
    atr = max(float(df["ATR"].iloc[-2]), price * 0.001)
    vol_ma = max(float(df["VOL_MA"].iloc[-2]), 1e-9)

    green = c.Close > c.Open
    red = c.Close < c.Open

    score = 0
    notes = []

    if green:
        if body > atr * 0.32:
            score += 24
            notes.append("Live-vihreä kynttilä vahvistuu nopeasti")
        if body > atr * 0.62:
            score += 18
            notes.append("Live-vihreä kynttilä erittäin vahva")
        if c.Close > c.EMA9:
            score += 10
            notes.append("Hinta EMA9 yläpuolella")
        if c.Close > c.EMA21:
            score += 10
            notes.append("Hinta EMA21 yläpuolella")
        if c.High > prev.High.tail(10).max():
            score += 14
            notes.append("Uusi korkea huippu / breakout")
        if c.Volume > vol_ma:
            score += 8
            notes.append("Volyymi tukee nousua")

    if red:
        if body > atr * 0.32:
            score -= 24
            notes.append("Live-punainen kynttilä vahvistuu nopeasti")
        if body > atr * 0.62:
            score -= 18
            notes.append("Live-punainen kynttilä erittäin vahva")
        if c.Close < c.EMA9:
            score -= 10
            notes.append("Hinta EMA9 alapuolella")
        if c.Close < c.EMA21:
            score -= 10
            notes.append("Hinta EMA21 alapuolella")
        if c.Low < prev.Low.tail(10).min():
            score -= 14
            notes.append("Uusi matala pohja / breakdown")
        if c.Volume > vol_ma:
            score -= 8
            notes.append("Volyymi tukee laskua")

    if score >= 34:
        return score, "NOPEA OSTA", notes
    if score <= -34:
        return score, "NOPEA MYY", notes

    return score, "EI", notes


def range_filter(df):
    d = df.tail(50)
    price = float(df.Close.iloc[-1])
    rng = (d.High.max() - d.Low.min()) / price
    ema_gap = abs(df.EMA50.iloc[-1] - df.EMA100.iloc[-1]) / price
    return rng < 0.0038 and ema_gap < 0.0018


def ai_engine(df):
    live = df.iloc[-1]
    closed = df.iloc[:-1].copy()

    price = float(live.Close)
    score = 0
    notes = []

    bias, details = higher_tf_bias(symbol)
    support, resistance, mid = support_resistance(closed)

    if bias == "NOUSU":
        score += 14
        notes.append("Isompi aikaväli tukee nousua")
    elif bias == "LASKU":
        score -= 14
        notes.append("Isompi aikaväli tukee laskua")
    else:
        notes.append("Isompi aikaväli epäselvä")

    if price > live.EMA9 > live.EMA21:
        score += 14
        notes.append("Nopea EMA-rakenne bullish")

    if price < live.EMA9 < live.EMA21:
        score -= 14
        notes.append("Nopea EMA-rakenne bearish")

    if price > live.EMA50 > live.EMA100:
        score += 16
        notes.append("Pitkä EMA-rakenne bullish")

    if price < live.EMA50 < live.EMA100:
        score -= 16
        notes.append("Pitkä EMA-rakenne bearish")

    if price > live.VWAP:
        score += 6
        notes.append("Hinta VWAP yläpuolella")
    else:
        score -= 6
        notes.append("Hinta VWAP alapuolella")

    if live.RSI < 30:
        score += 10
        notes.append(f"RSI {live.RSI:.1f}: ylimyyty")
    elif live.RSI > 70:
        score -= 10
        notes.append(f"RSI {live.RSI:.1f}: yliostettu")

    if live.MACD > live.MACD_SIGNAL and live.MACD_HIST > 0:
        score += 10
        notes.append("MACD bullish")

    if live.MACD < live.MACD_SIGNAL and live.MACD_HIST < 0:
        score -= 10
        notes.append("MACD bearish")

    p_score, p_notes = candle_pattern_score(closed)
    score += p_score
    notes.extend(p_notes)

    l_score, alert, l_notes = live_reaction(df)
    score += l_score * 0.95
    notes.extend(l_notes)

    no_trade = range_filter(closed)

    if no_trade and alert == "EI":
        score *= 0.55
        notes.append("Sivuttaismarkkina: signaalia leikataan")

    final = int(max(-100, min(100, score)))

    if alert == "NOPEA OSTA":
        level = "⚡ NOPEA OSTA"
        final = max(final, 58)
    elif alert == "NOPEA MYY":
        level = "⚡ NOPEA MYY"
        final = min(final, -58)
    elif final >= 55:
        level = "VAHVA OSTA"
    elif final >= 32:
        level = "OSTA"
    elif final >= 18:
        level = "TARKKAILU OSTA"
    elif final <= -55:
        level = "VAHVA MYY"
    elif final <= -32:
        level = "MYY"
    elif final <= -18:
        level = "TARKKAILU MYY"
    else:
        level = "ODOTA"

    if no_trade and abs(final) < 24:
        level = "EI TREIDIÄ"

    conf = int(min(95, max(45, 50 + abs(final) * 0.45)))

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
    if stop and target:
        rr = abs(target - price) / abs(price - stop)

    return {
        "level": level,
        "score": final,
        "confidence": conf,
        "price": price,
        "support": support,
        "resistance": resistance,
        "mid": mid,
        "bias": bias,
        "details": details,
        "notes": notes[:20],
        "direction": direction,
        "stop": stop,
        "target": target,
        "rr": rr,
    }


def signal_box(ai):
    level = ai["level"]
    conf = ai["confidence"]

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
        f'<div class="signal {cls}">{level}<br>{conf}%</div>',
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
    ))

    if show_fast:
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA9, name="EMA9", mode="lines", line=dict(color="#38bdf8", width=1.5)))
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA21, name="EMA21", mode="lines", line=dict(color="#fb7185", width=1.5)))

    if show_slow:
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA50, name="EMA50", mode="lines", line=dict(color="#facc15", width=2.4)))
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA100, name="EMA100", mode="lines", line=dict(color="#c084fc", width=2.4)))

    if show_vwap:
        fig.add_trace(go.Scatter(x=d.index, y=d.VWAP, name="VWAP", mode="lines", line=dict(color="#22d3ee", width=2.0)))

    if show_levels:
        fig.add_hline(y=ai["support"], line_dash="dot", line_color="#22c55e")
        fig.add_hline(y=ai["resistance"], line_dash="dot", line_color="#ef4444")
        fig.add_hline(y=ai["mid"], line_dash="dot", line_color="#64748b")

    fig.add_hline(y=ai["price"], line_dash="dash", line_color="#facc15")

    if ai["stop"] is not None:
        fig.add_hline(y=ai["stop"], line_dash="dash", line_color="#ef4444")
        fig.add_hline(y=ai["target"], line_dash="dash", line_color="#22c55e")

    fig.update_layout(
        title=f"{selected_name} — Rahasampo Radar V25",
        height=760,
        template="plotly_dark",
        paper_bgcolor="#070d1c",
        plot_bgcolor="#070d1c",
        margin=dict(l=8, r=8, t=50, b=8),
        xaxis_rangeslider_visible=False,
        legend=dict(orientation="h", y=1.04, x=0),
        uirevision=f"v25_{symbol}_{tf}",
    )

    st.plotly_chart(fig, use_container_width=True, config={"scrollZoom": True, "responsive": True})


def remember(ai):
    if ai["level"] in ["ODOTA", "EI TREIDIÄ"]:
        return

    now = datetime.now(ZoneInfo(APP_TZ)).strftime("%H:%M:%S")

    st.session_state.memory.append({
        "Aika": now,
        "Kohde": selected_name,
        "Signaali": ai["level"],
        "Hinta": round(ai["price"], 4),
        "Score": ai["score"],
        "Varmuus": ai["confidence"],
    })

    st.session_state.memory = st.session_state.memory[-50:]


def run():
    try:
        raw = load_data()
        df = add_indicators(raw)
        ai = ai_engine(df)
        remember(ai)

        st.title("💰 Rahasampo Radar V25 PRO")

        c1, c2, c3, c4, c5 = st.columns(5)
        c1.metric("Kohde", selected_name)
        c2.metric("Hinta", f"{ai['price']:,.4f}")
        c3.metric("Signaali", ai["level"])
        c4.metric("Score", f"{ai['score']} / 100")
        c5.metric("Trend", ai["bias"])

        st.caption(f"Binance live OHLC | TF: {tf} | Päivitetty: {now_local()} | Live {refresh}s")

        signal_box(ai)
        draw_chart(df, ai)

        a, b, c = st.columns(3)

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
                st.write("Ei vielä entryä.")
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
            st.subheader("🧠 Miksi AI sanoo näin?")
            for n in ai["notes"]:
                st.write("• " + n)
            st.markdown("</div>", unsafe_allow_html=True)

        with st.expander("🧠 AI-muisti"):
            if st.session_state.memory:
                st.dataframe(pd.DataFrame(st.session_state.memory), use_container_width=True, hide_index=True)
            else:
                st.info("Ei vielä signaaleja.")

        st.warning("Opetustyökalu. Ei tee oikeita kauppoja eikä ole sijoitusneuvo.")

    except Exception as e:
        st.error(f"Virhe: {e}")


run_every = f"{refresh}s" if live_on else None


@st.fragment(run_every=run_every)
def live_fragment():
    run()


live_fragment()
