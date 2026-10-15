"""Pure Rahasampo strategy calculations shared by live UI and historical replay.

No network requests, Streamlit calls, or order execution are performed here.
"""
from __future__ import annotations

import numpy as np
import pandas as pd

from .data_quality import has_sufficient_timeframe_data
from .decision import classify_score


def rsi(close, period=14):
    """Wilder-style RSI with explicit all-gain/all-loss/flat edge cases."""
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    result = 100 - (100 / (1 + rs))
    result = result.mask((avg_loss == 0) & (avg_gain > 0), 100.0)
    result = result.mask((avg_gain == 0) & (avg_loss > 0), 0.0)
    result = result.mask((avg_gain == 0) & (avg_loss == 0), 50.0)
    return result.clip(0, 100)


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

    df["ATR"] = tr.rolling(14, min_periods=14).mean()
    df["VOL_MA"] = df["Volume"].rolling(20, min_periods=20).mean()

    # UTC-session VWAP is valid only when the loaded data contains that session's first bar.
    # Missing session starts stay NaN rather than displaying a misleading partial-session value.
    typical = (df["High"] + df["Low"] + df["Close"]) / 3
    index_utc = df.index.tz_localize("UTC") if df.index.tz is None else df.index.tz_convert("UTC")
    session_key = pd.Series(index_utc.normalize(), index=df.index)
    cumulative_pv = (typical * df["Volume"]).groupby(session_key).cumsum()
    cumulative_volume = df["Volume"].groupby(session_key).cumsum().replace(0, np.nan)
    df["VWAP"] = cumulative_pv / cumulative_volume
    for session_start in session_key.unique():
        session_mask = session_key == session_start
        if index_utc[session_mask.to_numpy()].min() != session_start:
            df.loc[session_mask, "VWAP"] = np.nan
    df["VWAP"] = df["VWAP"].groupby(session_key).ffill()

    return df


def support_resistance(df):
    d = df.tail(120)
    return (
        float(d["Low"].quantile(0.08)),
        float(d["High"].quantile(0.92)),
        float(d["Close"].median()),
    )


def range_filter(df):
    d = df.tail(50)
    price = float(df.Close.iloc[-1])
    range_pct = (d.High.max() - d.Low.min()) / price
    ema_gap = abs(df.EMA50.iloc[-1] - df.EMA100.iloc[-1]) / price
    return range_pct < 0.0026 and ema_gap < 0.0013


def market_structure(df):
    d = df.tail(35)

    high_now = d.High.tail(8).max()
    high_prev = d.High.iloc[:-8].tail(12).max()
    low_now = d.Low.tail(8).min()
    low_prev = d.Low.iloc[:-8].tail(12).min()

    if high_now > high_prev and low_now > low_prev:
        return "HH/HL nousurakenne", 16

    if high_now < high_prev and low_now < low_prev:
        return "LH/LL laskurakenne", -16

    if high_now > high_prev and low_now < low_prev:
        return "Laaja volatiliteetti / epäselvä", 0

    return "RANGE / sivuttaisrakenne", 0


def candle_power(df):
    c = df.iloc[-1]
    body = abs(c.Close - c.Open)
    rng = max(c.High - c.Low, 1e-9)
    ratio = body / rng

    if c.Close > c.Open:
        if ratio > 0.78:
            return "BUYERS 1", 16, "Ostajat hallitsevat kynttilää täysin"
        if ratio > 0.55:
            return "BUYERS 2", 11, "Ostajat vahvoja"
        if ratio > 0.32:
            return "BUYERS 3", 6, "Ostajat hieman vahvempia"
        return "BUYERS 4", 2, "Vihreä, mutta epävarma"

    if c.Close < c.Open:
        if ratio > 0.78:
            return "SELLERS 1", -16, "Myyjät hallitsevat kynttilää täysin"
        if ratio > 0.55:
            return "SELLERS 2", -11, "Myyjät vahvoja"
        if ratio > 0.32:
            return "SELLERS 3", -6, "Myyjät hieman vahvempia"
        return "SELLERS 4", -2, "Punainen, mutta epävarma"

    return "NEUTRAL", 0, "Doji / tasapaino"


