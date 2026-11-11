import unittest
import json
import subprocess
from pathlib import Path

import numpy as np
import pandas as pd

from radar_indicators import add_indicators, evaluate_signal_gates, rsi, signal_context_is_valid, validate_ohlcv


def sample_ohlcv(rows=80):
    index = pd.date_range("2026-01-01", periods=rows, freq="h", tz="UTC")
    close = pd.Series([100 + i * 0.17 + np.sin(i / 3) for i in range(rows)], index=index)
    return pd.DataFrame({
        "Open": close - 0.2, "High": close + 0.8, "Low": close - 0.9,
        "Close": close, "Volume": [10 + (i % 7) for i in range(rows)],
    }, index=index)


class CausalIndicatorTests(unittest.TestCase):
    def test_wilder_warmups_match_javascript_seed_indices(self):
        result = add_indicators(sample_ohlcv())
        self.assertTrue(result["RSI"].iloc[:14].isna().all())
        self.assertTrue(np.isfinite(result["RSI"].iloc[14]))
        self.assertTrue(result["ATR"].iloc[:14].isna().all())
        self.assertTrue(np.isfinite(result["ATR"].iloc[14]))
        self.assertTrue(result["PDI"].iloc[:14].isna().all())
        self.assertTrue(np.isfinite(result["PDI"].iloc[14]))
        self.assertTrue(result["ADX"].iloc[:27].isna().all())
        self.assertTrue(np.isfinite(result["ADX"].iloc[27]))
        self.assertTrue(result["VOL_MA"].iloc[:20].isna().all())
        self.assertTrue(np.isfinite(result["VOL_MA"].iloc[20]))

    def test_prefix_results_do_not_depend_on_future_rows(self):
        source = sample_ohlcv()
        full = add_indicators(source)
        columns = ["EMA9", "EMA21", "EMA50", "EMA100", "EMA200", "RSI", "MACD",
                   "MACD_SIGNAL", "MACD_HIST", "ATR", "ATR_PCT", "PDI", "MDI",
                   "ADX", "VOL_MA", "VOLUME_RATIO", "VWAP"]
        for end in (20, 35, 55, 79):
            prefix = add_indicators(source.iloc[: end + 1])
            pd.testing.assert_frame_equal(
                full.loc[prefix.index, columns], prefix[columns],
                check_exact=False, rtol=1e-12, atol=1e-12,
            )

    def test_vwap_never_backfills_from_first_positive_volume(self):
        source = sample_ohlcv(30)
        source.loc[source.index[:3], "Volume"] = 0
        result = add_indicators(source)
        self.assertTrue(result["VWAP"].iloc[:3].isna().all())
        self.assertTrue(np.isfinite(result["VWAP"].iloc[3]))
        self.assertTrue(result["VWAP"].iloc[3:].notna().all())

    def test_vwap_resets_at_utc_day_boundary(self):
        source = sample_ohlcv(30)
        result = add_indicators(source)
        second_day_start = result.index.get_loc(pd.Timestamp("2026-01-02 00:00:00", tz="UTC"))
        expected = (source["High"].iloc[second_day_start] + source["Low"].iloc[second_day_start] +
                    source["Close"].iloc[second_day_start]) / 3
        self.assertAlmostEqual(result["VWAP"].iloc[second_day_start], expected, places=12)

    def test_volume_average_excludes_the_current_candle(self):
        source = sample_ohlcv(30)
        source["Volume"] = 10.0
        source.iloc[-1, source.columns.get_loc("Volume")] = 100.0
        result = add_indicators(source)
        self.assertEqual(result["VOL_MA"].iloc[-1], 10.0)
        self.assertEqual(result["VOLUME_RATIO"].iloc[-1], 10.0)

    def test_all_zero_volume_keeps_vwap_and_volume_ratio_unavailable(self):
        source = sample_ohlcv(30)
        source["Volume"] = 0
        result = add_indicators(source)
        self.assertTrue(result["VWAP"].isna().all())
        self.assertTrue(result["VOLUME_RATIO"].isna().all())

    def test_rsi_flat_market_is_fifty_after_wilder_warmup(self):
        result = rsi(pd.Series([100.0] * 30))
        self.assertTrue(result.iloc[:14].isna().all())
        self.assertTrue(result.iloc[14:].eq(50.0).all())

    def test_rsi_uninterrupted_rise_is_one_hundred_after_warmup(self):
        result = rsi(pd.Series(np.arange(1.0, 31.0)))
        self.assertTrue(result.iloc[:14].isna().all())
        self.assertTrue(result.iloc[14:].eq(100.0).all())

    def test_rsi_uninterrupted_fall_is_zero_after_warmup(self):
        result = rsi(pd.Series(np.arange(30.0, 0.0, -1.0)))
        self.assertTrue(result.iloc[:14].isna().all())
        self.assertTrue(result.iloc[14:].eq(0.0).all())

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
        with self.assertRaisesRegex(ValueError, "gap"):
            validate_ohlcv(source.drop(source.index[10]), interval="1h")

    def test_valid_interval_sequence_is_accepted(self):
        self.assertEqual(len(validate_ohlcv(sample_ohlcv(), interval="1h")), 80)

    def test_validation_preserves_derived_columns_and_allows_indicator_warmup_nans(self):
        source = sample_ohlcv()
        source["EMA9"] = source["Close"].ewm(span=9, adjust=False).mean()
        source["ATR"] = np.nan
        result = validate_ohlcv(source)
        self.assertIn("EMA9", result.columns)
        self.assertIn("ATR", result.columns)
        self.assertTrue(result["ATR"].isna().all())

    def test_signal_context_requires_a_clear_direction_and_all_timeframes(self):
        complete = {"5m": "NOUSU", "15m": "NOUSU", "1h": "LASKU", "4h": "NOUSU"}
        self.assertTrue(signal_context_is_valid("NOUSU", complete))
        self.assertFalse(signal_context_is_valid("EPÄSELVÄ", complete))
        self.assertFalse(signal_context_is_valid("NOUSU", {"1h": "NOUSU", "4h": "NOUSU"}))
        self.assertFalse(signal_context_is_valid("NOUSU", {**complete, "4h": "?"}))


