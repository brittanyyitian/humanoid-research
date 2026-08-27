#!/usr/bin/env python3
"""Feed validated AI dossier quality back into a candidate funnel."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:
    from build_candidate_funnel import (
        _candidate_has_formal_blocker,
        _candidate_pool_context,
        _layer_key,
        _layer_summary,
        _select_shortlist_indexes,
    )
    from score_ai_research_dossier import score_dossier
    from validate_ai_overlay import evidence_context_from_manifest
    from validate_candidate_funnel import validate_candidate_funnel
except ModuleNotFoundError:  # pragma: no cover
    from scripts.build_candidate_funnel import (
        _candidate_has_formal_blocker,
        _candidate_pool_context,
        _layer_key,
        _layer_summary,
        _select_shortlist_indexes,
    )
    from scripts.score_ai_research_dossier import score_dossier
    from scripts.validate_ai_overlay import evidence_context_from_manifest
    from scripts.validate_candidate_funnel import validate_candidate_funnel


def _load_json(path: Path) -> Mapping[str, Any]:
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _text(value: Any) -> str:
    return str(value or "").strip()


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _assignment(value: str) -> tuple[str, Path]:
    if "=" not in value:
        raise ValueError("dossier assignments must use SYMBOL=path")
    symbol, path_text = value.split("=", 1)
    symbol = symbol.strip()
    if not symbol:
        raise ValueError("dossier assignment symbol must not be empty")
    return symbol, Path(path_text)


def _manifest_context(manifest_map: Mapping[str, Path], symbol: str) -> Optional[Mapping[str, str]]:
    path: Optional[Path] = manifest_map.get(symbol)
    if path is None:
        return None
    return evidence_context_from_manifest(path)


def _feedback_from_dossier(symbol: str, dossier: Mapping[str, Any], quality: Mapping[str, Any]) -> dict[str, Any]:
    projection: Mapping[str, Any] = _as_mapping(dossier.get("overlay_projection"))
    score: float = float(quality.get("score") or 0.0)
    delivery_allowed: bool = bool(quality.get("delivery_allowed"))
    action: str = "KEEP"
    score_delta: float = 0.0
    reasons: list[str] = []
    if score >= 85 and delivery_allowed and _text(dossier.get("research_status")) == "COMPLETED":
        action = "UPGRADE"
        score_delta = 6.0
        reasons.append("AI 深研质量达到 A 档，候选研究优先级上调。")
    elif score < 70 or not delivery_allowed:
        action = "DOWNGRADE"
        score_delta = -15.0
        reasons.append("AI 深研质量未达到正式交付线，候选研究优先级下调。")
    elif score < 75:
        action = "WATCH"
        score_delta = -6.0
        reasons.append("AI 深研质量处于 C/B 边界，保留观察并优先补证。")
    revenue: str = _text(projection.get("revenue_transmission"))
    if not revenue or any(token in revenue for token in ["需要用公告", "待验证", "无法确认"]):
        if action == "KEEP":
            action = "WATCH"
        score_delta = min(score_delta, -5.0)
        reasons.append("收入传导仍未落到清晰证据，不能维持核心候选权重。")
    layer: str = _text(projection.get("layer"))
    return {
        "symbol": symbol,
        "action": action,
        "score_delta": score_delta,
        "quality_score": score,
        "quality_band": _text(quality.get("quality_band")),
        "quality_delivery_allowed": delivery_allowed,
        "formal_blocker": not delivery_allowed,
        "projected_layer": layer,
        "projected_layer_key": _layer_key(layer) if layer else "",
        "reasons": reasons or ["AI 深研未改变候选漏斗优先级。"],
    }


def update_funnel(
    funnel: Mapping[str, Any],
    *,
    dossier_assignments: Sequence[str],
    manifest_assignments: Sequence[str] = (),
) -> dict[str, Any]:
    errors: list[str] = validate_candidate_funnel(funnel)
    if errors:
        raise ValueError("candidate_funnel invalid before update: " + "; ".join(errors))
    manifest_map: dict[str, Path] = {symbol: path for symbol, path in (_assignment(item) for item in manifest_assignments)}
    dossiers: dict[str, Mapping[str, Any]] = {}
    feedback_by_symbol: dict[str, dict[str, Any]] = {}
    for assignment in dossier_assignments:
        symbol: str
        path: Path
        symbol, path = _assignment(assignment)
        dossier: Mapping[str, Any] = _load_json(path)
        quality: dict[str, Any] = score_dossier(dossier, evidence_context=_manifest_context(manifest_map, symbol))
        feedback_by_symbol[symbol] = _feedback_from_dossier(symbol, dossier, quality)
        dossiers[symbol] = dossier

    rows: list[dict[str, Any]] = []
    for item in _as_list(funnel.get("candidate_rows")):
        if not isinstance(item, Mapping):
            continue
        row: dict[str, Any] = dict(item)
        symbol: str = _text(row.get("symbol"))
        feedback: Optional[dict[str, Any]] = feedback_by_symbol.get(symbol)
        row["selected_for_formal"] = False
        if row.get("stage_status") == "IN_SHORTLIST":
            row["stage_status"] = "DEFERRED"
            row["final_bucket"] = "evidence_watch"
        if feedback:
            projected_layer: str = _text(feedback.get("projected_layer"))
            if projected_layer:
                row["previous_layer"] = row.get("layer", "")
                row["layer"] = projected_layer
                row["layer_key"] = feedback.get("projected_layer_key") or _layer_key(projected_layer)
            row["score"] = round(max(0.0, min(100.0, float(row.get("score") or 0.0) + float(feedback.get("score_delta") or 0.0))), 2)
            row["ai_dossier_feedback"] = feedback
            if feedback.get("formal_blocker") is True:
                blockers: list[str] = [
                    str(item) for item in _as_list(row.get("red_flag_blockers"))
                    if str(item).strip()
                ]
                blocker: str = (
                    "AI 深研质量未过正式交付线："
                    f"score={float(feedback.get('quality_score') or 0.0):.1f}, "
                    f"band={_text(feedback.get('quality_band')) or 'UNKNOWN'}"
                )
                if blocker not in blockers:
                    blockers.append(blocker)
                row["red_flag_blockers"] = blockers
                if row.get("stage_status") != "FILTERED_OUT":
                    row["final_bucket"] = "evidence_watch"
                row["selected_for_formal"] = False
            reasons: list[Any] = _as_list(row.get("reasons"))
            row["reasons"] = [str(reason) for reason in reasons if str(reason).strip()] + _as_list(feedback.get("reasons"))
        rows.append(row)

    constraints: Mapping[str, Any] = _as_mapping(funnel.get("constraints"))
    shortlist_target: int = int(constraints.get("shortlist_target") or len(_as_list(funnel.get("shortlist_symbols"))) or 1)
    shortlist_indexes: set[int] = _select_shortlist_indexes(rows, shortlist_target)
    for index, row in enumerate(rows):
        if row.get("stage_status") == "FILTERED_OUT":
            continue
        if _candidate_has_formal_blocker(row):
            continue
        if index in shortlist_indexes:
            row["stage_status"] = "IN_SHORTLIST"
            row["final_bucket"] = "formal_shortlist"
            row["selected_for_formal"] = True
        elif row.get("final_bucket") == "formal_shortlist":
            row["stage_status"] = "DEFERRED"
            row["final_bucket"] = "evidence_watch"
            row["selected_for_formal"] = False

    rows.sort(key=lambda item: (0 if item.get("selected_for_formal") else 1, -float(item.get("score") or 0.0), _text(item.get("symbol"))))
    updated: dict[str, Any] = dict(funnel)
    updated["candidate_rows"] = rows
    updated["shortlist_symbols"] = [_text(row.get("symbol")) for row in rows if row.get("selected_for_formal") is True]
    updated["layer_summary"] = _layer_summary(rows)
    updated["candidate_pool_context"] = _candidate_pool_context(rows)
    updated["ai_dossier_feedback_summary"] = list(feedback_by_symbol.values())
    updated["next_step"] = "Run or refresh formal research on updated shortlist_symbols; use ai_dossier_feedback_summary to explain upgrades and downgrades."
    update_errors: list[str] = validate_candidate_funnel(updated)
    if update_errors:
        raise ValueError("candidate_funnel invalid after update: " + "; ".join(update_errors))
    return updated


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Update a candidate funnel from AI research dossiers")
    parser.add_argument("candidate_funnel")
    parser.add_argument("--dossier", action="append", default=[], help="SYMBOL=ai_research_dossier.json")
    parser.add_argument("--manifest", action="append", default=[], help="optional SYMBOL=manifest.json for source-ref scoring")
    parser.add_argument("--out", required=True)
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        if not args.dossier:
            raise ValueError("at least one --dossier assignment is required")
        updated: dict[str, Any] = update_funnel(
            _load_json(Path(args.candidate_funnel)),
            dossier_assignments=[str(item) for item in args.dossier],
            manifest_assignments=[str(item) for item in args.manifest],
        )
        _write_json(Path(args.out), updated)
        print(json.dumps({"ok": True, "out": str(args.out), "shortlist_symbols": updated["shortlist_symbols"]}, ensure_ascii=False, indent=2))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
