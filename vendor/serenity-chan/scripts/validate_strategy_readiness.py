#!/usr/bin/env python3
"""Evaluate which strategy modes a completed Serenity report can support."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:
    from build_comparison_report import validate_comparison_report
except ModuleNotFoundError:  # pragma: no cover
    from scripts.build_comparison_report import validate_comparison_report


CONTRACT_TYPE: str = "serenity_strategy_readiness"
SCHEMA_VERSION: str = "1.0"
FINAL_AI_STATUSES: set[str] = {"COMPLETED", "FAILED_INSUFFICIENT_EVIDENCE", "CONFLICT_WITH_DATA"}
STRATEGY_MODES: tuple[str, ...] = ("allocation", "watchlist", "evidence_trigger", "research_plan")
WATCHLIST_STATES: set[str] = {
    "CORE_CANDIDATE",
    "STRONG_OBSERVE",
    "CANDIDATE_POOL",
    "WAIT_FOR_BUY_POINT",
    "RESEARCH_GATED",
    "DATA_GATED",
}


def _load_json(path: Path) -> Mapping[str, Any]:
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _text(value: Any) -> str:
    return str(value or "").strip()


def _ranking_validity(report: Mapping[str, Any]) -> str:
    decision: Mapping[str, Any] = _as_mapping(report.get("final_decision"))
    ranking_validity: Mapping[str, Any] = _as_mapping(decision.get("ranking_validity"))
    status: str = _text(ranking_validity.get("status"))
    return status if status in {"VALID", "PARTIAL", "INVALID"} else "UNKNOWN"


def _formal_report_ready(report: Mapping[str, Any]) -> bool:
    readiness: Mapping[str, Any] = _as_mapping(report.get("report_readiness"))
    return readiness.get("stage") == "FINAL_REPORT_READY" and readiness.get("delivery_allowed") is True


def _quality_blocked_symbols(report: Mapping[str, Any]) -> list[str]:
    symbols: list[str] = []
    for row in _as_list(report.get("ai_research_dossier_matrix")):
        if not isinstance(row, Mapping):
            continue
        if _text(row.get("dossier_status")) == "NOT_PROVIDED":
            continue
        if row.get("quality_delivery_allowed") is not True:
            symbol: str = _text(row.get("symbol"))
            if symbol:
                symbols.append(symbol)
    return sorted(set(symbols))


def _non_final_ai_symbols(report: Mapping[str, Any]) -> list[str]:
    symbols: list[str] = []
    for row in _as_list(report.get("ai_review_status_matrix")):
        if not isinstance(row, Mapping):
            continue
        if _text(row.get("ai_review_status")) not in FINAL_AI_STATUSES:
            symbol: str = _text(row.get("symbol"))
            if symbol:
                symbols.append(symbol)
    return sorted(set(symbols))


def _ranking_rows(report: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [row for row in _as_list(report.get("candidate_priority_ranking")) if isinstance(row, Mapping)]


def _actionable_symbols(report: Mapping[str, Any]) -> list[str]:
    symbols: list[str] = []
    for row in _ranking_rows(report):
        gate: Mapping[str, Any] = _as_mapping(row.get("action_gate"))
        if row.get("decision_grade") is True and _text(gate.get("primary_gate")) == "NONE":
            symbol: str = _text(row.get("symbol"))
            if symbol:
                symbols.append(symbol)
    return symbols


def _watchlist_symbols(report: Mapping[str, Any]) -> list[str]:
    symbols: list[str] = []
    for row in _ranking_rows(report):
        symbol: str = _text(row.get("symbol"))
        if not symbol:
            continue
        if _text(row.get("action_readiness")) in WATCHLIST_STATES or float(row.get("research_priority_score") or 0.0) > 0:
            symbols.append(symbol)
    return symbols


def _evidence_first_symbols(report: Mapping[str, Any]) -> list[str]:
    symbols: list[str] = []
    for row in _ranking_rows(report):
        gate: Mapping[str, Any] = _as_mapping(row.get("action_gate"))
        primary_gate: str = _text(gate.get("primary_gate"))
        if primary_gate and primary_gate != "NONE":
            symbol: str = _text(row.get("symbol"))
            if symbol:
                symbols.append(symbol)
    return symbols


def evaluate_strategy_readiness(report: Mapping[str, Any]) -> dict[str, Any]:
    validation_errors: list[str] = validate_comparison_report(report)
    formal_ready: bool = _formal_report_ready(report) and not validation_errors
    ranking_validity: str = _ranking_validity(report)
    quality_blocked: list[str] = _quality_blocked_symbols(report)
    non_final_ai: list[str] = _non_final_ai_symbols(report)
    actionable: list[str] = _actionable_symbols(report) if formal_ready else []
    watchlist: list[str] = _watchlist_symbols(report) if formal_ready else []
    evidence_first: list[str] = _evidence_first_symbols(report) if formal_ready else []

    blocking_reasons: list[str] = []
    if validation_errors:
        blocking_reasons.append("comparison_report contract validation failed.")
    if not _formal_report_ready(report):
        blocking_reasons.append("comparison report is not formally delivery-ready.")
    if ranking_validity in {"INVALID", "UNKNOWN"}:
        blocking_reasons.append(f"ranking validity is {ranking_validity}.")
    if quality_blocked:
        blocking_reasons.append("AI dossier quality gate blocks strategy handoff: " + ", ".join(quality_blocked))
    if non_final_ai:
        blocking_reasons.append("AI research is not final for: " + ", ".join(non_final_ai))

    allowed: list[str] = ["research_plan"]
    if formal_ready:
        allowed.append("evidence_trigger")
    if formal_ready and ranking_validity in {"VALID", "PARTIAL"} and watchlist:
        allowed.append("watchlist")
    if formal_ready and ranking_validity == "VALID" and actionable and not quality_blocked and not non_final_ai:
        allowed.append("allocation")
    allowed = [mode for mode in STRATEGY_MODES if mode in set(allowed)]
    blocked: list[str] = [mode for mode in STRATEGY_MODES if mode not in set(allowed)]

    if "allocation" in allowed:
        status: str = "ACTION_READY"
        boundary: str = "可以输出带条件的配置、观察和复盘方案，仍需保留触发器与失效条件。"
        next_step: str = "Build Laplace strategy judgment with allocation, triggers, invalidation, and review cadence."
    elif "watchlist" in allowed:
        status = "WATCHLIST_READY"
        boundary = "可以输出观察名单、触发条件和升级路径；配置动作在 allocation 条件成熟后生成。"
        next_step = "Build watchlist strategy with upgrade/downgrade triggers and next-evidence cadence."
    elif "evidence_trigger" in allowed:
        status = "EVIDENCE_FIRST"
        boundary = "可以输出证据触发器和补证优先级，行动方案保持等待状态。"
        next_step = "Resolve primary gates or produce evidence-trigger strategy before allocation."
    else:
        status = "BLOCKED"
        boundary = "当前只支持研究计划和补证路径。"
        next_step = "Repair comparison report, AI research completion, or dossier quality before strategy handoff."

    return {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "status": status,
        "formal_report_ready": formal_ready,
        "ranking_validity": ranking_validity,
        "allowed_strategy_modes": allowed,
        "blocked_strategy_modes": blocked,
        "blocking_reasons": blocking_reasons,
        "actionable_symbols": actionable,
        "watchlist_symbols": watchlist,
        "evidence_first_symbols": sorted(set(evidence_first + quality_blocked + non_final_ai)),
        "quality_blocked_symbols": quality_blocked,
        "non_final_ai_symbols": non_final_ai,
        "decision_boundary": boundary,
        "primary_next_step": next_step,
    }


def validate_strategy_readiness(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != CONTRACT_TYPE:
        errors.append(f"contract_type must be {CONTRACT_TYPE}")
    if payload.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    if payload.get("status") not in {"ACTION_READY", "WATCHLIST_READY", "EVIDENCE_FIRST", "BLOCKED"}:
        errors.append("status is unknown")
    if not isinstance(payload.get("formal_report_ready"), bool):
        errors.append("formal_report_ready must be boolean")
    if payload.get("ranking_validity") not in {"VALID", "PARTIAL", "INVALID", "UNKNOWN"}:
        errors.append("ranking_validity is unknown")
    allowed: list[Any] = _as_list(payload.get("allowed_strategy_modes"))
    blocked: list[Any] = _as_list(payload.get("blocked_strategy_modes"))
    if sorted(set(str(item) for item in allowed + blocked)) != sorted(STRATEGY_MODES):
        errors.append("allowed_strategy_modes and blocked_strategy_modes must partition all strategy modes")
    for key in [
        "blocking_reasons",
        "actionable_symbols",
        "watchlist_symbols",
        "evidence_first_symbols",
        "quality_blocked_symbols",
        "non_final_ai_symbols",
    ]:
        if not isinstance(payload.get(key), list):
            errors.append(f"{key} must be an array")
    for key in ["decision_boundary", "primary_next_step"]:
        if not _text(payload.get(key)):
            errors.append(f"{key} must not be empty")
    return errors


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Evaluate Serenity strategy readiness")
    parser.add_argument("comparison_report")
    parser.add_argument("--mode", choices=STRATEGY_MODES, help="fail if this strategy mode is blocked")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        payload: dict[str, Any] = evaluate_strategy_readiness(_load_json(Path(args.comparison_report)))
        errors: list[str] = validate_strategy_readiness(payload)
        if errors:
            raise ValueError("; ".join(errors))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    if args.mode and args.mode not in payload["allowed_strategy_modes"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
