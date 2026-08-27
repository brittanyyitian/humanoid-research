#!/usr/bin/env python3
"""Build an auditable candidate funnel from an opportunity discovery plan."""

from __future__ import annotations

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:
    from build_theme_candidate_universe import THEME_PACKS, build_universe
    from validate_candidate_funnel import validate_candidate_funnel
    from validate_opportunity_discovery_plan import validate_opportunity_discovery_plan
    from validate_theme_candidate_universe import validate_universe
except ModuleNotFoundError:  # pragma: no cover
    from scripts.build_theme_candidate_universe import THEME_PACKS, build_universe
    from scripts.validate_candidate_funnel import validate_candidate_funnel
    from scripts.validate_opportunity_discovery_plan import validate_opportunity_discovery_plan
    from scripts.validate_theme_candidate_universe import validate_universe


RATING_CAP_SCORE: dict[str, float] = {"S": 4.0, "A": 3.0, "B": 1.5, "C": 0.5, "D": 0.0, "OBSERVE_ONLY": 0.0}
DATASET_SCORE: dict[str, float] = {"OK": 1.0, "PARTIAL": 0.55, "STALE": 0.35, "PENDING": 0.2, "FAILED": 0.0, "NOT_REQUESTED": 0.0}
LOW_PRICE_BONUS_CAP: float = 5.0
DISCOVERY_DATASET_WEIGHTS: Mapping[str, float] = {
    "current_quote": 5.0,
    "price_history_adjusted": 3.0,
    "filings_announcements": 5.0,
    "customer_order_capacity_evidence": 4.0,
    "valuation_inputs": 5.0,
    "financials": 3.0,
}
CORE_PREFLIGHT_DATASETS: tuple[str, ...] = ("current_quote", "filings_announcements", "valuation_inputs")
ACCEPTABLE_PREFLIGHT_STATUSES: set[str] = {"OK", "PARTIAL", "STALE"}
QUALITY_BLOCKING_RATING_CAPS: set[str] = {"D", "OBSERVE_ONLY"}


def _load_json(path: Path) -> Mapping[str, Any]:
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _write_json(path: Path, payload: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _safe_name(value: str) -> str:
    cleaned: str = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip())
    return cleaned or "candidate"


