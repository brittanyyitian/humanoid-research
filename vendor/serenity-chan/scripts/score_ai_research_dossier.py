#!/usr/bin/env python3
"""Score the research quality of a Serenity AI dossier."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence


def calibration_score_floor_delta() -> float:
    """Extra points required on the delivery score line when calibration is poor.

    Reads the calibration policy from SERENITY_CALIBRATION_POLICY. A missing or
    unreadable policy never lowers the default 70-point line.
    """
    policy_path: str = os.environ.get("SERENITY_CALIBRATION_POLICY", "")
    if not policy_path:
        return 0.0
    try:
        loaded: Any = json.loads(Path(policy_path).expanduser().read_text(encoding="utf-8"))
        delta: float = float(loaded.get("dossier_score_floor_delta", 0)) if isinstance(loaded, Mapping) else 0.0
    except Exception:
        return 0.0
    return min(max(delta, 0.0), 15.0)

try:
    from validate_ai_overlay import evidence_context_from_manifest
    from validate_ai_research_dossier import validate_dossier
except ModuleNotFoundError:  # pragma: no cover
    from scripts.validate_ai_overlay import evidence_context_from_manifest
    from scripts.validate_ai_research_dossier import validate_dossier


GENERIC_REVENUE_TEXT: tuple[str, ...] = (
    "需要用公告",
    "需要用财报",
    "待验证",
    "尚未执行",
    "无法确认",
    "需要验证",
)
STRONG_SOURCE_LEVELS: set[str] = {"L0", "L1"}
FINAL_STATUSES: set[str] = {"COMPLETED", "FAILED_INSUFFICIENT_EVIDENCE", "CONFLICT_WITH_DATA"}


def _load_json(path: str) -> Mapping[str, Any]:
    raw: str = sys.stdin.read() if path == "-" else Path(path).read_text(encoding="utf-8")
    payload: Any = json.loads(raw)
    if not isinstance(payload, Mapping):
        raise ValueError("dossier JSON must be an object")
    return payload


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _non_empty_count(value: Any) -> int:
    return len([item for item in _as_list(value) if _text(item)])


def _clip(value: float, maximum: float) -> float:
    return round(max(0.0, min(maximum, value)), 2)


def _quality_band(score: float) -> str:
    if score >= 85:
        return "A"
    if score >= 75:
        return "B"
    if score >= 65:
        return "C"
    return "D"


def _source_score(sources: Sequence[Any]) -> tuple[float, list[str], dict[str, int]]:
    rows: list[Mapping[str, Any]] = [item for item in sources if isinstance(item, Mapping)]
    read_rows: list[Mapping[str, Any]] = [row for row in rows if _text(row.get("read_status")) in {"READ", "PARTIAL_READ"}]
    strong_rows: list[Mapping[str, Any]] = [row for row in read_rows if _text(row.get("source_level")) in STRONG_SOURCE_LEVELS]
    score: float = 0.0
    score += min(5.0, len(read_rows) * 2.0)
    score += min(5.0, len(strong_rows) * 2.5)
    if any(_text(row.get("claim_boundary")) for row in rows):
        score += 2.0
    if len(read_rows) >= 3:
        score += 3.0
    issues: list[str] = []
    if not read_rows:
        issues.append("source_reading_log 没有 READ 或 PARTIAL_READ 来源。")
    return _clip(score, 15.0), issues, {"read_count": len(read_rows), "strong_count": len(strong_rows)}


def _research_question_score(path: Mapping[str, Any]) -> float:
    score: float = 0.0
    if _text(path.get("core_question")):
        score += 3.0
    if _text(path.get("decision_use")):
        score += 2.0
    hypotheses: list[Any] = _as_list(path.get("hypotheses"))
    tested: int = sum(
        1 for item in hypotheses
        if isinstance(item, Mapping) and _text(item.get("current_view")) in {"SUPPORTED", "PARTIAL", "CONFLICTED"}
    )
    score += min(3.0, len(hypotheses) * 1.0)
    if tested:
        score += 1.0
    if _text(path.get("base_rate_anchor")) or _text(path.get("reflexivity_check")):
        score += 1.0
    return _clip(score, 10.0)


def _evidence_test_score(path: Mapping[str, Any]) -> tuple[float, list[str]]:
    tests: list[Any] = _as_list(path.get("evidence_tests"))
    non_missing: int = 0
    with_refs: int = 0
    direct_or_lead: int = 0
    for item in tests:
        if not isinstance(item, Mapping):
            continue
        status: str = _text(item.get("evidence_status"))
        refs: list[Any] = _as_list(item.get("source_refs"))
        if status in {"DIRECT", "LEAD", "INFERRED", "CONFLICTED"}:
            non_missing += 1
        if refs:
            with_refs += 1
        if status in {"DIRECT", "LEAD", "CONFLICTED"}:
            direct_or_lead += 1
    score: float = min(4.0, len(tests) * 1.3) + min(4.0, non_missing * 2.0) + min(2.0, with_refs) + min(2.0, direct_or_lead)
    issues: list[str] = []
    if non_missing == 0:
        issues.append("evidence_tests 没有任何非 MISSING 测试。")
    return _clip(score, 12.0), issues


def _claim_graph_score(claims: Sequence[Any]) -> tuple[float, list[str]]:
    rows: list[Mapping[str, Any]] = [item for item in claims if isinstance(item, Mapping)]
    supported: int = sum(1 for row in rows if _text(row.get("status")) in {"SUPPORTED", "PARTIAL"})
    opposed: int = sum(1 for row in rows if _as_list(row.get("opposing_refs")))
    with_refs: int = sum(1 for row in rows if _as_list(row.get("supporting_refs")) or _as_list(row.get("opposing_refs")))
    score: float = min(4.0, len(rows) * 1.5) + min(3.0, supported * 1.5) + min(3.0, with_refs) + min(2.0, opposed * 2.0)
    issues: list[str] = []
    if supported == 0:
        issues.append("claim_graph 没有 SUPPORTED 或 PARTIAL claim。")
    return _clip(score, 12.0), issues


def _causal_chain_score(chain: Sequence[Any]) -> tuple[float, list[str]]:
    rows: list[Mapping[str, Any]] = [item for item in chain if isinstance(item, Mapping)]
    non_missing: int = sum(1 for row in rows if _text(row.get("evidence_status")) in {"DIRECT", "LEAD", "INFERRED", "CONFLICTED"})
    text_blob: str = " ".join(f"{row.get('step', '')} {row.get('mechanism', '')}" for row in rows)
    financial_terms: int = sum(1 for token in ["收入", "订单", "客户", "利润", "毛利", "现金流", "revenue", "margin", "cash"] if token.lower() in text_blob.lower())
    score: float = min(4.0, len(rows) * 1.2) + min(4.0, non_missing * 1.5) + min(4.0, financial_terms * 1.2)
    issues: list[str] = []
    if len(rows) < 3:
        issues.append("causal_chain 少于 3 步。")
    if financial_terms == 0:
        issues.append("causal_chain 没有连接到收入、利润、订单、客户或现金流。")
    return _clip(score, 12.0), issues


def _revenue_transmission_score(projection: Mapping[str, Any], research_status: str) -> tuple[float, list[str], list[str]]:
    text: str = _text(projection.get("revenue_transmission"))
    issues: list[str] = []
    caps: list[str] = []
    if not text:
        return 0.0, ["overlay_projection.revenue_transmission 为空。"], []
    score: float = 4.0
    if len(text) >= 24:
        score += 3.0
    if any(token in text for token in ["收入", "订单", "客户", "产能", "毛利", "现金流", "财务", "revenue", "margin"]):
        score += 3.0
    if any(token in text for token in ["分部", "产品", "公告", "年报", "季报", "source", "L0", "L1"]):
        score += 2.0
    if research_status == "COMPLETED" and any(token in text for token in GENERIC_REVENUE_TEXT):
        issues.append("COMPLETED dossier 的 revenue_transmission 仍停留在泛化待验证表述。")
    elif any(token in text for token in GENERIC_REVENUE_TEXT):
        caps.append("revenue_transmission 仍有待验证成分，AI 置信度上限为 MEDIUM。")
    return _clip(score, 12.0), issues, caps


def _bear_case_score(rows: Sequence[Any]) -> tuple[float, list[str], list[str]]:
    count: int = _non_empty_count(list(rows))
    issues: list[str] = []
    caps: list[str] = []
    if count == 0:
        issues.append("bear_case 为空。")
        return 0.0, issues, caps
    score: float = min(8.0, 3.0 + count * 2.0)
    if count < 2:
        caps.append("bear_case 少于 2 条，AI 置信度上限为 MEDIUM。")
    return _clip(score, 8.0), issues, caps


def _scenario_action_score(dossier: Mapping[str, Any]) -> float:
    scenarios: Mapping[str, Any] = _as_mapping(dossier.get("scenario_view"))
    trigger_table: Mapping[str, Any] = _as_mapping(dossier.get("trigger_table"))
    actions: Mapping[str, Any] = _as_mapping(dossier.get("action_conditions"))
    score: float = 0.0
    if all(isinstance(scenarios.get(key), Mapping) for key in ["base", "upside", "downside"]):
        score += 4.0
    trigger_count: int = sum(_non_empty_count(value) for value in trigger_table.values())
    action_count: int = sum(_non_empty_count(value) for value in actions.values())
    score += min(4.0, trigger_count * 0.8)
    score += min(4.0, action_count * 0.7)
    return _clip(score, 12.0)


def _uncertainty_score(dossier: Mapping[str, Any], projection: Mapping[str, Any]) -> float:
    path: Mapping[str, Any] = _as_mapping(dossier.get("research_path"))
    score: float = 0.0
    score += min(2.0, _non_empty_count(path.get("unresolved_questions")))
    score += min(2.0, _non_empty_count(dossier.get("confidence_dampers")))
    if _text(projection.get("required_next_evidence")):
        score += 2.0
    if _text(projection.get("posterior_basis")):
        score += 1.0
    return _clip(score, 7.0)


def score_dossier(
    dossier: Mapping[str, Any],
    *,
    evidence_context: Optional[Mapping[str, str]] = None,
) -> dict[str, Any]:
    validated: Mapping[str, Any] = validate_dossier(dossier, evidence_context=evidence_context)["normalized_dossier"]
    research_status: str = _text(validated.get("research_status"))
    if research_status not in FINAL_STATUSES:
        raise ValueError(f"research_status must be one of {sorted(FINAL_STATUSES)}")
    path: Mapping[str, Any] = _as_mapping(validated.get("research_path"))
    projection: Mapping[str, Any] = _as_mapping(validated.get("overlay_projection"))
    blocking_issues: list[str] = []
    cap_reasons: list[str] = []

    source_score, source_issues, source_stats = _source_score(_as_list(validated.get("source_reading_log")))
    evidence_score, evidence_issues = _evidence_test_score(path)
    claim_score, claim_issues = _claim_graph_score(_as_list(validated.get("claim_graph")))
    causal_score, causal_issues = _causal_chain_score(_as_list(validated.get("causal_chain")))
    revenue_score, revenue_issues, revenue_caps = _revenue_transmission_score(projection, research_status)
    bear_score, bear_issues, bear_caps = _bear_case_score(_as_list(validated.get("bear_case")))

    blocking_issues.extend(source_issues)
    blocking_issues.extend(evidence_issues)
    blocking_issues.extend(claim_issues)
    blocking_issues.extend(causal_issues)
    blocking_issues.extend(revenue_issues)
    blocking_issues.extend(bear_issues)
    cap_reasons.extend(revenue_caps)
    cap_reasons.extend(bear_caps)

    ai_confidence: str = _text(projection.get("ai_confidence"))
    growth: str = _text(projection.get("evidence_supported_growth"))
    if ai_confidence == "HIGH" and source_stats["strong_count"] == 0:
        cap_reasons.append("HIGH confidence 需要至少一个 L0/L1 来源。")
    if growth in {"H4", "H5"} and source_stats["strong_count"] == 0:
        blocking_issues.append("H4/H5 evidence_supported_growth 需要 L0/L1 来源。")

    dimension_scores: dict[str, float] = {
        "research_question": _research_question_score(path),
        "source_reading": source_score,
        "evidence_tests": evidence_score,
        "claim_graph": claim_score,
        "causal_chain": causal_score,
        "revenue_transmission": revenue_score,
        "bear_case": bear_score,
        "scenario_action": _scenario_action_score(validated),
        "uncertainty_controls": _uncertainty_score(validated, projection),
    }
    score: float = round(sum(dimension_scores.values()), 2)
    if cap_reasons and score > 82:
        score = 82.0
    if blocking_issues and score > 69:
        score = 69.0
    delivery_floor: float = 70.0 + calibration_score_floor_delta()
    delivery_allowed: bool = score >= delivery_floor and not blocking_issues
    confidence_cap: str = "HIGH"
    if blocking_issues or score < delivery_floor:
        confidence_cap = "LOW"
    elif cap_reasons or score < 85:
        confidence_cap = "MEDIUM"
    return {
        "contract_type": "serenity_ai_research_dossier_score",
        "schema_version": "1.0",
        "symbol": _text(validated.get("symbol")),
        "research_status": research_status,
        "score": score,
        "quality_band": _quality_band(score),
        "delivery_allowed": delivery_allowed,
        "delivery_score_floor": delivery_floor,
        "dimension_scores": dimension_scores,
        "blocking_issues": blocking_issues,
        "cap_reasons": cap_reasons,
        "gate_effects": {
            "report_readiness": "PASS" if delivery_allowed else "BLOCK",
            "ai_confidence_cap": confidence_cap,
            "action_gate": "NONE" if delivery_allowed else "AI_RESEARCH_QUALITY_GATED",
        },
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Score a Serenity AI research dossier")
    parser.add_argument("dossier", help="dossier JSON path or '-' for stdin")
    parser.add_argument("--manifest", help="optional fetch manifest used to resolve source refs")
    parser.add_argument("--min-score", type=float, default=70.0)
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        context: Optional[Mapping[str, str]] = evidence_context_from_manifest(Path(args.manifest)) if args.manifest else None
        result: dict[str, Any] = score_dossier(_load_json(args.dossier), evidence_context=context)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result["score"] < args.min_score or not result["delivery_allowed"]:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
