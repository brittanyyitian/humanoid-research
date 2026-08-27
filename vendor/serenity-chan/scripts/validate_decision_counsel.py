#!/usr/bin/env python3
"""Validate and render AI-written decision counsel against its decision brief.

The counsel is where AI judgment is allowed to be bold — but inside a
contract: every briefed action gets exactly one stance with rationale, risk,
and invalidation; observed/inferred/judgment stay separated; position-sizing
language is forbidden without a portfolio context; and HIGH confidence must
be earned by calibration history, not asserted.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

CONTRACT_TYPE: str = "serenity_decision_counsel"
SCHEMA_VERSION: str = "1.0"
STANCES: set[str] = {"EXECUTE", "DEFER", "SKIP"}
HIGH_CONFIDENCE_MIN_RESOLVED: int = 5
# 加仓/减仓/建仓/清仓/仓位 + a number% (or Chinese 成) = sizing language
_SIZING_RE = re.compile(r"(加仓|减仓|建仓|清仓|仓位|position)\D{0,8}\d+(\.\d+)?\s*(%|成)", re.IGNORECASE)


def _text(value: Any) -> str:
    return str(value or "").strip()


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _load_json(path: Path) -> Mapping[str, Any]:
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _counsel_text_blob(counsel: Mapping[str, Any]) -> str:
    parts: list[str] = [_text(counsel.get("market_view"))]
    for key in ["observed", "inferred", "judgment", "boundaries"]:
        parts.extend(_text(item) for item in _as_list(counsel.get(key)))
    for row in _as_list(counsel.get("action_counsel")):
        item: Mapping[str, Any] = _as_mapping(row)
        parts.extend(_text(item.get(key)) for key in ["rationale", "risk", "invalidation"])
    for row in _as_list(counsel.get("watch_counsel")):
        parts.append(_text(_as_mapping(row).get("view")))
    parts.append(_text(_as_mapping(counsel.get("portfolio_counsel")).get("text")))
    parts.append(_text(counsel.get("next_review")))
    return "\n".join(parts)


def validate_decision_counsel(
    counsel: Mapping[str, Any],
    *,
    brief: Optional[Mapping[str, Any]] = None,
) -> list[str]:
    errors: list[str] = []
    if counsel.get("contract_type") != CONTRACT_TYPE:
        errors.append(f"contract_type must be {CONTRACT_TYPE}")
    if counsel.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    if len(_text(counsel.get("market_view"))) < 8:
        errors.append("market_view must be a substantive statement")
    for key, minimum in [("observed", 2), ("inferred", 1), ("judgment", 1), ("boundaries", 1)]:
        items: list[Any] = [item for item in _as_list(counsel.get(key)) if _text(item)]
        if len(items) < minimum:
            errors.append(f"{key} needs at least {minimum} non-empty item(s)")
    if counsel.get("confidence") not in {"LOW", "MEDIUM", "HIGH"}:
        errors.append("confidence must be LOW, MEDIUM, or HIGH")
    if len(_text(counsel.get("next_review"))) < 4:
        errors.append("next_review must state when/what to revisit")

    portfolio_counsel: Mapping[str, Any] = _as_mapping(counsel.get("portfolio_counsel"))
    if not isinstance(portfolio_counsel.get("applicable"), bool):
        errors.append("portfolio_counsel.applicable must be boolean")

    rows: list[Any] = _as_list(counsel.get("action_counsel"))
    if not rows:
        errors.append("action_counsel must not be empty")
    seen_indexes: set[int] = set()
    for position, row in enumerate(rows):
        item: Mapping[str, Any] = _as_mapping(row)
        label: str = f"action_counsel[{position}]"
        index: Any = item.get("action_index")
        if not isinstance(index, int) or index < 1:
            errors.append(f"{label}.action_index must be a positive integer")
            continue
        if index in seen_indexes:
            errors.append(f"{label}: duplicate stance for action {index}")
        seen_indexes.add(index)
        if item.get("stance") not in STANCES:
            errors.append(f"{label}.stance must be one of {sorted(STANCES)}")
        for key in ["rationale", "risk", "invalidation"]:
            if len(_text(item.get(key))) < 4:
                errors.append(f"{label}.{key} must be substantive")

    if brief is not None:
        brief_actions: list[Any] = _as_list(brief.get("actions"))
        expected: set[int] = set(range(1, len(brief_actions) + 1))
        if seen_indexes != expected:
            missing: list[int] = sorted(expected - seen_indexes)
            extra: list[int] = sorted(seen_indexes - expected)
            if missing:
                errors.append(f"every briefed action needs a stance; missing action_index: {missing}")
            if extra:
                errors.append(f"action_index beyond the brief's action list: {extra}")
        for row in rows:
            item = _as_mapping(row)
            index = item.get("action_index")
            if isinstance(index, int) and 1 <= index <= len(brief_actions):
                brief_kind: str = _text(_as_mapping(brief_actions[index - 1]).get("kind"))
                if _text(item.get("kind")) != brief_kind:
                    errors.append(
                        f"action_counsel for action {index} declares kind {item.get('kind')!r} but the brief says {brief_kind!r}"
                    )
        if _text(counsel.get("source_brief_generated_at")) != _text(brief.get("generated_at")):
            errors.append("source_brief_generated_at must match the brief's generated_at (counsel is bound to one brief)")

        portfolio_provided: bool = bool(_as_mapping(brief.get("portfolio")).get("provided"))
        if portfolio_counsel.get("applicable") and not portfolio_provided:
            errors.append("portfolio_counsel.applicable=true but the brief has no portfolio context")
        if not portfolio_provided:
            match = _SIZING_RE.search(_counsel_text_blob(counsel))
            if match:
                errors.append(
                    f"position-sizing language is forbidden without portfolio context: {match.group(0)!r}"
                )
        resolved: Any = _as_mapping(brief.get("calibration")).get("resolved_claim_count")
        if counsel.get("confidence") == "HIGH" and (not isinstance(resolved, int) or resolved < HIGH_CONFIDENCE_MIN_RESOLVED):
            errors.append(
                f"HIGH confidence requires at least {HIGH_CONFIDENCE_MIN_RESOLVED} resolved calibration claims"
                f" (brief shows {resolved}); use MEDIUM or LOW until the track record exists"
            )
    return errors


def render_counsel_markdown(counsel: Mapping[str, Any], *, brief: Optional[Mapping[str, Any]] = None) -> str:
    brief_actions: list[Any] = _as_list(_as_mapping(brief).get("actions")) if brief else []
    lines: list[str] = [
        "# 决策咨询",
        "",
        f"- 基于简报：{_text(counsel.get('source_brief_generated_at'))[:19]}",
        f"- 置信度：{_text(counsel.get('confidence'))}",
        f"- 市场判读：{_text(counsel.get('market_view'))}",
        "",
        "## 事实 / 推断 / 判断",
    ]
    for key, title in [("observed", "观察到的"), ("inferred", "推断"), ("judgment", "判断")]:
        lines.append(f"**{title}**")
        lines.extend(f"- {_text(item)}" for item in _as_list(counsel.get(key)) if _text(item))
    lines.extend(["", "## 逐动作意见", "| # | 动作 | 表态 | 理由 | 风险 | 失效条件 |", "|---:|---|---|---|---|---|"])
    for row in _as_list(counsel.get("action_counsel")):
        item: Mapping[str, Any] = _as_mapping(row)
        index: Any = item.get("action_index")
        action_title: str = ""
        if isinstance(index, int) and 1 <= index <= len(brief_actions):
            action_title = _text(_as_mapping(brief_actions[index - 1]).get("title"))[:36]
        lines.append(
            "| {i} | {title} | **{stance}** | {rationale} | {risk} | {inval} |".format(
                i=index,
                title=(action_title or _text(item.get("kind"))).replace("|", "\\|"),
                stance=_text(item.get("stance")),
                rationale=_text(item.get("rationale")).replace("|", "\\|"),
                risk=_text(item.get("risk")).replace("|", "\\|"),
                inval=_text(item.get("invalidation")).replace("|", "\\|"),
            )
        )
    watch_rows: list[Any] = _as_list(counsel.get("watch_counsel"))
    if watch_rows:
        lines.extend(["", "## 逐标的观点"])
        lines.extend(
            f"- **{_text(_as_mapping(row).get('symbol'))}**：{_text(_as_mapping(row).get('view'))}"
            for row in watch_rows
        )
    portfolio_counsel: Mapping[str, Any] = _as_mapping(counsel.get("portfolio_counsel"))
    lines.extend([
        "",
        "## 组合层意见",
        f"- {'适用' if portfolio_counsel.get('applicable') else '不适用（无持仓上下文，不含任何仓位建议）'}：{_text(portfolio_counsel.get('text'))}",
        "",
        "## 边界",
    ])
    lines.extend(f"- {_text(item)}" for item in _as_list(counsel.get("boundaries")) if _text(item))
    lines.extend(["", f"**下次复核**：{_text(counsel.get('next_review'))}"])
    return "\n".join(lines)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Validate and render Serenity decision counsel")
    parser.add_argument("counsel", help="decision_counsel JSON path")
    parser.add_argument("--brief", help="decision_brief JSON the counsel answers (enables cross-checks)")
    parser.add_argument("--md-out", help="render validated counsel to Markdown")
    parser.add_argument("--json", action="store_true", help="emit machine-readable result")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        counsel: Mapping[str, Any] = _load_json(Path(args.counsel))
        brief: Optional[Mapping[str, Any]] = _load_json(Path(args.brief)) if args.brief else None
        errors: list[str] = validate_decision_counsel(counsel, brief=brief)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps({"ok": not errors, "errors": errors}, ensure_ascii=False, indent=2))
    else:
        print(("OK" if not errors else "FAILED") + f": {args.counsel}")
        for error in errors:
            print(f"- ERROR {error}")
    if errors:
        return 1
    if args.md_out:
        md_path: Path = Path(args.md_out)
        md_path.parent.mkdir(parents=True, exist_ok=True)
        md_path.write_text(render_counsel_markdown(counsel, brief=brief) + "\n", encoding="utf-8")
        print(f"rendered: {md_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
