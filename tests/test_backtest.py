import unittest

import numpy as np
import pandas as pd

from rahasampo.backtest import backtest_signal_candidates


def frame_from_rows(rows):
    index = pd.date_range("2026-01-01T00:00:00Z", periods=len(rows), freq="min")
    return pd.DataFrame(rows, columns=["Open", "High", "Low", "Close"], index=index)


class BacktestTests(unittest.TestCase):
    def test_entry_uses_next_bar_open_and_reports_metrics(self):
        frame = frame_from_rows([
            [100, 101, 99, 100],
            [100, 103, 99, 102],
            [102, 103, 101, 102],
            [102, 103, 101, 102],
        ])
        atr = pd.Series([1.0] * len(frame), index=frame.index)
        trades, report = backtest_signal_candidates(
            frame, atr, [{"signal_index": 0, "side": "long"}],
            max_holding_bars=3, stop_atr=1.0, target_atr=2.0,
            fee_rate=0, slippage_bps=0, seed=7,
        )
        self.assertEqual(report.trade_count, 1)
        self.assertEqual(trades.iloc[0]["entry_index"], 1)
        self.assertEqual(trades.iloc[0]["event"], "take_profit")
        self.assertAlmostEqual(report.mean_net_return_pct, 2.0)
        self.assertEqual(report.win_rate_pct, 100.0)
        self.assertIsNone(report.mean_return_ci95_pct)

    def test_overlapping_candidates_are_logged_and_skipped(self):
        frame = frame_from_rows([[100, 101, 99, 100]] * 8)
        atr = pd.Series([10.0] * len(frame), index=frame.index)
        trades, report = backtest_signal_candidates(
            frame, atr,
            [{"signal_index": 0, "side": "long"},
             {"signal_index": 1, "side": "short"},
             {"signal_index": 4, "side": "long"}],
            max_holding_bars=3, stop_atr=1.0, target_atr=2.0,
            fee_rate=0, slippage_bps=0, seed=7,
        )
        self.assertEqual(report.skipped_overlapping, 1)
        self.assertEqual(trades.iloc[1]["event"], "rejected_overlap")
        self.assertEqual(report.trade_count, 2)

    def test_bootstrap_interval_is_reproducible(self):
        frame = frame_from_rows([
            [100, 101, 99, 100],
            [100, 103, 99, 102],
            [100, 101, 99, 100],
            [100, 101, 97, 98],
            [100, 101, 99, 100],
        ])
        atr = pd.Series([1.0] * len(frame), index=frame.index)
        candidates = [{"signal_index": 0, "side": "long"}, {"signal_index": 2, "side": "long"}]
        _, first = backtest_signal_candidates(
            frame, atr, candidates, max_holding_bars=2, stop_atr=1.0,
            target_atr=2.0, fee_rate=0, slippage_bps=0, bootstrap_samples=300, seed=19,
        )
        _, second = backtest_signal_candidates(
            frame, atr, candidates, max_holding_bars=2, stop_atr=1.0,
            target_atr=2.0, fee_rate=0, slippage_bps=0, bootstrap_samples=300, seed=19,
        )
        self.assertEqual(first.mean_return_ci95_pct, second.mean_return_ci95_pct)

    def test_invalid_atr_is_unresolved_not_counted_as_trade(self):
        frame = frame_from_rows([[100, 101, 99, 100]] * 4)
        atr = pd.Series([np.nan, 1.0, 1.0, 1.0], index=frame.index)
        trades, report = backtest_signal_candidates(
            frame, atr, [{"signal_index": 0, "side": "long"}],
            max_holding_bars=2, fee_rate=0, slippage_bps=0,
        )
        self.assertEqual(report.trade_count, 0)
        self.assertEqual(report.unresolved_count, 1)
        self.assertEqual(trades.iloc[0]["event"], "unresolved")


if __name__ == "__main__":
    unittest.main()
