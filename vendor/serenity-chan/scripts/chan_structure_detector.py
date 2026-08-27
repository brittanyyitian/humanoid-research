#!/usr/bin/env python3
"""Detect a conservative Chan-style structure from OHLC rows."""

from __future__ import annotations

import argparse
import csv
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence


CONTRACT_TYPE: str = "serenity_chan_structure"
SCHEMA_VERSION: str = "1.0"


def _safe_float(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _text(value: Any) -> str:
    return str(value or "").strip()


def _row_value(row: Mapping[str, Any], keys: Sequence[str]) -> Any:
    for key in keys:
        if key in row and row[key] not in (None, ""):
            return row[key]
    return None


def _normalize_rows(rows: Sequence[Mapping[str, Any]]) -> list[dict[str, Any]]:
    normalized: list[dict[str, Any]] = []
    for row in rows:
        high: Optional[float] = _safe_float(_row_value(row, ["high", "最高", "最高价"]))
        low: Optional[float] = _safe_float(_row_value(row, ["low", "最低", "最低价"]))
        close: Optional[float] = _safe_float(_row_value(row, ["close", "收盘", "收盘价"]))
        date: str = _text(_row_value(row, ["date", "trade_date", "datetime", "日期"]))
        if high is None or low is None or close is None:
            continue
        normalized.append({"date": date, "high": high, "low": low, "close": close})
    return normalized


def _fractal_payload(row: Mapping[str, Any], kind: str) -> dict[str, Any]:
    price_key: str = "high" if kind == "top" else "low"
    return {
        "date": _text(row.get("date")),
        "kind": kind,
        "price": float(row.get(price_key) or 0.0),
    }


def _fractals(rows: Sequence[Mapping[str, Any]]) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    tops: list[dict[str, Any]] = []
    bottoms: list[dict[str, Any]] = []
    for index in range(1, len(rows) - 1):
        prev: Mapping[str, Any] = rows[index - 1]
        current: Mapping[str, Any] = rows[index]
        nxt: Mapping[str, Any] = rows[index + 1]
        current_high: float = float(current["high"])
        current_low: float = float(current["low"])
        if current_high > float(prev["high"]) and current_high >= float(nxt["high"]):
            tops.append(_fractal_payload(current, "top"))
        if current_low < float(prev["low"]) and current_low <= float(nxt["low"]):
            bottoms.append(_fractal_payload(current, "bottom"))
    return tops, bottoms


def _trend_state(tops: Sequence[Mapping[str, Any]], bottoms: Sequence[Mapping[str, Any]]) -> str:
    if len(tops) < 2 or len(bottoms) < 2:
        return "UNKNOWN"
    higher_lows: bool = float(bottoms[-1]["price"]) > float(bottoms[-2]["price"])
    higher_highs: bool = float(tops[-1]["price"]) > float(tops[-2]["price"])
    lower_lows: bool = float(bottoms[-1]["price"]) < float(bottoms[-2]["price"])
    lower_highs: bool = float(tops[-1]["price"]) < float(tops[-2]["price"])
    if higher_lows and higher_highs:
        return "UP_STRUCTURE"
    if lower_lows and lower_highs:
        return "DOWN_STRUCTURE"
    return "RANGE_STRUCTURE"


def _center(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    if len(rows) < 20:
        return {"detected": False, "low": None, "high": None, "basis": "少于 20 根 K 线，结构中枢不成立。"}
    recent: Sequence[Mapping[str, Any]] = rows[-20:]
    first_half: Sequence[Mapping[str, Any]] = recent[:10]
    second_half: Sequence[Mapping[str, Any]] = recent[10:]
    overlap_low: float = max(min(float(row["low"]) for row in first_half), min(float(row["low"]) for row in second_half))
    overlap_high: float = min(max(float(row["high"]) for row in first_half), max(float(row["high"]) for row in second_half))
    detected: bool = overlap_low <= overlap_high
    return {
        "detected": detected,
        "low": round(overlap_low, 4) if detected else None,
        "high": round(overlap_high, 4) if detected else None,
        "basis": "最近 20 根 K 线前后两段价格重叠区间。" if detected else "最近 20 根 K 线未形成可复核重叠区间。",
    }


def _buy_points(
    rows: Sequence[Mapping[str, Any]],
    *,
    tops: Sequence[Mapping[str, Any]],
    bottoms: Sequence[Mapping[str, Any]],
    center: Mapping[str, Any],
    trend_state: str,
) -> list[dict[str, str]]:
    close: float = float(rows[-1]["close"]) if rows else 0.0
    second_status: str = "NOT_PRESENT"
    second_reason: str = "最近底分型不足或未形成高低点抬升。"
    if len(bottoms) >= 2 and trend_state in {"UP_STRUCTURE", "RANGE_STRUCTURE"}:
        last_bottom: float = float(bottoms[-1]["price"])
        previous_bottom: float = float(bottoms[-2]["price"])
        if last_bottom > previous_bottom and close > last_bottom:
            second_status = "CANDIDATE"
            second_reason = "最近底分型高于前底，收盘价重新站上最近底分型。"

    third_status: str = "NOT_PRESENT"
    third_reason: str = "未检测到中枢上沿突破后的回踩确认。"
    center_high: Optional[float] = _safe_float(center.get("high"))
    if center.get("detected") is True and center_high is not None and close > center_high and len(tops) >= 2:
        third_status = "CANDIDATE"
        third_reason = "收盘价位于最近中枢上沿之上，需要后续回踩不破来确认三买。"
    return [
        {"type": "SECOND_BUY", "status": second_status, "reason": second_reason},
        {"type": "THIRD_BUY", "status": third_status, "reason": third_reason},
    ]


def detect_chan_structure(rows: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    normalized: list[dict[str, Any]] = _normalize_rows(rows)
    bar_count: int = len(normalized)
    if bar_count < 30:
        return {
            "contract_type": CONTRACT_TYPE,
            "schema_version": SCHEMA_VERSION,
            "bar_count": bar_count,
            "last_date": _text(normalized[-1].get("date")) if normalized else "",
            "structure_status": "INSUFFICIENT_HISTORY",
            "trend_state": "UNKNOWN",
            "fractals": {"top_count": 0, "bottom_count": 0, "recent_top": None, "recent_bottom": None},
            "center": {"detected": False, "low": None, "high": None, "basis": "K 线数量不足。"},
            "buy_point_candidates": [],
            "action": "DATA_REQUIRED",
            "confidence": "LOW",
            "evidence_notes": ["至少需要 30 根有效 OHLC K 线，正式买点判断建议使用 120 根以上。"],
        }
    tops: list[dict[str, Any]]
    bottoms: list[dict[str, Any]]
    tops, bottoms = _fractals(normalized)
    trend: str = _trend_state(tops, bottoms)
    center: dict[str, Any] = _center(normalized)
    buy_points: list[dict[str, str]] = _buy_points(normalized, tops=tops, bottoms=bottoms, center=center, trend_state=trend)
    candidate_count: int = len([row for row in buy_points if row["status"] == "CANDIDATE"])
    if len(tops) < 2 or len(bottoms) < 2:
        structure_status: str = "WEAK_STRUCTURE"
    elif trend == "RANGE_STRUCTURE":
        structure_status = "RANGE_STRUCTURE"
    else:
        structure_status = "STRUCTURE_DETECTED"
    if candidate_count:
        action: str = "STRUCTURE_WATCH"
    elif structure_status == "STRUCTURE_DETECTED":
        action = "WAIT_FOR_BUY_POINT"
    else:
        action = "NO_BUY_POINT"
    confidence: str = "HIGH" if bar_count >= 120 and len(tops) >= 4 and len(bottoms) >= 4 else "MEDIUM" if bar_count >= 60 else "LOW"
    return {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "bar_count": bar_count,
        "last_date": _text(normalized[-1].get("date")),
        "structure_status": structure_status,
        "trend_state": trend,
        "fractals": {
            "top_count": len(tops),
            "bottom_count": len(bottoms),
            "recent_top": tops[-1] if tops else None,
            "recent_bottom": bottoms[-1] if bottoms else None,
        },
        "center": center,
        "buy_point_candidates": buy_points,
        "action": action,
        "confidence": confidence,
        "evidence_notes": [
            "该探测器只输出结构证据，不单独生成正式买入结论。",
            "买点候选需要结合复权价格、成交、基本面门控和风险约束复核。",
        ],
    }


def validate_chan_structure(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != CONTRACT_TYPE:
        errors.append(f"contract_type must be {CONTRACT_TYPE}")
    if payload.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    if payload.get("structure_status") not in {"INSUFFICIENT_HISTORY", "STRUCTURE_DETECTED", "RANGE_STRUCTURE", "WEAK_STRUCTURE"}:
        errors.append("structure_status is unknown")
    if payload.get("trend_state") not in {"UP_STRUCTURE", "DOWN_STRUCTURE", "RANGE_STRUCTURE", "UNKNOWN"}:
        errors.append("trend_state is unknown")
    if payload.get("action") not in {"STRUCTURE_WATCH", "WAIT_FOR_BUY_POINT", "NO_BUY_POINT", "DATA_REQUIRED"}:
        errors.append("action is unknown")
    if payload.get("confidence") not in {"LOW", "MEDIUM", "HIGH"}:
        errors.append("confidence is unknown")
    if not isinstance(payload.get("buy_point_candidates"), list):
        errors.append("buy_point_candidates must be an array")
    if not isinstance(payload.get("evidence_notes"), list) or not payload.get("evidence_notes"):
        errors.append("evidence_notes must not be empty")
    return errors


def _read_csv(path: Path) -> list[Mapping[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return [dict(row) for row in csv.DictReader(handle)]


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Detect Chan structure from OHLC CSV")
    parser.add_argument("ohlc_csv", help="CSV with date/high/low/close columns")
    parser.add_argument("--out")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        payload: dict[str, Any] = detect_chan_structure(_read_csv(Path(args.ohlc_csv)))
        errors: list[str] = validate_chan_structure(payload)
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
