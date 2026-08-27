#!/usr/bin/env python3
"""Validate a Serenity candidate funnel."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence


STAGE_STATUSES: set[str] = {"IN_SHORTLIST", "DEFERRED", "FILTERED_OUT"}
FINAL_BUCKETS: set[str] = {
    "formal_shortlist",
    "evidence_watch",
    "constraint_excluded",
    "data_preflight_needed",
}
POOL_CONTEXTS: set[str] = {"EMPTY", "SAME_LAYER_COMPARISON", "SAME_THEME_DIFFERENT_LAYERS", "CROSS_THEME_DIAGNOSTIC"}
QUALITY_FLOOR_STATUSES: set[str] = {"PENDING_PREFLIGHT", "PASS", "BLOCKED"}


def _load_json(path: Path) -> Mapping[str, Any]:
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _as_mapping(value: Any, label: str, errors: list[str]) -> Mapping[str, Any]:
    if isinstance(value, Mapping):
        return value
    errors.append(f"{label} must be an object")
    return {}


def _as_list(value: Any, label: str, errors: list[str]) -> list[Any]:
    if isinstance(value, list):
        return value
    errors.append(f"{label} must be an array")
    return []


def _non_empty(value: Any) -> bool:
    return bool(str(value or "").strip())


def validate_candidate_funnel(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != "serenity_candidate_funnel":
        errors.append("contract_type must be serenity_candidate_funnel")
    if payload.get("schema_version") != "1.0":
        errors.append("schema_version must be 1.0")
    for key in ["generated_at", "source_plan_path", "next_step"]:
        if not _non_empty(payload.get(key)):
            errors.append(f"{key} must not be empty")
    if not _as_list(payload.get("source_universe_paths"), "source_universe_paths", errors):
        errors.append("source_universe_paths must not be empty")

    constraints: Mapping[str, Any] = _as_mapping(payload.get("constraints"), "constraints", errors)
    if not _as_list(constraints.get("market_scope"), "constraints.market_scope", errors):
        errors.append("constraints.market_scope must not be empty")
    _as_list(constraints.get("excluded_boards"), "constraints.excluded_boards", errors)
    _as_mapping(constraints.get("price_preference"), "constraints.price_preference", errors)
    shortlist_target: Any = constraints.get("shortlist_target")
    if not isinstance(shortlist_target, int) or shortlist_target < 1:
        errors.append("constraints.shortlist_target must be a positive integer")
    low_price_cap: Any = constraints.get("low_price_bonus_cap")
    if low_price_cap is not None and (not isinstance(low_price_cap, (int, float)) or float(low_price_cap) < 0 or float(low_price_cap) > 5):
        errors.append("constraints.low_price_bonus_cap must be between 0 and 5 when supplied")

    pool_context: Mapping[str, Any] = _as_mapping(payload.get("candidate_pool_context"), "candidate_pool_context", errors)
    if pool_context.get("pool_context") not in POOL_CONTEXTS:
        errors.append("candidate_pool_context.pool_context is unknown")
    for key in ["same_theme", "same_layer", "capital_allocation_comparable", "strategy_comparable"]:
        if not isinstance(pool_context.get(key), bool):
            errors.append(f"candidate_pool_context.{key} must be boolean")
    for key in ["allowed_decision_modes", "forbidden_decision_modes"]:
        values: list[Any] = _as_list(pool_context.get(key), f"candidate_pool_context.{key}", errors)
        if any(not _non_empty(item) for item in values):
            errors.append(f"candidate_pool_context.{key} must contain non-empty strings")
    if not _non_empty(pool_context.get("reason")):
        errors.append("candidate_pool_context.reason must not be empty")

    layer_summary: list[Any] = _as_list(payload.get("layer_summary"), "layer_summary", errors)
    summarized_selected: set[str] = set()
    for index, item in enumerate(layer_summary):
        row: Mapping[str, Any] = _as_mapping(item, f"layer_summary[{index}]", errors)
        for key in ["layer_key", "layer", "why_layer_matters"]:
            if not _non_empty(row.get(key)):
                errors.append(f"layer_summary[{index}].{key} must not be empty")
        if not isinstance(row.get("candidate_count"), int) or row.get("candidate_count") < 1:
            errors.append(f"layer_summary[{index}].candidate_count must be a positive integer")
        for key in ["layer_score", "evidence_strength_score"]:
            value: Any = row.get(key)
            if not isinstance(value, (int, float)) or float(value) < 0 or float(value) > 100:
                errors.append(f"layer_summary[{index}].{key} must be between 0 and 100")
        for selected in _as_list(row.get("selected_candidates"), f"layer_summary[{index}].selected_candidates", errors):
            if _non_empty(selected):
                summarized_selected.add(str(selected))

    stage_summary: list[Any] = _as_list(payload.get("stage_summary"), "stage_summary", errors)
    if len(stage_summary) < 3:
        errors.append("stage_summary must contain at least 3 stages")
    for index, item in enumerate(stage_summary):
        row: Mapping[str, Any] = _as_mapping(item, f"stage_summary[{index}]", errors)
        for key in ["stage", "rule"]:
            if not _non_empty(row.get(key)):
                errors.append(f"stage_summary[{index}].{key} must not be empty")
        for key in ["input_count", "output_count"]:
            if not isinstance(row.get(key), int) or row.get(key) < 0:
                errors.append(f"stage_summary[{index}].{key} must be a non-negative integer")

    rows: list[Any] = _as_list(payload.get("candidate_rows"), "candidate_rows", errors)
    if not rows:
        errors.append("candidate_rows must not be empty")
    symbols: set[str] = set()
    selected_symbols: list[str] = []
    for index, item in enumerate(rows):
        row: Mapping[str, Any] = _as_mapping(item, f"candidate_rows[{index}]", errors)
        for key in ["symbol", "market", "theme_key", "theme", "layer", "layer_key"]:
            if not _non_empty(row.get(key)):
                errors.append(f"candidate_rows[{index}].{key} must not be empty")
        theme_keys: list[Any] = _as_list(row.get("theme_keys"), f"candidate_rows[{index}].theme_keys", errors)
        normalized_theme_keys: list[str] = [str(item) for item in theme_keys if _non_empty(item)]
        if not normalized_theme_keys:
            errors.append(f"candidate_rows[{index}].theme_keys must not be empty")
        if _non_empty(row.get("theme_key")) and str(row.get("theme_key")) not in normalized_theme_keys:
            errors.append(f"candidate_rows[{index}].theme_key must be included in theme_keys")
        symbol: str = str(row.get("symbol") or "")
        if symbol:
            if symbol in symbols:
                errors.append(f"candidate_rows duplicate symbol: {symbol}")
            symbols.add(symbol)
        if row.get("stage_status") not in STAGE_STATUSES:
            errors.append(f"candidate_rows[{index}].stage_status is unknown")
        if row.get("final_bucket") not in FINAL_BUCKETS:
            errors.append(f"candidate_rows[{index}].final_bucket is unknown")
        if not isinstance(row.get("selected_for_formal"), bool):
            errors.append(f"candidate_rows[{index}].selected_for_formal must be boolean")
        score: Any = row.get("score")
        if not isinstance(score, (int, float)) or float(score) < 0 or float(score) > 100:
            errors.append(f"candidate_rows[{index}].score must be between 0 and 100")
        breakdown: Mapping[str, Any] = _as_mapping(row.get("score_breakdown"), f"candidate_rows[{index}].score_breakdown", errors)
        for key in [
            "theme_fit_score",
            "value_chain_score",
            "data_readiness_score",
            "evidence_strength_score",
            "affordability_score",
            "risk_penalty",
        ]:
            value: Any = breakdown.get(key)
            if not isinstance(value, (int, float)) or float(value) < 0:
                errors.append(f"candidate_rows[{index}].score_breakdown.{key} must be a non-negative number")
        quality_floor: Mapping[str, Any] = _as_mapping(row.get("quality_floor"), f"candidate_rows[{index}].quality_floor", errors)
        if quality_floor.get("status") not in QUALITY_FLOOR_STATUSES:
            errors.append(f"candidate_rows[{index}].quality_floor.status is unknown")
        blockers: list[Any] = _as_list(quality_floor.get("blockers"), f"candidate_rows[{index}].quality_floor.blockers", errors)
        _as_list(quality_floor.get("risk_flags"), f"candidate_rows[{index}].quality_floor.risk_flags", errors)
        if not _non_empty(quality_floor.get("evidence_floor")):
            errors.append(f"candidate_rows[{index}].quality_floor.evidence_floor must not be empty")
        red_flags: list[Any] = _as_list(row.get("red_flag_blockers"), f"candidate_rows[{index}].red_flag_blockers", errors)
        if quality_floor.get("status") == "BLOCKED" and not blockers:
            errors.append(f"candidate_rows[{index}].quality_floor.blockers must explain BLOCKED status")
        if row.get("selected_for_formal") is True and quality_floor.get("status") == "BLOCKED":
            errors.append(f"candidate_rows[{index}] quality BLOCKED candidate cannot be selected_for_formal")
        if row.get("selected_for_formal") is True and red_flags:
            errors.append(f"candidate_rows[{index}] red_flag_blockers must be empty for formal shortlist")
        if len([item for item in _as_list(row.get("reasons"), f"candidate_rows[{index}].reasons", errors) if _non_empty(item)]) < 1:
            errors.append(f"candidate_rows[{index}].reasons must not be empty")
        if len([item for item in _as_list(row.get("evidence_tasks"), f"candidate_rows[{index}].evidence_tasks", errors) if _non_empty(item)]) < 1:
            errors.append(f"candidate_rows[{index}].evidence_tasks must not be empty")
        if row.get("selected_for_formal") is True:
            if row.get("stage_status") != "IN_SHORTLIST" or row.get("final_bucket") != "formal_shortlist":
                errors.append(f"candidate_rows[{index}] selected_for_formal must be IN_SHORTLIST/formal_shortlist")
            selected_symbols.append(symbol)

    shortlist: list[Any] = _as_list(payload.get("shortlist_symbols"), "shortlist_symbols", errors)
    if [str(symbol) for symbol in shortlist] != selected_symbols:
        errors.append("shortlist_symbols must match selected candidate rows in order")
    if set(selected_symbols) - summarized_selected:
        errors.append("layer_summary.selected_candidates must include every shortlist symbol")
    excluded: list[Any] = _as_list(payload.get("excluded_directions"), "excluded_directions", errors)
    for index, item in enumerate(excluded):
        row: Mapping[str, Any] = _as_mapping(item, f"excluded_directions[{index}]", errors)
        for key in ["direction", "reason", "revisit_trigger"]:
            if not _non_empty(row.get(key)):
                errors.append(f"excluded_directions[{index}].{key} must not be empty")
    return errors


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Validate candidate funnel JSON")
    parser.add_argument("funnel")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        errors: list[str] = validate_candidate_funnel(_load_json(Path(args.funnel)))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print("OK: candidate funnel")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
