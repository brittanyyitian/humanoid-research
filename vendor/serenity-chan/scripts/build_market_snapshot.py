#!/usr/bin/env python3
"""Build a market snapshot for market-regime analysis from live benchmark data.

This closes the input side of `build_market_regime.py`: it fetches registry
benchmarks (Tencent index aliases first, Yahoo for US indices) and writes the
`benchmarks[].price_history + quote` shape that the regime builder consumes.
Failed benchmarks are excluded from `benchmarks` and reported in `failed` so
an unreachable feed cannot poison the regime vote as a false risk-off signal.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Optional, Sequence

try:
    from market_quotes import BENCHMARKS, DEFAULT_BENCHMARK_KEYS, fetch_benchmark
except ModuleNotFoundError:  # pragma: no cover - supports python -m scripts.build_market_snapshot
    from scripts.market_quotes import BENCHMARKS, DEFAULT_BENCHMARK_KEYS, fetch_benchmark


CONTRACT_TYPE: str = "serenity_market_snapshot"
SCHEMA_VERSION: str = "1.0"


def build_market_snapshot(keys: Sequence[str], *, history_days: int = 280) -> dict[str, Any]:
    benchmarks: list[dict[str, Any]] = []
    failed: list[dict[str, str]] = []
    for key in keys:
        try:
            benchmarks.append(fetch_benchmark(key, chart_range_days=history_days))
        except Exception as exc:
            failed.append({"key": key, "error": f"{type(exc).__name__}: {exc}"})
    return {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "requested_keys": list(keys),
        "benchmarks": benchmarks,
        "failed": failed,
        "summary": {
            "requested_count": len(list(keys)),
            "fetched_count": len(benchmarks),
            "failed_count": len(failed),
        },
    }


def validate_market_snapshot(payload: dict[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != CONTRACT_TYPE:
        errors.append(f"contract_type must be {CONTRACT_TYPE}")
    benchmarks: Any = payload.get("benchmarks")
    if not isinstance(benchmarks, list):
        errors.append("benchmarks must be an array")
        return errors
    for index, row in enumerate(benchmarks):
        if not isinstance(row, dict):
            errors.append(f"benchmarks[{index}] must be an object")
            continue
        if not str(row.get("symbol") or "").strip():
            errors.append(f"benchmarks[{index}].symbol must not be empty")
        history: Any = row.get("price_history")
        if not isinstance(history, list) or len(history) < 30:
            errors.append(f"benchmarks[{index}].price_history needs at least 30 rows")
    return errors


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Fetch benchmark data into a market snapshot")
    parser.add_argument(
        "--benchmarks",
        nargs="*",
        default=list(DEFAULT_BENCHMARK_KEYS),
        help=f"benchmark keys (known: {', '.join(sorted(BENCHMARKS))}; default: {' '.join(DEFAULT_BENCHMARK_KEYS)})",
    )
    parser.add_argument("--history-days", type=int, default=280, help="daily bars per benchmark")
    parser.add_argument("--out", help="write snapshot JSON to this path")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        payload: dict[str, Any] = build_market_snapshot(args.benchmarks, history_days=args.history_days)
        if not payload["benchmarks"]:
            failures: str = "; ".join(f"{row['key']}: {row['error']}" for row in payload["failed"])
            raise RuntimeError(f"no benchmark could be fetched ({failures})")
        errors: list[str] = validate_market_snapshot(payload)
        if errors:
            raise ValueError("; ".join(errors))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    text: str = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        out_path: Path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text + "\n", encoding="utf-8")
        print(json.dumps({"ok": True, "out": args.out, "summary": payload["summary"]}, ensure_ascii=False))
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
