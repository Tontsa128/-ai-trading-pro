"""End-to-end historical backtest using the actual V27 scoring engine.

Input OHLCV timestamps must be UTC candle-open times. Every signal is evaluated
at candle close and the simulator enters no earlier than the next candle open.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

import numpy as np
import pandas as pd

from .backtest import backtest_signal_candidates
from .backtest_cli import calculate_atr, read_ohlcv_csv
from .data_quality import select_closed_candles
from .strategy_replay import generate_strategy_candidates
from .triple_barrier import compare_strategy_to_random, run_random_entry_baseline


def run_cli(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Offline backtest using Rahasampo's V27 strategy")
    parser.add_argument("--ohlcv", required=True, help="CSV: timestamp,open,high,low,close,volume (UTC candle-open times)")
    parser.add_argument("--symbol", default="BTCUSDT")
    parser.add_argument("--timeframe", default="1m", choices=["1m", "3m", "5m", "15m"])
    parser.add_argument("--window-bars", type=int, default=420, help="Signal engine lookback; default matches app's initial data window")
    parser.add_argument("--paper-equity", type=float, default=1000.0, help="Simulated quote-currency equity, not a real account balance")
    parser.add_argument("--risk-fraction", type=float, default=0.005, help="Risk budget fraction per trade, default 0.005 = 0.5%%")
    parser.add_argument("--fee-rate", type=float, default=0.001, help="Fee fraction per side; default 0.001 = 0.10%%")
    parser.add_argument("--slippage-bps", type=float, default=5.0, help="Adverse slippage per fill, in basis points")
    parser.add_argument("--minimum-net-rr", type=float, default=1.2, help="Minimum modeled net reward/risk ratio")
    parser.add_argument("--cooldown-bars", type=int, default=3)
    parser.add_argument("--daily-signal-limit", type=int, default=8)
    parser.add_argument("--max-holding-bars", type=int, default=20)
    parser.add_argument("--stop-atr", type=float, default=1.25)
    parser.add_argument("--target-atr", type=float, default=2.2)
    parser.add_argument("--simulations", type=int, default=200)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument("--signals-out", default="strategy_signals.csv")
    parser.add_argument("--trades-out", default="strategy_trades.csv")
    parser.add_argument("--report-out", default="strategy_report.json")
    args = parser.parse_args(argv)

    try:
        history = read_ohlcv_csv(args.ohlcv, timeframe=args.timeframe, min_rows=120)
        history = select_closed_candles(history, args.timeframe)
        if len(history) < 120:
            raise ValueError("Fewer than 120 fully closed candles remain after filtering.")

        candidates, audit, diagnostics = generate_strategy_candidates(
            history,
            timeframe=args.timeframe,
            symbol=args.symbol,
            window_bars=args.window_bars,
            paper_equity=args.paper_equity,
            risk_fraction=args.risk_fraction,
            fee_rate=args.fee_rate,
            slippage_bps=args.slippage_bps,
            minimum_net_reward_risk_ratio=args.minimum_net_rr,
            cooldown_bars=args.cooldown_bars,
            daily_signal_limit=args.daily_signal_limit,
        )
        atr = calculate_atr(history)
        trades, report = backtest_signal_candidates(
            history,
            atr,
            candidates,
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
        baseline: dict = {"available": False, "reason": "Need at least 10 resolved trades for even a preliminary random benchmark."}
        if len(accepted_returns) >= 10:
            try:
                accepted_sides = trades.loc[trades["accepted"], "side"].astype(str).str.lower()
                long_probability = float((accepted_sides == "long").mean())
                sampled = run_random_entry_baseline(
                    history,
                    atr,
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
                baseline = {
                    "available": True,
                    "benchmark": sampled["method"],
                    "simulations": sampled["simulations"],
                    "trades_per_simulation": sampled["trades_per_simulation"],
                    "long_probability": sampled["long_probability"],
                    "mean_expectancy_pct": sampled["mean_expectancy_pct"],
                    "p05_expectancy_pct": sampled["p05_expectancy_pct"],
                    "median_expectancy_pct": sampled["median_expectancy_pct"],
                    "p95_expectancy_pct": sampled["p95_expectancy_pct"],
                    "probability_positive_expectancy": sampled["probability_positive_expectancy"],
                    "comparison": compare_strategy_to_random(accepted_returns, sampled),
                }
            except (ValueError, RuntimeError) as exc:
                baseline = {"available": False, "reason": str(exc)}

        report_payload = {
            "research_only": True,
            "instrument": args.symbol,
            "timeframe": args.timeframe,
            "source_rows_after_closed_candle_filter": len(history),
            "replay_diagnostics": diagnostics.to_dict(),
            "backtest": report.to_dict(),
            "random_baseline": baseline,
            "settings": {
                "window_bars": args.window_bars,
                "paper_equity": args.paper_equity,
                "risk_fraction": args.risk_fraction,
                "fee_rate_per_side": args.fee_rate,
                "slippage_bps_per_fill": args.slippage_bps,
                "minimum_net_reward_risk_ratio": args.minimum_net_rr,
                "cooldown_bars": args.cooldown_bars,
                "daily_signal_limit": args.daily_signal_limit,
                "max_holding_bars": args.max_holding_bars,
                "stop_atr": args.stop_atr,
                "target_atr": args.target_atr,
                "simulations": args.simulations,
                "seed": args.seed,
            },
            "limitations": [
                "This uses the same pure scoring functions as the live UI, but it is still a research replay, not proof of a profitable edge.",
                "Higher-timeframe OHLCV is reconstructed from the provided base-timeframe candles; timeframes not divisible by the base are marked unavailable. Validate the replay against exported live signals before relying on it.",
                "EMA/RSI startup state can differ slightly because historical indicators are prepared causally over the supplied file; the app normally receives a rolling window.",
                "Execution uses next-candle open in simulation; real spread, queue priority, latency, partial fills and stop gaps can materially change returns.",
                "Spot data cannot faithfully simulate futures, borrow fees, funding, liquidation, margin or exchange-specific short rules.",
                "No live orders are placed.",
            ],
        }

        for destination in (args.signals_out, args.trades_out, args.report_out):
            Path(destination).parent.mkdir(parents=True, exist_ok=True)
        audit.to_csv(args.signals_out, index=False)
        trades.to_csv(args.trades_out, index=False)
        Path(args.report_out).write_text(
            json.dumps(report_payload, indent=2, ensure_ascii=False, default=str),
            encoding="utf-8",
        )
        print(json.dumps(report_payload, indent=2, ensure_ascii=False, default=str))
        return 0
    except (OSError, ValueError, KeyError, RuntimeError, IndexError) as exc:
        print(f"Strategy backtest input/error: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(run_cli())
