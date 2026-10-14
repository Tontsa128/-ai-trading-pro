"""Deterministic, testable decision gates for the heuristic signal engine."""
from __future__ import annotations


def classify_score(
    score: int,
    *,
    range_blocked: bool = False,
    higher_timeframe_data_ok: bool = True,
) -> str:
    """Classify score without allowing a fast-candle alert to force a trade."""
    if not higher_timeframe_data_ok:
        return "EI TREIDIÄ"
    if range_blocked:
        return "EI TREIDIÄ"
    if score >= 65:
        return "VAHVA OSTA"
    if score >= 38:
        return "OSTA"
    if score >= 18:
        return "TARKKAILU OSTA"
    if score <= -65:
        return "VAHVA MYY"
    if score <= -38:
        return "MYY"
    if score <= -18:
        return "TARKKAILU MYY"
    return "ODOTA"