def candle_pattern_score(df):
    if len(df) < 8:
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

    short_trend_up = df.Close.tail(8).mean() > df.Close.tail(20).mean()
    short_trend_down = df.Close.tail(8).mean() < df.Close.tail(20).mean()

    if body / rng < 0.12:
        notes.append("Doji / markkina epäröi")

    if green and body / rng > 0.70:
        score += 18
        notes.append("Bullish Marubozu / vahva vihreä momentum")

    if red and body / rng > 0.70:
        score -= 18
        notes.append("Bearish Marubozu / vahva punainen momentum")

    if green and lower > body * 2 and short_trend_down:
        score += 20
        notes.append("Hammer laskun jälkeen → bullish reversal")

    if red and upper > body * 2 and short_trend_up:
        score -= 20
        notes.append("Shooting Star nousun jälkeen → bearish reversal")

    if p_red and green and c.Close > p.Open and c.Open <= p.Close:
        score += 24
        notes.append("Bullish Engulfing")

    if p_green and red and c.Close < p.Open and c.Open >= p.Close:
        score -= 24
        notes.append("Bearish Engulfing")

    if p2.Close < p2.Open and abs(p.Close - p.Open) < abs(p2.Close - p2.Open) * 0.55 and green:
        score += 18
        notes.append("Morning Star -tyyppinen nousukäännös")

    if p2.Close > p2.Open and abs(p.Close - p.Open) < abs(p2.Close - p2.Open) * 0.55 and red:
        score -= 18
        notes.append("Evening Star -tyyppinen laskukäännös")

    last3 = df.tail(3)

    if all(last3["Close"] > last3["Open"]) and last3["Close"].is_monotonic_increasing:
        score += 18
        notes.append("Three White Soldiers / ostajat painavat")

    if all(last3["Close"] < last3["Open"]) and last3["Close"].is_monotonic_decreasing:
        score -= 18
        notes.append("Three Black Crows / myyjät painavat")

    return score, notes


def detect_triangle(df):
    if len(df) < 40:
        return "Ei tarpeeksi dataa", 0, None

    d = df.tail(35).copy()
    x = np.arange(len(d))

    highs = d["High"].values
    lows = d["Low"].values

    high_slope, high_intercept = np.polyfit(x, highs, 1)
    low_slope, low_intercept = np.polyfit(x, lows, 1)

    price = float(d.Close.iloc[-1])
    atr = max(float(d.ATR.iloc[-1]), price * 0.001)

    flat_limit = atr * 0.018
    slope_strength = atr * 0.025

    resistance_line = high_slope * x[-1] + high_intercept
    support_line = low_slope * x[-1] + low_intercept

    breakout_up = d.Close.iloc[-1] > resistance_line + atr * 0.15
    breakout_down = d.Close.iloc[-1] < support_line - atr * 0.15

    triangle_type = "Ei kolmiota"
    score = 0

    if high_slope < -slope_strength and low_slope > slope_strength:
        triangle_type = "Symmetrinen kolmio"
        if breakout_up:
            score = 24
            triangle_type += " + breakout ylös"
        elif breakout_down:
            score = -24
            triangle_type += " + breakdown alas"
        else:
            score = 4

    elif abs(high_slope) < flat_limit and low_slope > slope_strength:
        triangle_type = "Nouseva kolmio"
        if breakout_up:
            score = 30
            triangle_type += " + breakout ylös"
        else:
            score = 14

    elif high_slope < -slope_strength and abs(low_slope) < flat_limit:
        triangle_type = "Laskeva kolmio"
        if breakout_down:
            score = -30
            triangle_type += " + breakdown alas"
        else:
            score = -14

    lines = {
        "resistance_line": resistance_line,
        "support_line": support_line,
        "high_slope": high_slope,
        "low_slope": low_slope,
    }

    return triangle_type, score, lines


