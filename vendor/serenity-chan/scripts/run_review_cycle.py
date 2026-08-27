#!/usr/bin/env python3
"""Build due review tasks from a Serenity watchlist."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:
    from update_watchlist_from_report import summarize_watchlist_items, validate_watchlist
except ModuleNotFoundError:  # pragma: no cover
    from scripts.update_watchlist_from_report import summarize_watchlist_items, validate_watchlist


CONTRACT_TYPE: str = "serenity_review_cycle"
SCHEMA_VERSION: str = "1.0"
OUTCOME_CONTRACT_TYPE: str = "serenity_review_outcome"
HORIZON_DAYS: dict[str, int] = {"30d": 30, "90d": 90, "180d": 180}
WATCH_STATES: set[str] = {"ACTION_CANDIDATE", "EVIDENCE_FIRST", "WAIT_FOR_BUY_POINT", "WATCHLIST", "REMOVED"}
JUDGMENT_DELTAS: set[str] = {"CONFIRMED", "WEAKENED", "BROKEN", "UPGRADED", "UNCHANGED"}
ACTION_DELTAS: set[str] = {"HOLD_WATCH", "UPGRADE_WATCH", "DOWNGRADE_WATCH", "ACTION_READY", "REMOVE"}


def _load_json(path: Path) -> Mapping[str, Any]:
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _parse_datetime(value: Any) -> dt.datetime:
    text: str = _text(value)
    if not text:
        raise ValueError("datetime value is empty")
    normalized: str = text.replace("Z", "+00:00")
    parsed = dt.datetime.fromisoformat(normalized)
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.timezone.utc)
    return parsed.astimezone(dt.timezone.utc)


def _parse_due_before(value: str) -> dt.datetime:
    if value.lower() == "today":
        now = dt.datetime.now(dt.timezone.utc)
        return dt.datetime(now.year, now.month, now.day, 23, 59, 59, tzinfo=dt.timezone.utc)
    parsed = dt.date.fromisoformat(value)
    return dt.datetime(parsed.year, parsed.month, parsed.day, 23, 59, 59, tzinfo=dt.timezone.utc)


def _history_by_horizon(row: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    history: dict[str, Mapping[str, Any]] = {}
    for item in _as_list(row.get("history")):
        if not isinstance(item, Mapping):
            continue
        horizon: str = _text(item.get("horizon"))
        try:
            reviewed_at: dt.datetime = _parse_datetime(item.get("reviewed_at"))
        except ValueError:
            continue
        if horizon not in HORIZON_DAYS:
            continue
        current: Mapping[str, Any] = history.get(horizon, {})
        try:
            current_reviewed_at: dt.datetime = _parse_datetime(current.get("reviewed_at"))
        except ValueError:
            current_reviewed_at = dt.datetime.min.replace(tzinfo=dt.timezone.utc)
        if not current or reviewed_at >= current_reviewed_at:
            history[horizon] = item
    return history


def _review_due_date(
    *,
    generated_at: dt.datetime,
    days: int,
    history_item: Mapping[str, Any],
) -> dt.datetime:
    next_review_date: str = _text(history_item.get("next_review_date"))
    if next_review_date:
        parsed = dt.date.fromisoformat(next_review_date[:10])
        return dt.datetime(parsed.year, parsed.month, parsed.day, 23, 59, 59, tzinfo=dt.timezone.utc)
    return generated_at + dt.timedelta(days=days)


def build_review_cycle(watchlist: Mapping[str, Any], *, due_before: str, source_watchlist_path: str = "") -> dict[str, Any]:
    errors: list[str] = validate_watchlist(watchlist)
    if errors:
        raise ValueError("; ".join(errors))
    generated_at: dt.datetime = _parse_datetime(watchlist.get("generated_at"))
    cutoff: dt.datetime = _parse_due_before(due_before)
    due_items: list[dict[str, Any]] = []
    for item in _as_list(watchlist.get("items")):
        row: Mapping[str, Any] = item if isinstance(item, Mapping) else {}
        if row.get("removed") is True:
            continue
        triggers: Mapping[str, Any] = _as_mapping(row.get("triggers"))
        history = _history_by_horizon(row)
        for horizon, days in HORIZON_DAYS.items():
            due_date: dt.datetime = _review_due_date(
                generated_at=generated_at,
                days=days,
                history_item=history.get(horizon, {}),
            )
            tasks: list[str] = [str(task) for task in _as_list(triggers.get(horizon)) if str(task).strip()]
            if due_date <= cutoff and tasks:
                due_items.append({
                    "symbol": _text(row.get("symbol")),
                    "name": _text(row.get("name")),
                    "watch_state": _text(row.get("watch_state")),
                    "horizon": horizon,
                    "due_date": due_date.date().isoformat(),
                    "review_tasks": tasks,
                    "upgrade_conditions": [str(task) for task in _as_list(row.get("upgrade_conditions")) if str(task).strip()],
                    "downgrade_conditions": [str(task) for task in _as_list(row.get("downgrade_conditions")) if str(task).strip()],
                    "next_evidence": [str(task) for task in _as_list(row.get("next_evidence")) if str(task).strip()],
                })
    due_items.sort(key=lambda row: (row["due_date"], row["symbol"], row["horizon"]))
    return {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "due_before": cutoff.date().isoformat(),
        "source_watchlist_path": source_watchlist_path,
        "summary": {
            "due_count": len(due_items),
            "symbols_due": sorted({row["symbol"] for row in due_items}),
            "horizons_due": sorted({row["horizon"] for row in due_items}, key=lambda key: HORIZON_DAYS[key]),
        },
        "due_items": due_items,
    }


def validate_review_cycle(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != CONTRACT_TYPE:
        errors.append(f"contract_type must be {CONTRACT_TYPE}")
    if payload.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    summary: Mapping[str, Any] = _as_mapping(payload.get("summary"))
    due_items: list[Any] = _as_list(payload.get("due_items"))
    if summary.get("due_count") != len(due_items):
        errors.append("summary.due_count must match due_items length")
    for index, item in enumerate(due_items):
        row: Mapping[str, Any] = item if isinstance(item, Mapping) else {}
        if not row:
            errors.append(f"due_items[{index}] must be an object")
            continue
        for key in ["symbol", "watch_state", "horizon", "due_date"]:
            if not _text(row.get(key)):
                errors.append(f"due_items[{index}].{key} must not be empty")
        if row.get("horizon") not in HORIZON_DAYS:
            errors.append(f"due_items[{index}].horizon is invalid")
        if not _as_list(row.get("review_tasks")):
            errors.append(f"due_items[{index}].review_tasks must not be empty")
    return errors


def validate_review_outcome(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != OUTCOME_CONTRACT_TYPE:
        errors.append(f"contract_type must be {OUTCOME_CONTRACT_TYPE}")
    if payload.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    if not _text(payload.get("reviewed_at")):
        errors.append("reviewed_at must not be empty")
    else:
        try:
            _parse_datetime(payload.get("reviewed_at"))
        except ValueError:
            errors.append("reviewed_at must be an ISO datetime")
    outcomes: list[Any] = _as_list(payload.get("outcomes"))
    if not outcomes:
        errors.append("outcomes must not be empty")
    seen: set[tuple[str, str]] = set()
    for index, item in enumerate(outcomes):
        row: Mapping[str, Any] = item if isinstance(item, Mapping) else {}
        if not row:
            errors.append(f"outcomes[{index}] must be an object")
            continue
        for key in ["symbol", "horizon", "judgment_delta", "action_delta", "next_state", "next_review_date"]:
            if not _text(row.get(key)):
                errors.append(f"outcomes[{index}].{key} must not be empty")
        if row.get("horizon") not in HORIZON_DAYS:
            errors.append(f"outcomes[{index}].horizon is invalid")
        if row.get("judgment_delta") not in JUDGMENT_DELTAS:
            errors.append(f"outcomes[{index}].judgment_delta is invalid")
        if row.get("action_delta") not in ACTION_DELTAS:
            errors.append(f"outcomes[{index}].action_delta is invalid")
        if row.get("next_state") not in WATCH_STATES:
            errors.append(f"outcomes[{index}].next_state is invalid")
        if _text(row.get("next_review_date")):
            try:
                dt.date.fromisoformat(_text(row.get("next_review_date"))[:10])
            except ValueError:
                errors.append(f"outcomes[{index}].next_review_date must be an ISO date")
        if not _as_list(row.get("checked_evidence")):
            errors.append(f"outcomes[{index}].checked_evidence must not be empty")
        key: tuple[str, str] = (_text(row.get("symbol")), _text(row.get("horizon")))
        if key in seen:
            errors.append(f"outcomes[{index}] duplicates symbol+horizon")
        seen.add(key)
    return errors


def apply_review_outcome(watchlist: Mapping[str, Any], outcome: Mapping[str, Any]) -> dict[str, Any]:
    watch_errors = validate_watchlist(watchlist)
    outcome_errors = validate_review_outcome(outcome)
    if watch_errors or outcome_errors:
        raise ValueError("; ".join([*watch_errors, *outcome_errors]))
    updated: dict[str, Any] = json.loads(json.dumps(watchlist, ensure_ascii=False))
    reviewed_at: str = _text(outcome.get("reviewed_at"))
    by_symbol: dict[str, dict[str, Any]] = {
        _text(item.get("symbol")): item
        for item in _as_list(updated.get("items"))
        if isinstance(item, dict) and _text(item.get("symbol"))
    }
    missing_symbols: list[str] = [
        _text(raw.get("symbol"))
        for raw in _as_list(outcome.get("outcomes"))
        if isinstance(raw, Mapping) and _text(raw.get("symbol")) not in by_symbol
    ]
    if missing_symbols:
        raise ValueError("review_outcome contains symbols not in watchlist: " + ", ".join(sorted(set(missing_symbols))))

    applied = 0
    for raw in _as_list(outcome.get("outcomes")):
        if not isinstance(raw, Mapping):
            continue
        symbol = _text(raw.get("symbol"))
        item = by_symbol.get(symbol)
        if item is None:
            continue
        history = item.setdefault("history", [])
        history.append({
            "reviewed_at": reviewed_at,
            "horizon": _text(raw.get("horizon")),
            "judgment_delta": _text(raw.get("judgment_delta")),
            "action_delta": _text(raw.get("action_delta")),
            "checked_evidence": [str(value) for value in _as_list(raw.get("checked_evidence")) if str(value).strip()],
            "next_state": _text(raw.get("next_state")),
            "next_review_date": _text(raw.get("next_review_date")),
            "notes": _text(raw.get("notes")),
        })
        item["last_reviewed_at"] = reviewed_at
        item["next_review_due_at"] = _text(raw.get("next_review_date"))
        if _text(raw.get("next_state")) != "REMOVED":
            item["watch_state"] = _text(raw.get("next_state"))
        else:
            item["watch_state"] = "WATCHLIST"
            item["removed"] = True
        applied += 1
    updated["last_reviewed_at"] = reviewed_at
    updated["summary"] = summarize_watchlist_items([
        item for item in _as_list(updated.get("items")) if isinstance(item, Mapping)
    ])
    updated.setdefault("review_summary", {})
    updated["review_summary"] = {
        "applied_count": applied,
        "outcome_count": len(_as_list(outcome.get("outcomes"))),
        "source_reviewed_at": reviewed_at,
    }
    updated_errors = validate_watchlist(updated)
    if updated_errors:
        raise ValueError("; ".join(updated_errors))
    return updated


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Build due Serenity watchlist review tasks")
    parser.add_argument("watchlist")
    parser.add_argument("--due-before", default="today", help="YYYY-MM-DD or today")
    parser.add_argument("--apply", dest="review_outcome", help="apply serenity_review_outcome JSON and write updated watchlist")
    parser.add_argument("--out")
    args = parser.parse_args(argv)
    try:
        watchlist_path = Path(args.watchlist)
        if args.review_outcome:
            payload = apply_review_outcome(_load_json(watchlist_path), _load_json(Path(args.review_outcome)))
        else:
            payload = build_review_cycle(
                _load_json(watchlist_path),
                due_before=args.due_before,
                source_watchlist_path=str(watchlist_path.resolve()),
            )
            errors = validate_review_cycle(payload)
            if errors:
                raise ValueError("; ".join(errors))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
