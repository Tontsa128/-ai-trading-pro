import unittest
from unittest.mock import Mock, patch

import pandas as pd
import requests

from rahasampo.historical_data import fetch_binance_historical_klines
from rahasampo.market_data import BINANCE_KLINE_URLS


def response(payload, *, status=200):
    item = Mock()
    item.status_code = status
    item.text = ""
    if status >= 400:
        item.raise_for_status.side_effect = requests.HTTPError(f"HTTP {status}")
    else:
        item.raise_for_status.return_value = None
    item.json.return_value = payload
    return item


class HistoricalDataTests(unittest.TestCase):
    def setUp(self):
        self.start = pd.Timestamp("2026-01-01T00:00:00Z")
        self.opens = [
            self.start + pd.Timedelta(minutes=n)
            for n in range(4)
        ]
        self.rows = [
            [
                int(ts.value // 1_000_000),
                "100.0", "101.0", "99.0", "100.5", "12.5",
                int(ts.value // 1_000_000) + 59_999,
                "1250.0", 10, "5.0", "500.0", "0",
            ]
            for ts in self.opens
        ]

    @patch("rahasampo.historical_data.requests.get")
    def test_downloads_multiple_pages_and_returns_only_closed_candles(self, get):
        end = self.start + pd.Timedelta(minutes=3)
        now = self.start + pd.Timedelta(minutes=4)

        def fake_get(url, *, params, timeout, headers):
            cursor = int(params["startTime"])
            end_ms = int(params["endTime"])
            chosen = [row for row in self.rows if cursor <= int(row[0]) <= end_ms]
            return response(chosen[:int(params["limit"])])

        get.side_effect = fake_get
        frame = fetch_binance_historical_klines(
            "BTCUSDT", "1m",
            start_time=self.start, end_time=end, now=now,
            page_limit=2, max_bars=120,
        )
        self.assertEqual(len(frame), 4)
        self.assertEqual(frame.index[0], self.opens[0])
        self.assertEqual(frame.index[-1], self.opens[3])
        self.assertEqual(get.call_count, 2)
        self.assertEqual(frame.columns.tolist(), ["Open", "High", "Low", "Close", "Volume"])

    @patch("rahasampo.historical_data.requests.get")
    def test_excludes_current_incomplete_candle(self, get):
        end = self.start + pd.Timedelta(minutes=2, seconds=30)
        now = end

        def fake_get(url, *, params, timeout, headers):
            cursor = int(params["startTime"])
            end_ms = int(params["endTime"])
            chosen = [row for row in self.rows if cursor <= int(row[0]) <= end_ms]
            return response(chosen[:int(params["limit"])])

        get.side_effect = fake_get
        frame = fetch_binance_historical_klines(
            "BTCUSDT", "1m",
            start_time=self.start, end_time=end, now=now,
            page_limit=10, max_bars=120,
        )
        self.assertEqual(len(frame), 2)
        self.assertEqual(frame.index[-1], self.opens[1])

    @patch("rahasampo.historical_data.requests.get")
    def test_fails_over_when_primary_endpoint_is_unavailable(self, get):
        end = self.start + pd.Timedelta(minutes=3)
        now = self.start + pd.Timedelta(minutes=4)

        def fake_get(url, *, params, timeout, headers):
            if url == BINANCE_KLINE_URLS[0]:
                return response([], status=503)
            cursor = int(params["startTime"])
            end_ms = int(params["endTime"])
            chosen = [row for row in self.rows if cursor <= int(row[0]) <= end_ms]
            return response(chosen[:int(params["limit"])])

        get.side_effect = fake_get
        frame = fetch_binance_historical_klines(
            "BTCUSDT", "1m",
            start_time=self.start, end_time=end, now=now,
            page_limit=1000, max_bars=120,
        )
        self.assertEqual(len(frame), 4)
        self.assertEqual(get.call_args_list[1].args[0], BINANCE_KLINE_URLS[1])

    @patch("rahasampo.historical_data.requests.get")
    def test_rejects_missing_candle_gaps(self, get):
        end = self.start + pd.Timedelta(minutes=3)
        now = self.start + pd.Timedelta(minutes=4)
        # A 3-minute gap violates the downloader's strict historical-quality contract.
        broken = [self.rows[0], self.rows[3]]

        def fake_get(url, *, params, timeout, headers):
            cursor = int(params["startTime"])
            end_ms = int(params["endTime"])
            chosen = [row for row in broken if cursor <= int(row[0]) <= end_ms]
            return response(chosen[:int(params["limit"])])

        get.side_effect = fake_get
        with self.assertRaisesRegex(ValueError, "missing candle intervals"):
            fetch_binance_historical_klines(
                "BTCUSDT", "1m",
                start_time=self.start, end_time=end, now=now,
                page_limit=1000, max_bars=120,
            )

    @patch("rahasampo.historical_data.requests.get")
    def test_rejects_invalid_market_symbol_and_oversized_range(self, get):
        with self.assertRaises(ValueError):
            fetch_binance_historical_klines(
                "btc-usdt", "1m", start_time=self.start,
                end_time=self.start + pd.Timedelta(minutes=2),
                now=self.start + pd.Timedelta(minutes=3), max_bars=120,
            )
        with self.assertRaisesRegex(ValueError, "exceeding max_bars"):
            fetch_binance_historical_klines(
                "BTCUSDT", "1m", start_time=self.start,
                end_time=self.start + pd.Timedelta(days=2),
                now=self.start + pd.Timedelta(days=2), max_bars=120,
            )
        get.assert_not_called()


if __name__ == "__main__":
    unittest.main()
