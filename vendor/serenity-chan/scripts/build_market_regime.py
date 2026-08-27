#!/usr/bin/env python3
"""Build a market-regime snapshot from benchmark price histories."""

from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:
    from technical_health import analyze_price_csv, analyze_price_rows
except ModuleNotFoundError:  # pragma: no cover
    from scripts.technical_health import analyze_price_csv, analyze_price_rows


CONTRACT_TYPE: str = "serenity_market_regime"
SCHEMA_VERSION: str = "1.0"


def _load_json(path: Path) -> Mapping[str, Any]:
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _text(value: Any) -> str:
    return str(value or "").strip()


def _manifest_dataset_path(manifest: Mapping[str, Any], dataset: str) -> Optional[Path]:
    for item in _as_list(manifest.get("results")):
        if not isinstance(item, Mapping):
            continue
        if _text(item.get("dataset")) == dataset and _text(item.get("data_path")):
            return Path(_text(item.get("data_path")))
    return None


def _symbol(manifest: Mapping[str, Any]) -> str:
    symbol: Mapping[str, Any] = _as_mapping(manifest.get("symbol"))
    return _text(symbol.get("symbol")) or _text(manifest.get("symbol"))


def _market(manifest: Mapping[str, Any]) -> str:
    symbol: Mapping[str, Any] = _as_mapping(manifest.get("symbol"))
    return _text(symbol.get("market"))


def benchmark_from_snapshot(row: Mapping[str, Any]) -> dict[str, Any]:
    price_rows: list[Any] = _as_list(row.get("price_history"))
    quote: Mapping[str, Any] = _as_mapping(row.get("quote"))
    health: dict[str, Any] = analyze_price_rows([item for item in price_rows if isinstance(item, Mapping)], quote=quote)
    return {
        "symbol": _text(row.get("symbol")),
        "name": _text(row.get("name")),
        "market": _text(row.get("market")),
        "technical_health": health,
    }


def benchmark_from_manifest(path: Path) -> dict[str, Any]:
    manifest: Mapping[str, Any] = _load_json(path)
    price_path: Optional[Path] = _manifest_dataset_path(manifest, "price_history_adjusted")
    quote_path: Optional[Path] = _manifest_dataset_path(manifest, "current_quote")
    if price_path is None:
        health: dict[str, Any] = {
            "status": "DATA_GATED",
            "history_depth_status": "IPO_TOO_NEW_OR_DATA_GATED",
            "trend_state": "DATA_GATED",
            "chan_action": "DATA_REQUIRED",
            "buy_point_claim_allowed": False,
            "latest_close": None,
            "metrics": {"bars": 0},
            "relative_strength": {"status": "DATA_GATED", "benchmark_bars": 0},
            "decision_note": "Benchmark adjusted price history is missing.",
            "readiness_score": 25.0,
        }
    else:
        health = analyze_price_csv(price_path, quote_path)
    return {
        "symbol": _symbol(manifest),
        "name": _symbol(manifest),
        "market": _market(manifest),
        "technical_health": health,
        "source_manifest_path": str(path),
    }


def _regime_status(benchmarks: Sequence[Mapping[str, Any]]) -> tuple[str, int, int, int]:
    ok_count: int = 0
    risk_on_count: int = 0
    risk_off_count: int = 0
    for benchmark in benchmarks:
        health: Mapping[str, Any] = _as_mapping(benchmark.get("technical_health"))
        if health.get("status") in {"OK", "PARTIAL"}:
            ok_count += 1
        trend_state: str = _text(health.get("trend_state"))
        if trend_state in {"TREND_PULLBACK_WATCH", "CONSTRUCTIVE_PULLBACK_WATCH", "STRONG_EXTENDED_WATCH"}:
            risk_on_count += 1
        if trend_state in {"WEAK_OR_DOWNTREND", "DATA_GATED"}:
            risk_off_count += 1
    if not benchmarks or ok_count == 0:
        return "DATA_GATED", ok_count, risk_on_count, risk_off_count
    denominator: int = max(1, len(benchmarks))
    if risk_on_count / denominator >= 0.6:
        return "RISK_ON", ok_count, risk_on_count, risk_off_count
    if risk_off_count / denominator >= 0.6:
        return "RISK_OFF", ok_count, risk_on_count, risk_off_count
    return "MIXED", ok_count, risk_on_count, risk_off_count


def _decision_boundary(status: str) -> str:
    if status == "RISK_ON":
        return "市场环境支持把高质量候选推进到触发器和买点观察，但仍需个股证据与结构确认。"
    if status == "MIXED":
        return "市场环境分化，策略判断需要更重视相对强弱、候选层级和失效条件。"
    if status == "RISK_OFF":
        return "市场环境偏弱，正式行动应降低仓位表达，优先等待结构改善或只保留研究观察。"
    return "市场环境数据不足，不能把宏观/指数环境作为支持行动的证据。"


def build_market_regime(
    *,
    snapshot_path: Optional[Path] = None,
    manifest_paths: Sequence[Path] = (),
) -> dict[str, Any]:
    benchmarks: list[dict[str, Any]] = []
    if snapshot_path:
        snapshot: Mapping[str, Any] = _load_json(snapshot_path)
        benchmarks.extend(
            benchmark_from_snapshot(row)
            for row in _as_list(snapshot.get("benchmarks"))
            if isinstance(row, Mapping)
        )
    benchmarks.extend(benchmark_from_manifest(path) for path in manifest_paths)
    status, ok_count, risk_on_count, risk_off_count = _regime_status(benchmarks)
    return {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "summary": {
            "regime_status": status,
            "benchmark_count": len(benchmarks),
            "ok_count": ok_count,
            "risk_on_count": risk_on_count,
            "risk_off_count": risk_off_count,
        },
        "benchmarks": benchmarks,
        "decision_boundary": _decision_boundary(status),
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Build Serenity market regime")
    parser.add_argument("--snapshot", help="JSON snapshot with benchmarks[].price_history")
    parser.add_argument("--manifest", action="append", default=[], help="Benchmark data-router manifest path")
    parser.add_argument("--out")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        payload: dict[str, Any] = build_market_regime(
            snapshot_path=Path(args.snapshot) if args.snapshot else None,
            manifest_paths=[Path(item) for item in args.manifest],
        )
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
