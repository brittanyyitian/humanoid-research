#!/usr/bin/env python3
"""Aggregate provider health from attempt ledgers or real-data smoke output."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence


CONTRACT_TYPE: str = "serenity_provider_health"
SCHEMA_VERSION: str = "1.0"


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _attempts_from_manifest(payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    acquisition: Mapping[str, Any] = _as_mapping(payload.get("data_acquisition"))
    return [row for row in _as_list(acquisition.get("attempt_ledger")) if isinstance(row, Mapping)]


def _attempts_from_smoke_summary(payload: Mapping[str, Any]) -> list[Mapping[str, Any]]:
    attempts: list[Mapping[str, Any]] = []
    for result in _as_list(payload.get("results")):
        if not isinstance(result, Mapping):
            continue
        acquisition: Mapping[str, Any] = _as_mapping(result.get("data_acquisition"))
        attempts.extend(row for row in _as_list(acquisition.get("attempt_ledger")) if isinstance(row, Mapping))
    return attempts


def _attempt_signature(attempt: Mapping[str, Any]) -> tuple[str, ...]:
    return (
        _text(attempt.get("dataset")),
        _text(attempt.get("source_name")) or _text(attempt.get("provider")),
        _text(attempt.get("source_level")),
        _text(attempt.get("stage")),
        _text(attempt.get("status")),
        _text(attempt.get("attempted_at")),
        _text(attempt.get("gap_type")),
        _text(attempt.get("reason")),
    )


def _dedupe_attempts(attempts: Sequence[Mapping[str, Any]]) -> list[Mapping[str, Any]]:
    deduped: list[Mapping[str, Any]] = []
    seen: set[tuple[str, ...]] = set()
    for attempt in attempts:
        signature = _attempt_signature(attempt)
        if signature in seen:
            continue
        seen.add(signature)
        deduped.append(attempt)
    return deduped


def _collect_attempts(path: Path) -> list[Mapping[str, Any]]:
    attempts: list[Mapping[str, Any]] = []
    if path.is_dir():
        for manifest_path in sorted(path.rglob("manifest.json")):
            try:
                payload: Any = _load_json(manifest_path)
            except Exception:
                continue
            if isinstance(payload, Mapping):
                attempts.extend(_attempts_from_manifest(payload))
        for ledger_path in sorted(path.rglob("attempt_ledger.json")):
            try:
                payload = _load_json(ledger_path)
            except Exception:
                continue
            attempts.extend(row for row in _as_list(payload) if isinstance(row, Mapping))
        return _dedupe_attempts(attempts)
    payload = _load_json(path)
    if isinstance(payload, list):
        return _dedupe_attempts([row for row in payload if isinstance(row, Mapping)])
    if isinstance(payload, Mapping) and payload.get("contract_type") == "serenity_provider_health":
        return []
    if isinstance(payload, Mapping) and "results" in payload:
        return _dedupe_attempts(_attempts_from_smoke_summary(payload))
    if isinstance(payload, Mapping):
        return _dedupe_attempts(_attempts_from_manifest(payload))
    return attempts


def _health_status(ok_count: int, fail_count: int) -> str:
    if ok_count > 0 and fail_count == 0:
        return "HEALTHY"
    if ok_count > 0 and fail_count > 0:
        return "DEGRADED"
    return "FAILED"


def build_provider_health(source: Path) -> dict[str, Any]:
    attempts: list[Mapping[str, Any]] = _collect_attempts(source)
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for attempt in attempts:
        source_name: str = _text(attempt.get("source_name")) or _text(attempt.get("provider"))
        dataset: str = _text(attempt.get("dataset"))
        if not source_name or not dataset:
            continue
        key: tuple[str, str] = (source_name, dataset)
        row: dict[str, Any] = grouped.setdefault(key, {
            "source_name": source_name,
            "dataset": dataset,
            "source_level": _text(attempt.get("source_level")),
            "ok_count": 0,
            "fail_count": 0,
            "last_status": "",
            "last_attempted_at": "",
            "last_reason": "",
            "gap_types": set(),
        })
        status: str = _text(attempt.get("status"))
        if status == "OK":
            row["ok_count"] += 1
        elif status != "NOT_APPLICABLE":
            row["fail_count"] += 1
        attempted_at: str = _text(attempt.get("attempted_at"))
        if attempted_at >= row["last_attempted_at"]:
            row["last_attempted_at"] = attempted_at
            row["last_status"] = status
            row["last_reason"] = _text(attempt.get("reason"))
            row["source_level"] = _text(attempt.get("source_level")) or row["source_level"]
        gap_type: str = _text(attempt.get("gap_type"))
        if gap_type:
            row["gap_types"].add(gap_type)

    providers: list[dict[str, Any]] = []
    for row in grouped.values():
        ok_count: int = int(row["ok_count"])
        fail_count: int = int(row["fail_count"])
        if ok_count == 0 and fail_count == 0:
            continue
        providers.append({
            "source_name": row["source_name"],
            "dataset": row["dataset"],
            "source_level": row["source_level"],
            "health_status": _health_status(ok_count, fail_count),
            "ok_count": ok_count,
            "fail_count": fail_count,
            "last_status": row["last_status"] or "UNKNOWN",
            "last_attempted_at": row["last_attempted_at"],
            "last_reason": row["last_reason"],
            "gap_types": sorted(row["gap_types"]),
        })
    providers.sort(key=lambda row: (row["source_name"], row["dataset"]))
    failed_count: int = len([row for row in providers if row["health_status"] == "FAILED"])
    degraded_count: int = len([row for row in providers if row["health_status"] == "DEGRADED"])
    healthy_count: int = len([row for row in providers if row["health_status"] == "HEALTHY"])
    if not providers:
        status = "EMPTY"
    elif failed_count:
        status = "FAILED" if failed_count == len(providers) else "DEGRADED"
    elif degraded_count:
        status = "DEGRADED"
    else:
        status = "HEALTHY"
    return {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "status": status,
        "summary": {
            "provider_count": len(providers),
            "healthy_count": healthy_count,
            "degraded_count": degraded_count,
            "failed_count": failed_count,
        },
        "providers": providers,
    }


def validate_provider_health(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != CONTRACT_TYPE:
        errors.append(f"contract_type must be {CONTRACT_TYPE}")
    if payload.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    providers: list[Any] = _as_list(payload.get("providers"))
    summary: Mapping[str, Any] = _as_mapping(payload.get("summary"))
    if summary.get("provider_count") != len(providers):
        errors.append("summary.provider_count must match providers length")
    for index, provider in enumerate(providers):
        row: Mapping[str, Any] = provider if isinstance(provider, Mapping) else {}
        if not row:
            errors.append(f"providers[{index}] must be an object")
            continue
        for key in ["source_name", "dataset", "health_status", "last_status"]:
            if not _text(row.get(key)):
                errors.append(f"providers[{index}].{key} must not be empty")
        if row.get("health_status") not in {"HEALTHY", "DEGRADED", "FAILED"}:
            errors.append(f"providers[{index}].health_status is invalid")
    return errors


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Build Serenity provider health ledger")
    parser.add_argument("source", help="manifest, attempt ledger, real-data smoke summary, or directory")
    parser.add_argument("--out", help="write provider health JSON")
    args = parser.parse_args(argv)
    try:
        payload = build_provider_health(Path(args.source))
        errors = validate_provider_health(payload)
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
