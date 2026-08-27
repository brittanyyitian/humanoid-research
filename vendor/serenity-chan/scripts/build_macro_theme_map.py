#!/usr/bin/env python3
"""Build the macro-to-theme map that drives opportunity discovery."""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:
    from build_theme_candidate_universe import THEME_PACKS
    from validate_macro_theme_map import validate_macro_theme_map
except ModuleNotFoundError:  # pragma: no cover
    from scripts.build_theme_candidate_universe import THEME_PACKS
    from scripts.validate_macro_theme_map import validate_macro_theme_map


BROAD_THEME_KEYS: tuple[str, ...] = ("grid_power", "ai_compute", "robotics", "innovative_medicine")
BROAD_CONTEXT_TOKENS: tuple[str, ...] = ("当前", "现在", "大趋势", "形势", "大环境", "世界层面", "宏观")
BROAD_NEED_TOKENS: tuple[str, ...] = ("机会", "可选", "推荐", "便宜", "方向", "行业", "入", "怎么搞")
STRONG_BROAD_CONTEXT_TOKENS: tuple[str, ...] = ("大趋势", "形势", "大环境", "世界层面", "宏观", "整体", "全市场", "大盘")
LOW_PRICE_TOKENS: tuple[str, ...] = ("便宜", "低价", "价格低", "价格便宜", "低位")
THEME_BASE_WEIGHTS: Mapping[str, float] = {
    "grid_power": 0.94,
    "ai_compute": 0.90,
    "robotics": 0.78,
    "innovative_medicine": 0.72,
}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _has_broad_opportunity_intent(prompt: str) -> bool:
    if _has_strong_broad_context(prompt):
        return True
    return any(token in prompt for token in BROAD_CONTEXT_TOKENS) and any(token in prompt for token in BROAD_NEED_TOKENS)


def _has_strong_broad_context(prompt: str) -> bool:
    return any(token in prompt for token in STRONG_BROAD_CONTEXT_TOKENS)


def _is_theme_anchored_request(prompt: str, seed_keys: Sequence[str], explicit_keys: Sequence[str]) -> bool:
    return bool(seed_keys and not explicit_keys and not _has_strong_broad_context(prompt))


def _pack_aliases(theme_key: str) -> list[str]:
    pack: Mapping[str, Any] = THEME_PACKS.get(theme_key, {})
    return [str(item).lower() for item in pack.get("aliases", []) if _text(item)]


def _theme_match_values(theme_key: str) -> list[str]:
    pack: Mapping[str, Any] = THEME_PACKS.get(theme_key, {})
    values: list[str] = [theme_key.lower(), str(pack.get("display_theme") or "").lower()]
    values.extend(_pack_aliases(theme_key))
    return sorted({value for value in values if value}, key=len, reverse=True)


def _theme_key_for_value(value: str) -> Optional[str]:
    normalized: str = value.lower().strip()
    if normalized in THEME_PACKS:
        return normalized
    for theme_key in THEME_PACKS:
        aliases: list[str] = _theme_match_values(theme_key)
        if normalized == theme_key or theme_key in normalized:
            return theme_key
        if any(alias and (normalized == alias or alias in normalized) for alias in aliases):
            return theme_key
    return None


def _explicit_theme_keys(explicit_themes: Sequence[str]) -> list[str]:
    selected: list[str] = []
    for value in explicit_themes:
        theme_key: Optional[str] = _theme_key_for_value(_text(value))
        if theme_key and theme_key not in selected:
            selected.append(theme_key)
    return selected


def _theme_seed_keys(prompt: str) -> list[str]:
    normalized: str = prompt.lower()
    selected: list[str] = []
    for theme_key in THEME_PACKS:
        aliases: list[str] = _theme_match_values(theme_key)
        if theme_key in normalized or any(alias and alias in normalized for alias in aliases):
            selected.append(theme_key)
    return selected


def _theme_exclusion_keys(prompt: str) -> list[str]:
    normalized: str = prompt.lower()
    excluded: list[str] = []
    prefix_markers: tuple[str, ...] = ("除", "除了", "不要", "不看", "不考虑", "排除", "剔除", "别", "别看")
    suffix_markers: tuple[str, ...] = ("之外", "以外", "除外")
    for theme_key in THEME_PACKS:
        for alias in _theme_match_values(theme_key):
            for match in re.finditer(re.escape(alias), normalized):
                before: str = normalized[max(0, match.start() - 6):match.start()]
                after: str = normalized[match.end():match.end() + 8]
                if any(marker in before for marker in prefix_markers) or any(marker in after for marker in suffix_markers):
                    if theme_key not in excluded:
                        excluded.append(theme_key)
                    break
            if theme_key in excluded:
                break
    return excluded


