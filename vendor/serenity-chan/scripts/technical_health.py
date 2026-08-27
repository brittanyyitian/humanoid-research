#!/usr/bin/env python3
"""Compute deterministic technical-health fields from adjusted daily prices."""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import math
import sys
from pathlib import Path
from typing import Any, Iterable, Mapping, Optional, Sequence


def _parse_float(value: Any) -> Optional[float]:
    if value is None or value == "":
        return None
    try:
        number = float(str(value).replace(",", ""))
    except Exception:
        return None
    if math.isnan(number) or math.isinf(number):
        return None
    return number


def _parse_date(value: Any) -> Optional[dt.date]:
    if value is None:
        return None
    text = str(value).strip()[:10]
    for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y%m%d"):
        try:
            return dt.datetime.strptime(text, fmt).date()
        except ValueError:
            pass
    return None


def _round(value: Optional[float], digits: int = 2) -> Optional[float]:
    return None if value is None else round(value, digits)


def _pct(numerator: Optional[float], denominator: Optional[float]) -> Optional[float]:
    if numerator is None or denominator in (None, 0):
        return None
    return (numerator / denominator - 1.0) * 100.0


def _return_pct(closes: Sequence[float], window: int) -> Optional[float]:
    if len(closes) <= window:
        return None
    start: float = closes[-window - 1]
    end: float = closes[-1]
    return _pct(end, start)


def _sma(values: Sequence[float], window: int) -> Optional[float]:
    if len(values) < window:
        return None
    return sum(values[-window:]) / window


def _atr(rows: Sequence[Mapping[str, Any]], window: int = 20) -> Optional[float]:
    if len(rows) < 2:
        return None
    true_ranges: list[float] = []
    previous_close: Optional[float] = None
    for row in rows:
        high = _parse_float(row.get("high"))
        low = _parse_float(row.get("low"))
        close = _parse_float(row.get("close") or row.get("adj_close"))
        if high is None or low is None or close is None:
            continue
        if previous_close is None:
            true_range = high - low
        else:
            true_range = max(high - low, abs(high - previous_close), abs(low - previous_close))
        true_ranges.append(true_range)
        previous_close = close
    if not true_ranges:
        return None
    sample = true_ranges[-window:]
    return sum(sample) / len(sample)


