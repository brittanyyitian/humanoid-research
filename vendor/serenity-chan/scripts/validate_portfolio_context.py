#!/usr/bin/env python3
"""Validate portfolio context before Serenity emits portfolio-level actions."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence


CONTRACT_TYPE: str = "serenity_portfolio_context"
SCHEMA_VERSION: str = "1.0"


def _load_json(path: Path) -> Mapping[str, Any]:
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _text(value: Any) -> str:
    return str(value or "").strip()


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _float_or_none(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def validate_portfolio_context(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != CONTRACT_TYPE:
        errors.append(f"contract_type must be {CONTRACT_TYPE}")
    if payload.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    if not isinstance(payload.get("provided"), bool):
        errors.append("provided must be boolean")
    if not _text(payload.get("generated_at")):
        errors.append("generated_at must be non-empty")
    if not _text(payload.get("decision_boundary")):
        errors.append("decision_boundary must be non-empty")
    if payload.get("provided") is True and not _text(payload.get("account_scope")):
        errors.append("account_scope must be non-empty when provided is true")
    if not isinstance(payload.get("constraints"), Mapping):
        errors.append("constraints must be an object")
    positions: list[Any] = _as_list(payload.get("positions"))
    if payload.get("provided") is True and not positions:
        errors.append("positions must contain at least one item when provided is true")
    total_weight: float = 0.0
    for index, row in enumerate(positions):
        item: Mapping[str, Any] = _as_mapping(row)
        if not _text(item.get("symbol")):
            errors.append(f"positions[{index}].symbol must be non-empty")
        weight: Optional[float] = _float_or_none(item.get("weight_pct"))
        if weight is None or weight < 0:
            errors.append(f"positions[{index}].weight_pct must be a non-negative number")
        elif weight > 100:
            errors.append(f"positions[{index}].weight_pct must not exceed 100")
        else:
            total_weight += weight
    if total_weight > 100.5:
        errors.append("sum of positions.weight_pct must not exceed 100.5")
    return errors


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Validate Serenity portfolio context")
    parser.add_argument("portfolio_context")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        errors: list[str] = validate_portfolio_context(_load_json(Path(args.portfolio_context)))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print("OK: portfolio context")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
