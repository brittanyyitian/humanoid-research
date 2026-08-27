#!/usr/bin/env python3
"""Build a calibration report from the companion forecast ledger."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional, Sequence


CONTRACT_TYPE: str = "serenity_calibration_report"
SCHEMA_VERSION: str = "1.0"
DEFAULT_LEDGER_PATH: str = "~/.cache/serenity-chan/forecast-ledger.sqlite"


def _ledger_path(raw_path: Optional[str]) -> Path:
    value: str = raw_path or os.environ.get("SERENITY_FORECAST_LEDGER_PATH", DEFAULT_LEDGER_PATH)
    return Path(value).expanduser()


def _avg(values: Sequence[float]) -> Optional[float]:
    if not values:
        return None
    return sum(values) / len(values)


def _round(value: Optional[float]) -> Optional[float]:
    return None if value is None else round(value, 4)


def _rows(ledger_path: Path) -> tuple[int, list[sqlite3.Row]]:
    if not ledger_path.exists():
        return 0, []
    conn: sqlite3.Connection = sqlite3.connect(ledger_path)
    conn.row_factory = sqlite3.Row
    try:
        forecast_count: int = int(conn.execute("SELECT COUNT(*) FROM forecasts").fetchone()[0])
        claim_rows: list[sqlite3.Row] = conn.execute(
            """
            SELECT status, final_brier, initial_brier
            FROM claims
            ORDER BY forecast_id, claim_id
            """
        ).fetchall()
    except sqlite3.OperationalError:
        return 0, []
    finally:
        conn.close()
    return forecast_count, claim_rows


def confidence_policy(resolved_count: int, avg_final_brier: Optional[float]) -> dict[str, Any]:
    if resolved_count < 5 or avg_final_brier is None:
        return {
            "status": "INSUFFICIENT_HISTORY",
            "decision": "历史结算样本不足，AI 判断必须继续以证据链、反证和场景权重为主。",
        }
    if avg_final_brier <= 0.2:
        return {
            "status": "WELL_CALIBRATED",
            "decision": "历史预测误差较低，可以保持当前证据门槛，同时继续写入可复盘 claim。",
        }
    if avg_final_brier <= 0.3:
        return {
            "status": "WATCH",
            "decision": "历史预测误差中等，正式行动前需要更明确的触发器和失效条件。",
        }
    return {
        "status": "TIGHTEN_EVIDENCE_BAR",
        "decision": "历史预测误差偏高，需要提高证据门槛，降低高确信表达，并优先复查失败 claim 的共同原因。",
    }


POLICY_CONTRACT_TYPE: str = "serenity_calibration_policy"
POLICY_BY_STATUS: dict[str, dict[str, Any]] = {
    "INSUFFICIENT_HISTORY": {"h4_h5_confidence_floor": 0.65, "dossier_score_floor_delta": 0},
    "WELL_CALIBRATED": {"h4_h5_confidence_floor": 0.65, "dossier_score_floor_delta": 0},
    "WATCH": {"h4_h5_confidence_floor": 0.70, "dossier_score_floor_delta": 3},
    "TIGHTEN_EVIDENCE_BAR": {"h4_h5_confidence_floor": 0.75, "dossier_score_floor_delta": 5},
}


def build_calibration_policy(report: dict[str, Any]) -> dict[str, Any]:
    """Project the calibration report into machine-consumed evidence bars.

    Poor historical calibration raises the L0/L1 confidence floor used by
    overlay validation and the dossier delivery score line, so past error
    directly prices future confidence.
    """
    status: str = str(report.get("confidence_policy", {}).get("status") or "INSUFFICIENT_HISTORY")
    knobs: dict[str, Any] = POLICY_BY_STATUS.get(status, POLICY_BY_STATUS["INSUFFICIENT_HISTORY"])
    summary: dict[str, Any] = report.get("summary", {}) if isinstance(report.get("summary"), dict) else {}
    return {
        "contract_type": POLICY_CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "status": status,
        "based_on": {
            "resolved_claim_count": summary.get("resolved_claim_count"),
            "avg_final_brier": summary.get("avg_final_brier"),
            "ledger_path": report.get("ledger_path"),
        },
        **knobs,
    }


def build_calibration_report(ledger_path: Path) -> dict[str, Any]:
    forecast_count, claim_rows = _rows(ledger_path)
    resolved_rows: list[sqlite3.Row] = [row for row in claim_rows if row["status"] == "resolved"]
    final_scores: list[float] = [float(row["final_brier"]) for row in resolved_rows if row["final_brier"] is not None]
    initial_scores: list[float] = [float(row["initial_brier"]) for row in resolved_rows if row["initial_brier"] is not None]
    avg_final: Optional[float] = _avg(final_scores)
    avg_initial: Optional[float] = _avg(initial_scores)
    return {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "ledger_path": str(ledger_path),
        "summary": {
            "forecast_count": forecast_count,
            "claim_count": len(claim_rows),
            "resolved_claim_count": len(resolved_rows),
            "avg_final_brier": _round(avg_final),
            "avg_initial_brier": _round(avg_initial),
        },
        "confidence_policy": confidence_policy(len(resolved_rows), avg_final),
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Build Serenity calibration report from forecast ledger")
    parser.add_argument("--ledger")
    parser.add_argument("--out")
    parser.add_argument("--policy-out", help="write machine-consumed calibration policy JSON")
    args: argparse.Namespace = parser.parse_args(argv)
    payload: dict[str, Any] = build_calibration_report(_ledger_path(args.ledger))
    text: str = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out:
        Path(args.out).write_text(text + "\n", encoding="utf-8")
    else:
        print(text)
    if args.policy_out:
        policy: dict[str, Any] = build_calibration_policy(payload)
        policy_path: Path = Path(args.policy_out)
        policy_path.parent.mkdir(parents=True, exist_ok=True)
        policy_path.write_text(json.dumps(policy, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"policy_out": args.policy_out, "status": policy["status"]}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
