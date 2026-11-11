"""Causal and validated technical indicators for the legacy Streamlit app.

Warm-up values remain NaN. No indicator may read future rows or silently
replace invalid market observations with zeroes or future-derived values.
"""
import numpy as np
import pandas as pd

OHLCV_COLUMNS = ("Open", "High", "Low", "Close", "Volume")
REQUIRED_HIGHER_TIMEFRAMES = {"5m", "15m", "1h", "4h"}
DIRECTIONAL_BIASES = {"VAHVA NOUSU", "NOUSU", "VAHVA LASKU", "LASKU"}
INTERVALS = {
    "1m": pd.Timedelta(minutes=1),
    "3m": pd.Timedelta(minutes=3),
    "5m": pd.Timedelta(minutes=5),
    "15m": pd.Timedelta(minutes=15),
    "1h": pd.Timedelta(hours=1),
    "4h": pd.Timedelta(hours=4),
    "1d": pd.Timedelta(days=1),
}


def validate_ohlcv(df: pd.DataFrame, interval: str | None = None) -> pd.DataFrame:
    """Validate ordered, unique, finite and internally consistent OHLCV bars.

    If an interval is supplied, missing or duplicated time slots fail closed.
    The function returns a defensive copy and never repairs market data.
    """
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

    result = df.loc[:, list(OHLCV_COLUMNS)].copy()
    for column in OHLCV_COLUMNS:
        result[column] = pd.to_numeric(result[column], errors="raise")

    values = result.to_numpy(dtype=float)
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
    """Allow directional signals only with complete higher-timeframe context."""
    return (
        bias in DIRECTIONAL_BIASES
        and set(details) == REQUIRED_HIGHER_TIMEFRAMES
        and all(value in ("NOUSU", "LASKU", "EPÄSELVÄ") for value in details.values())
    )


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    """Return exponentially smoothed RSI with mathematically correct edge cases."""
    if period < 1:
        raise ValueError("period must be >= 1")
    values = pd.to_numeric(close, errors="raise")
    if not np.isfinite(values.dropna().to_numpy(dtype=float)).all():
        raise ValueError("RSI input contains non-finite values.")

    delta = values.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()

    result = pd.Series(np.nan, index=values.index, dtype=float)
    valid = avg_gain.notna() & avg_loss.notna()
    flat = valid & avg_gain.eq(0) & avg_loss.eq(0)
    gains_only = valid & avg_gain.gt(0) & avg_loss.eq(0)
    losses_only = valid & avg_gain.eq(0) & avg_loss.gt(0)
    regular = valid & avg_gain.gt(0) & avg_loss.gt(0)

    result.loc[flat] = 50.0
    result.loc[gains_only] = 100.0
    result.loc[losses_only] = 0.0
    relative_strength = avg_gain.loc[regular] / avg_loss.loc[regular]
    result.loc[regular] = 100.0 - (100.0 / (1.0 + relative_strength))
    return result.clip(0, 100)


def add_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """Add causal EMA, RSI, MACD, ATR, volume average and cumulative VWAP."""
    result = validate_ohlcv(df)

    result["EMA9"] = result["Close"].ewm(span=9, adjust=False).mean()
    result["EMA21"] = result["Close"].ewm(span=21, adjust=False).mean()
    result["EMA50"] = result["Close"].ewm(span=50, adjust=False).mean()
    result["EMA100"] = result["Close"].ewm(span=100, adjust=False).mean()

    result["RSI"] = rsi(result["Close"])

    ema12 = result["Close"].ewm(span=12, adjust=False).mean()
    ema26 = result["Close"].ewm(span=26, adjust=False).mean()
    result["MACD"] = ema12 - ema26
    result["MACD_SIGNAL"] = result["MACD"].ewm(span=9, adjust=False).mean()
    result["MACD_HIST"] = result["MACD"] - result["MACD_SIGNAL"]

    previous_close = result["Close"].shift(1)
    true_range = pd.concat(
        [
            result["High"] - result["Low"],
            (result["High"] - previous_close).abs(),
            (result["Low"] - previous_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    result["ATR"] = true_range.rolling(14, min_periods=14).mean()
    result["VOL_MA"] = result["Volume"].rolling(20, min_periods=20).mean()

    typical_price = (result["High"] + result["Low"] + result["Close"]) / 3
    cumulative_volume = result["Volume"].cumsum().replace(0, np.nan)
    cumulative_value = (typical_price * result["Volume"]).cumsum()
    result["VWAP"] = (cumulative_value / cumulative_volume).ffill()

    return result
