"""Triple-barrier labeling and seeded random-entry benchmarks."""
from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Literal

import numpy as np
import pandas as pd

Side = Literal["long", "short"]
Event = Literal["take_profit", "stop_loss", "time_expiry", "unresolved"]


@dataclass(frozen=True)
class TripleBarrierResult:
    event: Event
    label: int | None
    side: Side
    entry_index: int
    exit_index: int | None
    entry_price: float
    exit_price: float | None
    gross_return_pct: float | None
    net_return_pct: float | None
    bars_held: int
    reason: str

    def to_dict(self) -> dict:
        return asdict(self)


def _validate_prices(side, entry_price, stop_price, target_price, max_holding_bars):
    if side not in ("long", "short"):
        raise ValueError("side must be 'long' or 'short'.")
    if max_holding_bars < 1:
        raise ValueError("max_holding_bars must be at least 1.")
    prices = np.asarray([entry_price, stop_price, target_price], dtype=float)
    if not np.isfinite(prices).all() or (prices <= 0).any():
        raise ValueError("Entry, stop, and target prices must be finite and positive.")
    if side == "long" and not stop_price < entry_price < target_price:
        raise ValueError("For a long, stop < entry < target is required.")
    if side == "short" and not target_price < entry_price < stop_price:
        raise ValueError("For a short, target < entry < stop is required.")


