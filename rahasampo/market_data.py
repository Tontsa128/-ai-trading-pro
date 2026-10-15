"""Bounded, testable public Binance OHLCV client."""
from __future__ import annotations

import math
import time

import pandas as pd
import requests


BINANCE_KLINE_URLS = (
    "https://api.binance.com/api/v3/klines",
    "https://api1.binance.com/api/v3/klines",
    "https://api2.binance.com/api/v3/klines",
    "https://api3.binance.com/api/v3/klines",
    "https://data-api.binance.vision/api/v3/klines",
)

COLUMNS = ("Open", "High", "Low", "Close", "Volume")


def fetch_binance_klines(
    symbol: str,
    interval: str,
    limit: int,
    *,
    timezone_name: str = "UTC",
    total_timeout_seconds: float = 8.0,
    request_timeout_seconds: float = 2.0,
) -> pd.DataFrame:
    """Fetch klines with bounded endpoint failover and strict payload parsing.

    Returns a timezone-aware DatetimeIndex using candle-open timestamps. All
    endpoint failures are reported together; the caller must not synthesize
    replacement candles or present stale cache data as live.
    """
    if not symbol or not isinstance(symbol, str):
        raise ValueError("symbol must be a non-empty string.")
    if not interval or not isinstance(interval, str):
        raise ValueError("interval must be a non-empty string.")
    if not isinstance(limit, int) or isinstance(limit, bool) or limit < 1 or limit > 1000:
        raise ValueError("limit must be an integer between 1 and 1000.")
    if not math.isfinite(total_timeout_seconds) or total_timeout_seconds <= 0:
        raise ValueError("total_timeout_seconds must be finite and positive.")
    if not math.isfinite(request_timeout_seconds) or request_timeout_seconds <= 0:
        raise ValueError("request_timeout_seconds must be finite and positive.")

    deadline = time.monotonic() + total_timeout_seconds
    errors: list[str] = []
    for url in BINANCE_KLINE_URLS:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            response = requests.get(
                url,
                params={"symbol": symbol, "interval": interval, "limit": limit},
                timeout=min(request_timeout_seconds, remaining),
                headers={"User-Agent": "RahasampoRadar/27"},
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list) or not payload:
                raise ValueError("Kline payload was not a non-empty list.")

            rows: list[dict] = []
            timestamps: list[pd.Timestamp] = []
            for position, item in enumerate(payload):
                if not isinstance(item, (list, tuple)) or len(item) < 6:
                    raise ValueError(f"Malformed kline row at position {position}.")
                timestamp = pd.to_datetime(int(item[0]), unit="ms", utc=True, errors="raise")
                values = [float(item[i]) for i in range(1, 6)]
                if not all(math.isfinite(value) for value in values):
                    raise ValueError(f"Non-finite OHLCV value at row {position}.")
                timestamps.append(timestamp)
                rows.append(dict(zip(COLUMNS, values, strict=True)))

            index = pd.DatetimeIndex(timestamps, name="Date").tz_convert(timezone_name)
            frame = pd.DataFrame(rows, index=index, columns=COLUMNS)
            if frame.index.has_duplicates:
                raise ValueError("Kline payload contains duplicate candle timestamps.")
            if not frame.index.is_monotonic_increasing:
                raise ValueError("Kline payload timestamps are not chronological.")
            return frame

        except Exception as exc:
            errors.append(f"{url}: {type(exc).__name__}: {str(exc)[:160]}")

    raise RuntimeError(
        "Binance OHLCV unavailable from all configured endpoints. "
        + (" | ".join(errors) if errors else "Total timeout budget exhausted.")
    )



BINANCE_24H_TICKER_URLS = (
    "https://api.binance.com/api/v3/ticker/24hr",
    "https://api1.binance.com/api/v3/ticker/24hr",
    "https://api2.binance.com/api/v3/ticker/24hr",
    "https://data-api.binance.vision/api/v3/ticker/24hr",
)


