"""Historical replay of the same pure V27 signal engine used by the Streamlit app.

All decisions use candles available at that historical timestamp. Higher-timeframe
state is built only from fully completed aggregate bars. This module sends no
network requests and places no orders.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

import numpy as np
import pandas as pd

from .data_quality import TIMEFRAME_SECONDS, validate_ohlcv
from .risk import gate_decision_by_net_costs
from .strategy import add_indicators, ai_engine

HIGHER_TIMEFRAMES = ("5m", "15m", "1h", "4h")
ACTIONABLE_LEVELS = {"OSTA", "VAHVA OSTA", "MYY", "VAHVA MYY"}


@dataclass(frozen=True)
class ReplayDiagnostics:
    bars_received: int
    bars_evaluated: int
    warmup_bars_skipped: int
    actionable_raw: int
    accepted_candidates: int
    risk_blocked: int
    cooldown_blocked: int
    daily_limit_blocked: int
    timeframe_inputs: tuple[str, ...]

    def to_dict(self) -> dict[str, Any]:
        return {
            "bars_received": self.bars_received,
            "bars_evaluated": self.bars_evaluated,
            "warmup_bars_skipped": self.warmup_bars_skipped,
            "actionable_raw": self.actionable_raw,
            "accepted_candidates": self.accepted_candidates,
            "risk_blocked": self.risk_blocked,
            "cooldown_blocked": self.cooldown_blocked,
            "daily_limit_blocked": self.daily_limit_blocked,
            "timeframe_inputs": list(self.timeframe_inputs),
        }


def _rolling_window_ema(values: pd.Series, span: int, window: int = 179) -> pd.Series:
    """Vectorized adjust=False EMA reset to the most recent `window` bars."""
    if span < 1 or window < 2:
        raise ValueError("EMA span must be >= 1 and window must be >= 2.")
    full = values.ewm(span=span, adjust=False).mean()
    if len(values) <= window:
        return full
    alpha = 2.0 / (span + 1.0)
    decay = 1.0 - alpha
    power = decay ** window
    result = full.to_numpy(dtype=float, copy=True)
    full_values = full.to_numpy(dtype=float, copy=False)
    values_array = values.to_numpy(dtype=float, copy=False)
    # Pandas EWM is recursive: subtract the old seed contribution and insert
    # the start value that a fresh rolling-window EWM would have used.
    result[window:] = (
        full_values[window:]
        - power * full_values[:-window]
        + power * values_array[1:len(values) - window + 1]
    )
    return pd.Series(result, index=values.index, name=values.name)


def _resample_completed_bars(ohlcv: pd.DataFrame, base_timeframe: str, higher_timeframe: str) -> pd.DataFrame | None:
    base_seconds = TIMEFRAME_SECONDS[base_timeframe]
    higher_seconds = TIMEFRAME_SECONDS[higher_timeframe]
    if higher_seconds < base_seconds or higher_seconds % base_seconds:
        return None
    if higher_timeframe == base_timeframe:
        return ohlcv.copy()

    expected_rows = higher_seconds // base_seconds
    rule = pd.Timedelta(seconds=higher_seconds)
    grouped = ohlcv.resample(rule, origin="epoch", label="left", closed="left")
    frame = grouped.agg({
        "Open": "first",
        "High": "max",
        "Low": "min",
        "Close": "last",
        "Volume": "sum",
    })
    counts = ohlcv["Close"].resample(rule, origin="epoch", label="left", closed="left").count()
    frame = frame.loc[counts.eq(expected_rows)].dropna(subset=["Open", "High", "Low", "Close", "Volume"])
    frame.index.name = ohlcv.index.name
    return frame


def resample_ohlcv(
    ohlcv: pd.DataFrame,
    *,
    source_timeframe: str,
    target_timeframe: str,
) -> pd.DataFrame:
    """Build target-timeframe OHLCV bars only from complete source intervals."""
    if source_timeframe not in TIMEFRAME_SECONDS or target_timeframe not in TIMEFRAME_SECONDS:
        raise ValueError("Unsupported source or target timeframe.")
    if TIMEFRAME_SECONDS[target_timeframe] < TIMEFRAME_SECONDS[source_timeframe]:
        raise ValueError("Target timeframe cannot be smaller than its source timeframe.")
    if TIMEFRAME_SECONDS[target_timeframe] % TIMEFRAME_SECONDS[source_timeframe]:
        raise ValueError("Target timeframe must be an integer multiple of source timeframe.")
    if not isinstance(ohlcv.index, pd.DatetimeIndex) or ohlcv.index.tz is None:
        raise ValueError("OHLCV source must have a timezone-aware DatetimeIndex.")
    frame = ohlcv.copy()
    frame.index = frame.index.tz_convert("UTC")
    result = _resample_completed_bars(frame, source_timeframe, target_timeframe)
    if result is None or result.empty:
        raise ValueError("No complete target-timeframe candles could be built from the source data.")
    return result


def _timeframe_states(frame: pd.DataFrame, timeframe: str, *, window: int = 179) -> np.ndarray:
    """Produce live-equivalent trend states; short history is marked unknown."""
    states = np.full(len(frame), "?", dtype=object)
    if frame.empty:
        return states

    close = frame["Close"].astype(float)
    ema50 = _rolling_window_ema(close, 50, window)
    ema100 = _rolling_window_ema(close, 100, window)
    minimum_closed = 110
    if len(frame) < minimum_closed:
        return states
    for pos in range(minimum_closed - 1, len(frame)):
        price = float(close.iloc[pos])
        fast = float(ema50.iloc[pos])
        slow = float(ema100.iloc[pos])
        if price > fast > slow:
            states[pos] = "NOUSU"
        elif price < fast < slow:
            states[pos] = "LASKU"
        else:
            states[pos] = "EPÄSELVÄ"
    return states


def _combine_bias(details: dict[str, str]) -> str:
    bull = sum(value == "NOUSU" for value in details.values())
    bear = sum(value == "LASKU" for value in details.values())
    valid = sum(value in ("NOUSU", "LASKU", "EPÄSELVÄ") for value in details.values())
    if valid < 3:
        return "EPÄSELVÄ"
    if bull >= 3:
        return "VAHVA NOUSU"
    if bear >= 3:
        return "VAHVA LASKU"
    if bull >= 2 and bear == 0:
        return "NOUSU"
    if bear >= 2 and bull == 0:
        return "LASKU"
    return "EPÄSELVÄ"


def _rolling_vwap_matches_live_window(indicators: pd.DataFrame, window_bars: int) -> pd.DataFrame:
    """Hide VWAP whenever the live app's lookback window lacks UTC midnight."""
    result = indicators.copy()
    index_utc = result.index.tz_convert("UTC")
    index_ns = index_utc.to_numpy(dtype="datetime64[ns]").astype("int64")
    day_ns = index_utc.normalize().to_numpy(dtype="datetime64[ns]").astype("int64")
    midnight_positions: dict[int, int | None] = {}
    for day in np.unique(day_ns):
        pos = int(np.searchsorted(index_ns, day))
        midnight_positions[int(day)] = pos if pos < len(index_ns) and index_ns[pos] == day else None

    usable = np.zeros(len(result), dtype=bool)
    for pos, day in enumerate(day_ns):
        start_pos = midnight_positions[int(day)]
        earliest = max(0, pos - window_bars + 1)
        usable[pos] = start_pos is not None and start_pos >= earliest
    result.loc[~usable, "VWAP"] = np.nan
    return result


