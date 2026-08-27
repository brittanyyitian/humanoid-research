#!/usr/bin/env python3
"""Build a machine-readable validation proof for a formal Serenity delivery."""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import json
import subprocess
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence


CONTRACT_TYPE: str = "serenity_delivery_proof"
SCHEMA_VERSION: str = "1.0"


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _tail(value: str, *, max_chars: int = 2000) -> str:
    return value[-max_chars:] if len(value) > max_chars else value


def _run_validator(name: str, command: Sequence[str], *, cwd: Path) -> dict[str, Any]:
    completed = subprocess.run(
        list(command),
        cwd=str(cwd),
        check=False,
        capture_output=True,
        text=True,
        timeout=120,
    )
    return {
        "name": name,
        "command": [str(part) for part in command],
        "exit_code": int(completed.returncode),
        "status": "PASS" if completed.returncode == 0 else "FAIL",
        "stdout_tail": _tail(completed.stdout.strip()),
        "stderr_tail": _tail(completed.stderr.strip()),
    }


def build_delivery_proof(
    comparison_report: Path,
    *,
    markdown_report: Optional[Path] = None,
    python_executable: str = sys.executable,
) -> dict[str, Any]:
    root: Path = _repo_root()
    artifacts: list[dict[str, str]] = [
        {
            "role": "comparison_report",
            "path": str(comparison_report.resolve()),
            "sha256": _sha256(comparison_report),
        }
    ]
    validators: list[dict[str, Any]] = [
        _run_validator(
            "comparison_report_contract",
            [python_executable, "scripts/validate_comparison_report.py", str(comparison_report)],
            cwd=root,
        ),
        _run_validator(
            "formal_delivery_readiness",
            [python_executable, "scripts/validate_research_delivery.py", str(comparison_report)],
            cwd=root,
        ),
        _run_validator(
            "strategy_readiness_contract",
            [python_executable, "scripts/validate_strategy_readiness.py", str(comparison_report)],
            cwd=root,
        ),
    ]
    if markdown_report:
        artifacts.append({
            "role": "markdown_report",
            "path": str(markdown_report.resolve()),
            "sha256": _sha256(markdown_report),
        })
        validators.append(
            _run_validator(
                "markdown_output_contract",
                [python_executable, "scripts/validate_output_contract.py", str(markdown_report), "--require-delivery-proof"],
                cwd=root,
            )
        )
    all_passed: bool = all(row.get("status") == "PASS" for row in validators)
    return {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "proof_status": "PASS" if all_passed else "FAIL",
        "all_passed": all_passed,
        "artifacts": artifacts,
        "validators": validators,
    }


