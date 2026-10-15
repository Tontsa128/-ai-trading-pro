"""Conservative, fee-aware position sizing for research and paper-trading only."""
from __future__ import annotations

from dataclasses import asdict, dataclass
import math


@dataclass(frozen=True)
class RiskPlan:
    eligible: bool
    reason: str
    side: str
    risk_budget_quote: float
    position_quantity: float | None
    position_notional_quote: float | None
    estimated_max_loss_quote: float | None
    estimated_net_target_profit_quote: float | None
    net_reward_risk_ratio: float | None
    break_even_win_rate_pct: float | None
    round_trip_friction_pct: float

    def to_dict(self) -> dict:
        return asdict(self)


def calculate_risk_plan(
    *,
    entry_price: float,
    stop_price: float,
    target_price: float,
    side: str,
    equity_quote: float,
    risk_fraction: float = 0.005,
    fee_rate: float = 0.001,
    slippage_bps: float = 5.0,
    max_notional_fraction: float = 1.0,
    min_notional_quote: float = 10.0,
) -> RiskPlan:
    """Estimate unleveraged size and net reward/risk after round-trip costs.

    Fee and slippage are charged on both entry and exit notionals. This helper
    deliberately caps notional at available equity (no leverage), limits risk
    budget to 2% of equity, and rejects targets whose expected gross move does
    not cover modeled round-trip friction. It does not model spread depth,
    exchange lot/tick sizes, partial fills, stop gaps, funding, or borrow costs.
    It is a planning estimate, not an executable order.
    """
    values = (entry_price, stop_price, target_price, equity_quote, risk_fraction,
              fee_rate, slippage_bps, max_notional_fraction, min_notional_quote)
    if not all(math.isfinite(float(value)) for value in values):
        raise ValueError("All risk plan inputs must be finite numbers.")
    entry = float(entry_price)
    stop = float(stop_price)
    target = float(target_price)
    equity = float(equity_quote)
    risk = float(risk_fraction)
    fee = float(fee_rate)
    slippage = float(slippage_bps)
    max_notional = float(max_notional_fraction)
    minimum_notional = float(min_notional_quote)

    if side not in ("long", "short"):
        raise ValueError("side must be 'long' or 'short'.")
    if min(entry, stop, target, equity, minimum_notional) <= 0:
        raise ValueError("Prices, equity, and minimum notional must be positive.")
    if risk <= 0 or risk > 0.02:
        raise ValueError("risk_fraction must be greater than 0 and at most 0.02 (2%).")
    if fee < 0 or fee > 0.05:
        raise ValueError("fee_rate must be between 0 and 0.05 (5%) per side.")
    if slippage < 0 or slippage >= 1000:
        raise ValueError("slippage_bps must be in [0, 1000).")
    if max_notional <= 0 or max_notional > 1.0:
        raise ValueError("max_notional_fraction must be in (0, 1]; leverage is disabled.")

    if side == "long" and not stop < entry < target:
        raise ValueError("For a long, stop < entry < target is required.")
    if side == "short" and not target < entry < stop:
        raise ValueError("For a short, target < entry < stop is required.")

    friction = fee + slippage / 10_000.0
    risk_budget = equity * risk
    stop_loss_per_unit = abs(entry - stop) + entry * friction + stop * friction
    net_target_per_unit = abs(target - entry) - entry * friction - target * friction
    round_trip_friction_pct = ((entry + target) * friction / entry) * 100.0

    if net_target_per_unit <= 0:
        return RiskPlan(
            False,
            "Estimated target gain does not cover modeled round-trip fees and slippage; no trade.",
            side, risk_budget, None, None, None, None, None, None,
            round_trip_friction_pct,
        )

    quantity_by_risk = risk_budget / stop_loss_per_unit
    quantity_by_notional = equity * max_notional / entry
    quantity = min(quantity_by_risk, quantity_by_notional)
    notional = quantity * entry

    if notional < minimum_notional:
        return RiskPlan(
            False,
            "Risk-sized position is below the configured minimum notional; no trade.",
            side, risk_budget, None, None, None, None, None, None,
            round_trip_friction_pct,
        )

    estimated_loss = quantity * stop_loss_per_unit
    estimated_net_profit = quantity * net_target_per_unit
    net_rr = net_target_per_unit / stop_loss_per_unit
    break_even = stop_loss_per_unit / (stop_loss_per_unit + net_target_per_unit) * 100.0

    return RiskPlan(
        True,
        "Indicative only: validate account fees, order-book spread, lot size, and stop-gap risk.",
        side,
        risk_budget,
        quantity,
        notional,
        estimated_loss,
        estimated_net_profit,
        net_rr,
        break_even,
        round_trip_friction_pct,
    )



def gate_decision_by_net_costs(
    decision: dict,
    *,
    equity_quote: float,
    risk_fraction: float = 0.005,
    fee_rate: float = 0.001,
    slippage_bps: float = 5.0,
    min_notional_quote: float = 10.0,
) -> tuple[dict, RiskPlan | None]:
    """Block decisive candidates when risk inputs fail or target cannot cover costs."""
    from copy import deepcopy

    result = deepcopy(decision)
    level = str(result.get("level", "ODOTA"))
    directions = {
        "OSTA": "long",
        "VAHVA OSTA": "long",
        "MYY": "short",
        "VAHVA MYY": "short",
    }
    side = directions.get(level)
    if side is None:
        return result, None

    entry = result.get("price")
    stop = result.get("stop")
    target = result.get("target")
    if entry is None or stop is None or target is None:
        result["level"] = "EI TREIDIÄ"
        result["direction"] = "ODOTA"
        result["stop"] = None
        result["target"] = None
        result["rr"] = None
        result["notes"] = list(result.get("notes", [])) + [
            "Riskilaskennan hinta-, stop- tai tavoitetieto puuttuu; signaali estetty."
        ]
        return result, None

    try:
        plan = calculate_risk_plan(
            entry_price=float(entry),
            stop_price=float(stop),
            target_price=float(target),
            side=side,
            equity_quote=equity_quote,
            risk_fraction=risk_fraction,
            fee_rate=fee_rate,
            slippage_bps=slippage_bps,
            min_notional_quote=min_notional_quote,
        )
    except (TypeError, ValueError, OverflowError) as exc:
        result["level"] = "EI TREIDIÄ"
        result["direction"] = "ODOTA"
        result["stop"] = None
        result["target"] = None
        result["rr"] = None
        result["notes"] = list(result.get("notes", [])) + [
            f"Riskilaskenta epäonnistui ({type(exc).__name__}); signaali estetty."
        ]
        return result, None

    if not plan.eligible:
        result["level"] = "EI TREIDIÄ"
        result["direction"] = "ODOTA"
        result["stop"] = None
        result["target"] = None
        result["rr"] = None
        result["notes"] = list(result.get("notes", [])) + [plan.reason]
        return result, plan

    result["net_reward_risk_ratio"] = plan.net_reward_risk_ratio
    result["notes"] = list(result.get("notes", [])) + [
        f"Kulumalli huomioitu: nettopalkkioiden jälkeinen arvioitu R/R {plan.net_reward_risk_ratio:.2f}; ei toteutustakuu."
    ]
    return result, plan
