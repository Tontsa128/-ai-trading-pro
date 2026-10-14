import tempfile
import unittest
from pathlib import Path

import pandas as pd

from rahasampo.backtest_cli import read_ohlcv_csv, read_signal_candidates_csv


class BacktestCliInputTests(unittest.TestCase):
    def make_ohlcv(self, index):
        return pd.DataFrame({
            "timestamp": index,
            "open": [100.0] * len(index),
            "high": [101.0] * len(index),
            "low": [99.0] * len(index),
            "close": [100.5] * len(index),
            "volume": [10.0] * len(index),
        })

    def test_loads_ohlcv_and_maps_signal_to_exact_bar(self):
        index = pd.date_range("2026-01-01T00:00:00Z", periods=40, freq="min")
        with tempfile.TemporaryDirectory() as tmp:
            ohlcv_path = Path(tmp) / "ohlcv.csv"
            signals_path = Path(tmp) / "signals.csv"
            self.make_ohlcv(index).to_csv(ohlcv_path, index=False)
            pd.DataFrame({"timestamp": [index[5].isoformat()], "side": ["LONG"]}).to_csv(signals_path, index=False)

            frame = read_ohlcv_csv(ohlcv_path, timeframe="1m")
            candidates = read_signal_candidates_csv(signals_path, frame)

        self.assertEqual(len(frame), 40)
        self.assertEqual(candidates, [{"signal_index": 5, "side": "long"}])

    def test_rejects_signal_not_matching_exact_candle(self):
        index = pd.date_range("2026-01-01T00:00:00Z", periods=40, freq="min")
        with tempfile.TemporaryDirectory() as tmp:
            ohlcv_path = Path(tmp) / "ohlcv.csv"
            signals_path = Path(tmp) / "signals.csv"
            self.make_ohlcv(index).to_csv(ohlcv_path, index=False)
            pd.DataFrame({"timestamp": ["2026-01-01T00:05:30Z"], "side": ["long"]}).to_csv(signals_path, index=False)
            frame = read_ohlcv_csv(ohlcv_path, timeframe="1m")
            with self.assertRaisesRegex(ValueError, "does not exactly match"):
                read_signal_candidates_csv(signals_path, frame)

    def test_rejects_out_of_order_ohlcv_rows(self):
        index = pd.date_range("2026-01-01T00:00:00Z", periods=40, freq="min")
        frame = self.make_ohlcv(index)
        frame.iloc[[3, 4]] = frame.iloc[[4, 3]].to_numpy()
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "ohlcv.csv"
            frame.to_csv(path, index=False)
            with self.assertRaisesRegex(ValueError, "chronological order"):
                read_ohlcv_csv(path, timeframe="1m")


if __name__ == "__main__":
    unittest.main()
