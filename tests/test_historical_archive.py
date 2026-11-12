import csv
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from scripts.archive_binance_history import FIELDS, INTERVALS, archive_pair, candle_row, iso_ms, parse_ms


class HistoricalArchiveTests(unittest.TestCase):
    def test_availability_is_after_inclusive_close_timestamp(self):
        now_ms = 1_800_000_000_000
        raw = [now_ms - 3_600_000, "10", "12", "9", "11", "100",
               now_ms - 1, "1100", 42, "50", "550", "0"]
        row = candle_row("BTCUSDT", "1h", raw, "2026-11-12T12:00:00.000Z", now_ms)
        self.assertIsNotNone(row)
        self.assertEqual(parse_ms(row["available_at_utc"]), parse_ms(row["close_time_utc"]) + 1)
        self.assertEqual(row["collected_at_utc"], "2026-11-12T12:00:00.000Z")

    def test_open_candle_is_rejected(self):
        now_ms = 1_800_000_000_000
        raw = [now_ms - 1000, "10", "12", "9", "11", "100",
               now_ms + 1000, "1100", 42, "50", "550", "0"]
        self.assertIsNone(candle_row("BTCUSDT", "1h", raw, "x", now_ms))

    def test_archive_csv_is_sorted_and_deduplicated(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "BTCUSDT" / "1h.csv"
            path.parent.mkdir(parents=True)
            base = 1_700_000_000_000
            with path.open("w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=FIELDS)
                writer.writeheader()
                writer.writerow({
                    "symbol": "BTCUSDT", "interval": "1h",
                    "open_time_utc": iso_ms(base), "close_time_utc": iso_ms(base + 3_599_999),
                    "available_at_utc": iso_ms(base + 3_600_000), "collected_at_utc": "old",
                    "open": "1", "high": "2", "low": "1", "close": "2", "base_volume": "3",
                    "quote_volume": "4", "trade_count": "5", "taker_buy_base_volume": "1",
                    "taker_buy_quote_volume": "2",
                })
            # Existing row means incremental start is after it; mocked empty page keeps it unchanged.
            import scripts.archive_binance_history as module
            original = module.fetch_page
            module.fetch_page = lambda *args: []
            try:
                result = archive_pair("BTCUSDT", "1h", Path(tmp), 180,
                                      datetime.fromtimestamp((base + 7_200_000) / 1000, timezone.utc))
            finally:
                module.fetch_page = original
            self.assertEqual(result["rows_total"], 1)
            self.assertEqual(result["rows_added"], 0)
            with path.open(newline="", encoding="utf-8") as f:
                rows = list(csv.DictReader(f))
            self.assertEqual(len(rows), 1)


    def test_daily_interval_is_archived_for_ema200_confirmation(self):
        self.assertEqual(INTERVALS["1d"], 86_400_000)
        now_ms = 1_800_000_000_000
        raw = [now_ms - 86_400_000, "10", "12", "9", "11", "100",
               now_ms - 1, "1100", 42, "50", "550", "0"]
        row = candle_row("BTCUSDT", "1d", raw, "2026-11-12T12:00:00.000Z", now_ms)
        self.assertEqual(row["interval"], "1d")
        self.assertEqual(parse_ms(row["available_at_utc"]), parse_ms(row["close_time_utc"]) + 1)

    def test_existing_short_archive_backfills_older_history(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "BTCUSDT" / "1h.csv"
            path.parent.mkdir(parents=True)
            now = datetime(2026, 11, 12, tzinfo=timezone.utc)
            existing_open = int((now.timestamp() - 100 * 86_400) * 1000)
            with path.open("w", newline="", encoding="utf-8") as f:
                writer = csv.DictWriter(f, fieldnames=FIELDS)
                writer.writeheader()
                writer.writerow({
                    "symbol": "BTCUSDT", "interval": "1h",
                    "open_time_utc": iso_ms(existing_open), "close_time_utc": iso_ms(existing_open + 3_599_999),
                    "available_at_utc": iso_ms(existing_open + 3_600_000), "collected_at_utc": "old",
                    "open": "1", "high": "2", "low": "1", "close": "2", "base_volume": "3",
                    "quote_volume": "4", "trade_count": "5", "taker_buy_base_volume": "1",
                    "taker_buy_quote_volume": "2",
                })
            import scripts.archive_binance_history as module
            original = module.fetch_page
            starts = []
            module.fetch_page = lambda symbol, interval, start, end: (starts.append(start) or [])
            try:
                archive_pair("BTCUSDT", "1h", Path(tmp), 365, now)
            finally:
                module.fetch_page = original
            self.assertTrue(starts)
            self.assertLess(starts[0], existing_open, "a 365-day run must retrieve the missing older prefix")


if __name__ == "__main__":
    unittest.main()