def prepare_higher_timeframe_timeline(
    ohlcv: pd.DataFrame,
    timeframe: str,
) -> tuple[dict[str, tuple[np.ndarray, np.ndarray]], tuple[str, ...]]:
    """Return each timeframe's completed-bar times and causal state sequence."""
    if timeframe not in TIMEFRAME_SECONDS:
        raise ValueError(f"Unsupported timeframe: {timeframe}.")
    if ohlcv.index.tz is None:
        raise ValueError("OHLCV timestamps must be timezone-aware.")
    views: dict[str, tuple[np.ndarray, np.ndarray]] = {}
    for htf in HIGHER_TIMEFRAMES:
        frame = _resample_completed_bars(ohlcv, timeframe, htf)
        if frame is None or frame.empty:
            continue
        seconds = TIMEFRAME_SECONDS[htf]
        # Only complete aggregate candles are included. Their close time, not
        # their open label, determines when their state becomes observable.
        close_times = frame.index.tz_convert("UTC").to_numpy(dtype="datetime64[ns]").astype("int64") + seconds * 1_000_000_000
        states = _timeframe_states(frame, htf)
        views[htf] = (close_times, states)
    return views, tuple(views.keys())


def _bias_at(
    timeframe_views: dict[str, tuple[np.ndarray, np.ndarray]],
    signal_close_ns: int,
) -> tuple[str, dict[str, str]]:
    details: dict[str, str] = {name: "?" for name in HIGHER_TIMEFRAMES}
    for name, (close_times, states) in timeframe_views.items():
        pos = int(np.searchsorted(close_times, signal_close_ns, side="right") - 1)
        if pos >= 0:
            details[name] = str(states[pos])
    return _combine_bias(details), details