def smart_money_score(df):
    if len(df) < 40:
        return 0, []

    score = 0
    notes = []

    c = df.iloc[-1]
    p = df.iloc[-2]
    prior = df.iloc[-30:-1]

    recent_high = prior.High.max()
    recent_low = prior.Low.min()

    if c.Low < recent_low and c.Close > p.Close:
        score += 18
        notes.append("Liquidity sweep alhaalla → ostajat puolustivat")

    if c.High > recent_high and c.Close < p.Close:
        score -= 18
        notes.append("Liquidity sweep ylhäällä → myyjät puolustivat")

    if p.Close < recent_high and c.Close > recent_high:
        score += 16
        notes.append("Breakout yli likviditeetin")

    if p.Close > recent_low and c.Close < recent_low:
        score -= 16
        notes.append("Breakdown alle likviditeetin")

    return score, notes


def live_reaction(df):
    if len(df) < 30:
        return 0, "EI", []

    c = df.iloc[-1]
    prev = df.iloc[:-1]

    price = float(c.Close)
    body = abs(c.Close - c.Open)
    atr = max(float(df.ATR.iloc[-2]), price * 0.001)
    vol_ma = max(float(df.VOL_MA.iloc[-2]), 1e-9)

    green = c.Close > c.Open
    red = c.Close < c.Open

    score = 0
    notes = []

    if green:
        if body > atr * 0.22:
            score += 24
            notes.append("Live-vihreä kynttilä vahvistuu")
        if body > atr * 0.48:
            score += 18
            notes.append("Live-vihreä kynttilä erittäin vahva")
        if c.Close > c.EMA9:
            score += 10
            notes.append("Hinta EMA9 yläpuolella")
        if c.Close > c.EMA21:
            score += 10
            notes.append("Hinta EMA21 yläpuolella")
        if c.High >= prev.High.tail(8).max():
            score += 14
            notes.append("Uusi lyhyen aikavälin huippu / breakout")
        if c.Volume > vol_ma:
            score += 8
            notes.append("Volyymi tukee nousua")

    if red:
        if body > atr * 0.22:
            score -= 24
            notes.append("Live-punainen kynttilä vahvistuu")
        if body > atr * 0.48:
            score -= 18
            notes.append("Live-punainen kynttilä erittäin vahva")
        if c.Close < c.EMA9:
            score -= 10
            notes.append("Hinta EMA9 alapuolella")
        if c.Close < c.EMA21:
            score -= 10
            notes.append("Hinta EMA21 alapuolella")
        if c.Low <= prev.Low.tail(8).min():
            score -= 14
            notes.append("Uusi lyhyen aikavälin pohja / breakdown")
        if c.Volume > vol_ma:
            score -= 8
            notes.append("Volyymi tukee laskua")

    if score >= 30:
        return score, "NOPEA OSTA", notes
    if score <= -30:
        return score, "NOPEA MYY", notes

    return score, "EI", notes


# ============================================================
# AI ENGINE
# ============================================================

