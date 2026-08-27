#!/usr/bin/env python3
"""Append a compact delivery-proof block to a Serenity Markdown report."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:
    from build_delivery_proof import validate_delivery_proof
except ModuleNotFoundError:  # pragma: no cover
    from scripts.build_delivery_proof import validate_delivery_proof


def _load_json(path: Path) -> Mapping[str, Any]:
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def render_proof_block(proof: Mapping[str, Any]) -> str:
    errors: list[str] = validate_delivery_proof(proof)
    if errors:
        raise ValueError("; ".join(errors))
    if proof.get("all_passed") is not True or proof.get("proof_status") != "PASS":
        raise ValueError("delivery proof must pass before it can be appended to a formal report")
    lines: list[str] = [
        "## 交付验证凭证",
        f"- proof_status: {proof.get('proof_status')}",
        f"- all_passed: {str(proof.get('all_passed')).lower()}",
        "- artifacts:",
    ]
    for artifact in _as_list(proof.get("artifacts")):
        if isinstance(artifact, Mapping):
            lines.append(
                f"  - {artifact.get('role')}: `{artifact.get('path')}` sha256={artifact.get('sha256')}"
            )
    lines.append("- validators:")
    for validator in _as_list(proof.get("validators")):
        if not isinstance(validator, Mapping):
            continue
        command = " ".join(str(part) for part in _as_list(validator.get("command")))
        lines.append(
            f"  - {validator.get('name')}: status={validator.get('status')} exit={validator.get('exit_code')} command=`{command}`"
        )
    return "\n".join(lines).rstrip() + "\n"


def append_delivery_proof(markdown_path: Path, proof_path: Path, *, out_path: Path) -> None:
    markdown: str = markdown_path.read_text(encoding="utf-8").rstrip()
    proof: Mapping[str, Any] = _load_json(proof_path)
    block: str = render_proof_block(proof)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(markdown + "\n\n" + block, encoding="utf-8")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Append Serenity delivery proof to Markdown")
    parser.add_argument("markdown_report")
    parser.add_argument("delivery_proof")
    parser.add_argument("--out", required=True)
    args = parser.parse_args(argv)
    try:
        append_delivery_proof(Path(args.markdown_report), Path(args.delivery_proof), out_path=Path(args.out))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    print(json.dumps({"ok": True, "out": args.out}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