def triple_barrier_label(
    ohlcv: pd.DataFrame,
    *,
    entry_index: int,
    side: Side,
    entry_price: float,
    stop_price: float,
    target_price: float,
    max_holding_bars: int,
    fee_rate: float = 0.0004,
    slippage_bps: float = 2.0,
    same_bar_policy: Literal["stop", "target"] = "stop",
) -> TripleBarrierResult:
    """Label TP/SL/time expiry; unresolved horizons are never guessed.

    entry_index is the first bar after entry. If both price barriers are touched
    in one OHLC bar, the default assumes stop first as the conservative case.
    Costs are simple assumptions and should be calibrated to the exchange/venue.
    """
    required = {"Open", "High", "Low", "Close"}
    missing = required.difference(ohlcv.columns)
    if missing:
        raise ValueError(f"Missing OHLC columns: {', '.join(sorted(missing))}.")
    if entry_index < 0 or entry_index >= len(ohlcv):
        raise IndexError("entry_index is outside the OHLCV frame.")
    _validate_prices(side, entry_price, stop_price, target_price, max_holding_bars)
    if not np.isfinite(float(fee_rate)) or fee_rate < 0 or fee_rate >= 1:
        raise ValueError("Fee rate must be finite and in the range [0, 1).")
    if not np.isfinite(float(slippage_bps)) or slippage_bps < 0 or slippage_bps >= 10_000:
        raise ValueError("Slippage must be finite and in the range [0, 10000) basis points.")
    if same_bar_policy not in ("stop", "target"):
        raise ValueError("same_bar_policy must be 'stop' or 'target'.")

    slip = slippage_bps / 10_000.0
    entry_exec = entry_price * (1.0 + slip if side == "long" else 1.0 - slip)

    def finish(event, exit_index, raw_exit, bars_held, reason):
        if raw_exit is None:
            return TripleBarrierResult(
                event, None, side, entry_index, None, float(entry_price), None,
                None, None, bars_held, reason,
            )
        exit_exec = raw_exit * (1.0 - slip if side == "long" else 1.0 + slip)
        if side == "long":
            gross = (raw_exit - entry_price) / entry_price
            net = (exit_exec - entry_exec) / entry_exec
        else:
            gross = (entry_price - raw_exit) / entry_price
            net = (entry_exec - exit_exec) / entry_exec
        net -= fee_rate * (1.0 + exit_exec / entry_exec)
        return TripleBarrierResult(
            event=event,
            label=int(net > 0.0),
            side=side,
            entry_index=entry_index,
            exit_index=exit_index,
            entry_price=float(entry_price),
            exit_price=float(raw_exit),
            gross_return_pct=float(gross * 100.0),
            net_return_pct=float(net * 100.0),
            bars_held=bars_held,
            reason=reason,
        )

    for offset in range(max_holding_bars):
        bar_index = entry_index + offset
        if bar_index >= len(ohlcv):
            return finish(
                "unresolved", None, None, offset,
                "Insufficient future bars to resolve the full holding horizon.",
            )
        bar = ohlcv.iloc[bar_index]
        open_price, high, low, close = (
            float(bar["Open"]), float(bar["High"]), float(bar["Low"]), float(bar["Close"])
        )
        bar_prices = np.asarray([open_price, high, low, close], dtype=float)
        if (
            not np.isfinite(bar_prices).all()
            or (bar_prices <= 0).any()
            or high < max(open_price, close, low)
            or low > min(open_price, close, high)
        ):
            raise ValueError(f"Invalid OHLC values at row position {bar_index}.")
        # The opening price is the first observed price in each OHLC bar.
        # Resolve gaps before applying the conservative intrabar tie-break.
        if side == "long" and open_price <= stop_price:
            return finish(
                "stop_loss", bar_index, open_price, offset + 1,
                "Bar opened through the stop; gap-aware fill at open.",
            )
        if side == "long" and open_price >= target_price:
            return finish(
                "take_profit", bar_index, target_price, offset + 1,
                "Bar opened beyond the target; target price used without price improvement.",
            )
        if side == "short" and open_price >= stop_price:
            return finish(
                "stop_loss", bar_index, open_price, offset + 1,
                "Bar opened through the stop; gap-aware fill at open.",
            )
        if side == "short" and open_price <= target_price:
            return finish(
                "take_profit", bar_index, target_price, offset + 1,
                "Bar opened beyond the target; target price used without price improvement.",
            )

        if side == "long":
            stop_hit, target_hit = low <= stop_price, high >= target_price
        else:
            stop_hit, target_hit = high >= stop_price, low <= target_price

        if stop_hit and target_hit:
            if same_bar_policy == "stop":
                exit_price = min(open_price, stop_price) if side == "long" else max(open_price, stop_price)
                return finish(
                    "stop_loss", bar_index, exit_price, offset + 1,
                    "Both barriers touched in one OHLC bar; conservative stop-first assumption.",
                )
            return finish(
                "take_profit", bar_index, target_price, offset + 1,
                "Both barriers touched in one OHLC bar; target-first override was requested.",
            )
        if stop_hit:
            exit_price = min(open_price, stop_price) if side == "long" else max(open_price, stop_price)
            return finish("stop_loss", bar_index, exit_price, offset + 1, "Stop barrier touched; gap-aware conservative fill.")
        if target_hit:
            return finish("take_profit", bar_index, target_price, offset + 1, "Target barrier touched.")
        if offset == max_holding_bars - 1:
            return finish(
                "time_expiry", bar_index, float(bar["Close"]), offset + 1,
                "Neither price barrier was touched before the maximum holding time.",
            )
    raise RuntimeError("Unreachable triple-barrier state.")


