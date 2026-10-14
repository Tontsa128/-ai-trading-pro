"""Market-data validation helpers used before signal generation."""
from __future__ import annotations

import numpy as np
import pandas as pd

REQUIRED_OHLCV = ("Open", "High", "Low", "Close", "Volume")
TIMEFRAME_SECONDS = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900,
    "30m": 1800, "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400,
}


def validate_ohlcv(
    frame: pd.DataFrame,
    timeframe: str | None = None,
    *,
    now: pd.Timestamp | None = None,
    max_staleness_intervals: float = 1.5,
    max_gap_intervals: float = 2.5,
    min_rows: int = 1,
) -> tuple[bool, list[str]]:
    """Validate OHLCV integrity. This does not certify that a source is live."""
    errors: list[str] = []
    if not isinstance(frame, pd.DataFrame) or frame.empty:
        return False, ["No OHLCV rows received."]

    missing = [column for column in REQUIRED_OHLCV if column not in frame.columns]
    if missing:
        return False, [f"Missing required columns: {', '.join(missing)}"]
    if len(frame) < min_rows:
        errors.append(f"Not enough rows: {len(frame)} < {min_rows}.")
    if not isinstance(frame.index, pd.DatetimeIndex):
        return False, errors + ["Index must be a DatetimeIndex."]
    if frame.index.tz is None:
        return False, errors + ["Timestamps must include a timezone."]
    if frame.index.has_duplicates:
        errors.append("Duplicate candle timestamps detected.")
    if not frame.index.is_monotonic_increasing:
        errors.append("Candle timestamps are not chronological.")

    values = frame.loc[:, REQUIRED_OHLCV].apply(pd.to_numeric, errors="coerce")
    numeric = values.to_numpy(dtype=float)
    if not np.isfinite(numeric).all():
        errors.append("OHLCV data contains NaN or infinite values.")
    if (values[["Open", "High", "Low", "Close"]] <= 0).any().any():
        errors.append("Price values must be greater than zero.")
    if (values["Volume"] < 0).any():
        errors.append("Volume cannot be negative.")
    if not values.empty:
        if (values["High"] < values[["Open", "Close", "Low"]].max(axis=1)).any():
            errors.append("High is below Open, Close, or Low.")
        if (values["Low"] > values[["Open", "Close", "High"]].min(axis=1)).any():
            errors.append("Low is above Open, Close, or High.")

    if timeframe is not None:
        interval = TIMEFRAME_SECONDS.get(timeframe)
        if interval is None:
            errors.append(f"Unsupported timeframe: {timeframe}.")
        elif not frame.index.has_duplicates and frame.index.is_monotonic_increasing:
            utc_index = frame.index.tz_convert("UTC")
            gaps = utc_index.to_series().diff().dt.total_seconds().dropna()
            if (gaps > interval * max_gap_intervals).any():
                errors.append("Missing candle interval(s) detected.")
            current_time = pd.Timestamp.now(tz="UTC") if now is None else pd.Timestamp(now)
            if current_time.tzinfo is None:
                current_time = current_time.tz_localize("UTC")
            else:
                current_time = current_time.tz_convert("UTC")
            age_seconds = (current_time - utc_index[-1]).total_seconds()
            if age_seconds < -max(2.0, interval * 0.05):
                errors.append("Latest candle timestamp is unexpectedly in the future.")
            elif age_seconds > interval * max_staleness_intervals:
                errors.append(f"Stale market data: latest candle is {age_seconds:.0f}s old.")

    return not errors, errors


def select_closed_candles(
    frame: pd.DataFrame,
    timeframe: str,
    *,
    now: pd.Timestamp | None = None,
) -> pd.DataFrame:
    """Return only bars whose entire timeframe has elapsed."""
    interval = TIMEFRAME_SECONDS.get(timeframe)
    if interval is None:
        raise ValueError(f"Unsupported timeframe: {timeframe}.")
    if not isinstance(frame.index, pd.DatetimeIndex):
        raise TypeError("OHLCV frame must use a DatetimeIndex.")
    if frame.index.tz is None:
        raise ValueError("Candle timestamps must include a timezone.")
    current_time = pd.Timestamp.now(tz="UTC") if now is None else pd.Timestamp(now)
    if current_time.tzinfo is None:
        current_time = current_time.tz_localize("UTC")
    else:
        current_time = current_time.tz_convert("UTC")
    utc_index = frame.index.tz_convert("UTC")
    mask = utc_index + pd.to_timedelta(interval, unit="s") <= current_time
    return frame.loc[mask].copy()
