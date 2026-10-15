"""Paginated, validated public Binance historical OHLCV downloader."""
from __future__ import annotations

import math
import time
from typing import Any

import numpy as np
import pandas as pd
import requests

from .data_quality import TIMEFRAME_SECONDS, validate_ohlcv
from .market_data import BINANCE_KLINE_URLS

COLUMNS = ("Open", "High", "Low", "Close", "Volume")


def _timestamp_ms(value: Any, *, field: str) -> int:
    timestamp = pd.Timestamp(value)
    if timestamp.tzinfo is None:
        raise ValueError(f"{field} must include a timezone.")
    timestamp = timestamp.tz_convert("UTC")
    return int(timestamp.value // 1_000_000)


def fetch_binance_historical_klines(
    symbol: str,
    interval: str,
    *,
    days: int = 35,
    start_time: Any | None = None,
    end_time: Any | None = None,
    now: pd.Timestamp | None = None,
    page_limit: int = 1000,
    max_bars: int = 200_000,
    total_timeout_seconds: float = 120.0,
    request_timeout_seconds: float = 5.0,
) -> pd.DataFrame:
    """Download a bounded candle history with paging, endpoint failover and validation.

    `start_time` and `end_time` must be timezone-aware if supplied. If neither
    is supplied, the last `days` ending at `now` is requested. Incomplete
    final candles are removed. This module uses public market data only and
    does not send order requests.
    """
    if not isinstance(symbol, str) or not symbol or not symbol.isascii() or not symbol.isalnum() or symbol != symbol.upper():
        raise ValueError("symbol must be a non-empty uppercase alphanumeric exchange symbol.")
    if interval not in TIMEFRAME_SECONDS:
        raise ValueError(f"Unsupported Binance interval: {interval}.")
    if (start_time is None) != (end_time is None):
        raise ValueError("Provide both start_time and end_time, or neither.")
    if start_time is None and (not isinstance(days, int) or isinstance(days, bool) or days < 1 or days > 365):
        raise ValueError("days must be an integer from 1 to 365.")
    if not isinstance(page_limit, int) or isinstance(page_limit, bool) or page_limit < 1 or page_limit > 1000:
        raise ValueError("page_limit must be an integer from 1 to 1000.")
    if not isinstance(max_bars, int) or isinstance(max_bars, bool) or max_bars < 120 or max_bars > 1_000_000:
        raise ValueError("max_bars must be an integer from 120 to 1,000,000.")
    if not math.isfinite(total_timeout_seconds) or total_timeout_seconds <= 0:
        raise ValueError("total_timeout_seconds must be finite and positive.")
    if not math.isfinite(request_timeout_seconds) or request_timeout_seconds <= 0:
        raise ValueError("request_timeout_seconds must be finite and positive.")

    clock = pd.Timestamp.now(tz="UTC") if now is None else pd.Timestamp(now)
    if clock.tzinfo is None:
        raise ValueError("now must be timezone-aware.")
    clock = clock.tz_convert("UTC")
    clock_ms = int(clock.value // 1_000_000)
    interval_ms = TIMEFRAME_SECONDS[interval] * 1000

    if start_time is None:
        end_ms = clock_ms
        start_ms = end_ms - int(days) * 86_400_000
    else:
        start_ms = _timestamp_ms(start_time, field="start_time")
        end_ms = _timestamp_ms(end_time, field="end_time")
        if end_ms > clock_ms + 2_000:
            raise ValueError("end_time cannot be in the future.")
    start_ms = (start_ms // interval_ms) * interval_ms
    if end_ms < start_ms:
        raise ValueError("end_time must not be earlier than start_time.")

    requested_bars = (end_ms - start_ms) // interval_ms + 1
    if requested_bars > max_bars:
        raise ValueError(
            f"Requested range contains up to {requested_bars} candles, exceeding max_bars={max_bars}. "
            "Use a shorter date range or raise the explicit limit."
        )

    deadline = time.monotonic() + total_timeout_seconds
    records: list[list[float]] = []
    timestamps_ms: list[int] = []
    cursor_ms = start_ms

    while cursor_ms <= end_ms and len(records) < max_bars:
        remaining_total = deadline - time.monotonic()
        if remaining_total <= 0:
            raise TimeoutError(
                f"Historical download exceeded {total_timeout_seconds:.1f}s after {len(records)} candles."
            )
        request_count = min(page_limit, max_bars - len(records))
        params = {
            "symbol": symbol,
            "interval": interval,
            "startTime": cursor_ms,
            "endTime": end_ms,
            "limit": request_count,
        }
        payload = None
        errors: list[str] = []
        for url in BINANCE_KLINE_URLS:
            remaining_total = deadline - time.monotonic()
            if remaining_total <= 0:
                break
            try:
                response = requests.get(
                    url,
                    params=params,
                    timeout=min(request_timeout_seconds, remaining_total),
                    headers={"User-Agent": "RahasampoRadar/27"},
                )
                response.raise_for_status()
                candidate = response.json()
                if not isinstance(candidate, list):
                    raise ValueError("Kline response was not a list.")
                payload = candidate
                break
            except Exception as exc:
                errors.append(f"{url}: {type(exc).__name__}: {str(exc)[:120]}")
        if payload is None:
            raise RuntimeError(
                "Binance historical candles unavailable from all configured endpoints. "
                + (" | ".join(errors) if errors else "Total timeout budget exhausted.")
            )
        if not payload:
            break

        page_times: list[int] = []
        page_records: list[list[float]] = []
        for position, row in enumerate(payload):
            if not isinstance(row, (list, tuple)) or len(row) < 6:
                raise ValueError(f"Malformed historical kline at page row {position}.")
            try:
                open_ms = int(row[0])
                values = [float(row[column]) for column in range(1, 6)]
            except (TypeError, ValueError, OverflowError) as exc:
                raise ValueError(f"Malformed historical OHLCV values at page row {position}.") from exc
            if open_ms < cursor_ms or open_ms > end_ms:
                raise ValueError("Historical API returned a candle outside the requested cursor range.")
            if page_times and open_ms <= page_times[-1]:
                raise ValueError("Historical API page has duplicate or out-of-order candle timestamps.")
            if not np.isfinite(np.asarray(values, dtype=float)).all():
                raise ValueError(f"Historical API returned a non-finite value at page row {position}.")
            page_times.append(open_ms)
            page_records.append(values)

        if not page_times:
            break
        if timestamps_ms and page_times[0] <= timestamps_ms[-1]:
            raise ValueError("Historical API pagination did not advance beyond the previous page.")
        timestamps_ms.extend(page_times)
        records.extend(page_records)
        next_cursor = page_times[-1] + interval_ms
        if next_cursor <= cursor_ms:
            raise RuntimeError("Historical pagination cursor failed to advance.")
        cursor_ms = next_cursor
        if len(page_times) < request_count:
            break

    if not records:
        raise ValueError("No historical candles were returned for the requested range.")
    index = pd.to_datetime(np.asarray(timestamps_ms, dtype="int64"), unit="ms", utc=True, errors="raise")
    frame = pd.DataFrame(records, columns=COLUMNS, index=pd.DatetimeIndex(index, name="Date"))

    # A public API can return the currently forming bar. Only bars whose full
    # interval had elapsed at the retrieval time may enter the backtest.
    close_times = frame.index.to_numpy(dtype="datetime64[ns]").astype("int64") + interval_ms * 1_000_000
    now_ns = int(clock.value)
    frame = frame.loc[close_times <= now_ns].copy()
    if frame.empty:
        raise ValueError("No fully closed candles were returned.")
    if frame.index.has_duplicates or not frame.index.is_monotonic_increasing:
        raise ValueError("Historical candles must have unique chronological timestamps.")

    valid, quality_errors = validate_ohlcv(frame, min_rows=120)
    if not valid:
        raise ValueError("Invalid historical OHLCV data: " + "; ".join(quality_errors))
    gaps = frame.index.to_series().diff().dt.total_seconds().dropna()
    if (gaps > TIMEFRAME_SECONDS[interval] * 2.5).any():
        raise ValueError("Historical response contains missing candle intervals exceeding 2.5 bars.")
    return frame
