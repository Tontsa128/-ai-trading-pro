import unittest

import pandas as pd

from rahasampo.data_quality import select_closed_candles, validate_ohlcv


def sample_frame(index):
    return pd.DataFrame({"Open": [100.0] * len(index), "High": [101.0] * len(index),
        "Low": [99.0] * len(index), "Close": [100.5] * len(index), "Volume": [10.0] * len(index)},
        index=index)


class DataQualityTests(unittest.TestCase):
    def test_valid_ohlcv_is_accepted(self):
        now = pd.Timestamp("2026-10-14T12:04:30Z")
        index = pd.date_range("2026-10-14T12:00:00Z", periods=5, freq="min")
        ok, errors = validate_ohlcv(sample_frame(index), "1m", now=now, min_rows=5)
        self.assertTrue(ok, errors)

    def test_bad_ohlc_relationship_is_rejected(self):
        now = pd.Timestamp("2026-10-14T12:04:30Z")
        index = pd.date_range("2026-10-14T12:00:00Z", periods=5, freq="min")
        frame = sample_frame(index)
        frame.loc[index[2], "High"] = 80
        ok, errors = validate_ohlcv(frame, "1m", now=now, min_rows=5)
        self.assertFalse(ok)
        self.assertTrue(any("High" in error for error in errors))

    def test_naive_timestamps_are_rejected(self):
        index = pd.date_range("2026-10-14 12:00:00", periods=5, freq="min")
        ok, errors = validate_ohlcv(sample_frame(index), "1m")
        self.assertFalse(ok)
        self.assertTrue(any("timezone" in error for error in errors))

    def test_closed_candle_filter_drops_current_open_candle(self):
        now = pd.Timestamp("2026-10-14T12:04:30Z")
        index = pd.date_range("2026-10-14T12:00:00Z", periods=5, freq="min")
        result = select_closed_candles(sample_frame(index), "1m", now=now)
        self.assertEqual(len(result), 4)
        self.assertEqual(result.index[-1], index[3])

    def test_stale_data_is_rejected(self):
        now = pd.Timestamp("2026-10-14T12:10:00Z")
        index = pd.date_range("2026-10-14T12:00:00Z", periods=5, freq="min")
        ok, errors = validate_ohlcv(sample_frame(index), "1m", now=now)
        self.assertFalse(ok)
        self.assertTrue(any("Stale" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