def _display_theme(theme_key: str) -> str:
    pack: Mapping[str, Any] = THEME_PACKS.get(theme_key, {})
    return str(pack.get("display_theme") or theme_key)


def _layer_focus(theme_key: str) -> list[str]:
    pack: Mapping[str, Any] = THEME_PACKS.get(theme_key, {})
    layers: list[str] = []
    for row in pack.get("layers", []) if isinstance(pack.get("layers"), list) else []:
        if isinstance(row, Mapping):
            layer: str = _text(row.get("layer"))
            if layer:
                layers.append(layer)
    return layers


def _evidence_to_seek(theme_key: str) -> list[str]:
    pack: Mapping[str, Any] = THEME_PACKS.get(theme_key, {})
    evidence: list[str] = []
    for row in pack.get("layers", []) if isinstance(pack.get("layers"), list) else []:
        if not isinstance(row, Mapping):
            continue
        for item in row.get("evidence_to_seek", []) if isinstance(row.get("evidence_to_seek"), list) else []:
            text: str = _text(item)
            if text and text not in evidence:
                evidence.append(text)
    return evidence[:6] or ["收入传导", "客户/订单/产能证据"]


def _disconfirmation(theme_key: str) -> list[str]:
    pack: Mapping[str, Any] = THEME_PACKS.get(theme_key, {})
    downgraded: list[str] = []
    for row in pack.get("downgraded", []) if isinstance(pack.get("downgraded"), list) else []:
        if isinstance(row, Mapping):
            reason: str = _text(row.get("downgrade_reason"))
            if reason:
                downgraded.append(reason)
    return downgraded or ["主题热度无法映射到收入、订单、客户、产能或现金流。"]


def _why_now(theme_key: str) -> str:
    if theme_key == "grid_power":
        return "电力需求、数据中心负荷和电网投资共同决定设备与运营层的兑现节奏。"
    if theme_key == "ai_compute":
        return "AI资本开支和高速互联需求会沿硬件、PCB、光模块和算力基础设施传导。"
    if theme_key == "robotics":
        return "机器人量产预期需要通过核心部件、客户验证和产能良率转成收入证据。"
    if theme_key == "innovative_medicine":
        return "创新药机会取决于临床、商业化、BD、现金流和估值重定价的共同验证。"
    return f"{_display_theme(theme_key)} 需要先确认一阶驱动，再确认可交易层级的兑现证据。"


def _selection_reason(
    *,
    theme_key: str,
    broad_scan: bool,
    seed_keys: Sequence[str],
    explicit_keys: Sequence[str],
    price_style: str,
) -> str:
    if theme_key in explicit_keys:
        return "用户显式指定该主题，作为本轮可交易候选宇宙的硬约束。"
    if broad_scan and theme_key in seed_keys:
        return "用户问题具有开放机会意图，且该主题出现在表述中，作为高权重种子参与多主题缩圈。"
    if broad_scan:
        return "该主题处在当前宏观机会常用映射中，参与开放缩圈并接受真实数据验证。"
    if price_style in {"explicit_max_price", "low_nominal_price_preferred"} and theme_key == "grid_power":
        return "价格偏好强化了现金流和低名义价格可筛选的电力设备方向。"
    return "该主题与用户表述存在直接语义匹配，进入主题机会研究。"


def _price_style(max_price: Optional[float], prompt: str) -> str:
    if max_price is not None:
        return "explicit_max_price"
    if any(token in prompt for token in LOW_PRICE_TOKENS):
        return "low_nominal_price_preferred"
    return "no_explicit_price_limit"


def _affordability_profile(*, prompt: str, max_price: Optional[float], min_price: Optional[float]) -> dict[str, Any]:
    style: str = _price_style(max_price, prompt)
    if style == "explicit_max_price":
        nominal_role: str = "hard_ceiling"
    elif style == "low_nominal_price_preferred":
        nominal_role = "soft_preference"
    else:
        nominal_role = "neutral"
    return {
        "style": style,
        "min_price": min_price,
        "max_price": max_price,
        "nominal_price_role": nominal_role,
        "market_cap_role": "use total/float market cap and valuation inputs to avoid confusing low nominal price with cheap valuation",
        "liquidity_role": "prefer candidates with tradable liquidity and verifiable current quote data",
        "scoring_hint": "Nominal price can screen and rank affordability, while valuation and evidence decide research priority.",
    }


