#!/usr/bin/env python3
"""Build a tracked watchlist from a validated Serenity comparison report."""

from __future__ import annotations

import argparse
import json
import os
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:
    from build_comparison_report import validate_comparison_report
except ModuleNotFoundError:  # pragma: no cover
    from scripts.build_comparison_report import validate_comparison_report


CONTRACT_TYPE: str = "serenity_watchlist"
SCHEMA_VERSION: str = "1.0"
EVIDENCE_GATES: set[str] = {"DATA_GATED", "EVIDENCE_GATED", "VALUATION_GATED", "AI_REVIEW_GATED", "CAPITAL_ACTION_GATED"}


def _load_json(path: Path) -> Mapping[str, Any]:
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _safe_float(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _first_by_symbol(rows: Any) -> dict[str, Mapping[str, Any]]:
    indexed: dict[str, Mapping[str, Any]] = {}
    for row in _as_list(rows):
        if not isinstance(row, Mapping):
            continue
        symbol: str = _text(row.get("symbol"))
        if symbol and symbol not in indexed:
            indexed[symbol] = row
    return indexed


def _many_by_symbol(rows: Any) -> dict[str, list[Mapping[str, Any]]]:
    indexed: dict[str, list[Mapping[str, Any]]] = {}
    for row in _as_list(rows):
        if not isinstance(row, Mapping):
            continue
        symbol: str = _text(row.get("symbol"))
        if symbol:
            indexed.setdefault(symbol, []).append(row)
    return indexed


def _candidate_names(report: Mapping[str, Any]) -> dict[str, str]:
    names: dict[str, str] = {}
    for row in _as_list(report.get("candidates")):
        if isinstance(row, Mapping):
            names[_text(row.get("symbol"))] = _text(row.get("name"))
    return names


def _watch_state(row: Mapping[str, Any]) -> str:
    gate: Mapping[str, Any] = _as_mapping(row.get("action_gate"))
    primary_gate: str = _text(gate.get("primary_gate"))
    if row.get("decision_grade") is True and primary_gate == "NONE":
        return "ACTION_CANDIDATE"
    if primary_gate == "BUY_POINT_GATED":
        return "WAIT_FOR_BUY_POINT"
    if primary_gate in EVIDENCE_GATES:
        return "EVIDENCE_FIRST"
    return "WATCHLIST"


def _gate_reasons(row: Mapping[str, Any]) -> list[str]:
    gate: Mapping[str, Any] = _as_mapping(row.get("action_gate"))
    return [str(item) for item in _as_list(gate.get("blocking_reasons")) if str(item).strip()]


def _debt_lines(rows: Sequence[Mapping[str, Any]]) -> list[str]:
    lines: list[str] = []
    for row in rows:
        dataset: str = _text(row.get("dataset") or row.get("task_type") or "evidence")
        action: str = _text(row.get("next_action") or row.get("objective"))
        if action:
            lines.append(f"{dataset}: {action}")
    return lines


def _upgrade_conditions(
    ranking: Mapping[str, Any],
    *,
    growth: Mapping[str, Any],
    technical: Mapping[str, Any],
    runbook_rows: Sequence[Mapping[str, Any]],
) -> list[str]:
    conditions: list[str] = []
    conditions.extend(_gate_reasons(ranking)[:3])
    next_evidence: str = _text(growth.get("required_next_evidence"))
    if next_evidence:
        conditions.append(next_evidence)
    if _text(technical.get("chan_action")) in {"NO_BUY_POINT", "WAIT_FOR_SECOND_BUY", "WAIT_FOR_STRUCTURE_CONFIRMATION"}:
        conditions.append("价格结构出现可复核的二买、三买或趋势确认信号。")
    conditions.extend(_debt_lines(runbook_rows)[:3])
    if not conditions:
        conditions.append("保持正式报告中的核心假设成立，并出现新的 L0/L1 证据或价格结构改善。")
    return conditions


def _downgrade_conditions(*, growth: Mapping[str, Any], technical: Mapping[str, Any]) -> list[str]:
    conditions: list[str] = [
        "公告、财报、客户、订单或产能证据削弱核心收入传导。",
        "估值隐含增长继续上移而证据支持增长没有同步提高。",
        "出现高影响稀释、减持、回购失效或治理风险。",
    ]
    if _text(technical.get("trend_state")) in {"WEAK_OR_DOWNTREND", "BASE_BUILDING_WATCH"}:
        conditions.append("价格结构跌破观察基础，技术状态继续转弱。")
    if _text(growth.get("gap")) == "MARKET_AHEAD_OF_EVIDENCE":
        conditions.append("市场预期领先证据的缺口扩大。")
    return conditions


def _triggers(
    *,
    ranking: Mapping[str, Any],
    growth: Mapping[str, Any],
    technical: Mapping[str, Any],
    runbook_rows: Sequence[Mapping[str, Any]],
) -> dict[str, list[str]]:
    first_gate: str = _text(_as_mapping(ranking.get("action_gate")).get("primary_gate"))
    runbook_actions: list[str] = _debt_lines(runbook_rows)
    day30: list[str] = [
        "复核当前价格、成交、趋势状态和买点结构。",
        "读取近 30 天公告，检查资本动作、订单、客户或产能变化。",
    ]
    if first_gate:
        day30.append(f"主门控复核：{first_gate}。")
    day90: list[str] = [
        _text(growth.get("required_next_evidence")) or "复核收入传导、订单、客户、产能和估值输入是否更新。",
        "检查下一份季报或业绩预告是否支持研究假设。",
    ]
    day180: list[str] = [
        "复盘核心假设、情景概率、失效条件和候选池相对排序。",
        "重新跑正式研究，比较证据增量、估值赔率和行动状态变化。",
    ]
    if _text(technical.get("chan_action")):
        day30.append("缠论动作复核：" + _text(technical.get("chan_action")))
    if runbook_actions:
        day90.extend(runbook_actions[:2])
    return {"30d": day30, "90d": day90, "180d": day180}


def summarize_watchlist_items(items: Sequence[Mapping[str, Any]]) -> dict[str, int]:
    active_items: list[Mapping[str, Any]] = [item for item in items if item.get("removed") is not True]
    return {
        "item_count": len(items),
        "action_candidate_count": len([item for item in active_items if item.get("watch_state") == "ACTION_CANDIDATE"]),
        "evidence_first_count": len([item for item in active_items if item.get("watch_state") == "EVIDENCE_FIRST"]),
        "watchlist_count": len([item for item in active_items if item.get("watch_state") in {"WATCHLIST", "WAIT_FOR_BUY_POINT"}]),
    }


def state_watchlist_path() -> Path:
    """Canonical tracked-watchlist location; the decision brief reads this."""
    override: str = os.getenv("SERENITY_STATE_DIR", "")
    base: Path = Path(override).expanduser() if override else Path(
        os.getenv("SERENITY_DATA_DIR", str(Path.home() / ".cache" / "serenity-chan"))
    ).expanduser() / "state"
    return base / "watchlist.json"


def scorecard_to_watchlist_item(scorecard: Mapping[str, Any]) -> dict[str, Any]:
    """Conservative mapping from a single-memo scorecard into a tracked item.

    Single-company formal research otherwise dead-ends: without a watchlist
    entry it never reaches reviews or calibration. Open blockers keep the
    item at EVIDENCE_FIRST; falsification points become downgrade conditions.
    """
    symbol: str = _text(scorecard.get("ticker"))
    if not symbol:
        raise ValueError("scorecard.ticker is required")
    blockers: list[str] = [_text(item) for item in _as_list(scorecard.get("blockers")) if _text(item)]
    falsification: list[str] = [_text(item) for item in _as_list(scorecard.get("falsification_points")) if _text(item)]
    generated_at = datetime.now(timezone.utc)
    return {
        "symbol": symbol,
        "name": _text(scorecard.get("company")),
        "watch_state": "EVIDENCE_FIRST" if blockers else "WATCHLIST",
        "research_priority_score": None,
        "action_priority_score": None,
        "primary_gate": "EVIDENCE_GATED" if blockers else "NONE",
        "primary_gate_class": "EVIDENCE_VALIDATION" if blockers else "NONE",
        "quality_score": None,
        "quality_band": "",
        "upgrade_conditions": [f"解除：{item}" for item in blockers] or ["复核单股 memo 的关键证据与买点条件。"],
        "downgrade_conditions": falsification or ["核心 thesis 被证伪或财务兑现持续弱于预期。"],
        "triggers": {
            "30d": ["复核 blockers 与技术结构是否变化。"],
            "90d": ["复核最新财报与订单/产能兑现。"],
            "180d": ["复盘 thesis、估值隐含增长与证伪条件。"],
        },
        "next_evidence": blockers[:3],
        "evidence_debt": [],
        "last_reviewed_at": "",
        "next_review_due_at": (generated_at + timedelta(days=30)).date().isoformat(),
        "history": [],
    }


def append_scorecard_item(watchlist: dict[str, Any], scorecard: Mapping[str, Any]) -> dict[str, Any]:
    item: dict[str, Any] = scorecard_to_watchlist_item(scorecard)
    items: list[Any] = [
        row for row in _as_list(watchlist.get("items"))
        if isinstance(row, Mapping) and _text(row.get("symbol")) != item["symbol"]
    ]
    replaced: bool = len(items) != len(_as_list(watchlist.get("items")))
    for row in _as_list(watchlist.get("items")):
        if isinstance(row, Mapping) and _text(row.get("symbol")) == item["symbol"]:
            # keep review memory when re-adding the same symbol
            if _as_list(row.get("history")):
                item["history"] = list(_as_list(row.get("history")))
            if _text(row.get("last_reviewed_at")):
                item["last_reviewed_at"] = _text(row.get("last_reviewed_at"))
            break
    items.append(item)
    watchlist["items"] = items
    watchlist["summary"] = summarize_watchlist_items([row for row in items if isinstance(row, Mapping)])
    watchlist.setdefault("scorecard_merge", {})
    watchlist["scorecard_merge"] = {"symbol": item["symbol"], "replaced_existing": replaced}
    return watchlist


def _empty_watchlist() -> dict[str, Any]:
    return {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_report_path": "",
        "summary": summarize_watchlist_items([]),
        "items": [],
    }


def merge_previous_watchlist(watchlist: dict[str, Any], previous: Mapping[str, Any]) -> dict[str, Any]:
    """Carry review memory from a previous watchlist into a regenerated one.

    A new formal run must not erase review history: history rows,
    last_reviewed_at, and an explicit human REMOVED decision survive
    regeneration. Fresh ranking fields always come from the new report.
    """
    previous_items: dict[str, Mapping[str, Any]] = {}
    for item in _as_list(previous.get("items")):
        if isinstance(item, Mapping) and _text(item.get("symbol")):
            previous_items[_text(item.get("symbol"))] = item
    carried: int = 0
    for item in _as_list(watchlist.get("items")):
        if not isinstance(item, dict):
            continue
        old: Mapping[str, Any] = previous_items.get(_text(item.get("symbol")), {})
        if not old:
            continue
        history: list[Any] = [row for row in _as_list(old.get("history")) if isinstance(row, Mapping)]
        if history:
            item["history"] = history
        if _text(old.get("last_reviewed_at")):
            item["last_reviewed_at"] = _text(old.get("last_reviewed_at"))
        if _text(old.get("next_review_due_at")):
            item["next_review_due_at"] = _text(old.get("next_review_due_at"))
        if old.get("removed") is True:
            item["removed"] = True
        carried += 1
    watchlist["summary"] = summarize_watchlist_items([
        item for item in _as_list(watchlist.get("items")) if isinstance(item, Mapping)
    ])
    watchlist["previous_merge"] = {
        "previous_generated_at": _text(previous.get("generated_at")),
        "carried_item_count": carried,
    }
    return watchlist


def build_watchlist(report: Mapping[str, Any], *, source_report_path: str = "") -> dict[str, Any]:
    errors: list[str] = validate_comparison_report(report)
    if errors:
        raise ValueError("; ".join(errors))
    names: dict[str, str] = _candidate_names(report)
    growth_rows: dict[str, Mapping[str, Any]] = _first_by_symbol(report.get("growth_hypothesis_matrix"))
    technical_rows: dict[str, Mapping[str, Any]] = _first_by_symbol(report.get("technical_timing_matrix"))
    dossier_rows: dict[str, Mapping[str, Any]] = _first_by_symbol(report.get("ai_research_dossier_matrix"))
    runbook_rows: dict[str, list[Mapping[str, Any]]] = _many_by_symbol(report.get("research_debt_runbook"))
    debt_rows: dict[str, list[Mapping[str, Any]]] = _many_by_symbol(report.get("research_debt"))
    items: list[dict[str, Any]] = []
    generated_at = datetime.now(timezone.utc)
    for ranking in _as_list(report.get("candidate_priority_ranking")):
        if not isinstance(ranking, Mapping):
            continue
        symbol: str = _text(ranking.get("symbol"))
        growth: Mapping[str, Any] = growth_rows.get(symbol, {})
        technical: Mapping[str, Any] = technical_rows.get(symbol, {})
        dossier: Mapping[str, Any] = dossier_rows.get(symbol, {})
        gate: Mapping[str, Any] = _as_mapping(ranking.get("action_gate"))
        state: str = _watch_state(ranking)
        items.append({
            "symbol": symbol,
            "name": names.get(symbol, ""),
            "watch_state": state,
            "research_priority_score": _safe_float(ranking.get("research_priority_score")),
            "action_priority_score": _safe_float(ranking.get("action_priority_score")),
            "primary_gate": _text(gate.get("primary_gate")),
            "primary_gate_class": _text(gate.get("primary_gate_class")),
            "quality_score": _safe_float(dossier.get("quality_score")),
            "quality_band": _text(dossier.get("quality_band")),
            "upgrade_conditions": _upgrade_conditions(
                ranking,
                growth=growth,
                technical=technical,
                runbook_rows=runbook_rows.get(symbol, []),
            ),
            "downgrade_conditions": _downgrade_conditions(growth=growth, technical=technical),
            "triggers": _triggers(
                ranking=ranking,
                growth=growth,
                technical=technical,
                runbook_rows=runbook_rows.get(symbol, []),
            ),
            "next_evidence": _debt_lines(runbook_rows.get(symbol, [])),
            "evidence_debt": _debt_lines(debt_rows.get(symbol, [])),
            "last_reviewed_at": "",
            "next_review_due_at": (generated_at + timedelta(days=30)).date().isoformat(),
            "history": [],
        })
    items.sort(key=lambda item: (0 if item["watch_state"] == "ACTION_CANDIDATE" else 1, -(item["research_priority_score"] or 0.0), item["symbol"]))
    return {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at.isoformat(),
        "source_report_path": source_report_path,
        "summary": summarize_watchlist_items(items),
        "items": items,
    }


def validate_watchlist(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != CONTRACT_TYPE:
        errors.append(f"contract_type must be {CONTRACT_TYPE}")
    if payload.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    summary: Mapping[str, Any] = _as_mapping(payload.get("summary"))
    items: list[Any] = _as_list(payload.get("items"))
    if summary.get("item_count") != len(items):
        errors.append("summary.item_count must match items length")
    valid_items: list[Mapping[str, Any]] = [item for item in items if isinstance(item, Mapping)]
    expected_summary: dict[str, int] = summarize_watchlist_items(valid_items)
    for key in ["action_candidate_count", "evidence_first_count", "watchlist_count"]:
        if summary.get(key) != expected_summary[key]:
            errors.append(f"summary.{key} must match active items")
    for index, item in enumerate(items):
        row: Mapping[str, Any] = item if isinstance(item, Mapping) else {}
        if not row:
            errors.append(f"items[{index}] must be an object")
            continue
        for key in ["symbol", "watch_state", "primary_gate", "primary_gate_class"]:
            if not _text(row.get(key)):
                errors.append(f"items[{index}].{key} must not be empty")
        if row.get("watch_state") not in {"ACTION_CANDIDATE", "EVIDENCE_FIRST", "WAIT_FOR_BUY_POINT", "WATCHLIST"}:
            errors.append(f"items[{index}].watch_state is unknown")
        triggers: Mapping[str, Any] = _as_mapping(row.get("triggers"))
        for key in ["30d", "90d", "180d"]:
            if not _as_list(triggers.get(key)):
                errors.append(f"items[{index}].triggers.{key} must not be empty")
        for key in ["upgrade_conditions", "downgrade_conditions"]:
            if not _as_list(row.get(key)):
                errors.append(f"items[{index}].{key} must not be empty")
        history = row.get("history", [])
        if history is not None and not isinstance(history, list):
            errors.append(f"items[{index}].history must be an array")
    return errors


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Build Serenity watchlist from comparison report")
    parser.add_argument("comparison_report", nargs="?", help="validated comparison report (optional with --add-scorecard)")
    parser.add_argument("--previous", help="previous watchlist JSON; carries history, review timestamps, and REMOVED decisions")
    parser.add_argument("--add-scorecard", help="single-memo scorecard JSON to add/refresh as a tracked item")
    parser.add_argument("--state", action="store_true", help="write to the canonical state watchlist (auto-previous + .bak backup)")
    parser.add_argument("--out", help="output path (required unless --state)")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        out_path: Path
        previous_path: Optional[Path] = Path(args.previous) if args.previous else None
        if args.state:
            out_path = state_watchlist_path()
            if previous_path is None and out_path.exists():
                previous_path = out_path
        elif args.out:
            out_path = Path(args.out)
        else:
            raise ValueError("--out is required unless --state is used")
        if not args.comparison_report and not args.add_scorecard:
            raise ValueError("provide a comparison report and/or --add-scorecard")

        if args.comparison_report:
            source_path: Path = Path(args.comparison_report)
            payload: dict[str, Any] = build_watchlist(_load_json(source_path), source_report_path=str(source_path.resolve()))
            if previous_path is not None:
                payload = merge_previous_watchlist(payload, _load_json(previous_path))
        elif previous_path is not None and previous_path.exists():
            payload = json.loads(previous_path.read_text(encoding="utf-8"))
            if not isinstance(payload, dict):
                raise ValueError("previous watchlist must contain a JSON object")
        else:
            payload = _empty_watchlist()

        if args.add_scorecard:
            payload = append_scorecard_item(payload, _load_json(Path(args.add_scorecard)))

        errors: list[str] = validate_watchlist(payload)
        if errors:
            raise ValueError("; ".join(errors))
        if args.state and out_path.exists():
            backup_path: Path = out_path.with_suffix(out_path.suffix + ".bak")
            backup_path.write_text(out_path.read_text(encoding="utf-8"), encoding="utf-8")
        _write_json(out_path, payload)
        print(json.dumps({"ok": True, "out": str(out_path), "item_count": payload["summary"]["item_count"]}, ensure_ascii=False, indent=2))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
