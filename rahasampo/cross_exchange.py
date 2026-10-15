"""Cross-exchange spot price sanity checks."""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import math
import time

import requests


@dataclass(frozen=True)
class PriceCheck:
    ok: bool
    primary_price: float | None
    reference_price: float | None
    deviation_pct: float | None
    checked_at_utc: str
    message: str


def assess_price_divergence(
    primary_price: float,
    reference_price: float,
    *,
    reference_timestamp_ms: int,
    now_timestamp_ms: int | None = None,
    max_deviation_pct: float = 0.75,
    max_reference_age_seconds: float = 15.0,
) -> PriceCheck:
    """Check sane prices, reference freshness, and relative exchange deviation."""
    checked_at = datetime.now(timezone.utc).isoformat()
    prices = (float(primary_price), float(reference_price))
    if not all(math.isfinite(price) and price > 0 for price in prices):
        return PriceCheck(False, None, None, None, checked_at, "Invalid or non-finite exchange price.")
    if max_deviation_pct <= 0 or max_reference_age_seconds <= 0:
        raise ValueError("Deviation and freshness thresholds must be positive.")

    now_ms = int(time.time() * 1000) if now_timestamp_ms is None else int(now_timestamp_ms)
    reference_age = (now_ms - int(reference_timestamp_ms)) / 1000.0
    if reference_age < -2.0:
        return PriceCheck(False, prices[0], prices[1], None, checked_at, "Reference exchange timestamp is in the future.")
    if reference_age > max_reference_age_seconds:
        return PriceCheck(False, prices[0], prices[1], None, checked_at, f"Reference exchange ticker is stale ({reference_age:.1f}s).")

    midpoint = (prices[0] + prices[1]) / 2.0
    deviation = abs(prices[0] - prices[1]) / midpoint * 100.0
    if deviation > max_deviation_pct:
        return PriceCheck(
            False, prices[0], prices[1], deviation, checked_at,
            f"Cross-exchange price divergence {deviation:.3f}% exceeds {max_deviation_pct:.3f}%.",
        )
    return PriceCheck(
        True, prices[0], prices[1], deviation, checked_at,
        f"Cross-exchange prices agree within {max_deviation_pct:.3f}% (deviation {deviation:.3f}%).",
    )


def get_spot_price_check(
    symbol: str,
    *,
    max_deviation_pct: float = 0.75,
    max_reference_age_seconds: float = 15.0,
    timeout_seconds: float = 1.5,
) -> PriceCheck:
    """Fetch Binance and Bybit public spot tickers; fail closed on any fetch error.

    A single shared deadline bounds total UI blocking to at most three per-request
    timeouts, rather than multiplying the timeout across every fallback endpoint.
    """
    if not math.isfinite(float(timeout_seconds)) or timeout_seconds <= 0:
        raise ValueError("timeout_seconds must be finite and positive.")
    deadline = time.monotonic() + timeout_seconds * 3.0
    primary_price = None
    last_error = ""
    binance_urls = [
        "https://api.binance.com/api/v3/ticker/price",
        "https://api1.binance.com/api/v3/ticker/price",
        "https://api2.binance.com/api/v3/ticker/price",
        "https://data-api.binance.vision/api/v3/ticker/price",
    ]
    for url in binance_urls:
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        try:
            response = requests.get(
                url,
                params={"symbol": symbol},
                timeout=min(timeout_seconds, remaining),
                headers={"User-Agent": "RahasampoRadar/27"},
            )
            response.raise_for_status()
            payload = response.json()
            if payload.get("symbol") != symbol:
                raise ValueError("Binance ticker symbol does not match requested symbol.")
            primary_price = float(payload["price"])
            if not math.isfinite(primary_price) or primary_price <= 0:
                raise ValueError("Binance returned an invalid spot price.")
            break
        except Exception as exc:
            last_error = str(exc)
    if primary_price is None:
        return PriceCheck(
            False, None, None, None, datetime.now(timezone.utc).isoformat(),
            f"Binance spot ticker unavailable: {last_error[:180]}",
        )

    remaining = deadline - time.monotonic()
    if remaining <= 0:
        return PriceCheck(
            False, primary_price, None, None, datetime.now(timezone.utc).isoformat(),
            "Cross-exchange check exceeded its total timeout before the reference request.",
        )
    try:
        response = requests.get(
            "https://api.bybit.com/v5/market/tickers",
            params={"category": "spot", "symbol": symbol},
            timeout=min(timeout_seconds, remaining),
            headers={"User-Agent": "RahasampoRadar/27"},
        )
        response.raise_for_status()
        payload = response.json()
        if int(payload.get("retCode", -1)) != 0:
            raise ValueError(f"Bybit returned retCode={payload.get('retCode')}.")
        tickers = payload.get("result", {}).get("list", [])
        if not tickers or tickers[0].get("symbol") != symbol:
            raise ValueError("Bybit did not return the requested spot symbol.")
        reference_price = float(tickers[0]["lastPrice"])
        reference_timestamp_ms = int(payload["time"])
    except Exception as exc:
        return PriceCheck(
            False, primary_price, None, None, datetime.now(timezone.utc).isoformat(),
            f"Bybit spot reference unavailable: {str(exc)[:180]}",
        )

    return assess_price_divergence(
        primary_price, reference_price,
        reference_timestamp_ms=reference_timestamp_ms,
        max_deviation_pct=max_deviation_pct,
        max_reference_age_seconds=max_reference_age_seconds,
    )
