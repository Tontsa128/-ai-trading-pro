"""Causal technical indicators used by the legacy Streamlit application.

All rolling indicators use only observations at or before the row being
calculated. Warm-up rows intentionally remain NaN; callers must not backfill
them from future observations.
"""
import numpy as np
import pandas as pd


def rsi(close: pd.Series, period: int = 14) -> pd.Series:
    """Return the legacy exponentially smoothed RSI without future filling."""
    if period < 1:
        raise ValueError("period must be >= 1")
    delta = close.diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()
    rs = avg_gain / avg_loss.replace(0, np.nan)
    return (100 - (100 / (1 + rs))).fillna(50).clip(0, 100)


def add_indicators(df: pd.DataFrame) -> pd.DataFrame:
    """Add EMA, RSI, MACD, ATR, volume average and cumulative VWAP.

    ATR and volume average expose their natural warm-up NaNs. VWAP uses
    forward-fill only: a value can be carried forward from the past, never
    copied backwards from a later candle.
    """
    required = {"Open", "High", "Low", "Close", "Volume"}
    missing = required.difference(df.columns)
    if missing:
        raise ValueError(f"Missing OHLCV columns: {', '.join(sorted(missing))}")

    result = df.copy()
    for column in ("Open", "High", "Low", "Close", "Volume"):
        result[column] = pd.to_numeric(result[column], errors="raise")

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
