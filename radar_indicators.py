"""Causal OHLCV indicators aligned with the JavaScript TradingEngine.

EMA uses the first finite observation as its seed. RSI, ATR, DI and ADX use
Wilder smoothing with the same seed indices as trading-engine.js. Volume ratio
uses the previous 20 closed bars. VWAP resets at each UTC session boundary.
"""
import numpy as np
import pandas as pd

OHLCV_COLUMNS = ("Open", "High", "Low", "Close", "Volume")
REQUIRED_HIGHER_TIMEFRAMES = {"4h", "1d"}
DIRECTIONAL_BIASES = {"VAHVA NOUSU", "NOUSU", "VAHVA LASKU", "LASKU"}
PERIOD = 14
VOLUME_PERIOD = 20
INTERVALS = {
    "1m": pd.Timedelta(minutes=1), "3m": pd.Timedelta(minutes=3),
    "5m": pd.Timedelta(minutes=5), "15m": pd.Timedelta(minutes=15),
    "1h": pd.Timedelta(hours=1), "4h": pd.Timedelta(hours=4),
    "1d": pd.Timedelta(days=1),
}


def validate_ohlcv(df: pd.DataFrame, interval: str | None = None) -> pd.DataFrame:
    if not isinstance(df, pd.DataFrame) or df.empty:
        raise ValueError("OHLCV-data is empty or is not a DataFrame.")
    missing = set(OHLCV_COLUMNS).difference(df.columns)
    if missing:
        raise ValueError(f"Missing OHLCV columns: {', '.join(sorted(missing))}")
    if not isinstance(df.index, pd.DatetimeIndex):
        raise ValueError("OHLCV index must be a DatetimeIndex.")
    if df.index.hasnans:
        raise ValueError("OHLCV timestamps contain NaT.")
    if df.index.has_duplicates:
        raise ValueError("Duplicate OHLCV candle timestamps detected.")
    if not df.index.is_monotonic_increasing:
        raise ValueError("OHLCV candles are not ordered by timestamp.")
    result = df.copy()
    for column in OHLCV_COLUMNS:
        result[column] = pd.to_numeric(result[column], errors="raise")
    values = result.loc[:, list(OHLCV_COLUMNS)].to_numpy(dtype=float)
    if not np.isfinite(values).all():
        raise ValueError("OHLCV contains missing or non-finite values.")
    if (result[["Open", "High", "Low", "Close"]] <= 0).any().any():
        raise ValueError("OHLC prices must be greater than zero.")
    if (result["Volume"] < 0).any():
        raise ValueError("Volume cannot be negative.")
    invalid_high = result["High"] < result[["Open", "Close", "Low"]].max(axis=1)
    invalid_low = result["Low"] > result[["Open", "Close", "High"]].min(axis=1)
    if invalid_high.any() or invalid_low.any():
        raise ValueError("OHLC candle high/low is inconsistent with open/close.")
    if interval is not None:
        expected = INTERVALS.get(interval)
        if expected is None:
            raise ValueError(f"Unsupported candle interval: {interval}")
        if len(result) > 1 and not result.index.to_series().diff().iloc[1:].eq(expected).all():
            raise ValueError(f"OHLCV candle sequence contains a gap for interval {interval}.")
    return result


def signal_context_is_valid(bias: str, details: dict[str, str]) -> bool:
    return (
        bias in DIRECTIONAL_BIASES
        and set(details) == REQUIRED_HIGHER_TIMEFRAMES
        and all(value in ("NOUSU", "LASKU", "EPÄSELVÄ") for value in details.values())
    )


def _wilder(values, period: int = PERIOD) -> np.ndarray:
    array = np.asarray(values, dtype=float)
    output = np.full(len(array), np.nan, dtype=float)
    previous = None
    seed = 0.0
    for index, raw in enumerate(array):
        value = raw if np.isfinite(raw) else 0.0
        if index > 0 and index <= period:
            seed += value
        if index == period:
            previous = seed / period
            output[index] = previous
        elif index > period and previous is not None:
            previous = (previous * (period - 1) + value) / period
            output[index] = previous
    return output