class ConservativeSignalGateTests(unittest.TestCase):
    def setUp(self):
        self.bull = {
            "close": 110.0, "ema9": 109.0, "ema21": 108.0, "ema50": 105.0,
            "ema200": 100.0, "rsi": 60.0, "macd_hist": 0.4, "atr": 2.0,
            "atr_pct": 1.8, "adx": 25.0, "pdi": 30.0, "mdi": 15.0,
            "volume_ratio": 0.8,
        }

    def test_buy_requires_all_main_and_higher_timeframe_gates(self):
        decision, reasons = evaluate_signal_gates(
            self.bull, {"4h": "NOUSU", "1d": "NOUSU"}, 0.08, 300, 90.0, 112.0
        )
        self.assertEqual(decision, "BUY")
        self.assertEqual(reasons, [])

    def test_sell_is_only_a_directional_spot_signal(self):
        bear = {
            "close": 90.0, "ema9": 91.0, "ema21": 93.0, "ema50": 95.0,
            "ema200": 100.0, "rsi": 40.0, "macd_hist": -0.4, "atr": 2.0,
            "atr_pct": 2.0, "adx": 24.0, "pdi": 12.0, "mdi": 28.0,
            "volume_ratio": 0.9,
        }
        decision, reasons = evaluate_signal_gates(
            bear, {"4h": "LASKU", "1d": "LASKU"}, 0.08, 300, 88.0, 110.0
        )
        self.assertEqual(decision, "SELL")
        self.assertEqual(reasons, [])

    def test_missing_or_wide_spread_blocks_signal(self):
        for spread in (np.nan, -0.01, 0.15001):
            decision, _ = evaluate_signal_gates(
                self.bull, {"4h": "NOUSU", "1d": "NOUSU"}, spread, 300, 90.0, 112.0
            )
            self.assertEqual(decision, "WAIT")

    def test_volume_below_approved_half_average_blocks_buy(self):
        bar = dict(self.bull, volume_ratio=0.499)
        decision, _ = evaluate_signal_gates(
            bar, {"4h": "NOUSU", "1d": "NOUSU"}, 0.08, 300, 90.0, 112.0
        )
        self.assertEqual(decision, "WAIT")

    def test_adx_below_approved_threshold_blocks_buy(self):
        bar = dict(self.bull, adx=17.99)
        decision, _ = evaluate_signal_gates(
            bar, {"4h": "NOUSU", "1d": "NOUSU"}, 0.08, 300, 90.0, 112.0
        )
        self.assertEqual(decision, "WAIT")

    def test_disagreeing_or_missing_higher_timeframes_block_signal(self):
        for higher in (
            {"4h": "NOUSU", "1d": "LASKU"},
            {"4h": "NOUSU"},
            {"4h": "NOUSU", "1d": "?"},
        ):
            decision, _ = evaluate_signal_gates(self.bull, higher, 0.08, 300, 90.0, 112.0)
            self.assertEqual(decision, "WAIT")

    def test_missing_history_and_overextension_block_signal(self):
        decision, _ = evaluate_signal_gates(
            self.bull, {"4h": "NOUSU", "1d": "NOUSU"}, 0.08, 219, 90.0, 112.0
        )
        self.assertEqual(decision, "WAIT")
        bar = dict(self.bull, close=120.0)
        decision, _ = evaluate_signal_gates(
            bar, {"4h": "NOUSU", "1d": "NOUSU"}, 0.08, 300, 90.0, 112.0
        )
        self.assertEqual(decision, "WAIT")

    def test_insufficient_room_to_resistance_blocks_buy(self):
        decision, _ = evaluate_signal_gates(
            self.bull, {"4h": "NOUSU", "1d": "NOUSU"}, 0.08, 300, 90.0, 110.5
        )
        self.assertEqual(decision, "WAIT")

    def test_signal_context_requires_exactly_four_hour_and_daily_confirmation(self):
        self.assertTrue(signal_context_is_valid("NOUSU", {"4h": "NOUSU", "1d": "NOUSU"}))
        self.assertFalse(signal_context_is_valid("EPÄSELVÄ", {"4h": "NOUSU", "1d": "NOUSU"}))
        self.assertFalse(signal_context_is_valid("NOUSU", {"4h": "NOUSU", "1d": "LASKU"}))
        self.assertFalse(signal_context_is_valid("NOUSU", {"5m": "NOUSU", "15m": "NOUSU", "1h": "NOUSU", "4h": "NOUSU"}))