def read_price_csv(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        return list(csv.DictReader(handle))


def _clean_rows(rows: Iterable[Mapping[str, Any]]) -> list[dict[str, Any]]:
    cleaned: list[dict[str, Any]] = []
    for row in rows:
        date_value = _parse_date(row.get("date"))
        close = _parse_float(row.get("close") or row.get("adj_close"))
        high = _parse_float(row.get("high") or close)
        low = _parse_float(row.get("low") or close)
        if date_value is None or close is None or high is None or low is None:
            continue
        cleaned.append({
            "date": date_value.isoformat(),
            "close": close,
            "high": high,
            "low": low,
            "volume": _parse_float(row.get("volume")),
        })
    cleaned.sort(key=lambda item: item["date"])
    return cleaned


def _relative_strength(
    closes: Sequence[float],
    benchmark_rows: Optional[Iterable[Mapping[str, Any]]],
) -> dict[str, Any]:
    benchmark_cleaned: list[dict[str, Any]] = _clean_rows(benchmark_rows or [])
    benchmark_closes: list[float] = [float(row["close"]) for row in benchmark_cleaned]
    stock_return_20d: Optional[float] = _return_pct(closes, 20)
    stock_return_60d: Optional[float] = _return_pct(closes, 60)
    benchmark_return_20d: Optional[float] = _return_pct(benchmark_closes, 20)
    benchmark_return_60d: Optional[float] = _return_pct(benchmark_closes, 60)
    relative_20d: Optional[float] = None
    relative_60d: Optional[float] = None
    if stock_return_20d is not None and benchmark_return_20d is not None:
        relative_20d = stock_return_20d - benchmark_return_20d
    if stock_return_60d is not None and benchmark_return_60d is not None:
        relative_60d = stock_return_60d - benchmark_return_60d
    if relative_20d is None and relative_60d is None:
        status: str = "DATA_GATED"
    elif (relative_20d is not None and relative_20d >= 5.0) or (relative_60d is not None and relative_60d >= 8.0):
        status = "OUTPERFORMING"
    elif (relative_20d is not None and relative_20d <= -5.0) or (relative_60d is not None and relative_60d <= -8.0):
        status = "UNDERPERFORMING"
    else:
        status = "NEUTRAL"
    return {
        "status": status,
        "benchmark_bars": len(benchmark_cleaned),
        "stock_return_20d_pct": _round(stock_return_20d),
        "stock_return_60d_pct": _round(stock_return_60d),
        "benchmark_return_20d_pct": _round(benchmark_return_20d),
        "benchmark_return_60d_pct": _round(benchmark_return_60d),
        "relative_strength_20d_pct": _round(relative_20d),
        "relative_strength_60d_pct": _round(relative_60d),
    }


def analyze_price_rows(
    rows: Iterable[Mapping[str, Any]],
    quote: Optional[Mapping[str, Any]] = None,
    *,
    benchmark_rows: Optional[Iterable[Mapping[str, Any]]] = None,
) -> dict[str, Any]:
    cleaned: list[dict[str, Any]] = _clean_rows(rows)
    closes: list[float] = [float(row["close"]) for row in cleaned]
    latest_close: Optional[float] = closes[-1] if closes else _parse_float((quote or {}).get("regular_market_price"))
    sma20: Optional[float] = _sma(closes, 20)
    sma50: Optional[float] = _sma(closes, 50)
    sma200: Optional[float] = _sma(closes, 200)
    recent: list[dict[str, Any]] = cleaned[-252:] if cleaned else []
    high_52w: Optional[float] = max((_parse_float(row.get("high")) or 0.0) for row in recent) if recent else _parse_float((quote or {}).get("fifty_two_week_high"))
    low_52w_values: list[float] = [(_parse_float(row.get("low")) or 0.0) for row in recent if (_parse_float(row.get("low")) or 0.0) > 0]
    low_52w: Optional[float] = min(low_52w_values) if low_52w_values else _parse_float((quote or {}).get("fifty_two_week_low"))
    atr20: Optional[float] = _atr(cleaned, 20)
    relative_strength: dict[str, Any] = _relative_strength(closes, benchmark_rows)

    metrics: dict[str, Any] = {
        "bars": len(cleaned),
        "sma20": _round(sma20),
        "sma50": _round(sma50),
        "sma200": _round(sma200),
        "atr20": _round(atr20),
        "return_20d_pct": _round(_return_pct(closes, 20)),
        "return_60d_pct": _round(_return_pct(closes, 60)),
        "distance_to_sma20_pct": _round(_pct(latest_close, sma20)),
        "distance_to_sma50_pct": _round(_pct(latest_close, sma50)),
        "distance_to_sma200_pct": _round(_pct(latest_close, sma200)),
        "distance_to_52w_high_pct": _round(_pct(latest_close, high_52w)),
        "distance_to_52w_low_pct": _round(_pct(latest_close, low_52w)),
    }

    if len(cleaned) >= 250:
        history_depth_status = "FULL_250_PLUS"
    elif len(cleaned) >= 120:
        history_depth_status = "PARTIAL_120_249"
    elif len(cleaned) >= 60:
        history_depth_status = "SHORT_60_119"
    else:
        history_depth_status = "IPO_TOO_NEW_OR_DATA_GATED"

    status = "OK" if len(cleaned) >= 200 else "PARTIAL" if len(cleaned) >= 60 else "DATA_GATED"
    if latest_close is None or status == "DATA_GATED":
        return {
            "status": "DATA_GATED",
            "history_depth_status": history_depth_status,
            "trend_state": "DATA_GATED",
            "chan_action": "DATA_REQUIRED",
            "buy_point_claim_allowed": False,
            "latest_close": _round(latest_close),
            "metrics": metrics,
            "relative_strength": relative_strength,
            "decision_note": "复权日线历史不足，不能输出技术时机判断。",
            "readiness_score": 25.0,
        }

    distance20 = metrics["distance_to_sma20_pct"]
    distance_high = metrics["distance_to_52w_high_pct"]
    if sma20 and sma50 and sma200 and latest_close > sma20 > sma50 > sma200:
        if (distance20 is not None and distance20 >= 8.0) or (distance_high is not None and distance_high >= -5.0):
            trend_state = "STRONG_EXTENDED_WATCH"
            chan_action = "WAIT_FOR_SECOND_BUY"
            note = "强趋势已延伸，等待二买回调或三买回踩确认。"
            readiness = 62.0
        else:
            trend_state = "TREND_PULLBACK_WATCH"
            chan_action = "WAIT_FOR_STRUCTURE_CONFIRMATION"
            note = "趋势仍具建设性，但仅靠 DMA 接近不能确认缠论买点。"
            readiness = 66.0
    elif sma20 and sma50 and latest_close >= sma50 and (distance20 is not None and abs(distance20) <= 4.0):
        trend_state = "CONSTRUCTIVE_PULLBACK_WATCH"
        chan_action = "WAIT_FOR_STRUCTURE_CONFIRMATION"
        note = "价格接近短期均线，需要结构确认后才能称为买点。"
        readiness = 58.0
    elif sma200 and latest_close < sma200:
        trend_state = "WEAK_OR_DOWNTREND"
        chan_action = "NO_BUY_POINT"
        note = "价格低于长期均线，不能把反弹当成长线买点。"
        readiness = 38.0
    else:
        trend_state = "BASE_BUILDING_WATCH"
        chan_action = "WAIT_FOR_STRUCTURE_CONFIRMATION"
        note = "结构可观察，但需要多级别确认。"
        readiness = 50.0
    if relative_strength.get("status") == "OUTPERFORMING":
        readiness = min(72.0, readiness + 4.0)
        note += " 相对基准保持强势，优先观察结构确认。"
    elif relative_strength.get("status") == "UNDERPERFORMING":
        readiness = max(32.0, readiness - 6.0)
        note += " 相对基准走弱，不能把个股反弹直接升级为强趋势。"

    return {
        "status": status,
        "history_depth_status": history_depth_status,
        "trend_state": trend_state,
        "chan_action": chan_action,
        "buy_point_claim_allowed": False,
        "latest_close": _round(latest_close),
        "metrics": metrics,
        "relative_strength": relative_strength,
        "decision_note": note,
        "readiness_score": readiness,
    }


def analyze_price_csv(
    path: Path,
    quote_path: Optional[Path] = None,
    benchmark_path: Optional[Path] = None,
) -> dict[str, Any]:
    quote: Optional[Mapping[str, Any]] = None
    if quote_path and quote_path.exists():
        loaded: Any = json.loads(quote_path.read_text(encoding="utf-8"))
        if isinstance(loaded, Mapping):
            quote = loaded
    benchmark_rows: Optional[list[dict[str, Any]]] = read_price_csv(benchmark_path) if benchmark_path and benchmark_path.exists() else None
    return analyze_price_rows(read_price_csv(path), quote=quote, benchmark_rows=benchmark_rows)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Compute Serenity + Chan technical-health fields")
    parser.add_argument("price_history_csv")
    parser.add_argument("--quote", help="Optional current quote JSON")
    parser.add_argument("--benchmark", help="Optional benchmark adjusted price CSV")
    args = parser.parse_args(argv)
    try:
        result = analyze_price_csv(
            Path(args.price_history_csv),
            Path(args.quote) if args.quote else None,
            Path(args.benchmark) if args.benchmark else None,
        )
        print(json.dumps(result, ensure_ascii=False, indent=2))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())


