#!/usr/bin/env python3
"""Validate a Serenity opportunity discovery plan."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:
    from validate_macro_theme_map import validate_macro_theme_map
except ModuleNotFoundError:  # pragma: no cover
    from scripts.validate_macro_theme_map import validate_macro_theme_map


DISCOVERY_MODES: set[str] = {"open_opportunity", "theme_opportunity", "theme_research_required", "constraint_first"}
MARKETS: set[str] = {"CN_A", "US", "HK", "GLOBAL"}
THEME_SOURCES: set[str] = {"curated_pack", "ai_built_required"}


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


def validate_opportunity_discovery_plan(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != "serenity_opportunity_discovery_plan":
        errors.append("contract_type must be serenity_opportunity_discovery_plan")
    if payload.get("schema_version") != "1.0":
        errors.append("schema_version must be 1.0")
    if not _non_empty(payload.get("generated_at")):
        errors.append("generated_at must not be empty")
    if payload.get("discovery_mode") not in DISCOVERY_MODES:
        errors.append("discovery_mode is unknown")
    macro_theme_map: Mapping[str, Any] = _as_mapping(payload.get("macro_theme_map"), "macro_theme_map", errors)
    if macro_theme_map:
        macro_errors: list[str] = validate_macro_theme_map(macro_theme_map)
        errors.extend([f"macro_theme_map.{error}" for error in macro_errors])
        intent: Mapping[str, Any] = _as_mapping(macro_theme_map.get("intent"), "macro_theme_map.intent", errors)
        if intent.get("mode") in DISCOVERY_MODES and intent.get("mode") != payload.get("discovery_mode"):
            errors.append("discovery_mode must match macro_theme_map.intent.mode")

    request: Mapping[str, Any] = _as_mapping(payload.get("request"), "request", errors)
    for key in ["prompt", "horizon", "risk_profile"]:
        if not _non_empty(request.get(key)):
            errors.append(f"request.{key} must not be empty")
    market_scope: list[Any] = _as_list(request.get("market_scope"), "request.market_scope", errors)
    if not market_scope:
        errors.append("request.market_scope must not be empty")
    for market in market_scope:
        if str(market) not in MARKETS:
            errors.append(f"request.market_scope has unknown market: {market}")
    price: Mapping[str, Any] = _as_mapping(request.get("price_preference"), "request.price_preference", errors)
    if not _non_empty(price.get("style")):
        errors.append("request.price_preference.style must not be empty")
    _as_list(request.get("excluded_boards"), "request.excluded_boards", errors)

    hypotheses: list[Any] = _as_list(payload.get("trend_hypotheses"), "trend_hypotheses", errors)
    if len(hypotheses) < 1:
        errors.append("trend_hypotheses must contain at least 1 hypothesis")
    seen_theme_keys: set[str] = set()
    for index, item in enumerate(hypotheses):
        row: Mapping[str, Any] = _as_mapping(item, f"trend_hypotheses[{index}]", errors)
        for key in ["theme_key", "theme", "why_now"]:
            if not _non_empty(row.get(key)):
                errors.append(f"trend_hypotheses[{index}].{key} must not be empty")
        theme_key: str = str(row.get("theme_key") or "")
        if theme_key:
            if theme_key in seen_theme_keys:
                errors.append(f"duplicate theme_key in trend_hypotheses: {theme_key}")
            seen_theme_keys.add(theme_key)
        theme_source: str = str(row.get("theme_source") or "curated_pack")
        if theme_source not in THEME_SOURCES:
            errors.append(f"trend_hypotheses[{index}].theme_source is unknown")
        for key, minimum in [("value_chain_focus", 1), ("evidence_to_seek", 2), ("disconfirmation", 1)]:
            values: list[Any] = _as_list(row.get(key), f"trend_hypotheses[{index}].{key}", errors)
            if len([value for value in values if _non_empty(value)]) < minimum:
                errors.append(f"trend_hypotheses[{index}].{key} must contain at least {minimum} non-empty item(s)")
    if payload.get("discovery_mode") == "theme_research_required":
        if not any(isinstance(item, Mapping) and item.get("theme_source") == "ai_built_required" for item in hypotheses):
            errors.append("theme_research_required requires an ai_built_required hypothesis")

    policy: Mapping[str, Any] = _as_mapping(payload.get("universe_policy"), "universe_policy", errors)
    for key in ["minimum_universe_candidates", "preflight_candidate_limit", "shortlist_target"]:
        value: Any = policy.get(key)
        if not isinstance(value, int) or value < 1:
            errors.append(f"universe_policy.{key} must be a positive integer")
    selection_order: list[Any] = _as_list(policy.get("selection_order"), "universe_policy.selection_order", errors)
    if len([item for item in selection_order if _non_empty(item)]) < 3:
        errors.append("universe_policy.selection_order must contain at least 3 non-empty steps")
    preflight_profile: Mapping[str, Any] = _as_mapping(policy.get("preflight_profile"), "universe_policy.preflight_profile", errors)
    discovery_datasets: list[Any] = _as_list(
        preflight_profile.get("discovery_datasets"),
        "universe_policy.preflight_profile.discovery_datasets",
        errors,
    )
    formal_datasets: list[Any] = _as_list(
        preflight_profile.get("formal_required_datasets"),
        "universe_policy.preflight_profile.formal_required_datasets",
        errors,
    )
    if "financials" in [str(item) for item in discovery_datasets]:
        errors.append("discovery preflight must not require financials before shortlist")
    for dataset in ["current_quote", "filings_announcements", "valuation_inputs"]:
        if dataset not in [str(item) for item in discovery_datasets]:
            errors.append(f"discovery preflight must include {dataset}")
    for dataset in ["current_quote", "price_history_adjusted", "financials", "filings_announcements", "valuation_inputs"]:
        if dataset not in [str(item) for item in formal_datasets]:
            errors.append(f"formal research datasets must include {dataset}")
    ai_expansion_policy: Mapping[str, Any] = _as_mapping(policy.get("ai_expansion_policy"), "universe_policy.ai_expansion_policy", errors)
    if ai_expansion_policy:
        if ai_expansion_policy.get("enabled") not in {True, False}:
            errors.append("universe_policy.ai_expansion_policy.enabled must be boolean")
        for key in ["expansion_mode", "curated_theme_role", "integration_rule", "output_contract"]:
            if not _non_empty(ai_expansion_policy.get(key)):
                errors.append(f"universe_policy.ai_expansion_policy.{key} must not be empty")
    expansion_tasks: list[Any] = _as_list(policy.get("ai_expansion_tasks"), "universe_policy.ai_expansion_tasks", errors)
    if ai_expansion_policy.get("enabled") is True and not [item for item in expansion_tasks if _non_empty(item)]:
        errors.append("enabled ai expansion requires universe_policy.ai_expansion_tasks")
    if not _non_empty(policy.get("evidence_floor")):
        errors.append("universe_policy.evidence_floor must not be empty")
    if not _non_empty(payload.get("next_step")):
        errors.append("next_step must not be empty")
    return errors


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Validate opportunity discovery plan JSON")
    parser.add_argument("plan")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        errors: list[str] = validate_opportunity_discovery_plan(_load_json(Path(args.plan)))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print("OK: opportunity discovery plan")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
