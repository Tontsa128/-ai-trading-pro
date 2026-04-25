# -*- coding: utf-8 -*-

from datetime import datetime
import requests
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st


st.set_page_config(
    page_title="AI Trading Pro v20",
    page_icon="📈",
    layout="wide",
    initial_sidebar_state="collapsed",
)

st.markdown("""
<style>
.block-container {padding-top:0.25rem;padding-left:0.35rem;padding-right:0.35rem;}
h1 {font-size:1.05rem!important;margin-bottom:0.1rem;}
[data-testid="stMetricValue"] {font-size:0.9rem!important;}
.signal{
    border-radius:16px;
    padding:14px;
    font-size:22px;
    font-weight:900;
    text-align:center;
    margin:8px 0;
}
.buy{background:linear-gradient(90deg,#15803d,#22c55e);color:white;}
.prebuy{background:linear-gradient(90deg,#bbf7d0,#22c55e);color:#052e16;}
.watchbuy{background:linear-gradient(90deg,#dcfce7,#86efac);color:#052e16;}
.sell{background:linear-gradient(90deg,#b91c1c,#ef4444);color:white;}
.presell{background:linear-gradient(90deg,#fecaca,#ef4444);color:#450a0a;}
.watchsell{background:linear-gradient(90deg,#fee2e2,#fca5a5);color:#450a0a;}
.wait{background:linear-gradient(90deg,#facc15,#ca8a04);color:#111827;}
.card{
    background:#111936;
    border:1px solid #26345e;
    border-radius:14px;
    padding:12px;
    color:white;
    margin-bottom:10px;
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

ENTRY_INTERVALS = ["1m", "3m", "5m", "15m"]


def init_state():
    defaults = {
        "show_ema50": True,
        "show_ema100": True,
        "show_ema9_21": False,
        "show_levels": True,
        "show_bollinger": False,
        "drawing_tools": False,
        "live_on": True,
        "stable_y_range": None,
        "last_chart_key": "",
    }
    for k, v in defaults.items():
        if k not in st.session_state:
            st.session_state[k] = v


init_state()


st.sidebar.title("⚙️ Asetukset")
selected_name = st.sidebar.selectbox("Kohde", list(SYMBOLS.keys()), index=0)
symbol = SYMBOLS[selected_name]

entry_tf = st.sidebar.radio("Entry-aikaväli", ENTRY_INTERVALS, index=2)
refresh_seconds = st.sidebar.radio("Live-päivitys", [3, 5, 10, 15], index=1)
candle_limit = st.sidebar.slider("Kynttilöitä kaaviossa", 50, 180, 90, 10)

st.sidebar.divider()
st.session_state.show_ema50 = st.sidebar.checkbox("EMA50", value=st.session_state.show_ema50)
st.session_state.show_ema100 = st.sidebar.checkbox("EMA100", value=st.session_state.show_ema100)
st.session_state.show_ema9_21 = st.sidebar.checkbox("EMA9 / EMA21", value=st.session_state.show_ema9_21)
st.session_state.show_levels = st.sidebar.checkbox("Support / Resistance", value=st.session_state.show_levels)
st.session_state.show_bollinger = st.sidebar.checkbox("Bollinger", value=st.session_state.show_bollinger)
st.session_state.drawing_tools = st.sidebar.toggle("Piirtoviivat päälle", value=st.session_state.drawing_tools)
st.session_state.live_on = st.sidebar.toggle("Live päällä", value=st.session_state.live_on)

chart_key = f"{symbol}_{entry_tf}_{candle_limit}"
if st.session_state.last_chart_key != chart_key:
    st.session_state.stable_y_range = None
    st.session_state.last_chart_key = chart_key


@st.cache_data(ttl=2, show_spinner=False)
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
        price = price * (1 + np.random.normal(0, 0.0012))
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


def higher_timeframe_bias(symbol_code):
    details = {}
    for tf in ["15m", "1h", "4h"]:
        raw, _ = load_data(symbol_code, tf, 160)
        df = add_indicators(raw)
        closed = df.iloc[:-1].copy() if len(df) > 10 else df
        details[tf] = trend_of(closed)

    bull = sum(1 for v in details.values() if v == "NOUSU")
    bear = sum(1 for v in details.values() if v == "LASKU")

    if bull >= 2:
        return "NOUSU", details
    if bear >= 2:
        return "LASKU", details
    return "EPÄSELVÄ", details


def support_resistance(df, lookback=80):
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


def ai_engine(df_closed, live_price, big_bias, details):
    last = df_closed.iloc[-1]
    prev = df_closed.iloc[-2]

    price = float(live_price)
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
        score = score * 1.08
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

    score = int(max(-100, min(100, score)))
    confidence = int(min(88, max(45, 50 + abs(score) * 0.42)))

    if score >= 50:
        level = "VAHVA OSTA"
        direction = "OSTA"
    elif score >= 32:
        level = "OSTA"
        direction = "OSTA"
    elif score >= 18:
        level = "TARKKAILU OSTA"
        direction = "OSTA"
    elif score <= -50:
        level = "VAHVA MYY"
        direction = "MYY"
    elif score <= -32:
        level = "MYY"
        direction = "MYY"
    elif score <= -18:
        level = "TARKKAILU MYY"
        direction = "MYY"
    else:
        level = "ODOTA"
        direction = "ODOTA"

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

    return {
        "level": level,
        "direction": direction,
        "score": score,
        "confidence": confidence,
        "price": price,
        "support": support,
        "resistance": resistance,
        "stop": stop,
        "target": target,
        "big_bias": big_bias,
        "details": details,
        "notes": notes[:14],
    }


def signal_box(ai):
    level = ai["level"]
    conf = ai["confidence"]

    if level == "VAHVA OSTA":
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


def get_stable_y_range(d, live_price):
    y_low = float(d["Low"].min())
    y_high = float(d["High"].max())
    pad = max((y_high - y_low) * 0.16, live_price * 0.0015)
    wanted = [y_low - pad, y_high + pad]

    current = st.session_state.stable_y_range

    if current is None:
        st.session_state.stable_y_range = wanted
        return wanted

    low, high = current
    height = high - low

    near_top = live_price > high - height * 0.12
    near_bottom = live_price < low + height * 0.12
    outside = live_price > high or live_price < low

    if outside or near_top or near_bottom:
        st.session_state.stable_y_range = wanted
        return wanted

    return current


def draw_chart(df_live, ai):
    d = df_live.tail(candle_limit).copy()
    live_price = ai["price"]

    y_range = get_stable_y_range(d, live_price)
    x_range = [d.index[0], d.index[-1]]

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
        whiskerwidth=0.8,
    ))

    if st.session_state.show_ema9_21:
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA9, mode="lines", name="EMA9", line=dict(width=1, color="#38bdf8")))
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA21, mode="lines", name="EMA21", line=dict(width=1, color="#fb7185")))

    if st.session_state.show_ema50:
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA50, mode="lines", name="EMA50", line=dict(width=2, color="#facc15")))

    if st.session_state.show_ema100:
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA100, mode="lines", name="EMA100", line=dict(width=2, color="#c084fc")))

    if st.session_state.show_bollinger:
        fig.add_trace(go.Scatter(x=d.index, y=d.BB_UPPER, mode="lines", name="BB ylä", line=dict(width=1, color="#94a3b8")))
        fig.add_trace(go.Scatter(x=d.index, y=d.BB_LOWER, mode="lines", name="BB ala", line=dict(width=1, color="#94a3b8")))

    if st.session_state.show_levels:
        if y_range[0] <= ai["support"] <= y_range[1]:
            fig.add_hline(y=ai["support"], line_dash="dot", line_color="#22c55e", annotation_text="SUPPORT")
        if y_range[0] <= ai["resistance"] <= y_range[1]:
            fig.add_hline(y=ai["resistance"], line_dash="dot", line_color="#ef4444", annotation_text="RESISTANCE")

    fig.add_hline(y=ai["price"], line_dash="dash", line_color="#facc15", annotation_text="NYKYHINTA")

    if ai["direction"] != "ODOTA":
        if ai["stop"] is not None and y_range[0] <= ai["stop"] <= y_range[1]:
            fig.add_hline(y=ai["stop"], line_dash="dash", line_color="#ef4444", annotation_text="STOP")
        if ai["target"] is not None and y_range[0] <= ai["target"] <= y_range[1]:
            fig.add_hline(y=ai["target"], line_dash="dash", line_color="#22c55e", annotation_text="TARGET")

    fig.update_layout(
        title=f"{selected_name} — V20 VAKAA LIVE-KYNTTILÄKAAVIO",
        height=430,
        template="plotly_dark",
        paper_bgcolor="#070d1c",
        plot_bgcolor="#070d1c",
        xaxis_rangeslider_visible=False,
        margin=dict(l=5, r=5, t=42, b=5),
        legend=dict(orientation="h", y=1.04, x=0),
        dragmode="drawline" if st.session_state.drawing_tools else "pan",
        newshape=dict(line_color="#facc15", line_width=2),
        uirevision="stable_v20",
        xaxis=dict(range=x_range, autorange=False),
        yaxis=dict(range=y_range, autorange=False),
    )

    config = {
        "displayModeBar": st.session_state.drawing_tools,
        "scrollZoom": False,
        "responsive": True,
    }

    if st.session_state.drawing_tools:
        config["modeBarButtonsToAdd"] = ["drawline", "drawopenpath", "drawrect", "eraseshape"]

    st.plotly_chart(fig, use_container_width=True, config=config)


def render_app():
    raw, source = load_data(symbol, entry_tf, max(candle_limit + 140, 240))
    df_live = add_indicators(raw)

    # AI käyttää sulkeutuneita kynttilöitä, kaavio näyttää myös elävän viimeisen kynttilän.
    df_closed = df_live.iloc[:-1].copy() if len(df_live) > 30 else df_live.copy()
    live_price = float(df_live["Close"].iloc[-1])

    big_bias, details = higher_timeframe_bias(symbol)
    ai = ai_engine(df_closed, live_price, big_bias, details)

    st.title("📈 AI Trading Pro v20")

    c1, c2, c3, c4 = st.columns(4)
    c1.metric("Kohde", selected_name)
    c2.metric("Hinta", f"{ai['price']:,.4f}")
    c3.metric("AI-score", f"{ai['score']} / 100")
    c4.metric("Trend", ai["big_bias"])

    st.caption(
        f"Datalähde: {source} | TF: {entry_tf} | Päivitetty: {datetime.now().strftime('%H:%M:%S')} | Live {refresh_seconds}s"
    )

    signal_box(ai)
    draw_chart(df_live, ai)

    left, right = st.columns([1, 1])

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

    with right:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("🧠 Miksi AI näyttää näin?")
        st.write(f"15m: **{ai['details']['15m']}** | 1h: **{ai['details']['1h']}** | 4h: **{ai['details']['4h']}**")
        for n in ai["notes"]:
            st.write("• " + n)
        st.markdown("</div>", unsafe_allow_html=True)

    st.warning("Opetustyökalu. Ei tee oikeita kauppoja eikä ole sijoitusneuvo.")


run_every = f"{refresh_seconds}s" if st.session_state.live_on else None


@st.fragment(run_every=run_every)
def live_fragment():
    render_app()


live_fragment()
