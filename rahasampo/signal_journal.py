"""Persistent, idempotent journal for closed-candle decisions."""
from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import sqlite3
from typing import Any

DEFAULT_JOURNAL_PATH = os.environ.get("RAHASAMPO_SIGNAL_JOURNAL", "signal_journal.sqlite")
CANDIDATE_TYPES = ("BUY_CANDIDATE", "SELL_CANDIDATE")


def utc_timestamp(value: Any) -> str:
    import pandas as pd

    timestamp = pd.Timestamp(value)
    if timestamp.tzinfo is None:
        raise ValueError("Candle timestamp must be timezone-aware.")
    return timestamp.tz_convert("UTC").isoformat()


def make_signal_id(symbol: str, timeframe: str, candle_time: Any, strategy_version: str = "v27") -> str:
    parts = (symbol.strip().upper(), timeframe.strip(), utc_timestamp(candle_time), strategy_version)
    if not parts[0] or not parts[1]:
        raise ValueError("Symbol and timeframe must be non-empty.")
    return hashlib.sha256("|".join(parts).encode("utf-8")).hexdigest()


def _connect(path: str | Path | None = None) -> sqlite3.Connection:
    db_path = Path(path or DEFAULT_JOURNAL_PATH)
    if str(db_path) != ":memory:":
        db_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(str(db_path), timeout=5.0)
    connection.execute("PRAGMA busy_timeout = 5000")
    connection.execute(
        """
        CREATE TABLE IF NOT EXISTS signal_journal (
            signal_id TEXT PRIMARY KEY,
            evaluated_at_utc TEXT NOT NULL,
            candle_time_utc TEXT NOT NULL,
            symbol TEXT NOT NULL,
            timeframe TEXT NOT NULL,
            strategy_version TEXT NOT NULL,
            decision_type TEXT NOT NULL,
            level TEXT NOT NULL,
            score INTEGER NOT NULL,
            price REAL,
            stop REAL,
            target REAL,
            rr REAL,
            bias TEXT,
            structure TEXT,
            triangle TEXT,
            data_source TEXT,
            rejection_reasons_json TEXT NOT NULL,
            snapshot_json TEXT NOT NULL,
            UNIQUE(symbol, timeframe, candle_time_utc, strategy_version)
        )
        """
    )
    connection.execute(
        "CREATE INDEX IF NOT EXISTS idx_signal_journal_day "
        "ON signal_journal(symbol, timeframe, candle_time_utc, decision_type)"
    )
    return connection


def decision_type_for_level(level: str) -> str:
    if "TARKKAILU OSTA" in level:
        return "WATCH_LONG"
    if "TARKKAILU MYY" in level:
        return "WATCH_SHORT"
    if level in ("OSTA", "VAHVA OSTA"):
        return "BUY_CANDIDATE"
    if level in ("MYY", "VAHVA MYY"):
        return "SELL_CANDIDATE"
    if "EI TREIDIÄ" in level:
        return "NO_TRADE"
    return "WAIT"


def record_decision(
    *,
    symbol: str,
    timeframe: str,
    candle_time: Any,
    decision: dict,
    data_source: str,
    journal_path: str | Path | None = None,
    strategy_version: str = "v27",
) -> bool:
    """Insert one immutable decision per symbol/timeframe/closed candle.

    Repeated Streamlit reruns cannot create duplicate rows for the same candle.
    Returns True only when a new record was inserted.
    """
    candle_utc = utc_timestamp(candle_time)
    signal_id = make_signal_id(symbol, timeframe, candle_utc, strategy_version)
    evaluated_at = datetime.now(timezone.utc).isoformat()
    level = str(decision.get("level", "EI TREIDIÄ"))
    decision_type = decision_type_for_level(level)
    notes = decision.get("notes", [])
    if not isinstance(notes, list):
        notes = [str(notes)]
    snapshot = {
        "level": level,
        "score": int(decision.get("score", 0)),
        "price": decision.get("price"),
        "stop": decision.get("stop"),
        "target": decision.get("target"),
        "rr": decision.get("rr"),
        "bias": decision.get("bias"),
        "structure": decision.get("structure"),
        "triangle": decision.get("triangle"),
        "direction": decision.get("direction"),
        "notes": notes,
        "details": decision.get("details", {}),
    }

    with _connect(journal_path) as connection:
        cursor = connection.execute(
            """
            INSERT OR IGNORE INTO signal_journal (
                signal_id, evaluated_at_utc, candle_time_utc, symbol, timeframe,
                strategy_version, decision_type, level, score, price, stop, target, rr,
                bias, structure, triangle, data_source, rejection_reasons_json, snapshot_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                signal_id, evaluated_at, candle_utc, symbol.strip().upper(), timeframe,
                strategy_version, decision_type, level, int(decision.get("score", 0)),
                decision.get("price"), decision.get("stop"), decision.get("target"),
                decision.get("rr"), decision.get("bias"), decision.get("structure"),
                decision.get("triangle"), data_source,
                json.dumps(notes, ensure_ascii=False, default=str),
                json.dumps(snapshot, ensure_ascii=False, default=str),
            ),
        )
        return cursor.rowcount == 1


def candidate_history(
    *,
    symbol: str,
    timeframe: str,
    candle_time: Any,
    journal_path: str | Path | None = None,
) -> tuple[int, str | None]:
    """Return candidate count for the candle's UTC day and latest earlier candidate."""
    candle_utc = utc_timestamp(candle_time)
    day_start = candle_utc[:10] + "T00:00:00+00:00"
    query = """
        SELECT candle_time_utc FROM signal_journal
        WHERE symbol = ? AND timeframe = ?
          AND decision_type IN (?, ?)
          AND candle_time_utc >= ? AND candle_time_utc < ?
        ORDER BY candle_time_utc ASC
    """
    with _connect(journal_path) as connection:
        rows = connection.execute(
            query,
            (symbol.strip().upper(), timeframe, *CANDIDATE_TYPES, day_start, candle_utc),
        ).fetchall()
        previous = connection.execute(
            """
            SELECT candle_time_utc FROM signal_journal
            WHERE symbol = ? AND timeframe = ?
              AND decision_type IN (?, ?) AND candle_time_utc < ?
            ORDER BY candle_time_utc DESC LIMIT 1
            """,
            (symbol.strip().upper(), timeframe, *CANDIDATE_TYPES, candle_utc),
        ).fetchone()
    last = previous[0] if previous else None
    return len(rows), last


def journal_counts(*, journal_path: str | Path | None = None) -> dict[str, int]:
    with _connect(journal_path) as connection:
        rows = connection.execute(
            "SELECT decision_type, COUNT(*) FROM signal_journal GROUP BY decision_type"
        ).fetchall()
    return {str(kind): int(count) for kind, count in rows}