def _ai_theme_key(theme: str) -> str:
    cleaned: str = re.sub(r"[^A-Za-z0-9\u4e00-\u9fff]+", "_", theme.strip().lower())
    compact: str = "_".join(part for part in cleaned.split("_") if part)
    return f"ai_built_{compact[:48]}" if compact else "ai_built_theme"


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _safe_float(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _theme_key_for_display(theme: str) -> str:
    normalized: str = theme.strip()
    for theme_key, pack in THEME_PACKS.items():
        if normalized == theme_key or normalized == str(pack.get("display_theme") or ""):
            return theme_key
    return ""


def _theme_weights(plan: Mapping[str, Any]) -> Mapping[str, float]:
    macro: Mapping[str, Any] = _as_mapping(plan.get("macro_theme_map"))
    weights: dict[str, float] = {}
    for row in _as_list(macro.get("theme_candidates")):
        if not isinstance(row, Mapping):
            continue
        theme_key: str = _text(row.get("theme_key"))
        weight: Optional[float] = _safe_float(row.get("theme_weight"))
        if theme_key and weight is not None:
            weights[theme_key] = max(0.0, min(1.0, weight))
    if not weights:
        for row in _as_list(plan.get("trend_hypotheses")):
            if isinstance(row, Mapping):
                theme_key = _text(row.get("theme_key"))
                if theme_key:
                    weights[theme_key] = 0.8
    return weights


def _market_allowed(market: str, market_scope: Sequence[str]) -> bool:
    return "GLOBAL" in market_scope or market in market_scope


def _is_star_board(symbol: str) -> bool:
    code: str = symbol.split(".", 1)[0]
    return code.startswith(("688", "689"))


def _excluded_by_board(symbol: str, excluded_boards: Sequence[str]) -> bool:
    normalized: set[str] = {str(item).lower() for item in excluded_boards}
    return bool({"star", "科创板", "sci-tech", "sci_tech"} & normalized and _is_star_board(symbol))


def _candidate_theme_rows(plan: Mapping[str, Any], universe_paths: Sequence[Path]) -> tuple[list[dict[str, Any]], list[str], list[dict[str, str]]]:
    path_texts: list[str] = []
    excluded_directions: list[dict[str, str]] = []
    rows_by_symbol: dict[str, dict[str, Any]] = {}
    universes: list[tuple[Mapping[str, Any], str]] = []
    provided_theme_keys: set[str] = set()
    hypotheses: list[Mapping[str, Any]] = [
        item for item in _as_list(plan.get("trend_hypotheses"))
        if isinstance(item, Mapping)
    ]
    theme_by_key: dict[str, str] = {
        _text(item.get("theme_key")): _text(item.get("theme"))
        for item in hypotheses
    }
    default_ai_theme_key: str = next(
        (
            _text(item.get("theme_key"))
            for item in hypotheses
            if _text(item.get("theme_source")) == "ai_built_required" and _text(item.get("theme_key"))
        ),
        "",
    )

    def append_universe(universe: Mapping[str, Any], source_label: str) -> None:
        theme: str = _text(universe.get("theme"))
        universe_theme_key: str = _text(universe.get("theme_key")) or _theme_key_for_display(theme)
        if not universe_theme_key and default_ai_theme_key:
            universe_theme_key = default_ai_theme_key
        if not universe_theme_key and theme:
            universe_theme_key = _ai_theme_key(theme)
        universes.append((universe, universe_theme_key))
        path_texts.append(source_label)
        if universe_theme_key:
            provided_theme_keys.add(universe_theme_key)

    for path in universe_paths:
        universe: Mapping[str, Any] = _load_json(path)
        errors: list[str] = validate_universe(universe)
        if errors:
            raise ValueError(f"{path}: " + "; ".join(errors))
        append_universe(universe, str(path.resolve()))
    for hypothesis in hypotheses:
        if _text(hypothesis.get("theme_source") or "curated_pack") != "curated_pack":
            continue
        theme_key: str = _text(hypothesis.get("theme_key"))
        if not theme_key or theme_key not in THEME_PACKS or theme_key in provided_theme_keys:
            continue
        append_universe(build_universe(theme_key), f"generated:{theme_key}")

    for universe, universe_theme_key in universes:
        theme: str = _text(universe.get("theme"))
        for row in _as_list(universe.get("candidate_universe")):
            if not isinstance(row, Mapping):
                continue
            symbol: str = _text(row.get("symbol"))
            if not symbol:
                continue
            current: dict[str, Any] = rows_by_symbol.get(symbol, {})
            theme_keys: list[str] = list(current.get("theme_keys", [])) if isinstance(current.get("theme_keys"), list) else []
            row_theme_key: str = _text(row.get("theme_key")) or universe_theme_key
            if row_theme_key and row_theme_key not in theme_keys:
                theme_keys.append(row_theme_key)
            rows_by_symbol[symbol] = {
                "symbol": symbol,
                "name": _text(row.get("name")),
                "market": _text(row.get("market")),
                "theme_key": current.get("theme_key") or row_theme_key,
                "theme_keys": theme_keys,
                "theme": current.get("theme") or theme or theme_by_key.get(row_theme_key, ""),
                "layer": current.get("layer") or _text(row.get("layer")),
                "why_in_universe": current.get("why_in_universe") or _text(row.get("why_in_universe")),
                "initial_evidence_need": current.get("initial_evidence_need") or _text(row.get("initial_evidence_need")),
                "universe_order": min(int(current.get("universe_order", 10_000)), len(rows_by_symbol)),
            }
        for direction in _as_list(universe.get("downgraded_hot_directions")):
            if not isinstance(direction, Mapping):
                continue
            excluded_directions.append({
                "direction": _text(direction.get("direction")) or theme,
                "reason": _text(direction.get("downgrade_reason")) or "缺少可验证收入、订单、客户或产能证据。",
                "revisit_trigger": _text(direction.get("evidence_to_upgrade")) or "披露可追溯证据后重新纳入漏斗。",
            })
    return list(rows_by_symbol.values()), path_texts, excluded_directions


def _snapshot_by_symbol(snapshot_path: Optional[Path]) -> Mapping[str, Any]:
    if snapshot_path is None:
        return {}
    payload: Mapping[str, Any] = _load_json(snapshot_path)
    symbols: Any = payload.get("symbols")
    if isinstance(symbols, Mapping):
        return symbols
    return payload


def _manifest_path(preflight_root: Optional[Path], symbol: str) -> Optional[Path]:
    if preflight_root is None:
        return None
    candidates: list[Path] = [
        preflight_root / "data" / _safe_name(symbol) / "manifest.json",
        preflight_root / _safe_name(symbol) / "manifest.json",
        preflight_root / symbol / "manifest.json",
    ]
    for path in candidates:
        if path.is_file():
            return path
    return None


def _result_path(manifest: Mapping[str, Any], dataset: str) -> Optional[Path]:
    for row in _as_list(manifest.get("results")):
        if not isinstance(row, Mapping):
            continue
        if _text(row.get("dataset")) == dataset and _text(row.get("data_path")):
            return Path(_text(row.get("data_path")))
    return None


def _preflight_from_manifest(preflight_root: Optional[Path], symbol: str) -> dict[str, Any]:
    path: Optional[Path] = _manifest_path(preflight_root, symbol)
    if path is None:
        return {}
    manifest: Mapping[str, Any] = _load_json(path)
    acquisition: Mapping[str, Any] = _as_mapping(manifest.get("data_acquisition"))
    quality: Mapping[str, Any] = _as_mapping(manifest.get("data_quality"))
    row: dict[str, Any] = {
        "manifest_path": str(path),
        "status_by_dataset": dict(_as_mapping(acquisition.get("status_by_dataset"))),
        "rating_cap": _text(quality.get("rating_cap") or quality.get("full_research_rating_cap")),
    }
    quote_path: Optional[Path] = _result_path(manifest, "current_quote")
    if quote_path and quote_path.is_file():
        quote: Mapping[str, Any] = _load_json(quote_path)
        row["price"] = _safe_float(quote.get("regular_market_price"))
        row["volume"] = _safe_float(quote.get("regular_market_volume") or quote.get("volume"))
        row["turnover"] = _safe_float(quote.get("turnover") or quote.get("amount"))
        row["currency"] = _text(quote.get("currency"))
        row["quote_time"] = _text(quote.get("regular_market_time"))
    valuation_path: Optional[Path] = _result_path(manifest, "valuation_inputs")
    if valuation_path and valuation_path.is_file():
        valuation_payload: Mapping[str, Any] = _load_json(valuation_path)
        row["valuation_inputs"] = {
            "total_market_cap": _safe_float(valuation_payload.get("total_market_cap")),
            "float_market_cap": _safe_float(valuation_payload.get("float_market_cap")),
            "source_basis": _text(valuation_payload.get("source_basis")),
            "market_cap_basis": _text(valuation_payload.get("market_cap_basis")),
        }
        if row.get("price") is None:
            row["price"] = _safe_float(valuation_payload.get("regular_market_price"))
        if not row.get("currency"):
            row["currency"] = _text(valuation_payload.get("currency"))
    evidence_path: Optional[Path] = _result_path(manifest, "customer_order_capacity_evidence")
    if evidence_path and evidence_path.is_file():
        evidence_payload: Mapping[str, Any] = _load_json(evidence_path)
        summary: Mapping[str, Any] = _as_mapping(evidence_payload.get("summary"))
        row["customer_order_capacity_evidence"] = {
            "evidence_status": _text(summary.get("evidence_status")),
            "score": _safe_float(summary.get("score")),
            "direct_evidence_count": int(summary.get("direct_evidence_count") or 0),
            "lead_evidence_count": int(summary.get("lead_evidence_count") or 0),
            "review_queue_count": int(summary.get("review_queue_count") or 0),
        }
    return row


def _preflight_row(
    symbol: str,
    *,
    preflight_root: Optional[Path],
    snapshot: Mapping[str, Any],
) -> dict[str, Any]:
    snap: Any = snapshot.get(symbol)
    if isinstance(snap, Mapping):
        row: dict[str, Any] = dict(snap)
        if "status_by_dataset" not in row:
            row["status_by_dataset"] = {}
        return row
    return _preflight_from_manifest(preflight_root, symbol)


def _data_score(preflight: Mapping[str, Any]) -> float:
    statuses: Mapping[str, Any] = _as_mapping(preflight.get("status_by_dataset"))
    score: float = 0.0
    for dataset, weight in DISCOVERY_DATASET_WEIGHTS.items():
        score += weight * DATASET_SCORE.get(_text(statuses.get(dataset)), 0.0)
    rating_cap: str = _text(preflight.get("rating_cap"))
    score += RATING_CAP_SCORE.get(rating_cap, 0.0)
    return round(min(24.0, score), 2)


def _preflight_ready(preflight: Mapping[str, Any]) -> tuple[bool, list[str]]:
    statuses: Mapping[str, Any] = _as_mapping(preflight.get("status_by_dataset"))
    blockers: list[str] = []
    for dataset in CORE_PREFLIGHT_DATASETS:
        status: str = _text(statuses.get(dataset))
        if status not in ACCEPTABLE_PREFLIGHT_STATUSES:
            blockers.append(f"{dataset} 状态为 {status or 'MISSING'}，不能进入正式 shortlist。")
    return not blockers, blockers


def _price_pass(preflight: Mapping[str, Any], price_preference: Mapping[str, Any]) -> tuple[bool, str]:
    price: Optional[float] = _safe_float(preflight.get("price"))
    min_price: Optional[float] = _safe_float(price_preference.get("min_price"))
    max_price: Optional[float] = _safe_float(price_preference.get("max_price"))
    if price is None:
        return False, "缺少当前价格 preflight，不能确认价格约束。"
    if min_price is not None and price < min_price:
        return False, f"当前价格 {price:.2f} 低于最小价格约束 {min_price:.2f}。"
    if max_price is not None and price > max_price:
        return False, f"当前价格 {price:.2f} 高于最高价格约束 {max_price:.2f}。"
    return True, f"当前价格 {price:.2f} 满足价格约束。"


def _price_preference_score(preflight: Mapping[str, Any], price_preference: Mapping[str, Any]) -> tuple[float, str]:
    price: Optional[float] = _safe_float(preflight.get("price"))
    if price is None:
        return 0.0, ""
    style: str = _text(price_preference.get("style"))
    max_price: Optional[float] = _safe_float(price_preference.get("max_price"))
    if style == "low_nominal_price_preferred":
        if price <= 5:
            return LOW_PRICE_BONUS_CAP, "价格可达性加分：当前价格处于低价区间。"
        if price <= 10:
            return 4.5, "价格可达性加分：当前价格处于较低区间。"
        if price <= 20:
            return 2.5, "价格可达性加分：当前价格符合低价偏好。"
        if price <= 30:
            return 1.0, "价格可达性加分：当前价格接近低价偏好上沿。"
    if max_price is not None and max_price > 0 and price <= max_price:
        headroom: float = max(0.0, min(1.0, (max_price - price) / max_price))
        return round(headroom * 4.0, 2), "价格可达性加分：当前价格低于上限且保留约束空间。"
    return 0.0, ""


def _max_theme_weight(row: Mapping[str, Any], weights: Mapping[str, float]) -> float:
    keys: list[str] = [str(item) for item in _as_list(row.get("theme_keys")) if str(item).strip()]
    if not keys and _text(row.get("theme_key")):
        keys = [_text(row.get("theme_key"))]
    if not keys:
        return 0.65
    return max(weights.get(key, 0.65) for key in keys)


def _theme_fit_score(row: Mapping[str, Any], weights: Mapping[str, float]) -> float:
    return round(18.0 * _max_theme_weight(row, weights), 2)


def _value_chain_score(row: Mapping[str, Any]) -> float:
    layer: str = _text(row.get("layer"))
    reason: str = _text(row.get("why_in_universe"))
    if any(token in layer for token in ["主网", "特高压", "光模块", "光芯片", "高速互联", "减速器", "伺服", "传动", "临床", "商业化"]):
        base: float = 24.0
    elif any(token in layer for token in ["储能", "逆变器", "PCB", "服务器", "交换机", "半导体设备", "执行器", "传感", "视觉", "CXO", "CDMO"]):
        base = 20.0
    elif any(token in layer for token in ["运营", "应用", "本体", "系统集成", "云", "模型"]):
        base = 13.0
    else:
        base = 16.0
    if any(token in reason for token in ["核心", "龙头", "供应商", "设备", "订单", "客户"]):
        base += 1.5
    order: int = int(row.get("universe_order") or 0)
    if order >= 12:
        base -= 1.0
    return round(max(0.0, min(26.0, base)), 2)


def _evidence_strength_score(row: Mapping[str, Any], preflight: Mapping[str, Any]) -> float:
    statuses: Mapping[str, Any] = _as_mapping(preflight.get("status_by_dataset"))
    score: float = 6.0
    filings_status: str = _text(statuses.get("filings_announcements"))
    if filings_status == "OK":
        score += 5.0
    elif filings_status in ACCEPTABLE_PREFLIGHT_STATUSES:
        score += 3.0
    evidence_status: str = _text(_as_mapping(preflight.get("customer_order_capacity_evidence")).get("evidence_status"))
    evidence_score: Optional[float] = _safe_float(_as_mapping(preflight.get("customer_order_capacity_evidence")).get("score"))
    if evidence_status == "DIRECT_EVIDENCE_FOUND":
        score += 8.0
    elif evidence_status == "DISCLOSURE_LEADS_ONLY":
        score += 5.0
    elif evidence_score is not None:
        score += min(6.0, max(0.0, evidence_score / 100.0 * 6.0))
    elif _text(statuses.get("customer_order_capacity_evidence")) == "OK":
        score += 5.0
    elif _text(statuses.get("customer_order_capacity_evidence")) in ACCEPTABLE_PREFLIGHT_STATUSES:
        score += 3.0
    evidence_need: str = _text(row.get("initial_evidence_need"))
    if any(token in evidence_need for token in ["订单", "客户", "产能", "收入"]):
        score += 2.0
    return round(max(0.0, min(22.0, score)), 2)


def _affordability_score(preflight: Mapping[str, Any], price_preference: Mapping[str, Any]) -> tuple[float, list[str]]:
    reasons: list[str] = []
    price_score: float
    price_reason: str
    price_score, price_reason = _price_preference_score(preflight, price_preference)
    if price_reason:
        reasons.append(price_reason)
    valuation: Mapping[str, Any] = _as_mapping(preflight.get("valuation_inputs"))
    market_cap: Optional[float] = _safe_float(valuation.get("total_market_cap"))
    market_cap_score: float = 0.0
    if market_cap is not None and market_cap > 0:
        if market_cap <= 20_000_000_000:
            market_cap_score = 2.0
        elif market_cap <= 80_000_000_000:
            market_cap_score = 1.2
        else:
            market_cap_score = 0.4
        reasons.append("估值输入已提供市值口径，可区分低名义价格与真实估值。")
    return round(min(10.0, price_score + market_cap_score), 2), reasons


def _risk_penalty(row: Mapping[str, Any], preflight: Mapping[str, Any]) -> tuple[float, list[str]]:
    penalty: float = 0.0
    reasons: list[str] = []
    statuses: Mapping[str, Any] = _as_mapping(preflight.get("status_by_dataset"))
    failed_datasets: list[str] = [
        dataset for dataset, status in statuses.items()
        if _text(status) in {"FAILED", "NOT_REQUESTED"} and dataset in CORE_PREFLIGHT_DATASETS
    ]
    if failed_datasets:
        penalty += 10.0
        reasons.append("核心轻量预检存在缺口，不能提升研究优先级。")
    rating_cap: str = _text(preflight.get("rating_cap"))
    if rating_cap in {"C", "D", "OBSERVE_ONLY"}:
        penalty += 5.0
        reasons.append(f"数据质量评级上限为 {rating_cap}，降低缩圈优先级。")
    if any(token in _text(row.get("why_in_universe")) for token in ["线索", "相关"]):
        penalty += 1.5
    return round(min(18.0, penalty), 2), reasons


def _layer_key(layer: str) -> str:
    text: str = _text(layer).lower()
    if not text:
        return "unmapped"
    if any(token in text for token in ["减速器", "传动", "丝杠", "gear", "screw"]):
        return "robotics_precision_transmission"
    if any(token in text for token in ["伺服", "执行器", "运动控制", "空心杯", "actuator", "servo"]):
        return "robotics_actuation_control"
    if any(token in text for token in ["视觉", "力控", "传感", "感知", "vision", "sensor"]):
        return "robotics_sensing_vision"
    if any(token in text for token in ["本体", "系统集成", "应用", "integrat"]):
        return "robotics_body_integration"
    if any(token in text for token in ["光模块", "光芯片", "高速互联", "cpo"]):
        return "ai_compute_interconnect"
    if any(token in text for token in ["服务器", "交换机", "pcb", "电源", "热管理"]):
        return "ai_compute_hardware"
    if any(token in text for token in ["半导体设备", "先进制程", "薄膜", "刻蚀"]):
        return "semicap_equipment"
    if any(token in text for token in ["cmp", "抛光", "湿电子", "材料"]):
        return "semicap_materials"
    return re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "_", text).strip("_")[:48] or "other_layer"


