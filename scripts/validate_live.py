"""Run live Binance Spot validation against the dashboard's real indicator/pattern code.

This is a read-only market-data check. It never submits orders, uses exchange
credentials, fabricates candles, or changes strategy thresholds.
"""
from __future__ import annotations

import ast
import json
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests

from radar_indicators import add_indicators, validate_ohlcv

SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT")
INTERVAL = "1h"
LIMIT = 1000
MAX_LATEST_AGE_SECONDS = 2 * 60 * 60
ENDPOINTS = (
    "https://data-api.binance.vision/api/v3/klines",
    "https://api.binance.com/api/v3/klines",
    "https://api1.binance.com/api/v3/klines",
    "https://api2.binance.com/api/v3/klines",
)
REPORT_PATH = Path("validation/live-validation.json")
INDICATOR_COLUMNS = (
    "EMA9", "EMA21", "EMA50", "EMA100", "RSI", "MACD",
    "MACD_SIGNAL", "MACD_HIST", "ATR", "VOL_MA", "VWAP",
)


def load_dashboard_triangle_detector():
    """Load the exact detect_triangle function from app.py without importing Streamlit."""
    source = Path("app.py").read_text(encoding="utf-8")
    module = ast.parse(source, filename="app.py")
    function = next(
        (node for node in module.body
         if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
         and node.name == "detect_triangle"),
        None,
    )
    if function is None:
        raise RuntimeError("app.py does not define detect_triangle")
    isolated = ast.Module(body=[function], type_ignores=[])
    namespace = {"np": np}
    exec(compile(ast.fix_missing_locations(isolated), "app.py", "exec"), namespace)
    return namespace["detect_triangle"]


def fetch_klines(symbol: str) -> list:
    errors = []
    for endpoint in ENDPOINTS:
        for attempt in range(2):
            try:
                response = requests.get(
                    endpoint,
                    params={"symbol": symbol, "interval": INTERVAL, "limit": LIMIT},
                    timeout=12,
                    headers={"Accept": "application/json", "User-Agent": "RahasampoRadar-LiveValidation/1.0"},
                )
                if response.status_code == 200:
                    payload = response.json()
                    if isinstance(payload, list) and payload:
                        return payload
                    errors.append(f"{endpoint}: invalid/empty payload")
                else:
                    errors.append(f"{endpoint}: HTTP {response.status_code}")
            except (requests.RequestException, ValueError) as exc:
                errors.append(f"{endpoint}: {type(exc).__name__}: {exc}")
            time.sleep(attempt + 1)
    raise RuntimeError(f"Binance public Spot klines unavailable for {symbol}: {'; '.join(errors[-4:])}")


def to_closed_frame(raw: list) -> pd.DataFrame:
    columns = [
        "open_time", "Open", "High", "Low", "Close", "Volume",
        "close_time", "quote_volume", "trades", "taker_buy_base",
        "taker_buy_quote", "ignore",
    ]
    frame = pd.DataFrame(raw, columns=columns)
    for column in ("Open", "High", "Low", "Close", "Volume"):
        frame[column] = pd.to_numeric(frame[column], errors="raise")
    frame["open_time"] = pd.to_datetime(
        pd.to_numeric(frame["open_time"], errors="raise"), unit="ms", utc=True
    )
    frame["close_time"] = pd.to_numeric(frame["close_time"], errors="raise").astype("int64")
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    frame = frame.loc[frame["close_time"] < now_ms]
    if frame.empty:
        raise ValueError("Binance returned no fully closed hourly candles")
    return frame.set_index("open_time")[["Open", "High", "Low", "Close", "Volume"]]


def validate_symbol(symbol: str, detect_triangle) -> dict:
    candles = validate_ohlcv(to_closed_frame(fetch_klines(symbol)), interval=INTERVAL)
    if len(candles) < 120:
        raise ValueError(f"Only {len(candles)} closed candles; at least 120 are required")

    latest_age = (datetime.now(timezone.utc) - candles.index[-1].to_pydatetime()).total_seconds()
    if latest_age < 0 or latest_age > MAX_LATEST_AGE_SECONDS:
        raise ValueError(f"Latest closed candle is stale/future-dated ({latest_age:.0f}s old)")

    enriched = add_indicators(candles)
    missing = [name for name in INDICATOR_COLUMNS if name not in enriched.columns]
    if missing:
        raise ValueError(f"Indicator columns missing: {missing}")

    latest = enriched.iloc[-1]
    indicator_values = {name: float(latest[name]) for name in INDICATOR_COLUMNS}
    if not np.isfinite(list(indicator_values.values())).all():
        raise ValueError("Latest indicator values contain NaN or infinity")
    if indicator_values["ATR"] <= 0 or indicator_values["VOL_MA"] < 0:
        raise ValueError("ATR or volume average failed sanity checks")
    if not 0 <= indicator_values["RSI"] <= 100:
        raise ValueError("RSI is outside the 0..100 range")

    pattern, score, lines = detect_triangle(enriched)
    if not isinstance(pattern, str) or not isinstance(score, (int, float)) or not np.isfinite(score):
        raise ValueError("Triangle detector returned an invalid pattern or score")
    if lines is not None:
        line_values = [float(lines[key]) for key in ("resistance_line", "support_line", "high_slope", "low_slope")]
        if not np.isfinite(line_values).all():
            raise ValueError("Triangle detector returned non-finite trendlines")
        resistance, support = line_values[:2]
        if resistance <= 0 or support <= 0 or resistance < support:
            raise ValueError("Triangle detector returned inverted or non-positive trendlines")

    return {
        "symbol": symbol,
        "interval": INTERVAL,
        "closed_candles": int(len(candles)),
        "first_candle_open_utc": candles.index[0].isoformat(),
        "latest_candle_open_utc": candles.index[-1].isoformat(),
        "latest_candle_age_seconds": round(latest_age, 1),
        "latest_close": float(latest["Close"]),
        "indicators": indicator_values,
        "triangle": {"pattern": pattern, "score": float(score), "trendlines": lines},
        "data_validation": "passed",
    }


def main() -> int:
    detector = load_dashboard_triangle_detector()
    results, errors = [], []
    for symbol in SYMBOLS:
        try:
            results.append(validate_symbol(symbol, detector))
        except Exception as exc:
            errors.append({"symbol": symbol, "error": f"{type(exc).__name__}: {exc}"})

    report = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "source": "Binance Spot public REST klines",
        "mode": "read-only live validation; no orders",
        "symbols": list(SYMBOLS),
        "interval": INTERVAL,
        "results": results,
        "errors": errors,
        "passed": len(results) == len(SYMBOLS) and not errors,
    }
    REPORT_PATH.parent.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(json.dumps(report, indent=2, ensure_ascii=False, default=str) + "\n", encoding="utf-8")
    print(json.dumps(report, indent=2, ensure_ascii=False, default=str))
    return 0 if report["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
