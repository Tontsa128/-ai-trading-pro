import unittest

from rahasampo.cross_exchange import assess_price_divergence


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