def _abnormal_trading_name_risk(name: str) -> bool:
    raw: str = _text(name)
    compact: str = re.sub(r"\s+", "", raw).upper()
    if not compact:
        return False
    if any(token in compact for token in ["退市", "摘牌", "终止上市"]):
        return True
    if re.search(r"[\u4e00-\u9fff]", compact) and (
        compact.endswith("退") or re.match(r"^退[\u4e00-\u9fff]", compact)
    ):
        return True
    if re.match(r"^(?:S\*ST|\*ST|ST)(?:[\u4e00-\u9fff]|[0-9]|$)", compact):
        return True
    return bool(re.search(r"(?:^|[^A-Z0-9])(?:S\*ST|\*ST|ST)(?:[^A-Z0-9]|$)", compact))


def _quality_floor(row: Mapping[str, Any], preflight: Mapping[str, Any]) -> dict[str, Any]:
    name: str = _text(row.get("name"))
    symbol: str = _text(row.get("symbol"))
    blockers: list[str] = []
    risk_flags: list[str] = []
    if _abnormal_trading_name_risk(name):
        blockers.append("名称命中 ST、退市或异常交易风险。")
    rating_cap: str = _text(preflight.get("rating_cap"))
    if rating_cap in QUALITY_BLOCKING_RATING_CAPS:
        blockers.append(f"数据/证据上限为 {rating_cap}，不进入正式 shortlist。")
    elif rating_cap == "C":
        risk_flags.append("数据/证据上限为 C，保留研究但降低优先级。")
    price: Optional[float] = _safe_float(preflight.get("price"))
    if symbol.endswith((".SH", ".SZ", ".BJ")) and price is not None and price < 1.0:
        blockers.append("A 股价格低于 1 元，存在面值退市或异常风险。")
    valuation: Mapping[str, Any] = _as_mapping(preflight.get("valuation_inputs"))
    market_cap: Optional[float] = _safe_float(valuation.get("total_market_cap"))
    if market_cap is not None and 0 < market_cap < 3_000_000_000:
        risk_flags.append("总市值较小，需额外核验流动性、财务韧性和退市风险。")
    statuses: Mapping[str, Any] = _as_mapping(preflight.get("status_by_dataset"))
    failed_core: list[str] = [
        dataset for dataset in CORE_PREFLIGHT_DATASETS
        if _text(statuses.get(dataset)) in {"FAILED", "NOT_REQUESTED", "PENDING", ""}
    ]
    if failed_core:
        blockers.append("核心预检未通过：" + ", ".join(failed_core))
    status: str = "BLOCKED" if blockers else "PASS"
    return {
        "status": status,
        "blockers": blockers,
        "risk_flags": risk_flags,
        "evidence_floor": "core_preflight_plus_quality_floor",
    }


