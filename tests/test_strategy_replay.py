import json
import tempfile
import unittest
from pathlib import Path

import numpy as np
import pandas as pd

from rahasampo.strategy_backtest_cli import run_cli
from rahasampo.strategy_replay import (
    _bias_at,
    _resample_completed_bars,
    generate_strategy_candidates,
    prepare_higher_timeframe_timeline,
)


def make_ohlcv(periods=1800, *, freq="15min"):
    index = pd.date_range("2026-01-01T00:00:00Z", periods=periods, freq=freq)
    x = np.arange(periods, dtype=float)
    close = 100.0 + x * 0.015 + 0.55 * np.sin(x / 11.0) + 0.2 * np.sin(x / 3.0)
    open_price = close - 0.04 * np.sin(x / 4.0)
    high = np.maximum(open_price, close) + 0.12
    low = np.minimum(open_price, close) - 0.12
    return pd.DataFrame(
        {"Open": open_price, "High": high, "Low": low, "Close": close, "Volume": 1000.0 + (x % 17)},
        index=index,
    )


class StrategyReplayTests(unittest.TestCase):
    def test_higher_timeframe_state_never_uses_future_incomplete_bar(self):
        frame = make_ohlcv()
        changed_future = frame.copy()
        future_start = 1781
        for column in ("Open", "High", "Low", "Close"):
            changed_future.iloc[future_start:, changed_future.columns.get_loc(column)] *= 1.45

        original_views, original_names = prepare_higher_timeframe_timeline(frame, "15m")
        changed_views, changed_names = prepare_higher_timeframe_timeline(changed_future, "15m")
        signal_close_ns = int(frame.index[1780].value + 15 * 60 * 1_000_000_000)

        original_bias = _bias_at(original_views, signal_close_ns)
        changed_bias = _bias_at(changed_views, signal_close_ns)

        self.assertEqual(original_names, changed_names)
        self.assertEqual(original_bias, changed_bias)
        self.assertNotEqual(original_bias[1]["4h"], "?")

    def test_resampler_discards_incomplete_higher_timeframe_bucket(self):
        frame = make_ohlcv(periods=1800)
        four_hour = _resample_completed_bars(frame, "15m", "4h")
        self.assertIsNotNone(four_hour)
        self.assertGreaterEqual(len(four_hour), 110)
        self.assertLessEqual(
            four_hour.index[-1] + pd.Timedelta(hours=4),
            frame.index[-1] + pd.Timedelta(minutes=15),
        )

    def test_replay_uses_only_available_higher_timeframe_inputs(self):
        frame = make_ohlcv()
        candidates, audit, diagnostics = generate_strategy_candidates(
            frame,
            timeframe="15m",
            symbol="BTCUSDT",
            window_bars=420,
            paper_equity=1000.0,
            fee_rate=0.001,
            slippage_bps=5.0,
        )
        self.assertIn("15m", diagnostics.timeframe_inputs)
        self.assertIn("1h", diagnostics.timeframe_inputs)
        self.assertIn("4h", diagnostics.timeframe_inputs)
        self.assertNotIn("5m", diagnostics.timeframe_inputs)
        self.assertLessEqual(diagnostics.bars_evaluated, len(frame))
        self.assertEqual(diagnostics.accepted_candidates, len(candidates))
        self.assertIn("status", audit.columns)
        self.assertTrue(all(c["side"] in {"long", "short"} for c in candidates))

    def test_strategy_backtest_cli_writes_auditable_outputs_offline(self):
        frame = make_ohlcv(periods=1800)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = root / "ohlcv.csv"
            signals = root / "out" / "signals.csv"
            trades = root / "out" / "trades.csv"
            report_path = root / "out" / "report.json"
            csv = frame.reset_index(names="timestamp")
            csv.columns = ["timestamp", "open", "high", "low", "close", "volume"]
            csv.to_csv(source, index=False)

            exit_code = run_cli([
                "--ohlcv", str(source),
                "--symbol", "BTCUSDT",
                "--timeframe", "15m",
                "--window-bars", "420",
                "--max-holding-bars", "5",
                "--simulations", "10",
                "--signals-out", str(signals),
                "--trades-out", str(trades),
                "--report-out", str(report_path),
            ])

            self.assertEqual(exit_code, 0)
            self.assertTrue(signals.exists())
            self.assertTrue(trades.exists())
            self.assertTrue(report_path.exists())
            report = json.loads(report_path.read_text(encoding="utf-8"))
            self.assertTrue(report["research_only"])
            self.assertEqual(report["instrument"], "BTCUSDT")
            self.assertIn("replay_diagnostics", report)
            self.assertIn("backtest", report)
            self.assertIn("random_baseline", report)


if __name__ == "__main__":
    unittest.main()