def label_signal_candidates(
    ohlcv: pd.DataFrame,
    atr: pd.Series,
    candidates: list[dict],
    *,
    max_holding_bars: int = 20,
    stop_atr: float = 1.25,
    target_atr: float = 2.2,
    fee_rate: float = 0.0004,
    slippage_bps: float = 2.0,
) -> pd.DataFrame:
    """Automatically label historical signal candidates with triple barriers.

    Each candidate is a mapping with signal_index (the closed candle that
    generated the signal) and side ('long' or 'short'). The simulated entry is
    the next candle's open; stop/target distances use ATR known at signal time.
    This avoids using the signal candle's close as if it were a guaranteed fill.
    """
    missing = {"Open", "High", "Low", "Close"}.difference(ohlcv.columns)
    if missing:
        raise ValueError(f"Missing OHLC columns: {', '.join(sorted(missing))}.")
    if not ohlcv.index.equals(atr.index):
        raise ValueError("ATR index must exactly match the OHLCV index.")
    if max_holding_bars < 1 or stop_atr <= 0 or target_atr <= 0:
        raise ValueError("Holding horizon and ATR barrier multipliers must be positive.")

    records: list[dict] = []
    for candidate in candidates:
        signal_index = int(candidate["signal_index"])
        side = candidate["side"]
        if side not in ("long", "short"):
            raise ValueError("Each candidate side must be 'long' or 'short'.")
        if signal_index < 0 or signal_index >= len(ohlcv):
            raise IndexError("Candidate signal_index is outside the OHLCV frame.")

        record = {
            "signal_index": signal_index,
            "signal_time": ohlcv.index[signal_index],
            "side": side,
        }
        entry_index = signal_index + 1
        if entry_index >= len(ohlcv):
            records.append({
                **record,
                "entry_index": None,
                "entry_time": None,
                "event": "unresolved",
                "label": None,
                "entry_price": None,
                "exit_price": None,
                "gross_return_pct": None,
                "net_return_pct": None,
                "bars_held": 0,
                "reason": "No next candle exists for a realistic next-open entry.",
            })
            continue

        atr_value = float(atr.iloc[signal_index])
        if not np.isfinite(atr_value) or atr_value <= 0:
            records.append({
                **record,
                "entry_index": entry_index,
                "entry_time": ohlcv.index[entry_index],
                "event": "unresolved",
                "label": None,
                "entry_price": None,
                "exit_price": None,
                "gross_return_pct": None,
                "net_return_pct": None,
                "bars_held": 0,
                "reason": "ATR was unavailable or invalid at signal time.",
            })
            continue

        entry_price = float(ohlcv["Open"].iloc[entry_index])
        if side == "long":
            stop_price = entry_price - atr_value * stop_atr
            target_price = entry_price + atr_value * target_atr
        else:
            stop_price = entry_price + atr_value * stop_atr
            target_price = entry_price - atr_value * target_atr

        outcome = triple_barrier_label(
            ohlcv,
            entry_index=entry_index,
            side=side,
            entry_price=entry_price,
            stop_price=stop_price,
            target_price=target_price,
            max_holding_bars=max_holding_bars,
            fee_rate=fee_rate,
            slippage_bps=slippage_bps,
        )
        records.append({
            **record,
            "entry_time": ohlcv.index[entry_index],
            **outcome.to_dict(),
        })
    return pd.DataFrame(records)