def _candidate_has_formal_blocker(row: Mapping[str, Any]) -> bool:
    quality_floor: Mapping[str, Any] = _as_mapping(row.get("quality_floor"))
    if quality_floor.get("status") == "BLOCKED":
        return True
    if _as_list(row.get("red_flag_blockers")):
        return True
    feedback: Mapping[str, Any] = _as_mapping(row.get("ai_dossier_feedback"))
    return feedback.get("quality_delivery_allowed") is False


def _score_breakdown(
    row: Mapping[str, Any],
    preflight: Mapping[str, Any],
    price_preference: Mapping[str, Any],
    weights: Mapping[str, float],
) -> tuple[dict[str, float], list[str]]:
    affordability_score: float
    affordability_reasons: list[str]
    affordability_score, affordability_reasons = _affordability_score(preflight, price_preference)
    risk_penalty: float
    risk_reasons: list[str]
    risk_penalty, risk_reasons = _risk_penalty(row, preflight)
    breakdown: dict[str, float] = {
        "theme_fit_score": _theme_fit_score(row, weights),
        "value_chain_score": _value_chain_score(row),
        "data_readiness_score": _data_score(preflight),
        "evidence_strength_score": _evidence_strength_score(row, preflight),
        "affordability_score": affordability_score,
        "risk_penalty": risk_penalty,
    }
    return breakdown, affordability_reasons + risk_reasons


