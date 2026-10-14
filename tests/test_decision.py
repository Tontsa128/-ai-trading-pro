import unittest

from rahasampo.decision import classify_score


class DecisionGateTests(unittest.TestCase):
    def test_weak_score_is_not_upgraded_by_separate_candle_alert(self):
        # Candle alerts are intentionally not accepted as a parameter to this pure classifier.
        self.assertEqual(classify_score(12), "ODOTA")
        self.assertEqual(classify_score(-12), "ODOTA")

    def test_range_filter_blocks_all_trend_labels(self):
        for score in (-90, -40, -18, 0, 18, 40, 90):
            with self.subTest(score=score):
                self.assertEqual(classify_score(score, range_blocked=True), "EI TREIDIÄ")

    def test_missing_higher_timeframe_data_blocks_all_signals(self):
        for score in (-90, -40, 0, 40, 90):
            with self.subTest(score=score):
                self.assertEqual(
                    classify_score(score, higher_timeframe_data_ok=False),
                    "EI TREIDIÄ",
                )

    def test_score_thresholds_are_deterministic(self):
        self.assertEqual(classify_score(65), "VAHVA OSTA")
        self.assertEqual(classify_score(38), "OSTA")
        self.assertEqual(classify_score(18), "TARKKAILU OSTA")
        self.assertEqual(classify_score(-65), "VAHVA MYY")
        self.assertEqual(classify_score(-38), "MYY")
        self.assertEqual(classify_score(-18), "TARKKAILU MYY")


if __name__ == "__main__":
    unittest.main()
