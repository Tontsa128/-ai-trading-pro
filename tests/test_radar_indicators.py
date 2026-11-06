import unittest

import numpy as np
import pandas as pd

from radar_indicators import add_indicators


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

    def test_warmup_is_the_only_expected_rolling_gap(self):
        result = add_indicators(sample_ohlcv())
        self.assertTrue(result["ATR"].iloc[13:].notna().all())
        self.assertTrue(result["VOL_MA"].iloc[19:].notna().all())
        self.assertTrue(result["VWAP"].notna().all())


if __name__ == "__main__":
    unittest.main()