def volume_heat(rows: Iterable[Mapping[str, Any]]) -> dict[str, Any]:
    """Unit-free volume/price heat from daily rows: the FOMO sensor.

    Ratios and percentiles cancel volume units, so this works across
    providers without knowing whether volume is shares or lots. Requires 30
    bars for a meaningful window; percentiles use the full supplied window.
    """
    cleaned: list[dict[str, Any]] = _clean_rows(rows)
    volumes: list[float] = [float(row["volume"]) for row in cleaned if isinstance(row.get("volume"), (int, float)) and float(row["volume"]) > 0]
    closes: list[float] = [float(row["close"]) for row in cleaned]
    if len(volumes) < 30 or len(closes) < 30:
        return {"status": "DATA_GATED", "bars": len(cleaned), "note": "volume heat needs at least 30 bars with volume"}
    latest_volume: float = volumes[-1]
    avg_volume_20d: Optional[float] = _sma(volumes, 20)
    vol_ratio_20d: Optional[float] = _round(latest_volume / avg_volume_20d, 2) if avg_volume_20d else None
    volume_percentile: float = round(sum(1 for value in volumes if value <= latest_volume) / len(volumes) * 100.0, 1)
    latest_close: float = closes[-1]
    price_percentile: float = round(sum(1 for value in closes if value <= latest_close) / len(closes) * 100.0, 1)
    if vol_ratio_20d is not None and vol_ratio_20d >= 2.5 and price_percentile >= 90.0:
        heat_state: str = "CROWDED_SURGE"
    elif vol_ratio_20d is not None and vol_ratio_20d >= 1.8:
        heat_state = "ELEVATED"
    elif vol_ratio_20d is not None and vol_ratio_20d <= 0.5:
        heat_state = "DRIED_UP"
    else:
        heat_state = "NORMAL"
    return {
        "status": "OK",
        "bars": len(cleaned),
        "vol_ratio_20d": vol_ratio_20d,
        "volume_percentile": volume_percentile,
        "price_percentile": price_percentile,
        "heat_state": heat_state,
        "note": "比率与分位均为无量纲指标；CROWDED_SURGE=量能≥2.5倍20日均量且价格处于90分位以上。",
    }
