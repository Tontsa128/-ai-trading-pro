"""Conservative persisted signal-rate guardrails (analysis only; no execution)."""
from __future__ import annotations

from copy import deepcopy
import math
from typing import Any

import pandas as pd

from .data_quality import TIMEFRAME_SECONDS
from .signal_journal import CANDIDATE_TYPES, candidate_history, decision_type_for_level

ACTIONABLE_LEVELS = {"OSTA", "VAHVA OSTA", "MYY", "VAHVA MYY"}


def apply_signal_guardrails(
    decision: dict,
    *,
    symbol: str,
    timeframe: str,
    candle_time: Any,
    cooldown_bars: int = 3,
    daily_signal_limit: int = 8,
    journal_path: str | None = None,
) -> tuple[dict, str | None]:
    """Apply a per-symbol/timeframe UTC-day cap and candle-based cooldown.

    Only decisive BUY/SELL candidates consume the limit. Watch, wait, and
    no-trade classifications do not. Guardrail state comes from the persisted
    decision journal, and a journal failure blocks actionable candidates.
    """
    result = deepcopy(decision)
    if cooldown_bars < 0 or daily_signal_limit < 1:
        raise ValueError("cooldown_bars must be >= 0 and daily_signal_limit must be >= 1.")
    if timeframe not in TIMEFRAME_SECONDS:
        raise ValueError(f"Unsupported timeframe: {timeframe}.")

    original_level = str(result.get("level", "ODOTA"))
    if original_level not in ACTIONABLE_LEVELS:
        return result, None

    timestamp = pd.Timestamp(candle_time)
    if timestamp.tzinfo is None:
        raise ValueError("Guardrail candle_time must be timezone-aware.")
    timestamp = timestamp.tz_convert("UTC")

    try:
        count, last_candidate = candidate_history(
            symbol=symbol,
            timeframe=timeframe,
            candle_time=timestamp,
            journal_path=journal_path,
        )
    except Exception as exc:
        reason = f"Signaalipäiväkirja ei ole käytettävissä; signaali estetty ({type(exc).__name__})."
        return _block(result, reason), reason

    reason = None
    if count >= daily_signal_limit:
        reason = f"Päivän signaaliraja täynnä ({count}/{daily_signal_limit}, UTC)."
    elif last_candidate and cooldown_bars:
        last_time = pd.Timestamp(last_candidate)
        elapsed = (timestamp - last_time).total_seconds()
        cooldown_seconds = TIMEFRAME_SECONDS[timeframe] * cooldown_bars
        if not math.isfinite(elapsed) or elapsed < 0:
            reason = "Signaalihistorian aikajärjestys on virheellinen; signaali estetty."
        elif elapsed < cooldown_seconds:
            remaining = max(0, int(math.ceil(cooldown_seconds - elapsed)))
            reason = f"Cooldown aktiivinen; odota vähintään {remaining} sekuntia ennen uutta signaalia."

    if reason:
        return _block(result, reason), reason
    return result, None


def _block(decision: dict, reason: str) -> dict:
    decision["level"] = "EI TREIDIÄ"
    decision["direction"] = "ODOTA"
    decision["stop"] = None
    decision["target"] = None
    decision["rr"] = None
    decision["notes"] = list(decision.get("notes", [])) + [reason]
    return decision
