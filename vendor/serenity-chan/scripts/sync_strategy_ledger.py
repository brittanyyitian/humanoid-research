#!/usr/bin/env python3
"""Sync a Serenity Laplace strategy judgment into the companion forecast ledger."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:
    from validate_laplace_strategy_input import validate_strategy_input
    from validate_laplace_strategy_judgment import validate_strategy_judgment
except ModuleNotFoundError:  # pragma: no cover
    from scripts.validate_laplace_strategy_input import validate_strategy_input
    from scripts.validate_laplace_strategy_judgment import validate_strategy_judgment


CONTRACT_TYPE: str = "serenity_strategy_ledger_sync"
SCHEMA_VERSION: str = "1.0"
DEFAULT_LEDGER_PATH: str = "~/.cache/serenity-chan/forecast-ledger.sqlite"


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


def _safe_float(value: Any, default: float = 0.5) -> float:
    try:
        number: float = float(value)
    except (TypeError, ValueError):
        return default
    return min(1.0, max(0.0, number))


def _iso_datetime(value: Any) -> str:
    text: str = _text(value)
    if not text:
        return datetime.now(timezone.utc).isoformat()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return f"{text}T00:00:00+00:00"
    return text


def _record_id(strategy_input_path: Path, judgment: Mapping[str, Any]) -> str:
    basis: str = "|".join(
        [
            str(strategy_input_path.resolve()),
            _text(judgment.get("as_of_date")),
            _text(judgment.get("forecast")),
            _text(judgment.get("decision")),
        ]
    )
    digest: str = hashlib.sha256(basis.encode("utf-8")).hexdigest()[:18]
    return f"serenity_{digest}"


def _average_probability(claims: Sequence[Mapping[str, Any]]) -> float:
    values: list[float] = [_safe_float(claim.get("probability")) for claim in claims]
    return sum(values) / len(values) if values else 0.5


def _claim_record(claim: Mapping[str, Any], index: int) -> dict[str, Any]:
    record: dict[str, Any] = {
        "id": _text(claim.get("id")) or f"c{index}",
        "statement": _text(claim.get("claim")),
        "probability": _safe_float(claim.get("probability")),
        "resolution_date": _iso_datetime(claim.get("resolution_date")),
        "resolution_criteria": _text(claim.get("resolution_criteria")),
    }
    if isinstance(claim.get("resolution_probe"), Mapping):
        record["resolution_probe"] = dict(_as_mapping(claim.get("resolution_probe")))
    if _text(claim.get("source_symbol")):
        record["source_symbol"] = _text(claim.get("source_symbol"))
    return record


def build_forecast_record(
    strategy_input: Mapping[str, Any],
    judgment: Mapping[str, Any],
    *,
    strategy_input_path: Path,
) -> dict[str, Any]:
    decision_context: Mapping[str, Any] = _as_mapping(strategy_input.get("decision_context"))
    ledger_seed: Mapping[str, Any] = _as_mapping(strategy_input.get("ledger_seed"))
    raw_claims: list[Mapping[str, Any]] = [claim for claim in _as_list(judgment.get("ledger_claims")) if isinstance(claim, Mapping)]
    if not raw_claims:
        raise ValueError("strategy judgment must include at least one ledger_claim for calibration")
    claims: list[dict[str, Any]] = [_claim_record(claim, index) for index, claim in enumerate(raw_claims, start=1)]
    empty_claims: list[str] = [claim["id"] for claim in claims if not claim["statement"] or not claim["resolution_criteria"]]
    if empty_claims:
        raise ValueError("ledger_claims contain empty claim or resolution_criteria: " + ", ".join(empty_claims))
    scenario_map: Mapping[str, Any] = _as_mapping(judgment.get("scenarios"))
    scenarios: list[dict[str, Any]] = []
    for scenario_id, default_name in [("base", "Base"), ("upside", "Upside"), ("downside", "Downside")]:
        scenario: Mapping[str, Any] = _as_mapping(scenario_map.get(scenario_id))
        scenarios.append(
            {
                "id": scenario_id,
                "name": default_name,
                "probability": _safe_float(scenario.get("probability"), 1.0 / 3.0),
                "description": _text(scenario.get("summary")),
            }
        )
    probability_total: float = sum(float(item["probability"]) for item in scenarios)
    if probability_total:
        for item in scenarios:
            item["probability"] = float(item["probability"]) / probability_total
    next_evidence: list[dict[str, Any]] = []
    for index, item in enumerate(_as_list(judgment.get("next_evidence")), start=1):
        if not _text(item):
            continue
        next_evidence.append(
            {
                "id": f"e{index}",
                "signal": _text(item),
                "why": "用于复核 Serenity 策略判断是否仍然成立。",
                "check_by": claims[min(index - 1, len(claims) - 1)]["resolution_date"],
                "status": "open",
            }
        )
    if not next_evidence:
        next_evidence = [
            {
                "id": "e1",
                "signal": claims[0]["resolution_criteria"],
                "why": "用于结算首个 Serenity 策略 claim。",
                "check_by": claims[0]["resolution_date"],
                "status": "open",
            }
        ]
    average_probability: float = _average_probability(raw_claims)
    return {
        "id": _record_id(strategy_input_path, judgment),
        "question": _text(ledger_seed.get("question")) or _text(judgment.get("forecast")),
        "horizon": _text(ledger_seed.get("horizon")) or _text(decision_context.get("horizon")),
        "object": _text(ledger_seed.get("object")) or _text(decision_context.get("object")),
        "geography": _text(ledger_seed.get("geography")) or _text(decision_context.get("geography")),
        "decision_use": _text(ledger_seed.get("decision_use")) or _text(decision_context.get("decision_use")),
        "decision_profiles": [
            {
                "id": _text(decision_context.get("default_profile")) or "balanced",
                "label": _text(decision_context.get("default_profile")) or "balanced",
                "recommendation": _text(judgment.get("decision")),
                "constraints": "Respect Serenity evidence gates, invalidation, and review cadence.",
                "reversibility": "medium",
                "default": True,
            }
        ],
        "base_rate": {
            "summary": "Serenity evidence-gated strategy claims with explicit resolution dates.",
            "reference_class": "AI-assisted equity strategy judgments after data-first Serenity screening",
            "analogue": _text(decision_context.get("object")),
            "notes": "Prior probability is seeded from the average of claim-level probabilities.",
            "prior_probability": average_probability,
        },
        "claims": claims,
        "scenarios": scenarios,
        "current_state": {
            "thesis": _text(judgment.get("forecast")),
            "confidence": _text(judgment.get("confidence")) or "MEDIUM",
            "evidence_ceiling": " / ".join(_text(item) for item in _as_list(judgment.get("invalidation")) if _text(item)),
            "next_evidence": next_evidence,
            "revisit_at": claims[0]["resolution_date"],
        },
        "notes": "Synced from serenity_laplace_strategy_judgment.",
    }


def _ledger_path(raw_path: Optional[str]) -> Path:
    value: str = raw_path or os.environ.get("SERENITY_FORECAST_LEDGER_PATH", DEFAULT_LEDGER_PATH)
    return Path(value).expanduser()


def _forecast_ledger_script(root: Path) -> Path:
    return root / "companion-skills" / "laplace-forecast" / "scripts" / "forecast_ledger.py"


def sync_record(record: Mapping[str, Any], *, ledger_path: Path, root: Path) -> dict[str, Any]:
    script_path: Path = _forecast_ledger_script(root)
    with tempfile.TemporaryDirectory(prefix="serenity-ledger-sync-") as temp_dir:
        record_path: Path = Path(temp_dir) / "forecast_record.json"
        record_path.write_text(json.dumps(record, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        completed: subprocess.CompletedProcess[str] = subprocess.run(
            [sys.executable, str(script_path), "add", "--path", str(ledger_path), "--record-file", str(record_path)],
            check=False,
            capture_output=True,
            text=True,
        )
    stderr: str = completed.stderr.strip()
    stdout: str = completed.stdout.strip()
    if completed.returncode == 0:
        return {"status": "SYNCED", "ledger_id": stdout, "message": ""}
    if "entry id already exists" in stderr:
        return {"status": "ALREADY_EXISTS", "ledger_id": _text(record.get("id")), "message": stderr}
    raise RuntimeError(stderr or stdout or "forecast ledger add failed")


def build_sync_report(
    strategy_input_path: Path,
    judgment_path: Path,
    *,
    ledger_path: Path,
    root: Path,
    write_ledger: bool,
) -> dict[str, Any]:
    strategy_input: Mapping[str, Any] = _load_json(strategy_input_path)
    input_errors: list[str] = validate_strategy_input(strategy_input)
    if input_errors:
        raise ValueError("strategy_input invalid: " + "; ".join(input_errors))
    judgment: Mapping[str, Any] = _load_json(judgment_path)
    judgment_errors: list[str] = validate_strategy_judgment(judgment, strategy_input_path=strategy_input_path)
    if judgment_errors:
        raise ValueError("strategy_judgment invalid: " + "; ".join(judgment_errors))
    record: dict[str, Any] = build_forecast_record(strategy_input, judgment, strategy_input_path=strategy_input_path)
    sync_result: dict[str, Any] = {"status": "DRY_RUN", "ledger_id": record["id"], "message": ""}
    if write_ledger:
        sync_result = sync_record(record, ledger_path=ledger_path, root=root)
    return {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_strategy_input_path": str(strategy_input_path.resolve()),
        "source_judgment_path": str(judgment_path.resolve()),
        "ledger_path": str(ledger_path),
        "write_ledger": write_ledger,
        "sync_status": sync_result["status"],
        "ledger_id": sync_result["ledger_id"],
        "message": sync_result["message"],
        "claim_count": len(record["claims"]),
        "record": record,
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Sync Serenity strategy judgment into Laplace forecast ledger")
    parser.add_argument("--strategy-input", required=True)
    parser.add_argument("--judgment", required=True)
    parser.add_argument("--ledger")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--out")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        root: Path = Path(__file__).resolve().parents[1]
        payload: dict[str, Any] = build_sync_report(
            Path(args.strategy_input),
            Path(args.judgment),
            ledger_path=_ledger_path(args.ledger),
            root=root,
            write_ledger=not bool(args.dry_run),
        )
        text: str = json.dumps(payload, ensure_ascii=False, indent=2)
        if args.out:
            Path(args.out).write_text(text + "\n", encoding="utf-8")
        else:
            print(text)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
