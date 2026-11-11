import unittest

import numpy as np
import pandas as pd

from radar_indicators import add_indicators, rsi, signal_context_is_valid, validate_ohlcv


def sample_ohlcv(rows=80):
    index = pd.date_range("2026-01-01", periods=rows, freq="h", tz="UTC")
    close = pd.Series([100 + i * 0.17 + np.sin(i / 3) for i in range(rows)], index=index)
    return pd.DataFrame(
        {
            "Open": close - 0.2,
            "High": close + 0.8,
            "Low": close - 0.9,
            "Close": close,
            "Volume": [10 + (i % 7) for i in range(rows)],
        },
        index=index,
    )


class CausalIndicatorTests(unittest.TestCase):
    def test_rolling_warmup_is_not_backfilled(self):
        result = add_indicators(sample_ohlcv())
        self.assertTrue(result["ATR"].iloc[:13].isna().all())
        self.assertTrue(np.isfinite(result["ATR"].iloc[13]))
        self.assertTrue(result["VOL_MA"].iloc[:19].isna().all())
        self.assertTrue(np.isfinite(result["VOL_MA"].iloc[19]))

    def test_prefix_results_do_not_depend_on_future_rows(self):
        source = sample_ohlcv()
        full = add_indicators(source)
        columns = ["EMA9", "EMA21", "EMA50", "EMA100", "RSI", "MACD",
                   "MACD_SIGNAL", "MACD_HIST", "ATR", "VOL_MA", "VWAP"]

        for end in (20, 35, 55, 79):
            prefix = add_indicators(source.iloc[: end + 1])
            pd.testing.assert_frame_equal(
                full.loc[prefix.index, columns],
                prefix[columns],
                check_exact=False,
                rtol=1e-12,
                atol=1e-12,
            )

    def test_vwap_never_backfills_from_first_positive_volume(self):
        source = sample_ohlcv(30)
        source.loc[source.index[:3], "Volume"] = 0
        result = add_indicators(source)
        self.assertTrue(result["VWAP"].iloc[:3].isna().all())
        self.assertTrue(np.isfinite(result["VWAP"].iloc[3]))
        self.assertTrue(result["VWAP"].iloc[3:].notna().all())

    def test_all_zero_volume_keeps_vwap_unavailable(self):
        source = sample_ohlcv(30)
        source["Volume"] = 0
        self.assertTrue(add_indicators(source)["VWAP"].isna().all())

    def test_warmup_is_the_only_expected_rolling_gap(self):
        result = add_indicators(sample_ohlcv())
        self.assertTrue(result["ATR"].iloc[13:].notna().all())
        self.assertTrue(result["VOL_MA"].iloc[19:].notna().all())
        self.assertTrue(result["VWAP"].notna().all())

    def test_rsi_flat_market_is_fifty_after_initial_delta(self):
        result = rsi(pd.Series([100.0] * 20))
        self.assertTrue(result.iloc[1:].eq(50.0).all())
        self.assertTrue(np.isnan(result.iloc[0]))

    def test_rsi_uninterrupted_rise_is_one_hundred(self):
        result = rsi(pd.Series(np.arange(1.0, 21.0)))
        self.assertTrue(result.iloc[1:].eq(100.0).all())

    def test_rsi_uninterrupted_fall_is_zero(self):
        result = rsi(pd.Series(np.arange(20.0, 0.0, -1.0)))
        self.assertTrue(result.iloc[1:].eq(0.0).all())

    def test_invalid_ohlcv_is_rejected_not_repaired(self):
        source = sample_ohlcv()
        source.iloc[10, source.columns.get_loc("Close")] = np.nan
        with self.assertRaisesRegex(ValueError, "non-finite"):
            validate_ohlcv(source)

        source = sample_ohlcv()
        source.iloc[10, source.columns.get_loc("High")] = 1
        with self.assertRaisesRegex(ValueError, "high/low"):
            validate_ohlcv(source)

    def test_duplicate_and_unordered_timestamps_are_rejected(self):
        source = sample_ohlcv()
        duplicate = pd.concat([source.iloc[:10], source.iloc[[9]], source.iloc[10:]])
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            validate_ohlcv(duplicate)

        with self.assertRaisesRegex(ValueError, "ordered"):
            validate_ohlcv(source.iloc[::-1])

    def test_missing_interval_candle_is_rejected(self):
        source = sample_ohlcv()
        source = source.drop(source.index[10])
        with self.assertRaisesRegex(ValueError, "gap"):
            validate_ohlcv(source, interval="1h")

    def test_valid_interval_sequence_is_accepted(self):
        result = validate_ohlcv(sample_ohlcv(), interval="1h")
        self.assertEqual(len(result), 80)

    def test_signal_context_requires_a_clear_direction_and_all_timeframes(self):
        complete = {"5m": "NOUSU", "15m": "NOUSU", "1h": "LASKU", "4h": "NOUSU"}
        self.assertTrue(signal_context_is_valid("NOUSU", complete))
        self.assertFalse(signal_context_is_valid("EPÄSELVÄ", complete))
        self.assertFalse(signal_context_is_valid("NOUSU", {"1h": "NOUSU", "4h": "NOUSU"}))
        invalid = {**complete, "4h": "?"}
        self.assertFalse(signal_context_is_valid("NOUSU", invalid))


if __name__ == "__main__":
    unittest.main()