def rsi(close: pd.Series, period: int = PERIOD) -> pd.Series:
    if period < 1:
        raise ValueError("period must be >= 1")
    values = pd.to_numeric(close, errors="raise")
    raw = values.to_numpy(dtype=float)
    if not np.isfinite(raw).all():
        raise ValueError("RSI input contains non-finite values.")
    delta = np.diff(raw, prepend=raw[0])
    average_gain = _wilder(np.maximum(delta, 0.0), period)
    average_loss = _wilder(np.maximum(-delta, 0.0), period)
    output = np.full(len(raw), np.nan, dtype=float)
    for index, (gain, loss) in enumerate(zip(average_gain, average_loss)):
        if not np.isfinite(gain) or not np.isfinite(loss):
            continue
        if loss == 0:
            output[index] = 50.0 if gain == 0 else 100.0
        else:
            output[index] = 100.0 - 100.0 / (1.0 + gain / loss)
    return pd.Series(np.clip(output, 0.0, 100.0), index=values.index, dtype=float)


def add_indicators(df: pd.DataFrame) -> pd.DataFrame:
    result = validate_ohlcv(df)
    close = result["Close"]
    result["EMA9"] = close.ewm(span=9, adjust=False).mean()
    result["EMA21"] = close.ewm(span=21, adjust=False).mean()
    result["EMA50"] = close.ewm(span=50, adjust=False).mean()
    result["EMA100"] = close.ewm(span=100, adjust=False).mean()  # Legacy Python signal path until it is ported.
    result["EMA200"] = close.ewm(span=200, adjust=False).mean()

    result["RSI"] = rsi(close)
    ema12 = close.ewm(span=12, adjust=False).mean()
    ema26 = close.ewm(span=26, adjust=False).mean()
    result["MACD"] = ema12 - ema26
    result["MACD_SIGNAL"] = result["MACD"].ewm(span=9, adjust=False).mean()
    result["MACD_HIST"] = result["MACD"] - result["MACD_SIGNAL"]

    previous_close = close.shift(1)
    true_range = pd.concat([
        result["High"] - result["Low"],
        (result["High"] - previous_close).abs(),
        (result["Low"] - previous_close).abs(),
    ], axis=1).max(axis=1)
    atr = _wilder(true_range.to_numpy(dtype=float), PERIOD)
    result["ATR"] = pd.Series(atr, index=result.index)
    result["ATR_PCT"] = result["ATR"] / close * 100.0

    high = result["High"].to_numpy(dtype=float)
    low = result["Low"].to_numpy(dtype=float)
    plus_dm = np.zeros(len(result), dtype=float)
    minus_dm = np.zeros(len(result), dtype=float)
    for index in range(1, len(result)):
        upward = high[index] - high[index - 1]
        downward = low[index - 1] - low[index]
        if upward > downward and upward > 0:
            plus_dm[index] = upward
        if downward > upward and downward > 0:
            minus_dm[index] = downward
    plus_average = _wilder(plus_dm, PERIOD)
    minus_average = _wilder(minus_dm, PERIOD)
    pdi = np.full(len(result), np.nan, dtype=float)
    mdi = np.full(len(result), np.nan, dtype=float)
    for index, (atr_value, plus_value, minus_value) in enumerate(zip(atr, plus_average, minus_average)):
        if np.isfinite(atr_value) and atr_value > 0 and np.isfinite(plus_value):
            pdi[index] = 100.0 * plus_value / atr_value
        if np.isfinite(atr_value) and atr_value > 0 and np.isfinite(minus_value):
            mdi[index] = 100.0 * minus_value / atr_value
    dx = np.full(len(result), np.nan, dtype=float)
    for index, (plus_value, minus_value) in enumerate(zip(pdi, mdi)):
        total = plus_value + minus_value
        if np.isfinite(plus_value) and np.isfinite(minus_value) and total > 0:
            dx[index] = 100.0 * abs(plus_value - minus_value) / total
    adx = np.full(len(result), np.nan, dtype=float)
    dx_seed = 0.0
    previous_adx = None
    for index in range(PERIOD, len(result)):
        dx_value = dx[index] if np.isfinite(dx[index]) else 0.0
        if index < 2 * PERIOD - 1:
            dx_seed += dx_value
        elif index == 2 * PERIOD - 1:
            previous_adx = (dx_seed + dx_value) / PERIOD
            adx[index] = previous_adx
        elif previous_adx is not None:
            previous_adx = (previous_adx * (PERIOD - 1) + dx_value) / PERIOD
            adx[index] = previous_adx
    result["PDI"] = pdi
    result["MDI"] = mdi
    result["ADX"] = adx

    result["VOL_MA"] = result["Volume"].shift(1).rolling(VOLUME_PERIOD, min_periods=VOLUME_PERIOD).mean()
    volume_ratio = np.full(len(result), np.nan, dtype=float)
    volume_average = result["VOL_MA"].to_numpy(dtype=float)
    np.divide(
        result["Volume"].to_numpy(dtype=float), volume_average,
        out=volume_ratio,
        where=np.isfinite(volume_average) & (volume_average > 0),
    )
    result["VOLUME_RATIO"] = volume_ratio

    utc_index = result.index.tz_localize("UTC") if result.index.tz is None else result.index.tz_convert("UTC")
    sessions = pd.Series(utc_index.floor("D"), index=result.index)
    typical_price = (result["High"] + result["Low"] + close) / 3.0
    cumulative_value = (typical_price * result["Volume"]).groupby(sessions).cumsum()
    cumulative_volume = result["Volume"].groupby(sessions).cumsum().replace(0, np.nan)
    result["VWAP"] = cumulative_value / cumulative_volume
    return result