def generate_strategy_candidates(
    ohlcv: pd.DataFrame,
    *,
    timeframe: str,
    symbol: str = "BTCUSDT",
    window_bars: int = 420,
    higher_timeframe_ohlcv: pd.DataFrame | None = None,
    higher_timeframe_source_timeframe: str | None = None,
    paper_equity: float = 1000.0,
    risk_fraction: float = 0.005,
    fee_rate: float = 0.001,
    slippage_bps: float = 5.0,
    minimum_net_reward_risk_ratio: float = 1.2,
    cooldown_bars: int = 3,
    daily_signal_limit: int = 8,
) -> tuple[list[dict[str, Any]], pd.DataFrame, ReplayDiagnostics]:
    """Run V27's scoring logic chronologically and return auditable candidates.

    The strategy is evaluated on each candle using only bars through that
    candle's close. Actual simulated entry is still the following candle open
    in the event-driven backtester. This is research code, not an order engine.
    """
    if timeframe not in TIMEFRAME_SECONDS:
        raise ValueError(f"Unsupported timeframe: {timeframe}.")
    if window_bars < 120:
        raise ValueError("window_bars must be at least 120.")
    if cooldown_bars < 0 or daily_signal_limit < 1:
        raise ValueError("Invalid cooldown or daily signal limit.")
    if not isinstance(ohlcv, pd.DataFrame) or ohlcv.empty:
        raise ValueError("OHLCV data must be a non-empty DataFrame.")
    valid, errors = validate_ohlcv(ohlcv, min_rows=120)
    if not valid:
        raise ValueError("Invalid OHLCV history: " + "; ".join(errors))
    # Resampling requires canonical UTC candle-open times.
    frame = ohlcv.copy()
    frame.index = frame.index.tz_convert("UTC")
    base_interval_ns = TIMEFRAME_SECONDS[timeframe] * 1_000_000_000
    timestamp_ns = frame.index.to_numpy(dtype="datetime64[ns]").astype("int64")
    if (timestamp_ns % base_interval_ns != 0).any():
        raise ValueError("OHLCV timestamps must align to UTC candle-open boundaries for the selected timeframe.")
    gaps_seconds = np.diff(timestamp_ns) / 1_000_000_000
    if (gaps_seconds > TIMEFRAME_SECONDS[timeframe] * 2.5).any():
        raise ValueError("OHLCV history contains missing candle intervals exceeding 2.5 bars.")

    # EMA/RSI/MACD/ATR are causal, so their series can be prepared once.
    # After the 110 higher-TF candle warmup, startup EWM differences have
    # decayed; window-dependent VWAP eligibility is explicitly matched below.
    prepared = _rolling_vwap_matches_live_window(add_indicators(frame), window_bars)
    higher_source = higher_timeframe_ohlcv if higher_timeframe_ohlcv is not None else frame
    source_timeframe = higher_timeframe_source_timeframe or timeframe
    if source_timeframe not in TIMEFRAME_SECONDS:
        raise ValueError(f"Unsupported higher-timeframe source: {source_timeframe}.")
    if not isinstance(higher_source.index, pd.DatetimeIndex) or higher_source.index.tz is None:
        raise ValueError("Higher-timeframe source must use timezone-aware candle timestamps.")
    higher_source = higher_source.copy()
    higher_source.index = higher_source.index.tz_convert("UTC")
    source_valid, source_errors = validate_ohlcv(higher_source, min_rows=120)
    if not source_valid:
        raise ValueError("Invalid higher-timeframe source: " + "; ".join(source_errors))
    source_seconds = TIMEFRAME_SECONDS[source_timeframe]
    source_ns = higher_source.index.to_numpy(dtype="datetime64[ns]").astype("int64")
    if (source_ns % (source_seconds * 1_000_000_000) != 0).any():
        raise ValueError("Higher-timeframe source timestamps are not aligned to candle-open boundaries.")
    timeframe_views, available_frames = prepare_higher_timeframe_timeline(higher_source, source_timeframe)
    base_seconds = TIMEFRAME_SECONDS[timeframe]
    base_close_ns = timestamp_ns + base_seconds * 1_000_000_000

    valid_count = np.zeros(len(frame), dtype=int)
    for _, (close_times, states) in timeframe_views.items():
        positions = np.searchsorted(close_times, base_close_ns, side="right") - 1
        eligible = positions >= 0
        state_valid = np.zeros(len(frame), dtype=bool)
        state_valid[eligible] = np.isin(states[positions[eligible]], ["NOUSU", "LASKU", "EPÄSELVÄ"])
        valid_count += state_valid

    first_timeframe_valid = np.flatnonzero(valid_count >= 3)
    first_ready = max(119, int(first_timeframe_valid[0]) if first_timeframe_valid.size else len(frame))
    first_eval = first_ready
    candidates: list[dict[str, Any]] = []
    audit_rows: list[dict[str, Any]] = []
    daily_count: dict[str, int] = {}
    last_candidate_ns: int | None = None
    raw_count = risk_blocked = cooldown_blocked = daily_limit_blocked = 0

    for pos in range(first_eval, len(frame)):
        timestamp = frame.index[pos]
        timestamp_ns = int(base_close_ns[pos])
        start = max(0, pos - window_bars + 1)
        sample = prepared.iloc[start:pos + 1]
        bias_override = _bias_at(timeframe_views, timestamp_ns)
        decision = ai_engine(sample, higher_tf_override=bias_override)
        original_level = str(decision.get("level", "ODOTA"))
        if original_level not in ACTIONABLE_LEVELS:
            continue

        raw_count += 1
        side = "long" if "OSTA" in original_level else "short"
        plan_decision, plan = gate_decision_by_net_costs(
            decision,
            equity_quote=paper_equity,
            risk_fraction=risk_fraction,
            fee_rate=fee_rate,
            slippage_bps=slippage_bps,
            minimum_net_reward_risk_ratio=minimum_net_reward_risk_ratio,
        )
        status = "accepted"
        reason = ""
        if plan_decision.get("level") not in ACTIONABLE_LEVELS:
            status = "risk_blocked"
            reason = plan.reason if plan is not None else "; ".join(plan_decision.get("notes", ["Risk gate blocked candidate."])[-2:])
            risk_blocked += 1
        else:
            day = timestamp.date().isoformat()
            if daily_count.get(day, 0) >= daily_signal_limit:
                status = "daily_limit_blocked"
                reason = f"UTC-day candidate limit reached ({daily_signal_limit})."
                daily_limit_blocked += 1
            elif last_candidate_ns is not None and timestamp_ns - last_candidate_ns < base_seconds * cooldown_bars * 1_000_000_000:
                status = "cooldown_blocked"
                reason = f"Cooldown active ({cooldown_bars} bars)."
                cooldown_blocked += 1
            else:
                daily_count[day] = daily_count.get(day, 0) + 1
                last_candidate_ns = timestamp_ns
                candidates.append({"signal_index": pos, "side": side})

        audit_rows.append({
            "timestamp": timestamp.isoformat(),
            "signal_index": pos,
            "symbol": symbol,
            "timeframe": timeframe,
            "original_level": original_level,
            "score": int(decision.get("score", 0)),
            "signal_close_price": float(decision.get("price", np.nan)),
            "stop_from_signal_close": decision.get("stop"),
            "target_from_signal_close": decision.get("target"),
            "estimated_net_reward_risk": plan.net_reward_risk_ratio if plan is not None else None,
            "status": status,
            "reason": reason,
            "side": side,
        })

    audit = pd.DataFrame(audit_rows, columns=[
        "timestamp", "signal_index", "symbol", "timeframe", "original_level", "score",
        "signal_close_price", "stop_from_signal_close", "target_from_signal_close",
        "estimated_net_reward_risk", "status", "reason", "side",
    ])
    diagnostics = ReplayDiagnostics(
        bars_received=len(frame),
        bars_evaluated=max(0, len(frame) - first_eval),
        warmup_bars_skipped=first_eval,
        actionable_raw=raw_count,
        accepted_candidates=len(candidates),
        risk_blocked=risk_blocked,
        cooldown_blocked=cooldown_blocked,
        daily_limit_blocked=daily_limit_blocked,
        timeframe_inputs=available_frames,
    )
    return candidates, audit, diagnostics
