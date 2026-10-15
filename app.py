# -*- coding: utf-8 -*-

from datetime import datetime
from zoneinfo import ZoneInfo
import time
import numpy as np
import pandas as pd
import plotly.graph_objects as go
import streamlit as st

from rahasampo.data_quality import has_sufficient_timeframe_data, select_closed_candles, validate_ohlcv
from rahasampo.decision import classify_score
from rahasampo.cross_exchange import get_spot_price_check
from rahasampo.guardrails import apply_signal_guardrails
from rahasampo.signal_journal import journal_counts, record_decision
from rahasampo.market_data import fetch_binance_klines, fetch_binance_24h_tickers
from rahasampo.risk import gate_decision_by_net_costs
from rahasampo.strategy import add_indicators, ai_engine


# ============================================================
# RAHASAMPO RADAR V27 PRO — RESEARCH PREVIEW
# Opetustyökalu / treidausavustaja.
# Ei sijoitusneuvo. Ei tee oikeita kauppoja.
# ============================================================

APP_TZ = "Europe/Helsinki"

st.set_page_config(
    page_title="Rahasampo Radar V27 PRO",
    page_icon="💰",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown("""
<style>
.block-container {padding-top:0.25rem;padding-left:0.8rem;padding-right:0.8rem;}
h1 {font-size:1.45rem!important;}
[data-testid="stMetricValue"] {font-size:1.15rem!important;}
.signal{
    border-radius:18px;
    padding:18px;
    font-size:34px;
    font-weight:900;
    text-align:center;
    margin:8px 0 12px 0;
    letter-spacing:0.5px;
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
    padding:14px;
    color:white;
    margin-bottom:10px;
}
.good{color:#22c55e;font-weight:800;}
.bad{color:#ef4444;font-weight:800;}
.neutral{color:#facc15;font-weight:800;}
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
        "memory": [],
        "last_error": "",
        "last_level": "ODOTA",
        "last_score": 0,
        "cross_exchange_check": None,
    }
    for k, v in defaults.items():
        if k not in st.session_state:
            st.session_state[k] = v


init_state()


# ============================================================
# SIDEBAR
# ============================================================

st.sidebar.title("💰 Rahasampo Radar V27 PRO")

selected_name = st.sidebar.selectbox("Kohde", list(SYMBOLS.keys()), index=0)
symbol = SYMBOLS[selected_name]

tf = st.sidebar.radio("Aikaväli", TIMEFRAMES, index=0)
refresh = st.sidebar.radio("Live-päivitys", [2, 3, 5, 10], index=0)
candles = st.sidebar.slider("Kynttilöitä", 80, 300, 170, 10)

st.sidebar.subheader("🛡️ Simuloitu riskinhallinta")
paper_equity = st.sidebar.number_input("Testipääoma (USDT, ei oikea saldo)", min_value=50.0, max_value=1_000_000_000.0, value=1000.0, step=100.0)
risk_percent = st.sidebar.number_input("Riskibudjetti / treidi (%)", min_value=0.1, max_value=2.0, value=0.5, step=0.1)
fee_percent = st.sidebar.number_input("Taker-maksu / puoli (%)", min_value=0.0, max_value=5.0, value=0.1, step=0.025, format="%.3f")
slippage_bps = st.sidebar.number_input("Slippage / täyttö (bps)", min_value=0.0, max_value=999.0, value=5.0, step=1.0)

st.sidebar.caption("Vain paperilaskelma. Ei toimeksiantoja; short-suunnan laskelma ei tarkoita, että spot-tili voi myydä lainattua omaisuutta.")
st.sidebar.divider()

show_fast = st.sidebar.checkbox("EMA9 / EMA21", True)
show_slow = st.sidebar.checkbox("EMA50 / EMA100", True)
show_vwap = st.sidebar.checkbox("VWAP (UTC-session, vain täydellä datalla)", False)
show_levels = st.sidebar.checkbox("Support / Resistance", True)
show_patterns = st.sidebar.checkbox("Pattern-merkinnät", True)
live_on = st.sidebar.toggle("Live päällä", True)

st.sidebar.divider()

if st.sidebar.button("🔄 Resetoi data"):
    st.session_state.df = None
    st.session_state.memory = []
    st.session_state.last_error = ""
    st.rerun()

new_key = f"{symbol}_{tf}_{candles}"
if st.session_state.key != new_key:
    st.session_state.key = new_key
    st.session_state.df = None
    st.session_state.last_error = ""


# ============================================================
# DATA
# ============================================================

LIVE_DATA_SOURCE = "Binance live OHLC + Bybit spot price cross-check"


@st.cache_data(ttl=5, show_spinner=False)
def cached_spot_price_check(symbol_code):
    """Cache public cross-exchange tickers briefly to avoid needless API load."""
    result = get_spot_price_check(symbol_code)
    return {
        "ok": result.ok,
        "primary_price": result.primary_price,
        "reference_price": result.reference_price,
        "deviation_pct": result.deviation_pct,
        "checked_at_utc": result.checked_at_utc,
        "message": result.message,
    }


@st.cache_data(ttl=5, show_spinner=False)
def cached_market_overview():
    """A cached informational watchlist; never feeds the selected signal calculation."""
    return fetch_binance_24h_tickers(
        list(SYMBOLS.values()),
        total_timeout_seconds=3.0,
        request_timeout_seconds=0.75,
    )


@st.cache_data(ttl=2, show_spinner=False)
def get_klines(symbol_code, interval_code, limit_count):
    return fetch_binance_klines(
        symbol_code,
        interval_code,
        int(limit_count),
        timezone_name=APP_TZ,
        total_timeout_seconds=8.0,
        request_timeout_seconds=2.0,
    )


def load_data():
    """Fetch and validate live candles; cached data never powers live signals."""
    st.session_state.cross_exchange_check = None
    try:
        if st.session_state.df is None:
            candidate = get_klines(symbol, tf, max(candles + 230, 420))
        else:
            latest = get_klines(symbol, tf, 10)
            candidate = pd.concat([st.session_state.df, latest])
            candidate = candidate[~candidate.index.duplicated(keep="last")]
            candidate = candidate.sort_index().tail(max(candles + 230, 420))

        valid, errors = validate_ohlcv(candidate, timeframe=tf, min_rows=120)
        if not valid:
            raise RuntimeError("; ".join(errors))

        cross_check = cached_spot_price_check(symbol)
        st.session_state.cross_exchange_check = cross_check
        if not cross_check["ok"]:
            raise RuntimeError(cross_check["message"])

        st.session_state.df = candidate
        st.session_state.last_error = ""
        return candidate.copy(), LIVE_DATA_SOURCE

    except Exception as exc:
        st.session_state.last_error = str(exc)
        if st.session_state.df is not None:
            return st.session_state.df.copy(), "DATA FAIL — cached data only; signals disabled"
        return pd.DataFrame(columns=["Open", "High", "Low", "Close", "Volume"]), "DATA FAIL — no valid live data"


# ============================================================
# INDICATORS
# ============================================================

# ============================================================
# LIVE HIGHER-TIMEFRAME DATA
# ============================================================

@st.cache_data(ttl=20, show_spinner=False)
def higher_tf_bias(symbol_code):
    result = {}

    for htf in ["5m", "15m", "1h", "4h"]:
        try:
            raw = get_klines(symbol_code, htf, 180)
            valid, errors = validate_ohlcv(raw, timeframe=htf, min_rows=110)
            if not valid:
                raise RuntimeError("; ".join(errors))

            closed = select_closed_candles(raw, htf)
            if len(closed) < 110:
                raise RuntimeError("Not enough verified closed higher-timeframe candles.")

            d = add_indicators(closed)
            last = d.iloc[-1]

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

    # Require three valid, aligned timeframes. Missing feeds count as unknown.
    valid_count = sum(v in ("NOUSU", "LASKU", "EPÄSELVÄ") for v in result.values())
    if valid_count < 3:
        return "EPÄSELVÄ", result
    if bull >= 3:
        return "VAHVA NOUSU", result
    if bear >= 3:
        return "VAHVA LASKU", result
    if bull >= 2 and bear == 0:
        return "NOUSU", result
    if bear >= 2 and bull == 0:
        return "LASKU", result

    return "EPÄSELVÄ", result


# ============================================================
# PATTERN ENGINE
# ============================================================

# ============================================================
# UI
# ============================================================


def signal_box(ai):
    level = ai["level"]
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
        f'<div class="signal {cls}">{level}<br>Tekninen score {ai["score"]:+d}/100</div>',
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
        whiskerwidth=0.7,
    ))

    if show_fast:
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA9, name="EMA9", mode="lines", line=dict(color="#38bdf8", width=1.5)))
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA21, name="EMA21", mode="lines", line=dict(color="#fb7185", width=1.5)))

    if show_slow:
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA50, name="EMA50", mode="lines", line=dict(color="#facc15", width=2.3)))
        fig.add_trace(go.Scatter(x=d.index, y=d.EMA100, name="EMA100", mode="lines", line=dict(color="#c084fc", width=2.3)))

    if show_vwap:
        fig.add_trace(go.Scatter(x=d.index, y=d.VWAP, name="VWAP (UTC-session)", mode="lines", line=dict(color="#22d3ee", width=2)))

    if show_levels:
        fig.add_hline(y=ai["support"], line_dash="dot", line_color="#22c55e")
        fig.add_hline(y=ai["resistance"], line_dash="dot", line_color="#ef4444")
        fig.add_hline(y=ai["mid"], line_dash="dot", line_color="#64748b")

    fig.add_hline(y=ai["price"], line_dash="dash", line_color="#facc15")

    if ai["stop"] is not None and ai["target"] is not None:
        fig.add_hline(y=ai["stop"], line_dash="dash", line_color="#ef4444")
        fig.add_hline(y=ai["target"], line_dash="dash", line_color="#22c55e")

    if show_patterns and ai["triangle_lines"]:
        x0 = d.index[0]
        x1 = d.index[-1]
        fig.add_hline(y=ai["triangle_lines"]["resistance_line"], line_dash="dash", line_color="#ef4444")
        fig.add_hline(y=ai["triangle_lines"]["support_line"], line_dash="dash", line_color="#22c55e")

    fig.update_layout(
        title=f"{selected_name} — Rahasampo Radar V27 PRO",
        height=780,
        template="plotly_dark",
        paper_bgcolor="#070d1c",
        plot_bgcolor="#070d1c",
        margin=dict(l=8, r=8, t=48, b=8),
        xaxis_rangeslider_visible=False,
        legend=dict(orientation="h", y=1.04, x=0),
        uirevision=f"v26_{symbol}_{tf}",
    )

    fig.update_xaxes(rangeslider_visible=False)

    st.plotly_chart(
        fig,
        use_container_width=True,
        config={"scrollZoom": True, "responsive": True},
    )


def remember(ai):
    if ai["level"] in ["ODOTA", "EI TREIDIÄ"]:
        return

    item = {
        "Aika": now_local(),
        "Kohde": selected_name,
        "Signaali": ai["level"],
        "Hinta": round(ai["price"], 4),
        "Score": ai["score"],
        "Signaalivahvuus": ai["score"],
        "Pattern": ai["triangle"],
        "Structure": ai["structure"],
    }

    if st.session_state.memory and st.session_state.memory[-1]["Signaali"] == item["Signaali"]:
        return

    st.session_state.memory.append(item)
    st.session_state.memory = st.session_state.memory[-60:]


def run_app():
    st.title("💰 Rahasampo Radar V27 PRO — Research Preview")
    raw, source = load_data()

    with st.expander("🌐 Markkinakatsaus — 24 tunnin muutos", expanded=True):
        try:
            watch = cached_market_overview().copy()
            watch = watch.rename(columns={
                "symbol": "Kohde",
                "last_price": "Viimeisin hinta (USDT)",
                "change_24h_pct": "Muutos 24 h (%)",
                "quote_volume_24h": "Vaihto 24 h (USDT)",
                "retrieved_at_utc": "Haettu (UTC)",
            })
            watch["Viimeisin hinta (USDT)"] = watch["Viimeisin hinta (USDT)"].map(lambda x: f"{x:,.8f}".rstrip("0").rstrip("."))
            watch["Muutos 24 h (%)"] = watch["Muutos 24 h (%)"].map(lambda x: f"{x:+.2f}%")
            watch["Vaihto 24 h (USDT)"] = watch["Vaihto 24 h (USDT)"].map(lambda x: f"{x:,.0f}")
            watch["Haettu (UTC)"] = pd.to_datetime(watch["Haettu (UTC)"], utc=True).dt.strftime("%H:%M:%S")
            st.caption("Binancen julkinen spot-ticker. 24 h -muutos ja vaihto ovat tilannekuvaa, eivät kaupankäyntisignaali tai toteutuskelpoisuuden takuu.")
            st.dataframe(watch, use_container_width=True, hide_index=True)
        except Exception as watch_error:
            st.info(f"Markkinakatsaus ei ole juuri nyt saatavilla ({type(watch_error).__name__}); valitun kohteen datan tarkistus on tästä erillinen.")


    if source != LIVE_DATA_SOURCE:
        st.error(source)
        st.warning("NO TRADE — kelvollista live-dataa ei ole vahvistettu. Välimuistia ei käytetä signaalin muodostamiseen.")
        if st.session_state.last_error:
            st.caption(f"Viimeisin datavirhe: {st.session_state.last_error}")
        cross_check = st.session_state.cross_exchange_check
        if cross_check:
            st.caption(f"Ristiintarkistus: {cross_check.get('message', 'ei tietoa')}")
        return

    valid, data_errors = validate_ohlcv(raw, timeframe=tf, min_rows=120)
    if not valid:
        st.error("DATA FAIL — signaalin muodostaminen estetty.")
        for error in data_errors:
            st.write(f"• {error}")
        return

    closed_raw = select_closed_candles(raw, tf)
    if len(closed_raw) < 120:
        st.error("NO TRADE — suljettuja kynttilöitä ei ole tarpeeksi luotettavaan analyysiin.")
        return

    # Chart may show the forming candle; signal calculations use closed bars only.
    df = add_indicators(raw)
    signal_df = add_indicators(closed_raw)
    ai = ai_engine(signal_df, higher_tf_override=higher_tf_bias(symbol))
    ai, risk_plan = gate_decision_by_net_costs(
        ai,
        equity_quote=paper_equity,
        risk_fraction=risk_percent / 100.0,
        fee_rate=fee_percent / 100.0,
        slippage_bps=slippage_bps,
        min_notional_quote=10.0,
    )
    ai, guardrail_reason = apply_signal_guardrails(
        ai,
        symbol=symbol,
        timeframe=tf,
        candle_time=signal_df.index[-1],
        cooldown_bars=3,
        daily_signal_limit=8,
    )
    if ai.get("level") not in {"OSTA", "VAHVA OSTA", "MYY", "VAHVA MYY"} and risk_plan is not None and risk_plan.eligible:
        # Guardrails can block otherwise eligible candidates; never display them as an active plan.
        risk_plan = None
    journal_write_ok = True
    try:
        record_decision(
            symbol=symbol,
            timeframe=tf,
            candle_time=signal_df.index[-1],
            decision=ai,
            data_source=source,
        )
    except Exception as journal_error:
        journal_write_ok = False
        risk_plan = None
        original_level = ai.get("level", "ODOTA")
        ai["level"] = "EI TREIDIÄ"
        ai["score"] = 0
        ai["direction"] = "ODOTA"
        ai["stop"] = None
        ai["target"] = None
        ai["rr"] = None
        ai["notes"] = (
            list(ai.get("notes", []))
            + [f"Päiväkirjan kirjoitus epäonnistui ({type(journal_error).__name__}); alkuperäinen luokitus {original_level} estettiin."]
        )[:28]
        st.warning(
            "Signaalipäiväkirjan tallennus epäonnistui: "
            f"{type(journal_error).__name__}. Toiminnallinen signaali estettiin."
        )

    if journal_write_ok:
        remember(ai)

    signal_box(ai)

    cross_check = st.session_state.cross_exchange_check or {}
    spot_price = cross_check.get("primary_price")
    spot_price_label = f"{float(spot_price):,.4f}" if spot_price is not None else "—"
    spot_delta = None
    if spot_price is not None and ai.get("price"):
        spot_delta = (float(spot_price) / float(ai["price"]) - 1.0) * 100.0
    spot_delta_label = f"{spot_delta:+.3f}% vs. sulku" if spot_delta is not None else None

    c1, c2, c3, c4, c5 = st.columns(5)
    c1.metric("Binance spot nyt", spot_price_label, spot_delta_label)
    c2.metric("Signaalin sulku", f"{ai['price']:,.4f}")
    c3.metric("Tekninen score", f"{ai['score']} / 100")
    c4.metric("Trend", ai["bias"])
    c5.metric("Päivitetty", now_local())

    cross_check = st.session_state.cross_exchange_check or {}
    deviation = cross_check.get("deviation_pct")
    cross_status = f"Binance/Bybit ero {deviation:.3f}%" if deviation is not None else "Binance/Bybit ristiintarkistus OK"
    st.caption(f"{source} | {cross_status} | TF: {tf} | Päivitys {refresh}s | signaali ja stop/target-laskelma perustuvat viimeiseen suljettuun kynttilään, eivät toimeksiannon toteutushintaan | ajat Suomen ajassa")

    if st.session_state.last_error:
        st.warning(f"Datavaroitus: {st.session_state.last_error}")

    draw_chart(df, ai)

    a, b, c, d = st.columns(4)

    with a:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("🎯 Entry / Stop / Target")
        st.write(f"Suljetun kynttilän viitehinta: **{ai['price']:,.4f}**")
        st.write(f"Support: **{ai['support']:,.4f}**")
        st.write(f"Resistance: **{ai['resistance']:,.4f}**")
        if ai["stop"] is not None:
            st.write(f"Stop: **{ai['stop']:,.4f}**")
            st.write(f"Target: **{ai['target']:,.4f}**")
            st.write(f"RR: **1:{ai['rr']:.2f}**")
        else:
            st.write("Ei vielä selkeää entryä.")
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
        st.subheader("📐 Kuviot")
        st.write(f"Kolmio: **{ai['triangle']}**")
        st.write(f"Rakenne: **{ai['structure']}**")
        st.write(f"Candle power: **{ai['power']}**")
        st.markdown("</div>", unsafe_allow_html=True)

    with d:
        st.markdown('<div class="card">', unsafe_allow_html=True)
        st.subheader("🧪 V27 tutkimustyökalut")
        st.write("Käsin merkittävät win/loss-arviot on poistettu. Triple-barrier-luokitin ja satunnaisbaseline ovat testattavia tutkimusmoduuleja.")
        st.write("Historiallinen signaaliseuranta ja mallin koulutus kytketään käyttöliittymään vasta, kun niiden tulokset on erikseen testattu.")
        st.markdown("</div>", unsafe_allow_html=True)

    with st.expander("🧠 Miksi AI sanoo näin?"):
        for n in ai["notes"]:
            st.write("• " + n)

    with st.expander("🧠 AI-muisti / signaalit"):
        if st.session_state.memory:
            st.dataframe(pd.DataFrame(st.session_state.memory), use_container_width=True, hide_index=True)
        else:
            st.info("Ei vielä signaaleja.")

    with st.expander("🛡️ Riskilaskelma ja kulut", expanded=risk_plan is not None):
        st.caption("Arvio perustuu viimeisen suljetun kynttilän hintaan. Se ei mallinna toimeksiantokirjaa, spreadiä, täyttöjä, stopin ohitushyppyjä, pörssin minimitikkeitä tai viiveitä.")
        if risk_plan is None:
            st.info("Ei aktiivista OSTA/MYY-kandidaattia, jolle riskimäärä voitaisiin laskea. Watch/wait/EI TREIDIÄ -tilat eivät ole toimeksiantosuosituksia.")
        elif not risk_plan.eligible:
            st.error("EI TREIDIÄ — kulut tai riskirajat estivät signaalin.")
            st.write(risk_plan.reason)
            st.write(f"Arvioitu kierroksen kitka tavoitehintaan asti: {risk_plan.round_trip_friction_pct:.3f}%")
        elif ai.get("level") in {"OSTA", "VAHVA OSTA", "MYY", "VAHVA MYY"}:
            r1, r2, r3, r4 = st.columns(4)
            r1.metric("Simuloitu määrä", f"{risk_plan.position_quantity:.8f}".rstrip("0").rstrip("."))
            r2.metric("Positio (USDT)", f"{risk_plan.position_notional_quote:,.2f}")
            r3.metric("Arvioitu tappio stopissa", f"{risk_plan.estimated_max_loss_quote:,.2f} USDT")
            r4.metric("Arvioitu nettovoitto targetissa", f"{risk_plan.estimated_net_target_profit_quote:,.2f} USDT")
            st.write(f"Nettopohjainen R/R: **{risk_plan.net_reward_risk_ratio:.2f}** | Break-even-osumatarkkuus tällä yksinkertaistetulla mallilla: **{risk_plan.break_even_win_rate_pct:.1f}%**")
            st.warning("Tämä on USDT-määräinen paperilaskelma, ei order quantity -validointi. MYY on vain laskennallinen short-suunta; spot-short edellyttää erillisiä tuotteita/luottoa ja kulujen mallinnusta.")

    with st.expander("📘 Pysyvä signaalipäiväkirja"):
        try:
            counts = journal_counts()
            if counts:
                st.dataframe(
                    pd.DataFrame(
                        [{"Päätös": decision_type, "Määrä": count}
                         for decision_type, count in sorted(counts.items())]
                    ),
                    use_container_width=True,
                    hide_index=True,
                )
            else:
                st.info("Päiväkirjassa ei ole vielä päätöksiä.")
            st.caption("Tallennetaan yksi päätös symboli/aikaväli/suljettu kynttilä -yhdistelmää kohti. Paikallinen SQLite-tiedosto ei välttämättä säily pilvipalvelun uudelleenkäynnistyksissä.")
        except Exception as journal_error:
            st.warning(f"Päiväkirjaa ei voi lukea: {type(journal_error).__name__}.")

    with st.expander("🧪 Tutkimusmoduulien tila"):
        st.write("Triple-barrier: automaattiset TP/SL/aikaraja-merkinnät; ratkaisematon aikahorisontti jää merkitsemättä.")
        st.write("Satunnaisbaseline: kiinteä seed, ATR-pohjaiset stop- ja tavoitesäännöt sekä kulumalli.")
        st.write("Tutkimusmoduulit eivät vielä todista strategian kannattavuutta. Vertailu edellyttää tallennettua historiallista signaalisarjaa ja koskematonta testijaksoa.")

    st.warning("Opetustyökalu. Ei tee oikeita kauppoja eikä ole sijoitusneuvo.")


run_app()

if live_on:
    time.sleep(refresh)
    st.rerun()