def ai_engine(df, *, higher_tf_override: tuple[str, dict[str, str]]):
    live = df.iloc[-1]
    closed = df.iloc[:-1].copy()

    price = float(live.Close)
    score = 0
    notes = []

    bias, details = higher_tf_override
    htf_data_ok = has_sufficient_timeframe_data(details, minimum_valid=3)
    support, resistance, mid = support_resistance(closed)

    if bias == "VAHVA NOUSU":
        score += 18
        notes.append("Isompi aikaväli: vahva nousu")
    elif bias == "NOUSU":
        score += 12
        notes.append("Isompi aikaväli: nousu")
    elif bias == "VAHVA LASKU":
        score -= 18
        notes.append("Isompi aikaväli: vahva lasku")
    elif bias == "LASKU":
        score -= 12
        notes.append("Isompi aikaväli: lasku")
    else:
        notes.append("Isompi aikaväli epäselvä")

    structure, structure_score = market_structure(closed)
    score += structure_score
    notes.append(f"Market structure: {structure}")

    if price > live.EMA9 > live.EMA21:
        score += 14
        notes.append("Nopea EMA9/21 bullish")

    if price < live.EMA9 < live.EMA21:
        score -= 14
        notes.append("Nopea EMA9/21 bearish")

    if price > live.EMA50:
        score += 7
        notes.append("Hinta EMA50 yläpuolella")

    if price < live.EMA50:
        score -= 7
        notes.append("Hinta EMA50 alapuolella")

    if price > live.EMA100:
        score += 7
        notes.append("Hinta EMA100 yläpuolella")

    if price < live.EMA100:
        score -= 7
        notes.append("Hinta EMA100 alapuolella")

    if pd.notna(live.VWAP):
        if price > live.VWAP:
            score += 4
            notes.append("Hinta täyden UTC-session VWAP:n yläpuolella")
        else:
            score -= 4
            notes.append("Hinta täyden UTC-session VWAP:n alapuolella")
    else:
        notes.append("VWAP ohitettiin: täyttä UTC-session dataa ei ole ladattu")

    if live.RSI < 30:
        notes.append(f"RSI {live.RSI:.1f}: ylimyyty — ei yksinään ostosignaali")
    elif live.RSI > 70:
        notes.append(f"RSI {live.RSI:.1f}: yliostettu — ei yksinään myyntisignaali")
    else:
        notes.append(f"RSI {live.RSI:.1f}: neutraali")

    if live.MACD > live.MACD_SIGNAL and live.MACD_HIST > 0:
        score += 9
        notes.append("MACD bullish")

    if live.MACD < live.MACD_SIGNAL and live.MACD_HIST < 0:
        score -= 9
        notes.append("MACD bearish")

    power_name, power_score, power_note = candle_power(df)
    score += power_score
    notes.append(f"Candle power: {power_name} — {power_note}")

    pattern_score, pattern_notes = candle_pattern_score(closed)
    score += pattern_score
    notes.extend(pattern_notes)

    triangle_name, triangle_score, triangle_lines = detect_triangle(closed)
    score += triangle_score
    notes.append(f"Kolmio: {triangle_name}")

    sm_score, sm_notes = smart_money_score(closed)
    score += sm_score
    notes.extend(sm_notes)

    live_score, alert, live_notes = live_reaction(df)
    # A single candle may confirm momentum, but cannot force a buy/sell label.
    bounded_live_score = int(np.clip(live_score, -18, 18))
    score += bounded_live_score
    notes.extend(live_notes)
    if bounded_live_score != live_score:
        notes.append(f"Kynttilämomentin vaikutusta rajattiin: {live_score:+d} → {bounded_live_score:+d}")
    if alert in ("NOPEA OSTA", "NOPEA MYY"):
        notes.append(f"Nopea kynttilähälytys on vain vahvistava havainto: {alert}")

    no_trade = range_filter(closed)
    if no_trade:
        notes.append("Markkinan range-suodatin aktiivinen: trendisignaali estetty.")

    final = int(max(-100, min(100, score)))
    level = classify_score(
        final,
        range_blocked=no_trade,
        higher_timeframe_data_ok=htf_data_ok,
    )
    if not htf_data_ok:
        final = 0
        notes.append("Ylempien aikavälien data puutteellinen: signaali estetty.")

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
    if stop is not None and target is not None:
        rr = abs(target - price) / abs(price - stop)

    return {
        "level": level,
        "score": final,
        "price": price,
        "support": support,
        "resistance": resistance,
        "mid": mid,
        "bias": bias,
        "details": details,
        "notes": notes[:28],
        "stop": stop,
        "target": target,
        "rr": rr,
        "direction": direction,
        "structure": structure,
        "triangle": triangle_name,
        "triangle_lines": triangle_lines,
        "power": power_name,
    }
