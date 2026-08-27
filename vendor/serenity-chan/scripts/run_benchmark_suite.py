#!/usr/bin/env python3
"""Run opportunity-discovery benchmark cases against the real funnel pipeline."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:
    from build_candidate_funnel import build_candidate_funnel
    from build_opportunity_discovery_plan import build_plan
    from validate_candidate_funnel import validate_candidate_funnel
except ModuleNotFoundError:  # pragma: no cover
    from scripts.build_candidate_funnel import build_candidate_funnel
    from scripts.build_opportunity_discovery_plan import build_plan
    from scripts.validate_candidate_funnel import validate_candidate_funnel


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


def _case_paths(paths: Sequence[str]) -> list[Path]:
    if paths:
        result: list[Path] = []
        for item in paths:
            path: Path = Path(item)
            if path.is_dir():
                result.extend(sorted(path.glob("**/benchmark_case.json")))
            else:
                result.append(path)
        return result
    return sorted(Path("examples").glob("**/benchmark_case.json"))


def _selected_rows(funnel: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    return [
        row for row in _as_list(funnel.get("candidate_rows"))
        if isinstance(row, Mapping) and row.get("selected_for_formal") is True
    ]


def _run_case(case: Mapping[str, Any]) -> dict[str, Any]:
    with tempfile.TemporaryDirectory(prefix="serenity-benchmark-") as temp_dir:
        temp_root: Path = Path(temp_dir)
        plan: dict[str, Any] = build_plan(
            prompt=_text(case.get("prompt")),
            market_scope=[str(item) for item in _as_list(case.get("market_scope"))],
            excluded_boards=[str(item) for item in _as_list(case.get("excluded_boards"))],
            horizon=_text(case.get("horizon")) or "3-6个月",
            risk_profile=_text(case.get("risk_profile")) or "balanced",
            max_price=case.get("max_price"),
            min_price=case.get("min_price"),
            explicit_themes=[str(item) for item in _as_list(case.get("themes"))],
            preflight_candidate_limit=int(case.get("preflight_candidate_limit") or 24),
            shortlist_target=int(case.get("shortlist_target") or 8),
        )
        plan_path: Path = temp_root / "opportunity_discovery_plan.json"
        plan_path.write_text(json.dumps(plan, ensure_ascii=False, indent=2), encoding="utf-8")
        snapshot_path: Path = temp_root / "preflight_snapshot.json"
        snapshot_path.write_text(json.dumps(case.get("preflight_snapshot", {}), ensure_ascii=False, indent=2), encoding="utf-8")
        universe_paths: list[Path] = []
        for index, universe in enumerate(_as_list(case.get("universes"))):
            if not isinstance(universe, Mapping):
                continue
            path: Path = temp_root / f"universe_{index}.json"
            path.write_text(json.dumps(universe, ensure_ascii=False, indent=2), encoding="utf-8")
            universe_paths.append(path)
        funnel: dict[str, Any] = build_candidate_funnel(
            plan_path=plan_path,
            universe_paths=universe_paths,
            preflight_root=None,
            preflight_snapshot_path=snapshot_path,
        )
    errors: list[str] = validate_candidate_funnel(funnel)
    assertion_errors: list[str] = _assert_case(case, funnel)
    selected: list[Mapping[str, Any]] = _selected_rows(funnel)
    return {
        "name": _text(case.get("name")),
        "ok": not errors and not assertion_errors,
        "validation_errors": errors,
        "assertion_errors": assertion_errors,
        "shortlist_symbols": [_text(row.get("symbol")) for row in selected],
        "selected_layer_keys": sorted({_text(row.get("layer_key")) for row in selected}),
        "pool_context": _as_mapping(funnel.get("candidate_pool_context")).get("pool_context"),
    }


def _assert_case(case: Mapping[str, Any], funnel: Mapping[str, Any]) -> list[str]:
    assertions: Mapping[str, Any] = _as_mapping(case.get("assertions"))
    errors: list[str] = []
    selected: list[Mapping[str, Any]] = _selected_rows(funnel)
    selected_symbols: set[str] = {_text(row.get("symbol")) for row in selected}
    selected_layers: set[str] = {_text(row.get("layer_key")) for row in selected}
    min_count: Optional[int] = int(assertions["min_shortlist_count"]) if "min_shortlist_count" in assertions else None
    max_count: Optional[int] = int(assertions["max_shortlist_count"]) if "max_shortlist_count" in assertions else None
    if min_count is not None and len(selected) < min_count:
        errors.append(f"shortlist count {len(selected)} < {min_count}")
    if max_count is not None and len(selected) > max_count:
        errors.append(f"shortlist count {len(selected)} > {max_count}")
    forbidden: set[str] = {str(item) for item in _as_list(assertions.get("forbidden_selected_symbols"))}
    leaked: set[str] = selected_symbols & forbidden
    if leaked:
        errors.append("forbidden symbols selected: " + ", ".join(sorted(leaked)))
    required_layers: set[str] = {str(item) for item in _as_list(assertions.get("must_include_layer_keys"))}
    missing_layers: set[str] = required_layers - selected_layers
    if missing_layers:
        errors.append("required layer keys missing: " + ", ".join(sorted(missing_layers)))
    required_contexts: set[str] = {str(item) for item in _as_list(assertions.get("required_pool_contexts"))}
    pool_context: str = _text(_as_mapping(funnel.get("candidate_pool_context")).get("pool_context"))
    if required_contexts and pool_context not in required_contexts:
        errors.append(f"pool_context {pool_context} not in {sorted(required_contexts)}")
    cap: Any = assertions.get("max_low_price_bonus_cap")
    low_price_bonus_cap: Any = _as_mapping(funnel.get("constraints")).get("low_price_bonus_cap")
    if cap is not None and float(low_price_bonus_cap or 0.0) > float(cap):
        errors.append(f"low_price_bonus_cap {low_price_bonus_cap} > {cap}")
    expected_quality: str = _text(assertions.get("selected_quality_floor_status"))
    if expected_quality:
        for row in selected:
            status: str = _text(_as_mapping(row.get("quality_floor")).get("status"))
            if status != expected_quality:
                errors.append(f"{row.get('symbol')} selected quality_floor.status {status} != {expected_quality}")
    return errors


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Run Serenity benchmark suite")
    parser.add_argument("cases", nargs="*", help="benchmark_case.json files or directories")
    args: argparse.Namespace = parser.parse_args(argv)
    failures: int = 0
    results: list[dict[str, Any]] = []
    try:
        paths: list[Path] = _case_paths([str(item) for item in args.cases])
        if not paths:
            raise ValueError("no benchmark_case.json files found")
        for path in paths:
            result: dict[str, Any] = _run_case(_load_json(path))
            result["path"] = str(path)
            results.append(result)
            marker: str = "PASS" if result["ok"] else "FAIL"
            print(f"[{marker}] {result['name']}: {', '.join(result['shortlist_symbols'])} | {result['pool_context']}")
            if not result["ok"]:
                failures += 1
                for error in result["validation_errors"] + result["assertion_errors"]:
                    print(f"  - {error}")
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