def _theme_weight(
    *,
    theme_key: str,
    broad_scan: bool,
    seed_keys: Sequence[str],
    explicit_keys: Sequence[str],
    price_style: str,
    excluded_boards: Sequence[str],
) -> float:
    if theme_key in explicit_keys:
        return 1.0
    base: float = THEME_BASE_WEIGHTS.get(theme_key, 0.64)
    if not broad_scan and theme_key in seed_keys:
        base = max(base, 0.92)
    if broad_scan and theme_key in seed_keys:
        base += 0.08
    if price_style in {"explicit_max_price", "low_nominal_price_preferred"}:
        if theme_key == "grid_power":
            base += 0.06
        elif theme_key == "ai_compute":
            base -= 0.08
        elif theme_key == "robotics":
            base += 0.01
        elif theme_key == "innovative_medicine":
            base -= 0.04
    normalized_boards: set[str] = {str(item).lower() for item in excluded_boards}
    if normalized_boards & {"star", "科创板", "sci-tech", "sci_tech"}:
        if theme_key == "grid_power":
            base += 0.03
        elif theme_key == "ai_compute":
            base -= 0.02
        elif theme_key == "robotics":
            base -= 0.01
        elif theme_key == "innovative_medicine":
            base -= 0.06
    return round(max(0.0, min(1.0, base)), 3)


def _user_defined_theme_key(prompt: str) -> str:
    cleaned: str = re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]+", "_", prompt.strip().lower())
    compact: str = "_".join(part for part in cleaned.split("_") if part)
    return f"user_defined_{compact[:48]}" if compact else "user_defined_theme"


def _user_defined_theme_label(prompt: str) -> str:
    compact: str = " ".join(prompt.strip().split())
    return compact[:80] if compact else "用户定义主题"


def _macro_drivers(selected_theme_keys: Sequence[str], prompt: str, affordability: Mapping[str, Any]) -> list[dict[str, Any]]:
    drivers: list[dict[str, Any]] = []
    if "grid_power" in selected_theme_keys:
        drivers.append({
            "driver": "电力负荷、电网投资与设备交付",
            "role": "把宏观用电和新型电力系统映射到设备、运营和储能层级",
            "direction": "需求增长需要通过招标、订单、交付和回款验证",
            "theme_keys": ["grid_power"],
            "confidence": "HIGH",
        })
    if "ai_compute" in selected_theme_keys:
        drivers.append({
            "driver": "AI资本开支与高速互联升级",
            "role": "把算力投入映射到光模块、PCB、服务器、交换机和半导体设备",
            "direction": "资本开支上行需要继续验证客户、订单、毛利和库存质量",
            "theme_keys": ["ai_compute"],
            "confidence": "HIGH",
        })
    if "robotics" in selected_theme_keys:
        drivers.append({
            "driver": "机器人量产与核心部件国产供应",
            "role": "把产业预期拆到减速器、伺服、传感、本体和应用交付",
            "direction": "量产节奏需要通过客户验证、产能良率和收入占比确认",
            "theme_keys": ["robotics"],
            "confidence": "MEDIUM",
        })
    if "innovative_medicine" in selected_theme_keys:
        drivers.append({
            "driver": "创新药临床、商业化与BD重估",
            "role": "把医药风险偏好映射到临床读数、销售兑现、现金流和估值重定价",
            "direction": "机会强度取决于监管节点、销售爬坡、BD条款和融资能力",
            "theme_keys": ["innovative_medicine"],
            "confidence": "MEDIUM",
        })
    if not drivers:
        drivers.append({
            "driver": "用户主题热度与可交易映射",
            "role": "先定义主题边界，再寻找上市公司收入、订单、客户和现金流证据",
            "direction": "需要 AI 构建候选宇宙后再进入真实数据缩圈",
            "theme_keys": [],
            "confidence": "LOW",
        })
    if affordability.get("nominal_price_role") != "neutral":
        drivers.append({
            "driver": "价格可达性与交易约束",
            "role": "把名义价格偏好转成筛选条件，并用估值和市值避免低价误判",
            "direction": "低名义价格只提高可达性，正式结论仍由数据和证据决定",
            "theme_keys": list(selected_theme_keys),
            "confidence": "HIGH",
        })
    return drivers


