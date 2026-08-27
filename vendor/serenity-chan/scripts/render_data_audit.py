#!/usr/bin/env python3
"""Render a single-symbol data audit report from one fetch manifest.

This is the renderer for the Data audit and quick single-company routes.
It follows the data-audit template in references/05_output_templates.md:
market resolution, dataset statuses, gaps, research debt, manual tasks,
validation errors, and the resulting rating cap. It never invents analysis;
it only surfaces what the fetch layer actually produced.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence


def _load_json(path: Path) -> Mapping[str, Any]:
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _text(value: Any) -> str:
    return str(value if value is not None else "").strip()


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _cell(value: Any, *, empty: str = "-") -> str:
    text: str = _text(value)
    return text.replace("|", "\\|") if text else empty


def _dataset_rows(manifest: Mapping[str, Any]) -> list[str]:
    rows: list[str] = []
    for result in _as_list(manifest.get("results")):
        item: Mapping[str, Any] = _as_mapping(result)
        if not _text(item.get("dataset")):
            continue
        warnings: list[Any] = _as_list(item.get("warnings")) + _as_list(_as_mapping(item.get("validation")).get("warnings"))
        rows.append(
            "| {dataset} | {status} | {source} | {level} | {as_of} | {warnings} |".format(
                dataset=_cell(item.get("dataset")),
                status=_cell(item.get("status")),
                source=_cell(item.get("source")),
                level=_cell(item.get("source_level")),
                as_of=_cell(item.get("as_of_date") or item.get("retrieved_at"))[:19],
                warnings=_cell("; ".join(_text(w) for w in warnings[:3])),
            )
        )
    return rows


def _gap_rows(manifest: Mapping[str, Any]) -> list[str]:
    acquisition: Mapping[str, Any] = _as_mapping(manifest.get("data_acquisition"))
    rows: list[str] = []
    for gap in _as_list(acquisition.get("data_gaps")):
        item: Mapping[str, Any] = _as_mapping(gap)
        rows.append(
            "| {dataset} | {gap_type} | {impact} | {rating} | {action} |".format(
                dataset=_cell(item.get("dataset")),
                gap_type=_cell(item.get("gap_type")),
                impact=_cell(item.get("decision_impact")),
                rating=_cell(item.get("rating_impact")),
                action=_cell(item.get("next_action")),
            )
        )
    return rows


def _manual_task_rows(manifest: Mapping[str, Any]) -> list[str]:
    acquisition: Mapping[str, Any] = _as_mapping(manifest.get("data_acquisition"))
    rows: list[str] = []
    for task in _as_list(acquisition.get("manual_retrieval_tasks")):
        item: Mapping[str, Any] = _as_mapping(task)
        rows.append(
            "| {dataset} | {priority} | {target} | {objective} |".format(
                dataset=_cell(item.get("dataset")),
                priority=_cell(item.get("priority")),
                target=_cell(item.get("target_source")),
                objective=_cell(item.get("objective")),
            )
        )
    return rows


def _validation_errors(manifest: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    for result in _as_list(manifest.get("results")):
        item: Mapping[str, Any] = _as_mapping(result)
        for error in _as_list(item.get("errors")) + _as_list(_as_mapping(item.get("validation")).get("errors")):
            text: str = _text(error)
            if text:
                errors.append(f"- {item.get('dataset')}: {text}")
    return errors


def _valuation_lines(manifest: Mapping[str, Any]) -> list[str]:
    for result in _as_list(manifest.get("results")):
        item: Mapping[str, Any] = _as_mapping(result)
        if item.get("dataset") != "valuation_inputs":
            continue
        stats: Mapping[str, Any] = _as_mapping(_as_mapping(item.get("validation")).get("stats"))
        if not stats:
            break
        return [
            "## 5. 估值输入快照",
            f"- 当前价可用：{stats.get('has_regular_market_price')}",
            f"- 总股本可用：{stats.get('has_total_shares')}",
            f"- 总市值可用：{stats.get('has_total_market_cap')}",
            f"- 隐含总市值：{stats.get('implied_total_market_cap', '-')}",
            f"- 市值口径偏差：{stats.get('market_cap_diff_ratio', '-')}",
            "",
        ]
    return [
        "## 5. 估值输入快照",
        "- 估值输入不可用或未请求；市场隐含增长与估值赔率保持门控。",
        "",
    ]


def render_data_audit(manifest: Mapping[str, Any], *, manifest_path: str = "") -> str:
    symbol: Mapping[str, Any] = _as_mapping(manifest.get("symbol"))
    acquisition: Mapping[str, Any] = _as_mapping(manifest.get("data_acquisition"))
    quality: Mapping[str, Any] = _as_mapping(manifest.get("data_quality"))
    if not _text(symbol.get("symbol")):
        raise ValueError("manifest.symbol.symbol is required")
    lines: list[str] = [
        f"# {symbol.get('symbol')} 数据审计报告",
        "",
        "## 1. Market Resolution",
        f"- Input：{_cell(symbol.get('input_value') or symbol.get('symbol'))}",
        f"- Normalized：{_cell(symbol.get('symbol'))}",
        f"- Market：{_cell(symbol.get('market'))}",
        f"- Exchange：{_cell(symbol.get('exchange'))}",
        f"- Currency：{_cell(symbol.get('currency'))}",
        f"- Retrieved at：{_cell(manifest.get('retrieved_at'))}",
        "",
        "## 2. Data Manifest",
        "| Dataset | Status | Source | Level | As-of | Warnings |",
        "|---|---|---|---|---|---|",
        *(_dataset_rows(manifest) or ["| - | - | - | - | - | - |"]),
        "",
        "## 3. Data Gaps And Research Debt",
    ]
    gap_rows: list[str] = _gap_rows(manifest)
    if gap_rows:
        lines.extend([
            "| Dataset | Gap Type | Decision Impact | Rating Impact | Next Action |",
            "|---|---|---|---|---|",
            *gap_rows,
        ])
    else:
        lines.append("- 无数据缺口（gap_count=0）。")
    lines.extend(["", "## 4. Manual Retrieval Tasks"])
    task_rows: list[str] = _manual_task_rows(manifest)
    if task_rows:
        lines.extend([
            "| Dataset | Priority | Target Source | Objective |",
            "|---|---|---|---|",
            *task_rows,
        ])
    else:
        lines.append("- 无待补任务。")
    lines.append("")
    lines.extend(_valuation_lines(manifest))
    errors: list[str] = _validation_errors(manifest)
    lines.extend([
        "## 6. Validation Errors",
        *(errors or ["- 无校验错误。"]),
        "",
        "## 7. Rating Cap",
        f"- 当前请求范围评级上限：{_cell(quality.get('requested_data_rating_cap'))}",
        f"- 完整研究评级上限：{_cell(quality.get('full_research_rating_cap') or quality.get('rating_cap'))}",
        f"- full_research_ready：{acquisition.get('full_research_ready')}",
        f"- 取数尝试：{acquisition.get('attempt_count', 0)} 次；缺口 {acquisition.get('gap_count', 0)}；研究债务 {acquisition.get('research_debt_count', 0)}；补数任务 {acquisition.get('manual_task_count', 0)}",
        "",
        "> 本报告只呈现取数与校验事实，不构成研究结论。深入单股研究请按 references/05_output_templates.md 的单股 memo 模板执行。",
    ])
    if manifest_path:
        lines.append(f"> manifest: {manifest_path}")
    return "\n".join(lines)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Render a single-symbol data audit report")
    parser.add_argument("manifest", help="fetch manifest.json produced by data_router fetch")
    parser.add_argument("--out", help="write Markdown to this path instead of stdout")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        manifest_path: Path = Path(args.manifest)
        markdown: str = render_data_audit(_load_json(manifest_path), manifest_path=str(manifest_path.resolve()))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    if args.out:
        out_path: Path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(markdown + "\n", encoding="utf-8")
    else:
        print(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
