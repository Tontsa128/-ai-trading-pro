"""Deterministic event-driven backtest helpers for candidate signal streams."""
from __future__ import annotations

from dataclasses import asdict, dataclass

import numpy as np
import pandas as pd

from .triple_barrier import Side, triple_barrier_label


@dataclass(frozen=True)
class BacktestReport:
    trade_count: int
    skipped_overlapping: int
    unresolved_count: int
    win_rate_pct: float | None
    mean_net_return_pct: float | None
    median_net_return_pct: float | None
    profit_factor: float | None
    compounded_return_pct: float | None
    max_drawdown_pct: float | None
    mean_bars_held: float | None
    event_counts: dict[str, int]
    mean_return_ci95_pct: tuple[float, float] | None

    def to_dict(self) -> dict:
        return asdict(self)


def _max_drawdown_pct(net_returns_pct: np.ndarray) -> float:
    """Maximum peak-to-trough drawdown on compounded trade returns."""
    if net_returns_pct.size == 0:
        return 0.0
    equity = np.cumprod(1.0 + net_returns_pct / 100.0)
    peaks = np.maximum.accumulate(np.concatenate(([1.0], equity)))[1:]
    drawdowns = np.divide(equity, peaks, out=np.ones_like(equity), where=peaks != 0) - 1.0
    return float(drawdowns.min() * 100.0)


def _bootstrap_mean_ci(
    returns: np.ndarray,
    *,
    samples: int = 2000,
    seed: int = 42,
) -> tuple[float, float] | None:
    if returns.size < 2:
        return None
    if samples < 100:
        raise ValueError("Use at least 100 bootstrap samples.")
    rng = np.random.default_rng(seed)
    means = np.empty(samples, dtype=float)
    for i in range(samples):
        means[i] = rng.choice(returns, size=returns.size, replace=True).mean()
    lo, hi = np.quantile(means, [0.025, 0.975])
    return float(lo), float(hi)


