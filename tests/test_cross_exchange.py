import unittest
import time
from unittest.mock import Mock, patch

from rahasampo.cross_exchange import assess_price_divergence, get_spot_price_check


class CrossExchangeTests(unittest.TestCase):
    def test_close_prices_are_accepted(self):
        result = assess_price_divergence(
            100.0, 100.2, reference_timestamp_ms=1_000_000,
            now_timestamp_ms=1_005_000,
        )
        self.assertTrue(result.ok)
        self.assertGreater(result.deviation_pct, 0)

    def test_large_price_divergence_fails(self):
        result = assess_price_divergence(
            100.0, 102.0, reference_timestamp_ms=1_000_000,
            now_timestamp_ms=1_001_000,
        )
        self.assertFalse(result.ok)
        self.assertIn("divergence", result.message)

    def test_stale_reference_fails(self):
        result = assess_price_divergence(
            100.0, 100.1, reference_timestamp_ms=1_000_000,
            now_timestamp_ms=1_100_000,
        )
        self.assertFalse(result.ok)
        self.assertIn("stale", result.message)

    def test_future_reference_timestamp_fails(self):
        result = assess_price_divergence(
            100.0, 100.1, reference_timestamp_ms=1_010_000,
            now_timestamp_ms=1_000_000,
        )
        self.assertFalse(result.ok)
        self.assertIn("future", result.message)

    def test_public_ticker_adapter_parses_both_exchanges(self):
        now_ms = int(time.time() * 1000)
        binance_response = Mock()
        binance_response.raise_for_status.return_value = None
        binance_response.json.return_value = {"symbol": "BTCUSDT", "price": "100.00"}
        bybit_response = Mock()
        bybit_response.raise_for_status.return_value = None
        bybit_response.json.return_value = {
            "retCode": 0,
            "time": now_ms,
            "result": {"list": [{"symbol": "BTCUSDT", "lastPrice": "100.10"}]},
        }
        with patch("rahasampo.cross_exchange.requests.get", side_effect=[binance_response, bybit_response]):
            result = get_spot_price_check("BTCUSDT")
        self.assertTrue(result.ok, result.message)
        self.assertAlmostEqual(result.primary_price, 100.0)
        self.assertAlmostEqual(result.reference_price, 100.1)

    def test_public_ticker_adapter_fails_closed_when_reference_is_unavailable(self):
        binance_response = Mock()
        binance_response.raise_for_status.return_value = None
        binance_response.json.return_value = {"symbol": "BTCUSDT", "price": "100.00"}
        bybit_response = Mock()
        bybit_response.raise_for_status.return_value = None
        bybit_response.json.return_value = {"retCode": 10001, "retMsg": "invalid request", "result": {"list": []}}
        with patch("rahasampo.cross_exchange.requests.get", side_effect=[binance_response, bybit_response]):
            result = get_spot_price_check("BTCUSDT")
        self.assertFalse(result.ok)
        self.assertIn("Bybit", result.message)

    def test_invalid_prices_fail(self):
        for price in (0.0, -1.0, float("nan"), float("inf")):
            with self.subTest(price=price):
                result = assess_price_divergence(
                    price, 100.0, reference_timestamp_ms=1_000_000,
                    now_timestamp_ms=1_001_000,
                )
                self.assertFalse(result.ok)


if __name__ == "__main__":
    unittest.main()
