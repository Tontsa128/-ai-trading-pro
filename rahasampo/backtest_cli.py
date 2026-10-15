"""Command-line offline backtesting for timestamped signal candidates.

OHLCV timestamps are candle open times in UTC. A signal timestamp must match
the candle that generated it; simulated entries occur at the next candle open.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import numpy as np
import pandas as pd

from .backtest import backtest_signal_candidates
from .data_quality import TIMEFRAME_SECONDS, select_closed_candles, validate_ohlcv
from .triple_barrier import compare_strategy_to_random, run_random_entry_baseline


def read_ohlcv_csv(path: str | Path, *, timeframe: str, min_rows: int = 30) -> pd.DataFrame:
    frame = pd.read_csv(path)
    normalized = {str(column).strip().lower(): column for column in frame.columns}
    timestamp_column = next(
        (normalized[key] for key in ("timestamp", "datetime", "date", "time") if key in normalized),
        None,
    )
    if timestamp_column is None:
        raise ValueError("OHLCV CSV must include a timestamp, datetime, date, or time column.")

    column_map: dict[str, str] = {}
    for required in ("open", "high", "low", "close", "volume"):
        if required not in normalized:
            raise ValueError(f"OHLCV CSV is missing the {required} column.")
        column_map[normalized[required]] = required.title()

    parsed_time = pd.to_datetime(frame[timestamp_column], utc=True, errors="coerce")
    if parsed_time.isna().any():
        raise ValueError("OHLCV CSV contains invalid timestamps.")
    ohlcv = frame[list(column_map)].rename(columns=column_map)
    for column in ("Open", "High", "Low", "Close", "Volume"):
        ohlcv[column] = pd.to_numeric(ohlcv[column], errors="coerce")
    ohlcv.index = pd.DatetimeIndex(parsed_time, name="Date")
    if ohlcv.index.has_duplicates:
        raise ValueError("OHLCV CSV contains duplicate timestamps.")
    if not ohlcv.index.is_monotonic_increasing:
        raise ValueError("OHLCV CSV must be in chronological order; rows are not silently reordered.")

    valid, errors = validate_ohlcv(ohlcv, min_rows=min_rows)
    if not valid:
        raise ValueError("Invalid OHLCV CSV: " + "; ".join(errors))

    interval = TIMEFRAME_SECONDS.get(timeframe)
    if interval is None:
        raise ValueError(f"Unsupported timeframe: {timeframe}.")
    interval_ns = interval * 1_000_000_000
    timestamp_ns = ohlcv.index.to_numpy(dtype="datetime64[ns]").astype("int64")
    if timestamp_ns.size and (timestamp_ns % interval_ns != 0).any():
        raise ValueError("OHLCV timestamps must align to UTC candle-open boundaries for the selected timeframe.")
    gaps = ohlcv.index.to_series().diff().dt.total_seconds().dropna()
    if (gaps > interval * 2.5).any():
        raise ValueError("OHLCV CSV has missing candle intervals exceeding 2.5 bars.")
    return ohlcv


def read_signal_candidates_csv(path: str | Path, ohlcv: pd.DataFrame) -> list[dict]:
    signals = pd.read_csv(path)
    normalized = {str(column).strip().lower(): column for column in signals.columns}
    timestamp_column = next(
        (normalized[key] for key in ("timestamp", "datetime", "date", "time") if key in normalized),
        None,
    )
    if timestamp_column is None or "side" not in normalized:
        raise ValueError("Signal CSV must include timestamp and side columns.")

    timestamps = pd.to_datetime(signals[timestamp_column], utc=True, errors="coerce")
    if timestamps.isna().any():
        raise ValueError("Signal CSV contains invalid timestamps.")
    sides = signals[normalized["side"]].astype(str).str.strip().str.lower()
    if not sides.isin(["long", "short"]).all():
        raise ValueError("Signal side values must be long or short.")
    if timestamps.duplicated().any():
        raise ValueError("Signal CSV contains duplicate timestamps.")

    index_positions = {timestamp: position for position, timestamp in enumerate(ohlcv.index)}
    candidates: list[dict] = []
    for timestamp, side in zip(timestamps, sides, strict=True):
        if timestamp not in index_positions:
            raise ValueError(f"Signal timestamp {timestamp.isoformat()} does not exactly match an OHLCV candle.")
        candidates.append({"signal_index": index_positions[timestamp], "side": side})
    return sorted(candidates, key=lambda candidate: candidate["signal_index"])


def calculate_atr(ohlcv: pd.DataFrame, period: int = 14) -> pd.Series:
    previous_close = ohlcv["Close"].shift(1)
    true_range = pd.concat(
        [
            ohlcv["High"] - ohlcv["Low"],
            (ohlcv["High"] - previous_close).abs(),
            (ohlcv["Low"] - previous_close).abs(),
        ],
        axis=1,
    ).max(axis=1)
    return true_range.rolling(period, min_periods=period).mean()


def run_cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline Rahasampo candidate backtest")
    parser.add_argument("--ohlcv", required=True, help="CSV: timestamp,open,high,low,close,volume")
    parser.add_argument("--signals", required=True, help="CSV: timestamp,side (long or short)")
    parser.add_argument("--symbol", default="", help="Optional instrument label for the report")
    parser.add_argument("--timeframe", default="1m", choices=sorted(TIMEFRAME_SECONDS))
    parser.add_argument("--max-holding-bars", type=int, default=20)
    parser.add_argument("--stop-atr", type=float, default=1.25)
    parser.add_argument("--target-atr", type=float, default=2.2)
    parser.add_argument("--fee-rate", type=float, default=0.001, help="Fee fraction per side (default 0.001 = 0.10%; verify the account fee tier)")
    parser.add_argument("--slippage-bps", type=float, default=5.0, help="Adverse slippage per fill in basis points (default: 5)")
    parser.add_argument("--simulations", type=int, default=200)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--trades-out", default="backtest_trades.csv")
    parser.add_argument("--report-out", default="backtest_report.json")
    args = parser.parse_args(argv)

    try:
        historical = read_ohlcv_csv(args.ohlcv, timeframe=args.timeframe)
        historical = select_closed_candles(historical, args.timeframe)
        if len(historical) < 30:
            raise ValueError("Fewer than 30 fully closed candles remain after filtering.")

        candidates = read_signal_candidates_csv(args.signals, historical)
        if not candidates:
            raise ValueError("Signal CSV contains no candidates.")
        atr = calculate_atr(historical)
        trades, report = backtest_signal_candidates(
            historical, atr, candidates,
            max_holding_bars=args.max_holding_bars,
            stop_atr=args.stop_atr,
            target_atr=args.target_atr,
            fee_rate=args.fee_rate,
            slippage_bps=args.slippage_bps,
            seed=args.seed,
        )

        accepted_returns = (
            trades.loc[trades["accepted"], "net_return_pct"].dropna().astype(float).tolist()
            if not trades.empty else []
        )
        baseline_summary: dict = {"available": False}
        if accepted_returns:
            try:
                accepted_sides = trades.loc[trades["accepted"], "side"].astype(str).str.lower()
                long_probability = float((accepted_sides == "long").mean())
                baseline = run_random_entry_baseline(
                    historical, atr,
                    n_trades=len(accepted_returns),
                    max_holding_bars=args.max_holding_bars,
                    stop_atr=args.stop_atr,
                    target_atr=args.target_atr,
                    simulations=args.simulations,
                    seed=args.seed,
                    fee_rate=args.fee_rate,
                    slippage_bps=args.slippage_bps,
                    long_probability=long_probability,
                )
                comparison = compare_strategy_to_random(accepted_returns, baseline)
                baseline_summary = {
                    "available": True,
                    "benchmark": baseline["method"],
                    "simulations": baseline["simulations"],
                    "trades_per_simulation": baseline["trades_per_simulation"],
                    "long_probability": baseline["long_probability"],
                    "mean_expectancy_pct": baseline["mean_expectancy_pct"],
                    "p05_expectancy_pct": baseline["p05_expectancy_pct"],
                    "median_expectancy_pct": baseline["median_expectancy_pct"],
                    "p95_expectancy_pct": baseline["p95_expectancy_pct"],
                    "probability_positive_expectancy": baseline["probability_positive_expectancy"],
                    "comparison": comparison,
                }
            except (ValueError, RuntimeError) as exc:
                baseline_summary = {"available": False, "reason": str(exc)}

        report_payload = {
            "research_only": True,
            "instrument": args.symbol or Path(args.ohlcv).stem,
            "timeframe": args.timeframe,
            "input_signal_count": len(candidates),
            "strategy": report.to_dict(),
            "random_baseline": baseline_summary,
            "settings": {
                "max_holding_bars": args.max_holding_bars,
                "stop_atr": args.stop_atr,
                "target_atr": args.target_atr,
                "fee_rate_per_side": args.fee_rate,
                "slippage_bps_per_side": args.slippage_bps,
                "seed": args.seed,
            },
            "limitations": [
                "Results depend on the quality and venue of the supplied historical data.",
                "The random benchmark is diagnostic, not proof of profitability.",
                "No live orders are sent by this tool.",
                "Short-side returns are simplified directional PnL; borrow, margin, funding, liquidation and venue-specific short rules are not modeled.",
            ],
        }
        Path(args.trades_out).parent.mkdir(parents=True, exist_ok=True)
        Path(args.report_out).parent.mkdir(parents=True, exist_ok=True)
        trades.to_csv(args.trades_out, index=False)
        Path(args.report_out).write_text(
            json.dumps(report_payload, indent=2, ensure_ascii=False, default=str),
            encoding="utf-8",
        )
        print(json.dumps(report_payload, indent=2, ensure_ascii=False, default=str))
        return 0
    except (OSError, ValueError, KeyError) as exc:
        print(f"Backtest input/error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(run_cli())
