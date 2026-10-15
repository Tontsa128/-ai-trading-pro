import unittest
from unittest.mock import Mock, patch

import pandas as pd
import requests

from rahasampo.market_data import (BINANCE_KLINE_URLS, BINANCE_24H_TICKER_URLS, fetch_binance_klines, fetch_binance_24h_tickers)


def response(payload, *, status=200, text=""):
    item = Mock()
    item.status_code = status
    item.text = text
    if status >= 400:
        item.raise_for_status.side_effect = requests.HTTPError(f"HTTP {status}")
    else:
        item.raise_for_status.return_value = None
    item.json.return_value = payload
    return item


class BinanceMarketDataTests(unittest.TestCase):
    def setUp(self):
        self.payload = [
            [1767225600000, "100.0", "102.0", "99.0", "101.0", "12.5"],
            [1767225660000, "101.0", "103.0", "100.0", "102.0", "13.5"],
        ]

    @patch("rahasampo.market_data.requests.get")
    def test_success_returns_sorted_timezone_aware_ohlcv(self, get):
        get.return_value = response(self.payload)
        frame = fetch_binance_klines("BTCUSDT", "1m", 2, timezone_name="Europe/Helsinki")
        self.assertEqual(list(frame.columns), ["Open", "High", "Low", "Close", "Volume"])
        self.assertEqual(len(frame), 2)
        self.assertEqual(str(frame.index.tz), "Europe/Helsinki")
        self.assertTrue(frame.index.is_monotonic_increasing)
        self.assertAlmostEqual(frame.iloc[0]["Close"], 101.0)
        get.assert_called_once()

    @patch("rahasampo.market_data.requests.get")
    def test_endpoint_failover_continues_after_http_error(self, get):
        get.side_effect = [
            response([], status=503, text="unavailable"),
            response(self.payload),
        ]
        frame = fetch_binance_klines("BTCUSDT", "1m", 2)
        self.assertEqual(len(frame), 2)
        self.assertEqual(get.call_count, 2)
        self.assertEqual(get.call_args_list[0].args[0], BINANCE_KLINE_URLS[0])
        self.assertEqual(get.call_args_list[1].args[0], BINANCE_KLINE_URLS[1])

    @patch("rahasampo.market_data.requests.get")
    def test_all_endpoint_failures_raise_clear_runtime_error(self, get):
        get.side_effect = requests.Timeout("timeout")
        with self.assertRaisesRegex(RuntimeError, "unavailable from all configured endpoints"):
            fetch_binance_klines("BTCUSDT", "1m", 2, total_timeout_seconds=30)
        self.assertGreaterEqual(get.call_count, 1)

    @patch("rahasampo.market_data.requests.get")
    def test_malformed_payload_tries_next_endpoint(self, get):
        get.side_effect = [response([[1, "100"]]), response(self.payload)]
        frame = fetch_binance_klines("BTCUSDT", "1m", 2)
        self.assertEqual(len(frame), 2)
        self.assertEqual(get.call_count, 2)

    def test_rejects_invalid_request_parameters(self):
        for limit in (0, 1001, True, 1.5):
            with self.subTest(limit=limit), self.assertRaises(ValueError):
                fetch_binance_klines("BTCUSDT", "1m", limit)


    @patch("rahasampo.market_data.requests.get")
    def test_24h_watchlist_returns_validated_prices_and_change(self, get):
        payload = [
            {"symbol": "BTCUSDT", "lastPrice": "81000.0", "priceChangePercent": "-3.2", "quoteVolume": "120000000"},
            {"symbol": "ETHUSDT", "lastPrice": "2300.0", "priceChangePercent": "-5.4", "quoteVolume": "90000000"},
        ]
        get.return_value = response(payload)
        frame = fetch_binance_24h_tickers(["BTCUSDT", "ETHUSDT"])
        self.assertEqual(frame["symbol"].tolist(), ["BTCUSDT", "ETHUSDT"])
        self.assertAlmostEqual(frame.loc[0, "last_price"], 81000.0)
        self.assertAlmostEqual(frame.loc[1, "change_24h_pct"], -5.4)
        self.assertTrue(str(frame.loc[0, "retrieved_at_utc"].tz) == "UTC")
        self.assertEqual(get.call_args.args[0], BINANCE_24H_TICKER_URLS[0])

    @patch("rahasampo.market_data.requests.get")
    def test_24h_watchlist_fails_over_after_http_error(self, get):
        payload = [
            {"symbol": "BTCUSDT", "lastPrice": "81000.0", "priceChangePercent": "-3.2", "quoteVolume": "120000000"},
        ]
        get.side_effect = [response([], status=503), response(payload)]
        frame = fetch_binance_24h_tickers(["BTCUSDT"])
        self.assertEqual(len(frame), 1)
        self.assertEqual(get.call_count, 2)
        self.assertEqual(get.call_args_list[1].args[0], BINANCE_24H_TICKER_URLS[1])

    @patch("rahasampo.market_data.requests.get")
    def test_24h_watchlist_rejects_missing_symbols_and_non_finite_values(self, get):
        incomplete = [{"symbol": "BTCUSDT", "lastPrice": "81000", "priceChangePercent": "1", "quoteVolume": "10"}]
        get.side_effect = [response(incomplete) for _ in BINANCE_24H_TICKER_URLS]
        with self.assertRaisesRegex(RuntimeError, "watchlist unavailable"):
            fetch_binance_24h_tickers(["BTCUSDT", "ETHUSDT"], total_timeout_seconds=30)

    def test_24h_watchlist_rejects_bad_symbol_lists(self):
        for symbols in ([], ["BTCUSDT", "BTCUSDT"], ["btc-usdt"], "BTCUSDT"):
            with self.subTest(symbols=symbols), self.assertRaises(ValueError):
                fetch_binance_24h_tickers(symbols)


if __name__ == "__main__":
    unittest.main()
