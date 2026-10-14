import tempfile
import unittest
from pathlib import Path

import pandas as pd

from rahasampo.guardrails import apply_signal_guardrails
from rahasampo.signal_journal import candidate_history, journal_counts, record_decision


class SignalJournalTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.db = str(Path(self.temp.name) / "journal.sqlite")
        self.base_time = pd.Timestamp("2026-10-14T12:00:00Z")

    def tearDown(self):
        self.temp.cleanup()

    def decision(self, level="OSTA", score=48):
        return {
            "level": level, "score": score, "price": 100.0, "stop": 98.0,
            "target": 104.0, "rr": 2.0, "bias": "NOUSU",
            "structure": "HH/HL", "triangle": "Ei kolmiota",
            "direction": "OSTA", "notes": ["test reason"], "details": {"1h": "NOUSU"},
        }

    def test_record_is_idempotent_per_closed_candle(self):
        first = record_decision(
            symbol="BTCUSDT", timeframe="1m", candle_time=self.base_time,
            decision=self.decision(), data_source="test", journal_path=self.db,
        )
        second = record_decision(
            symbol="BTCUSDT", timeframe="1m", candle_time=self.base_time,
            decision=self.decision("MYY", -45), data_source="test", journal_path=self.db,
        )
        self.assertTrue(first)
        self.assertFalse(second)
        self.assertEqual(journal_counts(journal_path=self.db)["BUY_CANDIDATE"], 1)

    def test_no_trade_decisions_are_journaled_with_reason(self):
        record_decision(
            symbol="BTCUSDT", timeframe="1m", candle_time=self.base_time,
            decision=self.decision("EI TREIDIÄ", 0), data_source="test", journal_path=self.db,
        )
        self.assertEqual(journal_counts(journal_path=self.db)["NO_TRADE"], 1)

    def test_cooldown_blocks_new_directional_candidate(self):
        record_decision(
            symbol="BTCUSDT", timeframe="1m", candle_time=self.base_time,
            decision=self.decision(), data_source="test", journal_path=self.db,
        )
        result, reason = apply_signal_guardrails(
            self.decision("MYY", -48),
            symbol="BTCUSDT", timeframe="1m",
            candle_time=self.base_time + pd.Timedelta(minutes=1),
            cooldown_bars=3, daily_signal_limit=8, journal_path=self.db,
        )
        self.assertEqual(result["level"], "EI TREIDIÄ")
        self.assertIn("Cooldown", reason)
        self.assertIsNone(result["stop"])

    def test_new_signal_allowed_after_cooldown(self):
        record_decision(
            symbol="BTCUSDT", timeframe="1m", candle_time=self.base_time,
            decision=self.decision(), data_source="test", journal_path=self.db,
        )
        result, reason = apply_signal_guardrails(
            self.decision("MYY", -48),
            symbol="BTCUSDT", timeframe="1m",
            candle_time=self.base_time + pd.Timedelta(minutes=3),
            cooldown_bars=3, daily_signal_limit=8, journal_path=self.db,
        )
        self.assertEqual(result["level"], "MYY")
        self.assertIsNone(reason)

    def test_daily_signal_cap_blocks_ninth_candidate(self):
        for offset in (0, 3, 6):
            timestamp = self.base_time + pd.Timedelta(minutes=offset)
            record_decision(
                symbol="BTCUSDT", timeframe="1m", candle_time=timestamp,
                decision=self.decision(), data_source="test", journal_path=self.db,
            )
        for offset in (9, 12, 15, 18, 21):
            timestamp = self.base_time + pd.Timedelta(minutes=offset)
            record_decision(
                symbol="BTCUSDT", timeframe="1m", candle_time=timestamp,
                decision=self.decision(), data_source="test", journal_path=self.db,
            )
        result, reason = apply_signal_guardrails(
            self.decision("MYY", -48),
            symbol="BTCUSDT", timeframe="1m",
            candle_time=self.base_time + pd.Timedelta(minutes=24),
            cooldown_bars=3, daily_signal_limit=8, journal_path=self.db,
        )
        self.assertEqual(result["level"], "EI TREIDIÄ")
        self.assertIn("Päivän signaaliraja", reason)

    def test_daily_count_is_utc_day_scoped_but_cooldown_crosses_day(self):
        before_midnight = pd.Timestamp("2026-10-13T23:57:00Z")
        record_decision(
            symbol="BTCUSDT", timeframe="1m", candle_time=before_midnight,
            decision=self.decision(), data_source="test", journal_path=self.db,
        )
        result, reason = apply_signal_guardrails(
            self.decision("MYY", -48),
            symbol="BTCUSDT", timeframe="1m",
            candle_time=pd.Timestamp("2026-10-14T00:00:00Z"),
            cooldown_bars=5, daily_signal_limit=8, journal_path=self.db,
        )
        self.assertEqual(result["level"], "EI TREIDIÄ")
        self.assertIn("Cooldown", reason)
        count, latest = candidate_history(
            symbol="BTCUSDT", timeframe="1m",
            candle_time=pd.Timestamp("2026-10-14T00:00:00Z"),
            journal_path=self.db,
        )
        self.assertEqual(count, 0)
        self.assertIsNotNone(latest)

    def test_watch_signals_do_not_consume_candidate_guardrail(self):
        result, reason = apply_signal_guardrails(
            self.decision("TARKKAILU OSTA", 25),
            symbol="BTCUSDT", timeframe="1m",
            candle_time=self.base_time, journal_path=self.db,
        )
        self.assertEqual(result["level"], "TARKKAILU OSTA")
        self.assertIsNone(reason)


if __name__ == "__main__":
    unittest.main()
