#!/usr/bin/env python3
"""Decision journal: record what was done with each briefed action, then score it.

The calibration ledger measures whether *forecasts* were right; this journal
measures whether *decisions* were good. Every decision brief action can be
marked DONE or SKIPPED with a note; entries that carry a symbol also record
the price at decision time, so later briefs can show the counterfactual
("the CONDITION_CHECK you skipped is +8.2% since").

Storage is an append-only JSONL file in the state directory. Entries are
never rewritten; corrections are new entries.
"""

from __future__ import annotations

import datetime as dt
import json
import os
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

CONTRACT_TYPE: str = "serenity_decision_log_entry"
SCHEMA_VERSION: str = "1.0"
DECISIONS: set[str] = {"DONE", "SKIPPED"}


def _text(value: Any) -> str:
    return str(value or "").strip()


def state_dir() -> Path:
    override: Optional[str] = os.getenv("SERENITY_STATE_DIR")
    if override:
        return Path(override).expanduser()
    base: Path = Path(os.getenv("SERENITY_DATA_DIR", str(Path.home() / ".cache" / "serenity-chan"))).expanduser()
    return base / "state"


def log_path() -> Path:
    return state_dir() / "decision_log.jsonl"


def build_entry(
    *,
    action: Mapping[str, Any],
    decision: str,
    note: str = "",
    brief_generated_at: str = "",
    price_at_decision: Optional[float] = None,
) -> dict[str, Any]:
    if decision not in DECISIONS:
        raise ValueError(f"decision must be one of {sorted(DECISIONS)}")
    if not _text(action.get("kind")) or not _text(action.get("title")):
        raise ValueError("action must carry kind and title")
    entry: dict[str, Any] = {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "decided_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "brief_generated_at": _text(brief_generated_at),
        "decision": decision,
        "note": _text(note),
        "action_kind": _text(action.get("kind")),
        "action_title": _text(action.get("title")),
        "action_command": _text(action.get("command")),
        "symbol": _text(action.get("symbol")),
    }
    if price_at_decision is not None:
        entry["price_at_decision"] = float(price_at_decision)
    return entry


def validate_entry(entry: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if entry.get("contract_type") != CONTRACT_TYPE:
        errors.append(f"contract_type must be {CONTRACT_TYPE}")
    if entry.get("decision") not in DECISIONS:
        errors.append(f"decision must be one of {sorted(DECISIONS)}")
    for key in ["decided_at", "action_kind", "action_title"]:
        if not _text(entry.get(key)):
            errors.append(f"{key} must not be empty")
    price: Any = entry.get("price_at_decision")
    if price is not None and (not isinstance(price, (int, float)) or price <= 0):
        errors.append("price_at_decision must be a positive number when present")
    return errors


def append_entry(entry: Mapping[str, Any], *, path: Optional[Path] = None) -> Path:
    errors: list[str] = validate_entry(entry)
    if errors:
        raise ValueError("; ".join(errors))
    target: Path = path if path is not None else log_path()
    target.parent.mkdir(parents=True, exist_ok=True)
    with target.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return target


def read_entries(*, path: Optional[Path] = None, limit: int = 0) -> list[dict[str, Any]]:
    target: Path = path if path is not None else log_path()
    if not target.exists():
        return []
    entries: list[dict[str, Any]] = []
    for line in target.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            payload: Any = json.loads(line)
        except Exception:
            continue
        if isinstance(payload, dict):
            entries.append(payload)
    return entries[-limit:] if limit and limit > 0 else entries


def scoreboard_rows(
    entries: Sequence[Mapping[str, Any]],
    current_prices: Mapping[str, Any],
    *,
    limit: int = 10,
) -> list[dict[str, Any]]:
    """Latest decisions with the counterfactual price move since decision time.

    `since_pct` is signed price change since the decision was recorded; for a
    SKIPPED action a strongly positive value means the skip was costly, for a
    DONE action it means the follow-through paid. Interpretation stays with
    the reader — this table only states what happened.
    """
    rows: list[dict[str, Any]] = []
    for entry in list(entries)[-limit:]:
        symbol: str = _text(entry.get("symbol"))
        price_then: Any = entry.get("price_at_decision")
        price_now: Any = current_prices.get(symbol) if symbol else None
        since_pct: Optional[float] = None
        if (
            isinstance(price_then, (int, float)) and price_then > 0
            and isinstance(price_now, (int, float)) and price_now > 0
        ):
            since_pct = round((float(price_now) - float(price_then)) / float(price_then) * 100.0, 2)
        rows.append({
            "decided_at": _text(entry.get("decided_at"))[:10],
            "decision": _text(entry.get("decision")),
            "action_kind": _text(entry.get("action_kind")),
            "symbol": symbol,
            "note": _text(entry.get("note"))[:40],
            "price_at_decision": price_then if isinstance(price_then, (int, float)) else None,
            "current_price": price_now if isinstance(price_now, (int, float)) else None,
            "since_pct": since_pct,
        })
    rows.reverse()
    return rows