class JavaScriptIndicatorParityTests(unittest.TestCase):
    def test_same_ohlcv_produces_same_indicators_as_javascript(self):
        root = Path(__file__).resolve().parents[1]
        probe = root / "tests" / "engine-parity-probe.js"
        rows = 480
        index = pd.date_range("2026-01-01", periods=rows, freq="h", tz="UTC")
        bars = []
        previous = 100.0
        for i, stamp in enumerate(index):
            close = 110 + i * 0.035 + np.sin(i / 7) * 2.2 + np.sin(i / 29) * 0.7
            open_price = previous + np.sin(i / 5) * 0.12
            high = max(open_price, close) + 0.45 + (i % 5) * 0.025
            low = min(open_price, close) - 0.35 - (i % 3) * 0.03
            volume = 40 + (i % 17) * 2.5 + (i % 7)
            time_ms = int(stamp.timestamp() * 1000)
            bars.append({
                "time": time_ms, "closeTime": time_ms + 3_599_999,
                "open": float(open_price), "high": float(high), "low": float(low),
                "close": float(close), "volume": float(volume),
            })
            previous = close
        process = subprocess.run(
            ["node", str(probe)], input=json.dumps(bars), text=True,
            capture_output=True, cwd=root, check=True,
        )
        javascript = json.loads(process.stdout)
        frame = pd.DataFrame({
            "Open": [bar["open"] for bar in bars], "High": [bar["high"] for bar in bars],
            "Low": [bar["low"] for bar in bars], "Close": [bar["close"] for bar in bars],
            "Volume": [bar["volume"] for bar in bars],
        }, index=index)
        python = add_indicators(frame)
        mapping = {
            "ema9": "EMA9", "ema21": "EMA21", "ema50": "EMA50", "ema200": "EMA200",
            "rsi": "RSI", "atr": "ATR", "pdi": "PDI", "mdi": "MDI", "adx": "ADX",
            "macd": "MACD", "macdSignal": "MACD_SIGNAL", "macdHist": "MACD_HIST",
            "volumeRatio": "VOLUME_RATIO", "vwap": "VWAP",
        }
        self.assertEqual(len(javascript), len(python))
        for key, column in mapping.items():
            for index_value, js_row in enumerate(javascript):
                expected = js_row[key]
                actual = python[column].iloc[index_value]
                if expected is None:
                    self.assertTrue(np.isnan(actual), f"{column} row {index_value} should be unavailable")
                else:
                    self.assertTrue(
                        np.isclose(float(actual), float(expected), rtol=1e-9, atol=1e-9),
                        f"{column} differs at row {index_value}: Python={actual}, JS={expected}",
                    )


if __name__ == "__main__":
    unittest.main()
