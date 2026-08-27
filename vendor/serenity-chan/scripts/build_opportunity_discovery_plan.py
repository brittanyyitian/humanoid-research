#!/usr/bin/env python3
"""Build a structured opportunity discovery plan before candidate narrowing."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:
    from build_macro_theme_map import build_macro_theme_map
    from validate_macro_theme_map import validate_macro_theme_map
    from validate_opportunity_discovery_plan import validate_opportunity_discovery_plan
except ModuleNotFoundError:  # pragma: no cover
    from scripts.build_macro_theme_map import build_macro_theme_map
    from scripts.validate_macro_theme_map import validate_macro_theme_map
    from scripts.validate_opportunity_discovery_plan import validate_opportunity_discovery_plan


DISCOVERY_PREFLIGHT_DATASETS: list[str] = [
    "current_quote",
    "price_history_adjusted",
    "filings_announcements",
    "customer_order_capacity_evidence",
    "valuation_inputs",
]
FORMAL_RESEARCH_DATASETS: list[str] = [
    "current_quote",
    "price_history_adjusted",
    "financials",
    "filings_announcements",
    "customer_order_capacity_evidence",
    "valuation_inputs",
]
DEFAULT_SELECTION_ORDER: list[str] = [
    "先识别用户意图和宏观驱动，再把开放问题映射到多个可交易主题。",
    "将内置主题作为候选种子，允许 AI 为相邻方向补充可验证候选宇宙。",
    "用市场、板块、价格约束过滤不可执行候选。",
    "发现阶段使用轻量真实数据预检，优先确认价格、公告、估值和客户/订单/产能线索。",
    "用主题权重、产业链层级、数据可得性、证据强度和可买性共同缩圈。",
    "正式研究只接收 shortlist，并在该阶段执行财务、技术、公告和估值全量取数。",
]


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _trend_hypotheses_from_macro(macro_theme_map: Mapping[str, Any]) -> list[dict[str, Any]]:
    hypotheses: list[dict[str, Any]] = []
    for item in _as_list(macro_theme_map.get("theme_candidates")):
        if not isinstance(item, Mapping):
            continue
        hypotheses.append({
            "theme_key": str(item.get("theme_key") or ""),
            "theme_source": str(item.get("theme_source") or "curated_pack"),
            "theme": str(item.get("theme") or ""),
            "theme_weight": item.get("theme_weight"),
            "why_now": str(item.get("why_now") or ""),
            "selection_reason": str(item.get("selection_reason") or ""),
            "value_chain_focus": [str(value) for value in _as_list(item.get("value_chain_focus")) if str(value).strip()],
            "evidence_to_seek": [str(value) for value in _as_list(item.get("evidence_to_seek")) if str(value).strip()],
            "disconfirmation": [str(value) for value in _as_list(item.get("disconfirmation")) if str(value).strip()],
        })
    return hypotheses


def _minimum_universe_candidates(hypotheses: Sequence[Mapping[str, Any]], user_theme_required: bool) -> int:
    if user_theme_required:
        return 12
    curated_count: int = len([
        item for item in hypotheses
        if str(item.get("theme_source") or "curated_pack") == "curated_pack"
    ])
    return max(20, curated_count * 6)


def _ai_expansion_tasks(policy: Mapping[str, Any]) -> list[str]:
    tasks: list[str] = []
    for item in _as_list(policy.get("research_questions")):
        text: str = str(item).strip()
        if text:
            tasks.append(text)
    for item in _as_list(policy.get("candidate_universe_requirements")):
        text = str(item).strip()
        if text:
            tasks.append(text)
    return tasks


def build_plan(
    *,
    prompt: str,
    market_scope: Sequence[str],
    excluded_boards: Sequence[str],
    horizon: str,
    risk_profile: str,
    max_price: Optional[float],
    min_price: Optional[float],
    explicit_themes: Sequence[str],
    preflight_candidate_limit: int,
    shortlist_target: int,
) -> dict[str, Any]:
    macro_theme_map: dict[str, Any] = build_macro_theme_map(
        prompt=prompt,
        explicit_themes=explicit_themes,
        max_price=max_price,
        min_price=min_price,
        excluded_boards=excluded_boards,
    )
    macro_errors: list[str] = validate_macro_theme_map(macro_theme_map)
    if macro_errors:
        raise ValueError("; ".join(macro_errors))
    intent: Mapping[str, Any] = _as_mapping(macro_theme_map.get("intent"))
    constraint_interpretation: Mapping[str, Any] = _as_mapping(macro_theme_map.get("constraint_interpretation"))
    affordability_profile: Mapping[str, Any] = _as_mapping(constraint_interpretation.get("affordability_profile"))
    ai_expansion_policy: Mapping[str, Any] = _as_mapping(macro_theme_map.get("ai_expansion_policy"))
    hypotheses: list[dict[str, Any]] = _trend_hypotheses_from_macro(macro_theme_map)
    user_theme_required: bool = bool(intent.get("user_defined_theme_required"))
    return {
        "contract_type": "serenity_opportunity_discovery_plan",
        "schema_version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "request": {
            "prompt": prompt,
            "market_scope": list(market_scope),
            "horizon": horizon,
            "risk_profile": risk_profile,
            "price_preference": {
                "style": str(affordability_profile.get("style") or constraint_interpretation.get("price_style") or "no_explicit_price_limit"),
                "min_price": min_price,
                "max_price": max_price,
                "affordability_profile": dict(affordability_profile),
            },
            "excluded_boards": list(excluded_boards),
        },
        "discovery_mode": str(intent.get("mode") or "theme_research_required"),
        "macro_theme_map": macro_theme_map,
        "trend_hypotheses": hypotheses,
        "universe_policy": {
            "minimum_universe_candidates": _minimum_universe_candidates(hypotheses, user_theme_required),
            "preflight_candidate_limit": max(1, preflight_candidate_limit),
            "shortlist_target": max(1, shortlist_target),
            "selection_order": DEFAULT_SELECTION_ORDER,
            "preflight_profile": {
                "discovery_datasets": DISCOVERY_PREFLIGHT_DATASETS,
                "formal_required_datasets": FORMAL_RESEARCH_DATASETS,
                "transition_rule": "轻量预检先确认可交易性和关键证据，正式研究再对 shortlist 执行全量取数和深度分析。",
                "expansion_rule": "若硬约束导致 shortlist 未达到目标，继续对候选队列执行下一批轻量预检，直到达到目标或候选队列耗尽。",
            },
            "ai_expansion_policy": dict(ai_expansion_policy),
            "ai_expansion_tasks": _ai_expansion_tasks(ai_expansion_policy),
            "evidence_floor": "Final shortlist requires real discovery preflight data; theme labels only create evidence watch rows.",
            "open_theme_research_tasks": [
                "定义可投资主题边界、需求来源和真实受益链路。",
                "构建符合 schema 的 theme_candidate_universe，列出上市候选、产业链层级和证据需求。",
                "通过 validator 后再运行候选漏斗、轻量预检和正式研究。",
            ] if user_theme_required else _ai_expansion_tasks(ai_expansion_policy) if ai_expansion_policy.get("enabled") is True else [],
        },
        "next_step": "Build theme universes, run light preflight data collection, produce a candidate_funnel, then run formal research on shortlist.",
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Build an opportunity discovery plan")
    parser.add_argument("prompt", help="user opportunity request")
    parser.add_argument("--market-scope", nargs="+", default=["CN_A"], help="allowed markets")
    parser.add_argument("--exclude-board", action="append", default=[], help="board to exclude, e.g. STAR")
    parser.add_argument("--horizon", default="3-6个月")
    parser.add_argument("--risk-profile", default="balanced")
    parser.add_argument("--max-price", type=float)
    parser.add_argument("--min-price", type=float)
    parser.add_argument("--theme", action="append", default=[], help="explicit theme key or alias")
    parser.add_argument("--preflight-candidate-limit", type=int, default=24)
    parser.add_argument("--shortlist-target", type=int, default=8)
    parser.add_argument("--out", help="write plan JSON")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        payload: dict[str, Any] = build_plan(
            prompt=args.prompt,
            market_scope=[str(item) for item in args.market_scope],
            excluded_boards=[str(item) for item in args.exclude_board],
            horizon=str(args.horizon),
            risk_profile=str(args.risk_profile),
            max_price=args.max_price,
            min_price=args.min_price,
            explicit_themes=[str(item) for item in args.theme],
            preflight_candidate_limit=int(args.preflight_candidate_limit),
            shortlist_target=int(args.shortlist_target),
        )
        errors: list[str] = validate_opportunity_discovery_plan(payload)
        if errors:
            raise ValueError("; ".join(errors))
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