def _ai_expansion_policy(
    *,
    mode: str,
    broad_scan: bool,
    explicit_keys: Sequence[str],
    user_defined_required: bool,
    selected_theme_keys: Sequence[str],
) -> dict[str, Any]:
    theme_anchored: bool = bool(mode == "theme_opportunity" and selected_theme_keys and not explicit_keys)
    enabled: bool = bool(user_defined_required or theme_anchored or (broad_scan and not explicit_keys))
    if user_defined_required:
        expansion_mode: str = "user_defined_universe"
        curated_theme_role: str = "context_reference"
        research_questions: list[str] = [
            "定义主题边界、真实需求来源、消费或产业热度的可验证信号。",
            "寻找能把主题热度转成收入、订单、渠道、客户、产能或现金流的上市公司。",
            "识别同类替代方向和可能更强的一阶受益链路。",
        ]
    elif enabled:
        if theme_anchored:
            expansion_mode = "theme_adjacent_research"
            curated_theme_role = "theme_anchor"
            research_questions = [
                "沿用户主题检查遗漏产业层级、替代链路和相邻一阶受益方向。",
                "比较主题内候选与相邻方向的需求强度、兑现路径、估值拥挤度和数据可得性。",
                "为有真实收入传导的新增方向构建额外 theme_candidate_universe。",
            ]
        else:
            expansion_mode = "broad_adjacent_research"
            curated_theme_role = "seed_anchor"
            research_questions = [
                "沿宏观驱动检查内置主题之外的相邻可交易方向。",
                "比较相邻方向与种子主题的需求强度、兑现路径、估值拥挤度和数据可得性。",
                "为有真实收入传导的相邻方向构建额外 theme_candidate_universe。",
            ]
    else:
        expansion_mode = "explicit_scope"
        curated_theme_role = "selected_scope"
        research_questions = [
            "在用户显式主题范围内补充遗漏层级、边缘候选和反证方向。",
        ]
    return {
        "enabled": enabled,
        "expansion_mode": expansion_mode,
        "curated_theme_role": curated_theme_role,
        "seed_theme_keys": list(selected_theme_keys),
        "research_questions": research_questions,
        "candidate_universe_requirements": [
            "候选必须能映射到上市公司、市场、产业层级和可验证证据需求。",
            "候选必须区分直接证据、披露线索、主题叙事和待复核事项。",
            "新增宇宙必须通过 theme_candidate_universe schema 校验后进入候选漏斗。",
        ],
        "integration_rule": "validated AI-built universes are merged with curated seed universes before preflight and funnel scoring",
        "output_contract": "serenity_theme_candidate_universe",
    }