def run_random_entry_baseline(
    ohlcv: pd.DataFrame,
    atr: pd.Series,
    *,
    n_trades: int,
    max_holding_bars: int = 20,
    stop_atr: float = 1.25,
    target_atr: float = 2.2,
    simulations: int = 200,
    seed: int = 42,
    fee_rate: float = 0.0004,
    slippage_bps: float = 2.0,
) -> dict:
    """Randomize entry timing and direction with matching ATR-based barriers.

    ATR is read from the preceding bar and entries are filled at the next open.
    Within each simulation trades do not overlap. This benchmark is a diagnostic,
    not a substitute for benchmark portfolios and out-of-sample evaluation.
    """
    missing = {"Open", "High", "Low", "Close"}.difference(ohlcv.columns)
    if missing:
        raise ValueError(f"Missing OHLC columns: {', '.join(sorted(missing))}.")
    if n_trades < 1 or simulations < 1 or max_holding_bars < 1:
        raise ValueError("n_trades, simulations, and max_holding_bars must be positive.")
    if stop_atr <= 0 or target_atr <= 0:
        raise ValueError("stop_atr and target_atr must be positive.")
    if not ohlcv.index.equals(atr.index):
        raise ValueError("ATR index must exactly match the OHLCV index.")

    candidates = np.arange(1, len(ohlcv) - max_holding_bars + 1)
    candidates = np.asarray(
        [i for i in candidates if np.isfinite(float(atr.iloc[i - 1])) and float(atr.iloc[i - 1]) > 0],
        dtype=int,
    )
    if n_trades > len(candidates):
        raise ValueError(f"Requested {n_trades} trades, but only {len(candidates)} eligible entry bars exist.")

    rng = np.random.default_rng(seed)
    simulation_means: list[float] = []
    pooled_returns: list[float] = []
    for _ in range(simulations):
        order = rng.permutation(candidates)
        chosen: list[int] = []
        for candidate in order:
            position = int(candidate)
            # Check separation from every selected entry, independent of draw order.
            if all(abs(position - selected) >= max_holding_bars for selected in chosen):
                chosen.append(position)
            if len(chosen) == n_trades:
                break
        if len(chosen) < n_trades:
            raise ValueError("Not enough non-overlapping bars; reduce trades or holding time.")

        returns: list[float] = []
        for position in sorted(chosen):
            side: Side = "long" if rng.integers(0, 2) == 0 else "short"
            entry = float(ohlcv["Open"].iloc[position])
            current_atr = float(atr.iloc[position - 1])
            if side == "long":
                stop, target = entry - current_atr * stop_atr, entry + current_atr * target_atr
            else:
                stop, target = entry + current_atr * stop_atr, entry - current_atr * target_atr
            result = triple_barrier_label(
                ohlcv, entry_index=position, side=side, entry_price=entry,
                stop_price=stop, target_price=target, max_holding_bars=max_holding_bars,
                fee_rate=fee_rate, slippage_bps=slippage_bps,
            )
            if result.net_return_pct is not None:
                returns.append(result.net_return_pct)
        if len(returns) != n_trades:
            raise RuntimeError("Baseline unexpectedly produced unresolved trades.")
        simulation_means.append(float(np.mean(returns)))
        pooled_returns.extend(returns)

    values = np.asarray(simulation_means, dtype=float)
    return {
        "method": "seeded random entry and random direction; non-overlapping trades",
        "seed": seed,
        "simulations": simulations,
        "trades_per_simulation": n_trades,
        "holding_bars": max_holding_bars,
        "mean_expectancy_pct": float(values.mean()),
        "median_expectancy_pct": float(np.median(values)),
        "p05_expectancy_pct": float(np.quantile(values, 0.05)),
        "p95_expectancy_pct": float(np.quantile(values, 0.95)),
        "probability_positive_expectancy": float(np.mean(values > 0.0)),
        "simulation_expectancies_pct": values.tolist(),
        "pooled_trade_returns_pct": pooled_returns,
    }


def compare_strategy_to_random(
    strategy_net_returns_pct: list[float] | np.ndarray,
    baseline: dict,
) -> dict:
    """Compare observed mean return with the random benchmark distribution."""
    strategy = np.asarray(strategy_net_returns_pct, dtype=float)
    strategy = strategy[np.isfinite(strategy)]
    random_means = np.asarray(baseline["simulation_expectancies_pct"], dtype=float)
    if strategy.size == 0 or random_means.size == 0:
        raise ValueError("Strategy returns and baseline simulations must be non-empty.")
    observed = float(strategy.mean())
    p95 = float(np.quantile(random_means, 0.95))
    return {
        "strategy_trade_count": int(strategy.size),
        "strategy_mean_net_return_pct": observed,
        "random_mean_expectancy_pct": float(random_means.mean()),
        "random_95th_percentile_pct": p95,
        "strategy_beats_random_95th_percentile": bool(observed > p95),
        "fraction_random_runs_at_or_below_strategy": float(np.mean(random_means <= observed)),
        "interpretation": (
            "Strategy mean exceeded the 95th percentile of this seeded random benchmark."
            if observed > p95
            else "No evidence of outperformance versus this random benchmark in this comparison."
        ),
    }
