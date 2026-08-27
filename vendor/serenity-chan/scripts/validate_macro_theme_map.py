#!/usr/bin/env python3
"""Validate a Serenity macro theme map."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence


INTENT_MODES: set[str] = {"open_opportunity", "theme_opportunity", "theme_research_required", "constraint_first"}
THEME_SOURCES: set[str] = {"curated_pack", "ai_built_required"}
CONFIDENCE_LEVELS: set[str] = {"LOW", "MEDIUM", "HIGH"}


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


def validate_macro_theme_map(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != "serenity_macro_theme_map":
        errors.append("contract_type must be serenity_macro_theme_map")
    if payload.get("schema_version") != "1.0":
        errors.append("schema_version must be 1.0")
    if not _non_empty(payload.get("generated_at")):
        errors.append("generated_at must not be empty")

    request: Mapping[str, Any] = _as_mapping(payload.get("request"), "request", errors)
    if not _non_empty(request.get("prompt")):
        errors.append("request.prompt must not be empty")
    _as_list(request.get("explicit_themes"), "request.explicit_themes", errors)

    intent: Mapping[str, Any] = _as_mapping(payload.get("intent"), "intent", errors)
    if intent.get("mode") not in INTENT_MODES:
        errors.append("intent.mode is unknown")
    if not isinstance(intent.get("broad_scan"), bool):
        errors.append("intent.broad_scan must be boolean")
    _as_list(intent.get("theme_seed_keys"), "intent.theme_seed_keys", errors)
    excluded_key_values: list[Any] = _as_list(intent.get("excluded_theme_keys"), "intent.excluded_theme_keys", errors)
    explicit_key_values: list[Any] = _as_list(intent.get("explicit_theme_keys"), "intent.explicit_theme_keys", errors)
    if not isinstance(intent.get("user_defined_theme_required"), bool):
        errors.append("intent.user_defined_theme_required must be boolean")

    drivers: list[Any] = _as_list(payload.get("macro_drivers"), "macro_drivers", errors)
    if not drivers:
        errors.append("macro_drivers must not be empty")
    for index, item in enumerate(drivers):
        row: Mapping[str, Any] = _as_mapping(item, f"macro_drivers[{index}]", errors)
        for key in ["driver", "role", "direction"]:
            if not _non_empty(row.get(key)):
                errors.append(f"macro_drivers[{index}].{key} must not be empty")
        _as_list(row.get("theme_keys"), f"macro_drivers[{index}].theme_keys", errors)
        if row.get("confidence") not in CONFIDENCE_LEVELS:
            errors.append(f"macro_drivers[{index}].confidence is unknown")

    candidates: list[Any] = _as_list(payload.get("theme_candidates"), "theme_candidates", errors)
    if not candidates:
        errors.append("theme_candidates must not be empty")
    seen: set[str] = set()
    selected_set: set[str] = {str(item) for item in _as_list(payload.get("selected_theme_keys"), "selected_theme_keys", errors)}
    excluded_set: set[str] = {str(item) for item in excluded_key_values}
    explicit_set: set[str] = {str(item) for item in explicit_key_values}
    leaked_exclusions: set[str] = selected_set & excluded_set - explicit_set
    if leaked_exclusions:
        errors.append(f"excluded themes must not be selected: {sorted(leaked_exclusions)}")
    for index, item in enumerate(candidates):
        row = _as_mapping(item, f"theme_candidates[{index}]", errors)
        for key in ["theme_key", "theme", "why_now", "selection_reason"]:
            if not _non_empty(row.get(key)):
                errors.append(f"theme_candidates[{index}].{key} must not be empty")
        theme_key: str = str(row.get("theme_key") or "")
        if theme_key:
            if theme_key in seen:
                errors.append(f"duplicate theme_candidate theme_key: {theme_key}")
            seen.add(theme_key)
        if row.get("theme_source") not in THEME_SOURCES:
            errors.append(f"theme_candidates[{index}].theme_source is unknown")
        weight: Any = row.get("theme_weight")
        if not isinstance(weight, (int, float)) or float(weight) < 0 or float(weight) > 1:
            errors.append(f"theme_candidates[{index}].theme_weight must be between 0 and 1")
        for key, minimum in [("evidence_to_seek", 2), ("disconfirmation", 1)]:
            values: list[Any] = _as_list(row.get(key), f"theme_candidates[{index}].{key}", errors)
            if len([value for value in values if _non_empty(value)]) < minimum:
                errors.append(f"theme_candidates[{index}].{key} must contain at least {minimum} non-empty item(s)")
        if row.get("theme_source") == "curated_pack" and theme_key and theme_key not in selected_set:
            errors.append(f"curated theme {theme_key} must be listed in selected_theme_keys")

    if intent.get("mode") == "theme_research_required":
        if not any(isinstance(item, Mapping) and item.get("theme_source") == "ai_built_required" for item in candidates):
            errors.append("theme_research_required requires an ai_built_required theme candidate")
    if selected_set and intent.get("user_defined_theme_required") is True:
        errors.append("user_defined_theme_required cannot include curated selected_theme_keys")
    expansion: Mapping[str, Any] = _as_mapping(payload.get("ai_expansion_policy"), "ai_expansion_policy", errors)
    if not isinstance(expansion.get("enabled"), bool):
        errors.append("ai_expansion_policy.enabled must be boolean")
    for key in ["expansion_mode", "curated_theme_role", "integration_rule", "output_contract"]:
        if not _non_empty(expansion.get(key)):
            errors.append(f"ai_expansion_policy.{key} must not be empty")
    for key, minimum in [("research_questions", 1), ("candidate_universe_requirements", 2)]:
        values: list[Any] = _as_list(expansion.get(key), f"ai_expansion_policy.{key}", errors)
        if len([value for value in values if _non_empty(value)]) < minimum:
            errors.append(f"ai_expansion_policy.{key} must contain at least {minimum} non-empty item(s)")
    _as_list(expansion.get("seed_theme_keys"), "ai_expansion_policy.seed_theme_keys", errors)
    if intent.get("broad_scan") is True and intent.get("explicit_theme_keys") == [] and expansion.get("enabled") is not True:
        errors.append("broad open opportunity requires ai_expansion_policy.enabled")
    if intent.get("user_defined_theme_required") is True and expansion.get("enabled") is not True:
        errors.append("user_defined_theme_required requires ai_expansion_policy.enabled")
    if not _non_empty(payload.get("selection_policy")):
        errors.append("selection_policy must not be empty")
    constraints: Mapping[str, Any] = _as_mapping(payload.get("constraint_interpretation"), "constraint_interpretation", errors)
    if not _non_empty(constraints.get("price_style")):
        errors.append("constraint_interpretation.price_style must not be empty")
    _as_mapping(constraints.get("affordability_profile"), "constraint_interpretation.affordability_profile", errors)
    return errors


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Validate macro theme map JSON")
    parser.add_argument("path")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        errors: list[str] = validate_macro_theme_map(_load_json(Path(args.path)))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print("OK: macro theme map")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