def validate_delivery_proof(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != CONTRACT_TYPE:
        errors.append(f"contract_type must be {CONTRACT_TYPE}")
    if payload.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    validators: Any = payload.get("validators")
    if not isinstance(validators, list) or not validators:
        errors.append("validators must be a non-empty array")
    else:
        for index, row in enumerate(validators):
            if not isinstance(row, Mapping):
                errors.append(f"validators[{index}] must be an object")
                continue
            if row.get("status") not in {"PASS", "FAIL"}:
                errors.append(f"validators[{index}].status is invalid")
            if not isinstance(row.get("exit_code"), int):
                errors.append(f"validators[{index}].exit_code must be integer")
            command: Any = row.get("command")
            if not isinstance(command, list) or not command:
                errors.append(f"validators[{index}].command must be a non-empty array")
    artifacts: Any = payload.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        errors.append("artifacts must be a non-empty array")
    else:
        for index, artifact in enumerate(artifacts):
            if not isinstance(artifact, Mapping):
                errors.append(f"artifacts[{index}] must be an object")
                continue
            if not str(artifact.get("role") or "").strip():
                errors.append(f"artifacts[{index}].role must not be empty")
            digest: str = str(artifact.get("sha256") or "")
            if len(digest) != 64 or any(ch not in "0123456789abcdef" for ch in digest):
                errors.append(f"artifacts[{index}].sha256 must be lowercase sha256")
    all_passed: Any = payload.get("all_passed")
    if not isinstance(all_passed, bool):
        errors.append("all_passed must be boolean")
    expected_status: str = "PASS" if all_passed is True else "FAIL"
    if payload.get("proof_status") != expected_status:
        errors.append("proof_status must match all_passed")
    return errors


def _artifact_by_role(payload: Mapping[str, Any]) -> dict[str, Mapping[str, Any]]:
    indexed: dict[str, Mapping[str, Any]] = {}
    artifacts: Any = payload.get("artifacts")
    for artifact in artifacts if isinstance(artifacts, list) else []:
        if isinstance(artifact, Mapping) and str(artifact.get("role") or ""):
            indexed[str(artifact.get("role"))] = artifact
    return indexed


def verify_delivery_proof(
    payload: Mapping[str, Any],
    *,
    comparison_report: Optional[Path] = None,
    markdown_report: Optional[Path] = None,
) -> list[str]:
    errors: list[str] = validate_delivery_proof(payload)
    if payload.get("proof_status") != "PASS" or payload.get("all_passed") is not True:
        errors.append("delivery proof must be PASS for formal verification")
    validators: Any = payload.get("validators")
    for index, row in enumerate(validators if isinstance(validators, list) else []):
        if not isinstance(row, Mapping):
            continue
        if row.get("status") != "PASS" or row.get("exit_code") != 0:
            errors.append(f"validators[{index}] must have PASS status and exit_code 0")
    artifacts = _artifact_by_role(payload)

    def verify_artifact(role: str, expected_path: Optional[Path]) -> None:
        artifact: Mapping[str, Any] = artifacts.get(role, {})
        if not artifact:
            errors.append(f"missing {role} artifact")
            return
        artifact_path = Path(str(artifact.get("path") or ""))
        if expected_path is not None and artifact_path.resolve() != expected_path.resolve():
            errors.append(f"{role} artifact path does not match expected path")
        if not artifact_path.is_file():
            errors.append(f"{role} artifact file does not exist: {artifact_path}")
            return
        actual_digest = _sha256(artifact_path)
        if actual_digest != str(artifact.get("sha256") or ""):
            errors.append(f"{role} artifact sha256 mismatch")

    verify_artifact("comparison_report", comparison_report)
    if markdown_report is not None or "markdown_report" in artifacts:
        verify_artifact("markdown_report", markdown_report)
    return errors


# Only known validator scripts may be re-executed from a proof file, and always
# through the current interpreter: a proof is untrusted input and must never be
# able to run arbitrary commands.
RERUNNABLE_VALIDATORS: set[str] = {
    "validate_comparison_report.py",
    "validate_research_delivery.py",
    "validate_strategy_readiness.py",
    "validate_output_contract.py",
}


def rerun_proof_validators(payload: Mapping[str, Any]) -> list[str]:
    """Re-execute recorded validator commands and compare exit codes."""
    root: Path = _repo_root()
    errors: list[str] = []
    validators: Any = payload.get("validators")
    if not isinstance(validators, list) or not validators:
        return ["validators must be a non-empty array"]
    for index, row in enumerate(validators):
        if not isinstance(row, Mapping):
            errors.append(f"validators[{index}] must be an object")
            continue
        command: Any = row.get("command")
        if not isinstance(command, list) or len(command) < 2:
            errors.append(f"validators[{index}].command is not re-runnable")
            continue
        script_arg: str = str(command[1])
        script_name: str = Path(script_arg).name
        if script_name not in RERUNNABLE_VALIDATORS:
            errors.append(f"validators[{index}] references unknown validator: {script_name}")
            continue
        rerun_command: list[str] = [sys.executable, str(root / "scripts" / script_name), *[str(part) for part in command[2:]]]
        completed = subprocess.run(rerun_command, cwd=str(root), check=False, capture_output=True, text=True, timeout=120)
        if completed.returncode != int(row.get("exit_code", -1)):
            errors.append(
                f"validators[{index}] ({row.get('name')}) exit changed on rerun: recorded {row.get('exit_code')}, got {completed.returncode}"
            )
        if completed.returncode != 0:
            errors.append(f"validators[{index}] ({row.get('name')}) fails on rerun (exit {completed.returncode})")
    return errors


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Build Serenity formal delivery proof")
    parser.add_argument("comparison_report", nargs="?")
    parser.add_argument("--markdown-report", help="final Markdown report that already contains a delivery proof block")
    parser.add_argument("--python", default=sys.executable, help="Python executable used to run validators")
    parser.add_argument("--out", help="write proof JSON")
    parser.add_argument("--verify", help="verify an existing delivery_proof.json instead of building a new proof")
    parser.add_argument(
        "--rerun-validators",
        action="store_true",
        help="with --verify: re-execute the recorded validators (allowlisted scripts only) and compare exit codes",
    )
    args = parser.parse_args(argv)

    try:
        if args.verify:
            proof_payload: Any = json.loads(Path(args.verify).read_text(encoding="utf-8"))
            if not isinstance(proof_payload, Mapping):
                raise ValueError("proof JSON must contain an object")
            errors = verify_delivery_proof(
                proof_payload,
                comparison_report=Path(args.comparison_report) if args.comparison_report else None,
                markdown_report=Path(args.markdown_report) if args.markdown_report else None,
            )
            if args.rerun_validators:
                errors.extend(rerun_proof_validators(proof_payload))
            proof = dict(proof_payload)
        else:
            if not args.comparison_report:
                raise ValueError("comparison_report is required when building a delivery proof")
            proof = build_delivery_proof(
                Path(args.comparison_report),
                markdown_report=Path(args.markdown_report) if args.markdown_report else None,
                python_executable=args.python,
            )
            errors = validate_delivery_proof(proof)
        if errors:
            raise ValueError("; ".join(errors))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    text = json.dumps(proof, ensure_ascii=False, indent=2)
    if args.out:
        out_path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0 if proof["all_passed"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
