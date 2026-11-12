"""Validate the indicator and pattern code against LIVE Binance Spot klines.

Runs only on real exchange data. It never generates or substitutes candles:
if Binance cannot be reached or the data fails validation, the script exits
non-zero so the workflow fails visibly.
"""
import json
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import numpy as np
import pandas as pd
import requests

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from radar_indicators import add_indicators, detect_triangle, validate_ohlcv  # noqa: E402

SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT"]
INTERVAL = "1h"
LIMIT = 1000
ENDPOINTS = [
    "https://data-api.binance.vision/api/v3/klines",
    "https://api.binance.com/api/v3/klines",
    "https://api1.binance.com/api/v3/klines",
]
OUT = Path("validation/live-validation.json")


def fetch_klines(symbol: str) -> list:
    last = ""
    for url in ENDPOINTS:
        for attempt in range(3):
            try:
                r = requests.get(url, params={"symbol": symbol, "interval": INTERVAL, "limit": LIMIT},
                                 timeout=10, headers={"Accept": "application/json"})
                if r.status_code == 200:
                    payload = r.json()
                    if isinstance(payload, list) and payload:
                        return payload
                    last = f"{url}: unexpected payload"
                else:
                    last = f"{url}: HTTP {r.status_code}"
            except requests.RequestException as exc:
                last = f"{url}: {type(exc).__name__}"
            time.sleep(1 + attempt)
    raise RuntimeError(f"Could not fetch live {symbol} klines. Last error: {last}")


def to_frame(raw: list) -> pd.DataFrame:
    df = pd.DataFrame(raw, columns=[
        "open_time", "Open", "High", "Low", "Close", "Volume",
        "close_time", "quote_volume", "trades", "tb_base", "tb_quote", "ignore",
    ])
    for c in ["Open", "High", "Low", "Close", "Volume"]:
        df[c] = df[c].astype(float)
    df["open_time"] = pd.to_datetime(df["open_time"].astype("int64"), unit="ms", utc=True)
    df["close_time"] = df["close_time"].astype("int64")
    now_ms = int(datetime.now(timezone.utc).timestamp() * 1000)
    df = df[df["close_time"] < now_ms]  # keep closed candles only
    return df.set_index("open_time")[["Open", "High", "Low", "Close", "Volume"]]


def check_symbol(symbol: str) -> dict:
    raw = fetch_klines(symbol)
    df = validate_ohlcv(to_frame(raw), INTERVAL)
    enriched = add_indicators(df)
    atr_ok = enriched["ATR"].dropna().gt(0).all()

    patterns, bad_lines, windows = {}, [], 0
    for end in range(60, len(df) + 1):
        window = enriched.iloc[:end]
        name, score, lines = detect_triangle(window)
        windows += 1
        patterns[name] = patterns.get(name, 0) + 1
        if lines is None:
            continue
        lo, hi = window["Low"].min(), window["High"].max()
        for key in ["resistance_start", "resistance_end", "support_start", "support_end"]:
            v = lines[key]
            if not np.isfinite(v) or v < lo * 0.5 or v > hi * 1.5:
                bad_lines.append({"symbol": symbol, "at": str(window.index[-1]), "key": key, "value": float(v)})
        if lines["start_index"] >= lines["end_index"]:
            bad_lines.append({"symbol": symbol, "at": str(window.index[-1]), "key": "index_order"})

    return {
        "symbol": symbol,
        "candles": int(len(df)),
        "first_candle": str(df.index[0]),
        "last_candle": str(df.index[-1]),
        "atr_positive": bool(atr_ok),
        "windows_checked": windows,
        "pattern_counts": patterns,
        "invalid_trendlines": bad_lines[:20],
        "invalid_trendline_count": len(bad_lines),
    }


def main() -> int:
    results, errors = [], []
    for s in SYMBOLS:
        try:
            results.append(check_symbol(s))
        except Exception as exc:  # fail closed, never substitute data
            errors.append({"symbol": s, "error": str(exc)})

    summary = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": "Binance Spot public klines (live)",
        "interval": INTERVAL,
        "results": results,
        "errors": errors,
        "passed": not errors and all(r["atr_positive"] and r["invalid_trendline_count"] == 0 for r in results),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(summary, indent=2, ensure_ascii=False), encoding="utf-8")
    print(json.dumps(summary, indent=2, ensure_ascii=False))
    return 0 if summary["passed"] else 1


if __name__ == "__main__":
    sys.exit(main())