def _evidence_tasks(row: Mapping[str, Any]) -> list[str]:
    name: str = _text(row.get("name")) or _text(row.get("symbol"))
    layer: str = _text(row.get("layer")) or "待映射层级"
    return [
        f"验证 {name} 在「{layer}」中的收入、订单、客户、产能或现金流证据。",
        "读取最新年报、季报和近24个月公告，区分直接证据、披露线索和主题叙事。",
        "复核当前价格、估值输入、股本、市值和技术结构后再进入正式行动判断。",
    ]


def _select_shortlist_indexes(rows: Sequence[Mapping[str, Any]], shortlist_target: int) -> set[int]:
    eligible: list[int] = [
        index for index, row in enumerate(rows)
        if row.get("stage_status") == "DEFERRED" and row.get("final_bucket") == "evidence_watch"
        and not _candidate_has_formal_blocker(row)
    ]
    by_layer: dict[str, list[int]] = {}
    for index in eligible:
        layer: str = _layer_key(_text(rows[index].get("layer")))
        by_layer.setdefault(layer, []).append(index)
    for indexes in by_layer.values():
        indexes.sort(key=lambda item: float(rows[item].get("score") or 0.0), reverse=True)
    layer_order: list[str] = sorted(
        by_layer,
        key=lambda key: max(float(rows[index].get("score") or 0.0) for index in by_layer[key]),
        reverse=True,
    )
    selected: list[int] = []
    for layer in layer_order:
        if len(selected) >= shortlist_target:
            break
        selected.append(by_layer[layer][0])
    remaining: list[int] = [
        index for index in eligible
        if index not in selected
    ]
    remaining.sort(key=lambda item: float(rows[item].get("score") or 0.0), reverse=True)
    for index in remaining:
        if len(selected) >= shortlist_target:
            break
        selected.append(index)
    return set(selected)