def build_macro_theme_map(
    *,
    prompt: str,
    explicit_themes: Sequence[str],
    max_price: Optional[float],
    min_price: Optional[float],
    excluded_boards: Sequence[str] = (),
) -> dict[str, Any]:
    explicit_keys: list[str] = _explicit_theme_keys(explicit_themes)
    raw_seed_keys: list[str] = _theme_seed_keys(prompt)
    excluded_theme_keys: list[str] = _theme_exclusion_keys(prompt)
    seed_keys: list[str] = [key for key in raw_seed_keys if key not in excluded_theme_keys]
    raw_broad_scan: bool = _has_broad_opportunity_intent(prompt)
    affordability: dict[str, Any] = _affordability_profile(prompt=prompt, max_price=max_price, min_price=min_price)
    user_defined_required: bool = False
    broad_scan: bool = raw_broad_scan and not _is_theme_anchored_request(prompt, seed_keys, explicit_keys)
    if explicit_keys:
        selected_keys: list[str] = explicit_keys
        mode: str = "theme_opportunity" if len(selected_keys) == 1 else "open_opportunity"
    elif broad_scan:
        selected_keys = [key for key in BROAD_THEME_KEYS if key in THEME_PACKS and key not in excluded_theme_keys]
        if selected_keys:
            mode = "open_opportunity"
        else:
            mode = "theme_research_required"
            user_defined_required = True
    elif seed_keys:
        selected_keys = seed_keys
        mode = "theme_opportunity"
    else:
        selected_keys = []
        mode = "theme_research_required"
        user_defined_required = True

    candidates: list[dict[str, Any]] = []
    for theme_key in selected_keys:
        weight: float = _theme_weight(
            theme_key=theme_key,
            broad_scan=broad_scan,
            seed_keys=seed_keys,
            explicit_keys=explicit_keys,
            price_style=str(affordability["style"]),
            excluded_boards=excluded_boards,
        )
        candidates.append({
            "theme_key": theme_key,
            "theme": _display_theme(theme_key),
            "theme_source": "curated_pack",
            "theme_weight": weight,
            "why_now": _why_now(theme_key),
            "selection_reason": _selection_reason(
                theme_key=theme_key,
                broad_scan=broad_scan,
                seed_keys=seed_keys,
                explicit_keys=explicit_keys,
                price_style=str(affordability["style"]),
            ),
            "value_chain_focus": _layer_focus(theme_key),
            "evidence_to_seek": _evidence_to_seek(theme_key),
            "disconfirmation": _disconfirmation(theme_key),
        })
    if user_defined_required:
        candidates.append({
            "theme_key": _user_defined_theme_key(prompt),
            "theme": _user_defined_theme_label(prompt),
            "theme_source": "ai_built_required",
            "theme_weight": 1.0,
            "why_now": "需要先由 AI 明确主题边界、真实受益链路和可交易候选范围。",
            "selection_reason": "用户表述没有命中内置可交易主题包，先构建真实候选宇宙再缩圈。",
            "value_chain_focus": ["主题边界", "需求来源", "收入传导", "候选可得性"],
            "evidence_to_seek": ["可验证需求或消费热度", "上市公司收入、订单、渠道或客户证据", "同类候选和替代方向"],
            "disconfirmation": ["无法映射到上市公司收入、订单、客户、产能、现金流或可验证数据。"],
        })
    candidates.sort(key=lambda item: (-float(item.get("theme_weight") or 0), str(item.get("theme_key") or "")))
    sorted_selected_keys: list[str] = [
        str(item.get("theme_key"))
        for item in candidates
        if item.get("theme_source") == "curated_pack" and str(item.get("theme_key") or "")
    ]
    ai_expansion_policy: dict[str, Any] = _ai_expansion_policy(
        mode=mode,
        broad_scan=broad_scan,
        explicit_keys=explicit_keys,
        user_defined_required=user_defined_required,
        selected_theme_keys=sorted_selected_keys,
    )
    return {
        "contract_type": "serenity_macro_theme_map",
        "schema_version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "request": {
            "prompt": prompt,
            "explicit_themes": list(explicit_themes),
            "excluded_boards": list(excluded_boards),
        },
        "intent": {
            "mode": mode,
            "broad_scan": broad_scan and not explicit_keys,
            "theme_seed_keys": seed_keys,
            "excluded_theme_keys": excluded_theme_keys,
            "explicit_theme_keys": explicit_keys,
            "user_defined_theme_required": user_defined_required,
        },
        "macro_drivers": _macro_drivers(sorted_selected_keys, prompt, affordability),
        "theme_candidates": candidates,
        "selected_theme_keys": sorted_selected_keys,
        "ai_expansion_policy": ai_expansion_policy,
        "selection_policy": (
            "显式主题优先；用户排除主题从候选种子中移除；开放机会请求使用多主题宏观映射；自然语言主题词作为权重种子；内置主题作为种子锚点；"
            "AI 可为相邻方向和新主题构建可验证候选宇宙。"
        ),
        "constraint_interpretation": {
            "price_style": str(affordability["style"]),
            "affordability_profile": affordability,
            "excluded_theme_keys": excluded_theme_keys,
        },
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Build Serenity macro theme map")
    parser.add_argument("prompt")
    parser.add_argument("--theme", action="append", default=[])
    parser.add_argument("--max-price", type=float)
    parser.add_argument("--min-price", type=float)
    parser.add_argument("--exclude-board", action="append", default=[])
    parser.add_argument("--out")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        payload: dict[str, Any] = build_macro_theme_map(
            prompt=str(args.prompt),
            explicit_themes=[str(item) for item in args.theme],
            max_price=args.max_price,
            min_price=args.min_price,
            excluded_boards=[str(item) for item in args.exclude_board],
        )
        errors: list[str] = validate_macro_theme_map(payload)
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