def evaluate_signal_gates(
    bar: dict[str, float],
    higher_timeframes: dict[str, str],
    spread_pct: float,
    history_count: int,
    support: float,
    resistance: float,
) -> tuple[str, list[str]]:
    """Conservative Python equivalent of the shared JavaScript BUY/SELL/WAIT gates."""
    reasons: list[str] = []
    required = ("close", "ema9", "ema21", "ema50", "ema200", "rsi", "macd_hist",
                "atr", "atr_pct", "adx", "pdi", "mdi", "volume_ratio")
    if history_count < 220 or any(not np.isfinite(bar.get(key, np.nan)) for key in required):
        return "WAIT", ["Main timeframe history or indicators are incomplete."]
    if bar["close"] <= 0 or bar["atr"] <= 0:
        return "WAIT", ["Price or ATR is invalid."]
    if not np.isfinite(spread_pct) or spread_pct < 0 or spread_pct > 0.15:
        reasons.append("Bid/ask spread is missing, invalid or above 0.15%.")
    if bar["atr_pct"] > 3:
        reasons.append("ATR volatility exceeds 3%.")
    if abs(bar["close"] - bar["ema21"]) > 1.6 * bar["atr"]:
        reasons.append("Price is overextended from EMA21.")
    if set(higher_timeframes) != {"4h", "1d"} or any(
        value not in ("NOUSU", "LASKU") for value in higher_timeframes.values()
    ):
        reasons.append("Both 4h and 1d trend confirmations are required.")
    long_core = (
        bar["close"] > bar["ema200"] and bar["ema50"] > bar["ema200"]
        and bar["ema9"] > bar["ema21"] and bar["macd_hist"] > 0
        and 50 <= bar["rsi"] <= 68 and bar["adx"] >= 18
        and bar["pdi"] > bar["mdi"] and bar["volume_ratio"] >= 0.5
    )
    short_core = (
        bar["close"] < bar["ema200"] and bar["ema50"] < bar["ema200"]
        and bar["ema9"] < bar["ema21"] and bar["macd_hist"] < 0
        and 32 <= bar["rsi"] <= 50 and bar["adx"] >= 18
        and bar["mdi"] > bar["pdi"] and bar["volume_ratio"] >= 0.5
    )
    # Support/resistance must be based on prior closed candles, excluding the signal candle.
    long_room = np.isfinite(resistance) and (resistance - bar["close"]) / bar["atr"] >= 0.5
    short_room = np.isfinite(support) and (bar["close"] - support) / bar["atr"] >= 0.5
    common_ok = not reasons
    if long_core and higher_timeframes == {"4h": "NOUSU", "1d": "NOUSU"} and common_ok and long_room:
        return "BUY", []
    if short_core and higher_timeframes == {"4h": "LASKU", "1d": "LASKU"} and common_ok and short_room:
        return "SELL", []
    if not long_core and not short_core:
        reasons.append("Main timeframe trend, momentum, ADX, RSI or volume conditions are not aligned.")
    if not long_room and not short_room:
        reasons.append("There is not at least 0.5 ATR of room to the next support/resistance level.")
    if higher_timeframes.get("4h") != higher_timeframes.get("1d"):
        reasons.append("4h and 1d trend directions disagree.")
    return "WAIT", reasons