def _candidate_pool_context(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    selected: list[Mapping[str, Any]] = [row for row in rows if row.get("selected_for_formal") is True]
    if not selected:
        return {
            "pool_context": "EMPTY",
            "same_theme": False,
            "same_layer": False,
            "capital_allocation_comparable": False,
            "strategy_comparable": False,
            "allowed_decision_modes": ["expand_universe", "repair_preflight"],
            "forbidden_decision_modes": ["clear_top_candidate", "allocation_candidate"],
            "reason": "shortlist 为空，需要扩展候选宇宙或修复预检数据。",
        }
    theme_sets: list[set[str]] = [
        {str(item) for item in _as_list(row.get("theme_keys")) if str(item).strip()}
        for row in selected
    ]
    common_themes: set[str] = set.intersection(*theme_sets) if theme_sets else set()
    layer_keys: set[str] = {_layer_key(_text(row.get("layer"))) for row in selected}
    same_theme: bool = bool(common_themes) or len({_text(row.get("theme_key")) for row in selected}) == 1
    same_layer: bool = len(layer_keys) == 1
    if same_theme and same_layer:
        context: str = "SAME_LAYER_COMPARISON"
        allowed: list[str] = ["research_priority", "formal_comparison", "clear_top_candidate_if_gates_pass"]
        forbidden: list[str] = []
        reason: str = "shortlist 处于同一主题和同一主要产业层级，可进入同池正式比较。"
    elif same_theme:
        context = "SAME_THEME_DIFFERENT_LAYERS"
        allowed = ["research_priority", "layer_rotation", "watchlist_strategy"]
        forbidden = ["clear_top_candidate", "allocation_candidate"]
        reason = "shortlist 属于同一主题但跨产业层级，优先输出层级与研究优先级。"
    else:
        context = "CROSS_THEME_DIAGNOSTIC"
        allowed = ["diagnostic_ranking", "research_priority"]
        forbidden = ["clear_top_candidate", "allocation_candidate"]
        reason = "shortlist 跨主题，当前排序用于诊断和研究排队。"
    return {
        "pool_context": context,
        "same_theme": same_theme,
        "same_layer": same_layer,
        "capital_allocation_comparable": same_theme and same_layer,
        "strategy_comparable": same_theme,
        "allowed_decision_modes": allowed,
        "forbidden_decision_modes": forbidden,
        "reason": reason,
    }


def _layer_summary(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    grouped: dict[str, list[Mapping[str, Any]]] = {}
    for row in rows:
        if row.get("final_bucket") == "constraint_excluded":
            continue
        grouped.setdefault(_layer_key(_text(row.get("layer"))), []).append(row)
    summaries: list[dict[str, Any]] = []
    for layer_key, layer_rows in grouped.items():
        scores: list[float] = [float(row.get("score") or 0.0) for row in layer_rows]
        evidence_scores: list[float] = [
            float(_as_mapping(row.get("score_breakdown")).get("evidence_strength_score") or 0.0)
            for row in layer_rows
        ]
        selected_symbols: list[str] = [
            _text(row.get("symbol")) for row in layer_rows
            if row.get("selected_for_formal") is True
        ]
        representative: Mapping[str, Any] = max(layer_rows, key=lambda item: float(item.get("score") or 0.0))
        summaries.append({
            "layer_key": layer_key,
            "layer": _text(representative.get("layer")),
            "theme_keys": sorted({
                str(theme_key)
                for row in layer_rows
                for theme_key in _as_list(row.get("theme_keys"))
                if str(theme_key).strip()
            }),
            "candidate_count": len(layer_rows),
            "selected_candidates": selected_symbols,
            "layer_score": round(max(scores) if scores else 0.0, 2),
            "evidence_strength_score": round(sum(evidence_scores) / len(evidence_scores), 2) if evidence_scores else 0.0,
            "why_layer_matters": _text(representative.get("why_in_universe")) or "该层级进入候选宇宙，需用正式研究验证瓶颈与收入传导。",
        })
    summaries.sort(key=lambda item: (0 if item["selected_candidates"] else 1, -float(item["layer_score"]), item["layer_key"]))
    return summaries


def build_candidate_funnel(
    *,
    plan_path: Path,
    universe_paths: Sequence[Path],
    preflight_root: Optional[Path],
    preflight_snapshot_path: Optional[Path],
) -> dict[str, Any]:
    plan: Mapping[str, Any] = _load_json(plan_path)
    plan_errors: list[str] = validate_opportunity_discovery_plan(plan)
    if plan_errors:
        raise ValueError("; ".join(plan_errors))
    request: Mapping[str, Any] = _as_mapping(plan.get("request"))
    policy: Mapping[str, Any] = _as_mapping(plan.get("universe_policy"))
    market_scope: list[str] = [_text(item) for item in _as_list(request.get("market_scope")) if _text(item)]
    excluded_boards: list[str] = [_text(item) for item in _as_list(request.get("excluded_boards")) if _text(item)]
    price_preference: Mapping[str, Any] = _as_mapping(request.get("price_preference"))
    weights: Mapping[str, float] = _theme_weights(plan)
    shortlist_target: int = int(policy.get("shortlist_target") or 8)
    raw_rows: list[dict[str, Any]]
    source_universe_paths: list[str]
    excluded_directions: list[dict[str, str]]
    raw_rows, source_universe_paths, excluded_directions = _candidate_theme_rows(plan, universe_paths)
    if not raw_rows:
        raise ValueError("candidate funnel requires at least one curated universe or one validated AI-built universe")
    snapshot: Mapping[str, Any] = _snapshot_by_symbol(preflight_snapshot_path)

    rows: list[dict[str, Any]] = []
    static_pass_count: int = 0
    data_pass_count: int = 0
    for raw in raw_rows:
        symbol: str = _text(raw.get("symbol"))
        market: str = _text(raw.get("market"))
        reasons: list[str] = []
        selected: bool = False
        status: str = "DEFERRED"
        bucket: str = "evidence_watch"
        preflight: dict[str, Any] = _preflight_row(symbol, preflight_root=preflight_root, snapshot=snapshot)
        quality_floor: dict[str, Any] = {
            "status": "PENDING_PREFLIGHT",
            "blockers": [],
            "risk_flags": [],
            "evidence_floor": "core_preflight_plus_quality_floor",
        }
        score_breakdown: dict[str, float] = {
            "theme_fit_score": _theme_fit_score(raw, weights),
            "value_chain_score": _value_chain_score(raw),
            "data_readiness_score": 0.0,
            "evidence_strength_score": 0.0,
            "affordability_score": 0.0,
            "risk_penalty": 0.0,
        }
        score: float = score_breakdown["theme_fit_score"] + score_breakdown["value_chain_score"]
        if not _market_allowed(market, market_scope):
            status = "FILTERED_OUT"
            bucket = "constraint_excluded"
            reasons.append(f"市场 {market} 不在允许范围 {', '.join(market_scope)}。")
        elif _excluded_by_board(symbol, excluded_boards):
            status = "FILTERED_OUT"
            bucket = "constraint_excluded"
            reasons.append("命中排除板块约束。")
        else:
            static_pass_count += 1
            if not preflight:
                bucket = "data_preflight_needed"
                reasons.append("缺少 preflight 数据，不能进入正式 shortlist。")
            else:
                preflight_ok: bool
                preflight_blockers: list[str]
                preflight_ok, preflight_blockers = _preflight_ready(preflight)
                if not preflight_ok:
                    bucket = "data_preflight_needed"
                    reasons.extend(preflight_blockers)
                else:
                    price_ok: bool
                    price_reason: str
                    price_ok, price_reason = _price_pass(preflight, price_preference)
                    reasons.append(price_reason)
                    score_breakdown, scoring_reasons = _score_breakdown(raw, preflight, price_preference, weights)
                    score = sum(
                        value for key, value in score_breakdown.items()
                        if key != "risk_penalty"
                    ) - score_breakdown["risk_penalty"]
                    quality_floor = _quality_floor(raw, preflight)
                    if not price_ok:
                        status = "FILTERED_OUT"
                        bucket = "constraint_excluded"
                    elif quality_floor.get("status") == "BLOCKED":
                        status = "FILTERED_OUT"
                        bucket = "constraint_excluded"
                        reasons.extend(str(item) for item in _as_list(quality_floor.get("blockers")) if str(item).strip())
                    else:
                        reasons.extend(scoring_reasons)
                        reasons.extend(str(item) for item in _as_list(quality_floor.get("risk_flags")) if str(item).strip())
                        data_pass_count += 1
                        reasons.append("核心 preflight 数据已到位，可进入缩圈评分。")
        rows.append({
            **raw,
            "stage_status": status,
            "final_bucket": bucket,
            "selected_for_formal": selected,
            "score": round(max(0.0, min(100.0, score)), 2),
            "score_breakdown": score_breakdown,
            "layer_key": _layer_key(_text(raw.get("layer"))),
            "quality_floor": quality_floor,
            "red_flag_blockers": list(quality_floor.get("blockers", [])) if isinstance(quality_floor.get("blockers"), list) else [],
            "preflight": preflight,
            "reasons": reasons or ["进入主题候选宇宙，等待约束和证据筛选。"],
            "evidence_tasks": _evidence_tasks(raw),
        })

    shortlist_indexes: set[int] = _select_shortlist_indexes(rows, shortlist_target)
    for index, row in enumerate(rows):
        if index in shortlist_indexes:
            row["stage_status"] = "IN_SHORTLIST"
            row["final_bucket"] = "formal_shortlist"
            row["selected_for_formal"] = True
            row["reasons"].append("进入正式 shortlist，下一步运行 formal comparison 和 AI research。")
        elif row["stage_status"] == "DEFERRED" and row["final_bucket"] == "evidence_watch":
            row["reasons"].append("未进入本轮 shortlist，保留为证据观察池。")
    rows.sort(key=lambda item: (0 if item["selected_for_formal"] else 1, -float(item["score"]), _text(item.get("symbol"))))
    shortlist_symbols: list[str] = [_text(row.get("symbol")) for row in rows if row.get("selected_for_formal") is True]
    layer_summary: list[dict[str, Any]] = _layer_summary(rows)
    pool_context: dict[str, Any] = _candidate_pool_context(rows)
    return {
        "contract_type": "serenity_candidate_funnel",
        "schema_version": "1.0",
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source_plan_path": str(plan_path.resolve()),
        "source_universe_paths": source_universe_paths,
        "constraints": {
            "market_scope": market_scope,
            "excluded_boards": excluded_boards,
            "price_preference": dict(price_preference),
            "shortlist_target": shortlist_target,
            "theme_weights": dict(weights),
            "low_price_bonus_cap": LOW_PRICE_BONUS_CAP,
        },
        "candidate_pool_context": pool_context,
        "layer_summary": layer_summary,
        "stage_summary": [
            {
                "stage": "theme_universe",
                "input_count": len(raw_rows),
                "output_count": len(raw_rows),
                "rule": "Build a multi-theme, layer-first universe from the macro theme map before naming formal candidates.",
            },
            {
                "stage": "hard_constraints",
                "input_count": len(raw_rows),
                "output_count": static_pass_count,
                "rule": "Apply market and board exclusions before any formal comparison.",
            },
            {
                "stage": "data_preflight",
                "input_count": static_pass_count,
                "output_count": data_pass_count,
                "rule": "Use light real-data preflight for quote, filings, valuation and evidence signals before shortlist selection.",
            },
            {
                "stage": "formal_shortlist",
                "input_count": data_pass_count,
                "output_count": len(shortlist_symbols),
                "rule": "Only shortlisted symbols enter full financials, formal comparison and AI research.",
            },
        ],
        "candidate_rows": rows,
        "shortlist_symbols": shortlist_symbols,
        "excluded_directions": excluded_directions,
        "next_step": "Run formal research only on shortlist_symbols with full datasets, then pass this funnel as context to AI research and strategy handoff.",
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Build candidate funnel JSON")
    parser.add_argument("plan", help="opportunity_discovery_plan.json")
    parser.add_argument("--universe", action="append", default=[], help="optional theme_candidate_universe.json")
    parser.add_argument("--preflight-root", help="root containing data/<symbol>/manifest.json preflight data")
    parser.add_argument("--preflight-snapshot", help="static preflight snapshot JSON for tests or offline review")
    parser.add_argument("--out", help="write candidate funnel JSON")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        payload: dict[str, Any] = build_candidate_funnel(
            plan_path=Path(args.plan),
            universe_paths=[Path(item) for item in args.universe],
            preflight_root=Path(args.preflight_root) if args.preflight_root else None,
            preflight_snapshot_path=Path(args.preflight_snapshot) if args.preflight_snapshot else None,
        )
        errors: list[str] = validate_candidate_funnel(payload)
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
