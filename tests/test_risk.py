import unittest

from rahasampo.risk import calculate_risk_plan, gate_decision_by_net_costs


class RiskPlanTests(unittest.TestCase):
    def test_long_plan_caps_risk_budget_and_never_uses_leverage(self):
        plan = calculate_risk_plan(
            entry_price=100.0, stop_price=98.0, target_price=105.0,
            side="long", equity_quote=1000.0, risk_fraction=0.005,
            fee_rate=0.001, slippage_bps=5.0,
        )
        self.assertTrue(plan.eligible)
        self.assertLessEqual(plan.position_notional_quote, 1000.0)
        self.assertLessEqual(plan.estimated_max_loss_quote, plan.risk_budget_quote + 1e-9)
        self.assertGreater(plan.net_reward_risk_ratio, 0)
        self.assertGreater(plan.break_even_win_rate_pct, 0)

    def test_target_that_does_not_cover_round_trip_costs_is_rejected(self):
        plan = calculate_risk_plan(
            entry_price=100.0, stop_price=99.5, target_price=100.2,
            side="long", equity_quote=1000.0,
        )
        self.assertFalse(plan.eligible)
        self.assertIsNone(plan.position_quantity)
        self.assertIn("does not cover", plan.reason)

    def test_short_plan_validates_direction_and_calculates_size(self):
        plan = calculate_risk_plan(
            entry_price=100.0, stop_price=103.0, target_price=94.0,
            side="short", equity_quote=5000.0,
        )
        self.assertTrue(plan.eligible)
        self.assertGreater(plan.position_quantity, 0)
        self.assertLessEqual(plan.position_notional_quote, 5000.0)

    def test_rejects_invalid_direction_and_leverage(self):
        with self.assertRaises(ValueError):
            calculate_risk_plan(
                entry_price=100, stop_price=98, target_price=105,
                side="sell", equity_quote=1000,
            )
        with self.assertRaises(ValueError):
            calculate_risk_plan(
                entry_price=100, stop_price=98, target_price=105,
                side="long", equity_quote=1000, max_notional_fraction=2.0,
            )

    def test_rejects_risk_above_two_percent(self):
        with self.assertRaises(ValueError):
            calculate_risk_plan(
                entry_price=100, stop_price=98, target_price=105,
                side="long", equity_quote=1000, risk_fraction=0.03,
            )


    def test_decisive_signal_is_blocked_when_target_does_not_cover_costs(self):
        decision = {
            "level": "OSTA", "direction": "OSTA", "price": 100.0,
            "stop": 99.5, "target": 100.2, "rr": 0.4, "notes": [],
        }
        guarded, plan = gate_decision_by_net_costs(decision, equity_quote=1000.0)
        self.assertEqual(guarded["level"], "EI TREIDIÄ")
        self.assertIsNone(guarded["stop"])
        self.assertIsNotNone(plan)
        self.assertFalse(plan.eligible)

    def test_watch_signal_is_not_modified_by_risk_gate(self):
        decision = {"level": "TARKKAILU OSTA", "price": 100.0, "notes": []}
        guarded, plan = gate_decision_by_net_costs(decision, equity_quote=1000.0)
        self.assertEqual(guarded, decision)
        self.assertIsNone(plan)

    def test_missing_stop_for_buy_signal_fails_closed(self):
        decision = {"level": "OSTA", "direction": "OSTA", "price": 100.0, "stop": None, "target": 105.0, "notes": []}
        guarded, plan = gate_decision_by_net_costs(decision, equity_quote=1000.0)
        self.assertEqual(guarded["level"], "EI TREIDIÄ")
        self.assertIsNone(plan)


if __name__ == "__main__":
    unittest.main()
