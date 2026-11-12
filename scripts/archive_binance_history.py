#!/usr/bin/env python3
"""Archive closed Binance Spot klines as append-only, point-in-time CSV history.

The earliest defensible availability boundary for a kline is close_time + 1 ms.
This is derived from Binance's inclusive close timestamp, not an observed exchange
publication timestamp. collected_at_utc records when this collector retrieved it.
"""
from __future__ import annotations

import argparse
import csv
import io
import json
import time
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

SYMBOLS = ("BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT", "DOGEUSDT")
INTERVALS = {"1h": 60 * 60 * 1000, "4h": 4 * 60 * 60 * 1000}
ENDPOINTS = (
    "https://data-api.binance.vision/api/v3/klines",
    "https://api.binance.com/api/v3/klines",
    "https://api1.binance.com/api/v3/klines",
    "https://api2.binance.com/api/v3/klines",
)
FIELDS = (
    "symbol", "interval", "open_time_utc", "close_time_utc",
    "available_at_utc", "collected_at_utc", "open", "high", "low",
    "close", "base_volume", "quote_volume", "trade_count",
    "taker_buy_base_volume", "taker_buy_quote_volume",
)
LIMIT = 1000
USER_AGENT = "RahasampoRadar-HistoricalArchive/1.0"


def iso_ms(value: int) -> str:
    return datetime.fromtimestamp(value / 1000, timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def parse_ms(value: str) -> int:
    return int(datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000)


def fetch_page(symbol: str, interval: str, start_ms: int, end_ms: int) -> list:
    errors = []
    params = urlencode({"symbol": symbol, "interval": interval, "startTime": start_ms, "endTime": end_ms, "limit": LIMIT})
    for endpoint in ENDPOINTS:
        try:
            request = Request(endpoint + "?" + params, headers={"User-Agent": USER_AGENT, "Accept": "application/json"})
            with urlopen(request, timeout=25) as response:
                payload = json.loads(response.read().decode("utf-8"))
            if not isinstance(payload, list):
                raise ValueError("Binance response was not a kline list")
            return payload
        except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError) as exc:
            errors.append(f"{endpoint}: {type(exc).__name__}: {exc}")
    raise RuntimeError(f"All Binance public Spot endpoints failed for {symbol} {interval}: {'; '.join(errors)}")


def candle_row(symbol: str, interval: str, raw: list, collected_at: str, now_ms: int) -> dict | None:
    if len(raw) < 11:
        raise ValueError(f"Unexpected Binance kline shape ({len(raw)} fields)")
    open_ms, close_ms = int(raw[0]), int(raw[6])
    # Binance close time is inclusive; the candle is only knowable after it.
    if close_ms >= now_ms:
        return None
    return {
        "symbol": symbol,
        "interval": interval,
        "open_time_utc": iso_ms(open_ms),
        "close_time_utc": iso_ms(close_ms),
        "available_at_utc": iso_ms(close_ms + 1),
        "collected_at_utc": collected_at,
        "open": raw[1], "high": raw[2], "low": raw[3], "close": raw[4],
        "base_volume": raw[5], "quote_volume": raw[7], "trade_count": raw[8],
        "taker_buy_base_volume": raw[9], "taker_buy_quote_volume": raw[10],
    }


def read_existing(path: Path) -> dict[int, dict]:
    if not path.exists():
        return {}
    rows = {}
    with path.open("r", newline="", encoding="utf-8") as handle:
        for row in csv.DictReader(handle):
            rows[parse_ms(row["open_time_utc"])] = row
    return rows


def archive_pair(symbol: str, interval: str, output: Path, lookback_days: int, now: datetime) -> dict:
    interval_ms = INTERVALS[interval]
    path = output / symbol / f"{interval}.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    existing = read_existing(path)
    now_ms = int(now.timestamp() * 1000)
    if existing:
        start_ms = max(existing) + interval_ms
        mode = "incremental"
    else:
        start_ms = int((now - timedelta(days=lookback_days)).timestamp() * 1000)
        start_ms = (start_ms // interval_ms) * interval_ms
        mode = "initial_backfill"

    added = 0
    pages = 0
    cursor = start_ms
    while cursor < now_ms:
        payload = fetch_page(symbol, interval, cursor, now_ms)
        pages += 1
        if not payload:
            break
        collected_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
        page_last_open = int(payload[-1][0])
        for raw in payload:
            row = candle_row(symbol, interval, raw, collected_at, now_ms)
            if row is not None:
                open_ms = parse_ms(row["open_time_utc"])
                if open_ms not in existing:
                    existing[open_ms] = row
                    added += 1
        next_cursor = page_last_open + interval_ms
        if next_cursor <= cursor:
            raise RuntimeError(f"Pagination did not advance for {symbol} {interval}")
        cursor = next_cursor
        if len(payload) < LIMIT:
            break
        time.sleep(0.15)

    ordered = [existing[key] for key in sorted(existing)]
    temp_path = path.with_suffix(".csv.tmp")
    with temp_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS, extrasaction="ignore")
        writer.writeheader()
        writer.writerows(ordered)
    temp_path.replace(path)
    return {
        "symbol": symbol, "interval": interval, "mode": mode,
        "file": str(path), "rows_total": len(ordered), "rows_added": added,
        "pages_fetched": pages,
        "first_open_utc": ordered[0]["open_time_utc"] if ordered else None,
        "last_open_utc": ordered[-1]["open_time_utc"] if ordered else None,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path("historical-data/binance"))
    parser.add_argument("--lookback-days", type=int, default=180)
    args = parser.parse_args()
    if args.lookback_days < 30:
        parser.error("--lookback-days must be at least 30")
    now = datetime.now(timezone.utc)
    results, failures = [], []
    for symbol in SYMBOLS:
        for interval in INTERVALS:
            try:
                result = archive_pair(symbol, interval, args.output, args.lookback_days, now)
                results.append(result)
                print(json.dumps(result, ensure_ascii=False))
            except Exception as exc:
                failures.append({"symbol": symbol, "interval": interval, "error": f"{type(exc).__name__}: {exc}"})
                print(json.dumps(failures[-1], ensure_ascii=False))
    manifest = {
        "schema": 1,
        "source": "Binance public Spot REST klines",
        "generated_at_utc": datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z"),
        "lookback_days_for_new_files": args.lookback_days,
        "symbols": list(SYMBOLS),
        "intervals": list(INTERVALS),
        "availability_timestamp": "available_at_utc = Binance inclusive close_time + 1ms; derived earliest availability boundary, not observed publication latency",
        "collection_timestamp": "collected_at_utc = actual UTC retrieval time for the API page",
        "results": results,
        "failures": failures,
        "passed": len(results) == len(SYMBOLS) * len(INTERVALS) and not failures,
    }
    args.output.mkdir(parents=True, exist_ok=True)
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0 if manifest["passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