def backtest_signal_candidates(
    ohlcv: pd.DataFrame,
    atr: pd.Series,
    candidates: list[dict],
    *,
    max_holding_bars: int = 20,
    stop_atr: float = 1.25,
    target_atr: float = 2.2,
    fee_rate: float = 0.0004,
    slippage_bps: float = 2.0,
    bootstrap_samples: int = 2000,
    seed: int = 42,
) -> tuple[pd.DataFrame, BacktestReport]:
    """Replay candidate signals with one open position and realistic entry timing.

    Each candidate needs a signal_index (the completed signal candle) and side
    (long or short). Entry occurs at the next bar open. ATR is sampled from the
    signal candle only. Candidates arriving while a previous trade remains open
    are logged as rejected. Results are deterministic for fixed inputs and seed.
    """
    required = {"Open", "High", "Low", "Close"}
    missing = required.difference(ohlcv.columns)
    if missing:
        raise ValueError(f"Missing OHLC columns: {', '.join(sorted(missing))}.")
    if not ohlcv.index.equals(atr.index):
        raise ValueError("ATR index must exactly match the OHLCV index.")
    if max_holding_bars < 1 or stop_atr <= 0 or target_atr <= 0:
        raise ValueError("Holding horizon and ATR multipliers must be positive.")

    ordered = sorted(candidates, key=lambda item: int(item["signal_index"]))
    records: list[dict] = []
    accepted_returns: list[float] = []
    occupied_until = -1
    skipped_overlapping = 0
    unresolved_count = 0

    for candidate in ordered:
        signal_index = int(candidate["signal_index"])
        side = candidate["side"]
        if side not in ("long", "short"):
            raise ValueError("Candidate side must be long or short.")
        if signal_index < 0 or signal_index >= len(ohlcv):
            raise IndexError("Candidate signal_index is outside the OHLCV frame.")

        entry_index = signal_index + 1
        base = {
            "signal_index": signal_index,
            "signal_time": ohlcv.index[signal_index],
            "side": side,
            "entry_index": entry_index if entry_index < len(ohlcv) else None,
            "entry_time": ohlcv.index[entry_index] if entry_index < len(ohlcv) else None,
            "accepted": False,
            "rejection_reason": None,
        }
        if entry_index >= len(ohlcv):
            unresolved_count += 1
            records.append({
                **base, "event": "unresolved", "label": None, "entry_price": None,
                "exit_price": None, "gross_return_pct": None, "net_return_pct": None,
                "bars_held": 0, "reason": "No next candle for entry.",
            })
            continue

        if entry_index <= occupied_until:
            skipped_overlapping += 1
            records.append({
                **base,
                "rejection_reason": "Previous position was still open at this entry time.",
                "event": "rejected_overlap", "label": None, "entry_price": None,
                "exit_price": None, "gross_return_pct": None, "net_return_pct": None,
                "bars_held": 0,
                "reason": "Candidate skipped to enforce one open position at a time.",
            })
            continue

        atr_value = float(atr.iloc[signal_index])
        if not np.isfinite(atr_value) or atr_value <= 0:
            unresolved_count += 1
            records.append({
                **base, "event": "unresolved", "label": None, "entry_price": None,
                "exit_price": None, "gross_return_pct": None, "net_return_pct": None,
                "bars_held": 0, "reason": "ATR invalid at signal time.",
            })
            continue

        entry_price = float(ohlcv["Open"].iloc[entry_index])
        if not np.isfinite(entry_price) or entry_price <= 0:
            unresolved_count += 1
            records.append({
                **base, "event": "unresolved", "label": None, "entry_price": None,
                "exit_price": None, "gross_return_pct": None, "net_return_pct": None,
                "bars_held": 0, "reason": "Invalid entry price.",
            })
            continue

        if side == "long":
            stop_price = entry_price - atr_value * stop_atr
            target_price = entry_price + atr_value * target_atr
        else:
            stop_price = entry_price + atr_value * stop_atr
            target_price = entry_price - atr_value * target_atr

        outcome = triple_barrier_label(
            ohlcv, entry_index=entry_index, side=side, entry_price=entry_price,
            stop_price=stop_price, target_price=target_price,
            max_holding_bars=max_holding_bars, fee_rate=fee_rate,
            slippage_bps=slippage_bps,
        )
        row = {**base, "accepted": outcome.event != "unresolved", **outcome.to_dict()}
        if outcome.event == "unresolved":
            unresolved_count += 1
        else:
            accepted_returns.append(float(outcome.net_return_pct))
            if outcome.exit_index is not None:
                occupied_until = outcome.exit_index
        records.append(row)

    trades = pd.DataFrame(records)
    returns = np.asarray(accepted_returns, dtype=float)
    if not trades.empty:
        closed_trades = trades.loc[trades["accepted"]]
        event_counts = {str(k): int(v) for k, v in closed_trades["event"].value_counts().items()}
    else:
        closed_trades = trades
        event_counts = {}

    positive = returns[returns > 0]
    negative = returns[returns < 0]
    profit_factor = float(positive.sum() / abs(negative.sum())) if negative.size else None
    compounded = float((np.prod(1.0 + returns / 100.0) - 1.0) * 100.0) if returns.size else None
    report = BacktestReport(
        trade_count=int(returns.size),
        skipped_overlapping=skipped_overlapping,
        unresolved_count=unresolved_count,
        win_rate_pct=float(np.mean(returns > 0) * 100.0) if returns.size else None,
        mean_net_return_pct=float(returns.mean()) if returns.size else None,
        median_net_return_pct=float(np.median(returns)) if returns.size else None,
        profit_factor=profit_factor,
        compounded_return_pct=compounded,
        max_drawdown_pct=_max_drawdown_pct(returns) if returns.size else None,
        mean_bars_held=float(closed_trades["bars_held"].mean()) if event_counts else None,
        event_counts=event_counts,
        mean_return_ci95_pct=_bootstrap_mean_ci(returns, samples=bootstrap_samples, seed=seed),
    )
    return trades, report