def fetch_binance_24h_tickers(
    symbols: list[str] | tuple[str, ...],
    *,
    total_timeout_seconds: float = 3.0,
    request_timeout_seconds: float = 1.0,
) -> pd.DataFrame:
    """Fetch a validated multi-symbol spot watchlist from Binance's 24h ticker.

    The returned observation time is the local UTC retrieval time, not an
    exchange-provided per-trade timestamp. Prices and 24h change are display
    data only and are not substitutes for order-book or execution validation.
    """
    import json
    import re

    if not isinstance(symbols, (list, tuple)) or not symbols:
        raise ValueError("symbols must be a non-empty list or tuple.")
    requested = tuple(symbols)
    if any(not isinstance(symbol, str) or not re.fullmatch(r"[A-Z0-9]{2,30}", symbol) for symbol in requested):
        raise ValueError("symbols must contain uppercase exchange symbols.")
    if len(set(requested)) != len(requested):
        raise ValueError("symbols must not contain duplicates.")
    if not math.isfinite(total_timeout_seconds) or total_timeout_seconds <= 0:
        raise ValueError("total_timeout_seconds must be finite and positive.")
    if not math.isfinite(request_timeout_seconds) or request_timeout_seconds <= 0:
        raise ValueError("request_timeout_seconds must be finite and positive.")

    deadline = time.monotonic() + total_timeout_seconds
    params = {"symbols": json.dumps(list(requested), separators=(",", ":"))}
    errors: list[str] = []

    for url in BINANCE_24H_TICKER_URLS:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            response = requests.get(
                url,
                params=params,
                timeout=min(request_timeout_seconds, remaining),
                headers={"User-Agent": "RahasampoRadar/27"},
            )
            response.raise_for_status()
            payload = response.json()
            if not isinstance(payload, list) or not payload:
                raise ValueError("24h ticker payload was not a non-empty list.")

            by_symbol: dict[str, dict] = {}
            for position, item in enumerate(payload):
                if not isinstance(item, dict):
                    raise ValueError(f"Malformed 24h ticker row at position {position}.")
                symbol = item.get("symbol")
                if not isinstance(symbol, str) or symbol in by_symbol:
                    raise ValueError(f"Invalid or duplicate ticker symbol at position {position}.")
                by_symbol[symbol] = item
            if set(by_symbol) != set(requested):
                missing = sorted(set(requested) - set(by_symbol))
                extra = sorted(set(by_symbol) - set(requested))
                raise ValueError(f"Ticker symbols did not match request (missing={missing}, extra={extra}).")

            retrieved_at = pd.Timestamp.now(tz="UTC")
            rows = []
            for symbol in requested:
                item = by_symbol[symbol]
                last_price = float(item["lastPrice"])
                change_pct = float(item["priceChangePercent"])
                quote_volume = float(item["quoteVolume"])
                if not all(math.isfinite(value) for value in (last_price, change_pct, quote_volume)):
                    raise ValueError(f"Non-finite ticker metric for {symbol}.")
                if last_price <= 0 or quote_volume < 0:
                    raise ValueError(f"Invalid ticker price or quote volume for {symbol}.")
                rows.append({
                    "symbol": symbol,
                    "last_price": last_price,
                    "change_24h_pct": change_pct,
                    "quote_volume_24h": quote_volume,
                    "retrieved_at_utc": retrieved_at,
                })
            return pd.DataFrame(
                rows,
                columns=["symbol", "last_price", "change_24h_pct", "quote_volume_24h", "retrieved_at_utc"],
            )
        except Exception as exc:
            errors.append(f"{url}: {type(exc).__name__}: {str(exc)[:160]}")

    raise RuntimeError(
        "Binance 24h watchlist unavailable from all configured endpoints. "
        + (" | ".join(errors) if errors else "Total timeout budget exhausted.")
    )
