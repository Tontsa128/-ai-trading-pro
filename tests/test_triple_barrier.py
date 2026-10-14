import unittest

import numpy as np
import pandas as pd

from rahasampo.triple_barrier import compare_strategy_to_random, label_signal_candidates, run_random_entry_baseline, triple_barrier_label


def bars(rows):
    return pd.DataFrame(rows, columns=["Open", "High", "Low", "Close"]).assign(Volume=100.0)


class TripleBarrierTests(unittest.TestCase):
    def test_long_target_is_success(self):
        result = triple_barrier_label(bars([[100, 103, 99, 102]]), entry_index=0, side="long",
            entry_price=100, stop_price=98, target_price=102, max_holding_bars=1, fee_rate=0, slippage_bps=0)
        self.assertEqual(result.event, "take_profit")
        self.assertEqual(result.label, 1)
        self.assertAlmostEqual(result.exit_price, 102)

    def test_long_stop_is_loss(self):
        result = triple_barrier_label(bars([[100, 101, 97, 98]]), entry_index=0, side="long",
            entry_price=100, stop_price=98, target_price=104, max_holding_bars=1, fee_rate=0, slippage_bps=0)
        self.assertEqual(result.event, "stop_loss")
        self.assertEqual(result.label, 0)

    def test_short_target_is_success(self):
        result = triple_barrier_label(bars([[100, 101, 96, 97]]), entry_index=0, side="short",
            entry_price=100, stop_price=103, target_price=98, max_holding_bars=1, fee_rate=0, slippage_bps=0)
        self.assertEqual(result.event, "take_profit")
        self.assertEqual(result.label, 1)

    def test_same_bar_hit_is_stop_first_by_default(self):
        result = triple_barrier_label(bars([[100, 105, 95, 101]]), entry_index=0, side="long",
            entry_price=100, stop_price=98, target_price=103, max_holding_bars=1, fee_rate=0, slippage_bps=0)
        self.assertEqual(result.event, "stop_loss")
        self.assertIn("Both barriers", result.reason)

    def test_time_expiry_uses_last_close(self):
        result = triple_barrier_label(bars([[100, 101, 99, 100.5], [100.5, 101, 100, 100.8]]),
            entry_index=0, side="long", entry_price=100, stop_price=98, target_price=104,
            max_holding_bars=2, fee_rate=0, slippage_bps=0)
        self.assertEqual(result.event, "time_expiry")
        self.assertAlmostEqual(result.exit_price, 100.8)
        self.assertEqual(result.bars_held, 2)

    def test_incomplete_horizon_is_unresolved(self):
        result = triple_barrier_label(bars([[100, 101, 99, 100], [100, 101, 99, 100]]),
            entry_index=1, side="long", entry_price=100, stop_price=98, target_price=103,
            max_holding_bars=3, fee_rate=0, slippage_bps=0)
        self.assertEqual(result.event, "unresolved")
        self.assertIsNone(result.label)
        self.assertIsNone(result.net_return_pct)

    def test_costs_can_turn_gross_win_into_net_loss(self):
        result = triple_barrier_label(bars([[100, 101, 99, 100.1]]), entry_index=0, side="long",
            entry_price=100, stop_price=98, target_price=100.1, max_holding_bars=1,
            fee_rate=0.001, slippage_bps=0)
        self.assertGreater(result.gross_return_pct, 0)
        self.assertLess(result.net_return_pct, 0)
        self.assertEqual(result.label, 0)

    def test_invalid_barrier_order_is_rejected(self):
        with self.assertRaises(ValueError):
            triple_barrier_label(bars([[100, 101, 99, 100]]), entry_index=0, side="long",
                entry_price=100, stop_price=101, target_price=103, max_holding_bars=1)

    def test_batch_labeler_enters_on_next_open_and_labels_automatically(self):
        frame = bars([[100, 101, 99, 100], [100, 105, 99.5, 104], [104, 105, 103, 104]])
        atr = pd.Series([1.0, 1.0, 1.0], index=frame.index)
        labels = label_signal_candidates(
            frame, atr, [{"signal_index": 0, "side": "long"}],
            max_holding_bars=2, stop_atr=1.0, target_atr=2.0,
            fee_rate=0, slippage_bps=0,
        )
        self.assertEqual(len(labels), 1)
        self.assertEqual(labels.iloc[0]["entry_index"], 1)
        self.assertEqual(labels.iloc[0]["event"], "take_profit")
        self.assertEqual(labels.iloc[0]["label"], 1)

    def test_batch_labeler_marks_missing_next_entry_unresolved(self):
        frame = bars([[100, 101, 99, 100]])
        atr = pd.Series([1.0], index=frame.index)
        labels = label_signal_candidates(
            frame, atr, [{"signal_index": 0, "side": "long"}],
            max_holding_bars=2, fee_rate=0, slippage_bps=0,
        )
        self.assertEqual(labels.iloc[0]["event"], "unresolved")
        self.assertTrue(pd.isna(labels.iloc[0]["label"]))

    def test_non_finite_cost_assumptions_are_rejected(self):
        with self.assertRaises(ValueError):
            triple_barrier_label(bars([[100, 101, 99, 100]]), entry_index=0, side="long",
                entry_price=100, stop_price=98, target_price=103, max_holding_bars=1,
                fee_rate=float("nan"))

    def test_malformed_future_ohlc_is_rejected(self):
        with self.assertRaises(ValueError):
            triple_barrier_label(bars([[100, 101, 102, 100]]), entry_index=0, side="long",
                entry_price=100, stop_price=98, target_price=103, max_holding_bars=1,
                fee_rate=0, slippage_bps=0)

    def test_random_baseline_is_reproducible(self):
        count = 160
        close = np.linspace(100, 120, count)
        frame = pd.DataFrame({"Open": close, "High": close * 1.01, "Low": close * 0.99,
            "Close": close, "Volume": 100.0})
        atr = pd.Series(np.ones(count), index=frame.index)
        one = run_random_entry_baseline(frame, atr, n_trades=5, max_holding_bars=3,
            simulations=5, seed=12, fee_rate=0, slippage_bps=0)
        two = run_random_entry_baseline(frame, atr, n_trades=5, max_holding_bars=3,
            simulations=5, seed=12, fee_rate=0, slippage_bps=0)
        self.assertEqual(one["simulation_expectancies_pct"], two["simulation_expectancies_pct"])
        comparison = compare_strategy_to_random([0.5, 0.6, 0.4], one)
        self.assertIn("strategy_beats_random_95th_percentile", comparison)


if __name__ == "__main__":
    unittest.main()
