#!/usr/bin/env python3
"""Register manually retrieved evidence back into a Serenity manifest."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence


CONTRACT_TYPE: str = "serenity_manual_evidence"
SCHEMA_VERSION: str = "1.0"
SOURCE_LEVELS: set[str] = {
    "L0_OFFICIAL_DISCLOSURE",
    "L1_LICENSED_OR_PRO_DATABASE",
    "L2_FREE_API_OR_OPEN_SOURCE",
    "L3_MEDIA_F10_RESEARCH",
    "L4_RUMOR_OR_UNVERIFIED",
}
MACHINE_DATASETS: set[str] = {
    "current_quote",
    "price_history_raw",
    "price_history_adjusted",
    "share_capital",
    "valuation_inputs",
    "financials",
}
DATA_QUALITY_KEYS: dict[str, str] = {
    "current_quote": "current_price",
    "price_history_adjusted": "adjusted_history",
    "valuation_inputs": "valuation_inputs",
    "financials": "financials",
    "filings_announcements": "filings",
    "customer_order_capacity_evidence": "customer_order_capacity_evidence",
}
FULL_RESEARCH_RATING_DATASETS: tuple[str, ...] = (
    "current_quote",
    "price_history_adjusted",
    "financials",
    "filings_announcements",
    "customer_order_capacity_evidence",
)
FULL_RESEARCH_REQUIRED_DATASETS: tuple[str, ...] = (
    *FULL_RESEARCH_RATING_DATASETS,
    "valuation_inputs",
)
RATING_CAP_EXEMPT_DATASETS: set[str] = {"share_capital", "valuation_inputs"}
RATING_ORDER: tuple[str, ...] = ("OBSERVE_ONLY", "D", "C", "B", "A", "S")


def _load_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _stricter_cap(current: str, target: str) -> str:
    return current if RATING_ORDER.index(current) < RATING_ORDER.index(target) else target


def _cap_for_statuses(
    statuses: Mapping[str, Any],
    *,
    required_datasets: Sequence[str],
    validation_caps: Sequence[str] = (),
    downgrade_not_requested: bool,
) -> str:
    cap: str = "S"
    for dataset in required_datasets:
        status: str = str(statuses.get(dataset, "NOT_REQUESTED"))
        if status in {"FAILED", "PENDING", "STALE"}:
            cap = _stricter_cap(cap, "B")
        elif status == "NOT_REQUESTED" and downgrade_not_requested:
            cap = _stricter_cap(cap, "B")
        elif status == "PARTIAL":
            cap = _stricter_cap(cap, "A")
    for raw_cap in validation_caps:
        if raw_cap in RATING_ORDER:
            cap = _stricter_cap(cap, raw_cap)
    return cap


def _validation_caps_from_results(manifest: Mapping[str, Any]) -> list[str]:
    caps: list[str] = []
    for item in _as_list(manifest.get("results")):
        if not isinstance(item, Mapping):
            continue
        validation: Mapping[str, Any] = _as_mapping(item.get("validation"))
        cap: str = str(validation.get("rating_cap") or "")
        if cap in RATING_ORDER:
            caps.append(cap)
        source_level: str = str(item.get("source_level") or "")
        if source_level.startswith(("L3_", "L4_")) and str(item.get("dataset") or "") == "financials":
            caps.append("B")
    return caps


def _refresh_quality_caps(manifest: dict[str, Any]) -> None:
    acquisition: dict[str, Any] = manifest.setdefault("data_acquisition", {})
    statuses: Mapping[str, Any] = _as_mapping(acquisition.get("status_by_dataset"))
    requested_statuses: Mapping[str, Any] = _as_mapping(acquisition.get("requested_dataset_statuses"))
    requested_rating_datasets: list[str] = [
        dataset for dataset in requested_statuses
        if dataset not in RATING_CAP_EXEMPT_DATASETS
    ]
    validation_caps: list[str] = _validation_caps_from_results(manifest)
    requested_cap: str = _cap_for_statuses(
        requested_statuses,
        required_datasets=requested_rating_datasets,
        validation_caps=validation_caps,
        downgrade_not_requested=False,
    )
    full_cap: str = _cap_for_statuses(
        statuses,
        required_datasets=FULL_RESEARCH_RATING_DATASETS,
        validation_caps=validation_caps,
        downgrade_not_requested=True,
    )
    data_quality: dict[str, Any] = manifest.setdefault("data_quality", {})
    data_quality["requested_data_rating_cap"] = requested_cap
    data_quality["full_research_rating_cap"] = full_cap
    data_quality["rating_cap"] = full_cap
    acquisition["full_research_ready"] = full_cap == "S" and not _as_list(acquisition.get("research_debt"))


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _relative_or_absolute(path: Path, *, base: Path) -> str:
    try:
        return str(path.resolve().relative_to(base.resolve()))
    except ValueError:
        return str(path.resolve())


def build_manual_evidence(
    *,
    dataset: str,
    source_name: str,
    source_level: str,
    status: str,
    evidence_path: Path,
    claim_boundary: str,
    structured_payload_path: Optional[Path] = None,
    notes: str = "",
) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "registered_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "dataset": dataset,
        "source_name": source_name,
        "source_level": source_level,
        "status": status,
        "evidence_path": str(evidence_path.resolve()),
        "evidence_sha256": _sha256(evidence_path),
        "claim_boundary": claim_boundary,
        "notes": notes,
    }
    if structured_payload_path:
        payload["structured_payload_path"] = str(structured_payload_path.resolve())
        payload["structured_payload_sha256"] = _sha256(structured_payload_path)
    return payload


def validate_manual_evidence(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != CONTRACT_TYPE:
        errors.append(f"contract_type must be {CONTRACT_TYPE}")
    if payload.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    for key in ["dataset", "source_name", "evidence_path", "evidence_sha256", "claim_boundary"]:
        if not str(payload.get(key) or "").strip():
            errors.append(f"{key} must not be empty")
    if payload.get("source_level") not in SOURCE_LEVELS:
        errors.append("source_level is invalid")
    if payload.get("status") not in {"OK", "PARTIAL"}:
        errors.append("status must be OK or PARTIAL")
    digest: str = str(payload.get("evidence_sha256") or "")
    if len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest):
        errors.append("evidence_sha256 must be lowercase sha256")
    structured_digest: str = str(payload.get("structured_payload_sha256") or "")
    if structured_digest and (len(structured_digest) != 64 or any(ch not in "0123456789abcdef" for ch in structured_digest)):
        errors.append("structured_payload_sha256 must be lowercase sha256")
    return errors


def _register_attempt(manifest: dict[str, Any], evidence: Mapping[str, Any]) -> None:
    acquisition: dict[str, Any] = manifest.setdefault("data_acquisition", {})
    attempts: list[Any] = acquisition.setdefault("attempt_ledger", [])
    attempts.append({
        "dataset": evidence["dataset"],
        "source_name": evidence["source_name"],
        "source_level": evidence["source_level"],
        "stage": "MANUAL_RETRIEVAL",
        "status": evidence["status"],
        "attempted_at": evidence["registered_at"],
        "gap_type": None if evidence["status"] == "OK" else "EVIDENCE_DEPTH_LIMIT",
        "decision_impact": "EVIDENCE_IMPACT",
        "reason": evidence["claim_boundary"],
    })
    acquisition["attempt_count"] = len(attempts)


def _update_result(manifest: dict[str, Any], evidence: Mapping[str, Any]) -> None:
    dataset: str = str(evidence["dataset"])
    results: list[Any] = manifest.setdefault("results", [])
    target: Optional[dict[str, Any]] = None
    for item in results:
        if isinstance(item, dict) and item.get("dataset") == dataset:
            target = item
            break
    if target is None:
        target = {"dataset": dataset}
        results.append(target)
    refs: list[Any] = target.setdefault("manual_evidence_refs", [])
    refs.append({
        "source_name": evidence["source_name"],
        "source_level": evidence["source_level"],
        "status": evidence["status"],
        "evidence_path": evidence["evidence_path"],
        "evidence_sha256": evidence["evidence_sha256"],
        "claim_boundary": evidence["claim_boundary"],
    })
    target["status"] = evidence["status"]
    target["source"] = evidence["source_name"]
    target["source_level"] = evidence["source_level"]
    target["retrieved_at"] = evidence["registered_at"]
    target["raw_path"] = evidence["evidence_path"]
    target["raw_hash"] = evidence["evidence_sha256"]
    target.setdefault("warnings", [])
    target.setdefault("errors", [])
    if evidence.get("structured_payload_path"):
        target["data_path"] = evidence["structured_payload_path"]


def _close_resolved_gaps(manifest: dict[str, Any], dataset: str) -> None:
    acquisition: dict[str, Any] = manifest.setdefault("data_acquisition", {})
    for key in ["data_gaps", "research_debt", "manual_retrieval_tasks"]:
        rows: list[Any] = _as_list(acquisition.get(key))
        acquisition[key] = [
            row for row in rows
            if not isinstance(row, Mapping) or str(row.get("dataset") or "") != dataset
        ]
    acquisition["gap_count"] = len(_as_list(acquisition.get("data_gaps")))
    acquisition["research_debt_count"] = len(_as_list(acquisition.get("research_debt")))
    acquisition["manual_task_count"] = len(_as_list(acquisition.get("manual_retrieval_tasks")))


def register_manual_evidence(
    manifest: Mapping[str, Any],
    evidence: Mapping[str, Any],
    *,
    manifest_base: Path,
) -> dict[str, Any]:
    updated: dict[str, Any] = json.loads(json.dumps(manifest, ensure_ascii=False))
    dataset: str = str(evidence["dataset"])
    normalized_evidence: dict[str, Any] = dict(evidence)
    normalized_evidence["evidence_path"] = _relative_or_absolute(Path(str(evidence["evidence_path"])), base=manifest_base)
    if evidence.get("structured_payload_path"):
        normalized_evidence["structured_payload_path"] = _relative_or_absolute(Path(str(evidence["structured_payload_path"])), base=manifest_base)
    acquisition: dict[str, Any] = updated.setdefault("data_acquisition", {})
    manual_items: list[Any] = acquisition.setdefault("manual_evidence", [])
    manual_items.append(normalized_evidence)
    status_by_dataset: dict[str, Any] = acquisition.setdefault("status_by_dataset", {})
    requested_statuses: dict[str, Any] = acquisition.setdefault("requested_dataset_statuses", {})
    status_by_dataset[dataset] = evidence["status"]
    requested_statuses[dataset] = evidence["status"]
    quality_key: Optional[str] = DATA_QUALITY_KEYS.get(dataset)
    if quality_key:
        updated.setdefault("data_quality", {})[quality_key] = evidence["status"]
    _register_attempt(updated, normalized_evidence)
    _update_result(updated, normalized_evidence)
    if evidence["status"] == "OK":
        _close_resolved_gaps(updated, dataset)
    _refresh_quality_caps(updated)
    return updated


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Register externally retrieved evidence into a Serenity manifest")
    parser.add_argument("manifest")
    parser.add_argument("evidence_file")
    parser.add_argument("--dataset", required=True)
    parser.add_argument("--source-name", required=True)
    parser.add_argument("--source-level", required=True, choices=sorted(SOURCE_LEVELS))
    parser.add_argument("--status", choices=["OK", "PARTIAL"], default="PARTIAL")
    parser.add_argument("--claim-boundary", required=True)
    parser.add_argument("--structured-payload")
    parser.add_argument("--notes", default="")
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    try:
        manifest_path = Path(args.manifest)
        evidence_path = Path(args.evidence_file)
        structured_payload_path = Path(args.structured_payload) if args.structured_payload else None
        if args.status == "OK" and args.source_level not in {"L0_OFFICIAL_DISCLOSURE", "L1_LICENSED_OR_PRO_DATABASE"}:
            raise ValueError("registered evidence can set status OK only for L0 or L1 sources")
        if args.status == "OK" and args.dataset in MACHINE_DATASETS and not structured_payload_path:
            raise ValueError("machine-consumable datasets require --structured-payload before status OK")
        evidence = build_manual_evidence(
            dataset=args.dataset,
            source_name=args.source_name,
            source_level=args.source_level,
            status=args.status,
            evidence_path=evidence_path,
            claim_boundary=args.claim_boundary,
            structured_payload_path=structured_payload_path,
            notes=args.notes,
        )
        errors = validate_manual_evidence(evidence)
        if errors:
            raise ValueError("; ".join(errors))
        manifest_payload = _load_json(manifest_path)
        if not isinstance(manifest_payload, Mapping):
            raise ValueError("manifest must contain a JSON object")
        updated = register_manual_evidence(manifest_payload, evidence, manifest_base=manifest_path.resolve().parent)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    _write_json(Path(args.out), updated)
    print(json.dumps({"ok": True, "out": args.out, "dataset": args.dataset, "status": args.status}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
