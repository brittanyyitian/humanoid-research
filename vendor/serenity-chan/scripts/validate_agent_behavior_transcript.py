#!/usr/bin/env python3
"""Validate transcript-level adherence to the Serenity operating contract."""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence


CONTRACT_TYPE: str = "serenity_agent_behavior_case"
SCHEMA_VERSION: str = "1.0"


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _text(value: Any) -> str:
    return str(value or "")


def validate_agent_behavior_case(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != CONTRACT_TYPE:
        errors.append(f"contract_type must be {CONTRACT_TYPE}")
    if payload.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    transcript: str = _text(payload.get("transcript"))
    if not transcript.strip():
        errors.append("transcript must not be empty")
    expectations: Any = payload.get("expectations")
    if not isinstance(expectations, Mapping):
        errors.append("expectations must be an object")
        return errors

    for pattern in _as_list(expectations.get("required_patterns")):
        try:
            if not re.search(str(pattern), transcript, re.I | re.S):
                errors.append(f"required pattern not found: {pattern}")
        except re.error as exc:
            errors.append(f"invalid required regex {pattern!r}: {exc}")
    for pattern in _as_list(expectations.get("forbidden_patterns")):
        try:
            if re.search(str(pattern), transcript, re.I | re.S):
                errors.append(f"forbidden pattern found: {pattern}")
        except re.error as exc:
            errors.append(f"invalid forbidden regex {pattern!r}: {exc}")
    for command in _as_list(expectations.get("required_commands")):
        if str(command) not in transcript:
            errors.append(f"required command not found: {command}")
    for artifact in _as_list(expectations.get("required_artifacts")):
        if str(artifact) not in transcript:
            errors.append(f"required artifact not found: {artifact}")
    return errors


def _load_json(path: Path) -> Mapping[str, Any]:
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Validate Serenity transcript-level agent behavior")
    parser.add_argument("case")
    parser.add_argument("--json", action="store_true")
    args = parser.parse_args(argv)
    try:
        payload = _load_json(Path(args.case))
        errors = validate_agent_behavior_case(payload)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    result = {"ok": not errors, "errors": errors}
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        print(("OK" if not errors else "FAILED") + f": {args.case}")
        for error in errors:
            print(f"- ERROR {error}")
    return 0 if not errors else 1


if __name__ == "__main__":
    raise SystemExit(main())
