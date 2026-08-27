#!/usr/bin/env python3
"""Resolve due forecast-ledger claims when their resolution probes are machine-checkable."""

from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
import tempfile
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence


CONTRACT_TYPE: str = "serenity_resolved_claims"
SCHEMA_VERSION: str = "1.0"
DEFAULT_LEDGER_PATH: str = "~/.cache/serenity-chan/forecast-ledger.sqlite"
PRICE_FIELDS: set[str] = {"price", "current_price", "close", "latest_close"}


def _load_json(path: Optional[Path]) -> Mapping[str, Any]:
    if path is None:
        return {}
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _text(value: Any) -> str:
    return str(value or "").strip()


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _safe_float(value: Any) -> Optional[float]:
    if value in (None, ""):
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _ledger_path(raw_path: Optional[str]) -> Path:
    value: str = raw_path or os.environ.get("SERENITY_FORECAST_LEDGER_PATH", DEFAULT_LEDGER_PATH)
    return Path(value).expanduser()


def _forecast_ledger_script(root: Path) -> Path:
    return root / "companion-skills" / "laplace-forecast" / "scripts" / "forecast_ledger.py"


def _date_key(value: Any) -> str:
    text: str = _text(value)
    if not text:
        return ""
    return text[:10]


def _due_before(value: Optional[str]) -> str:
    if value and value.lower() == "today":
        return date.today().isoformat()
    if value:
        return _date_key(value)
    return date.today().isoformat()


def _operator(left: Any, op: str, right: Any) -> Optional[bool]:
    left_number: Optional[float] = _safe_float(left)
    right_number: Optional[float] = _safe_float(right)
    if left_number is None or right_number is None:
        return None
    if op == ">":
        return left_number > right_number
    if op == ">=":
        return left_number >= right_number
    if op == "<":
        return left_number < right_number
    if op == "<=":
        return left_number <= right_number
    if op in {"=", "=="}:
        return abs(left_number - right_number) < 1e-9
    return None


def _path_value(payload: Any, path: str) -> Any:
    current: Any = payload
    for part in path.split("."):
        if isinstance(current, Mapping):
            current = current.get(part)
        elif isinstance(current, list):
            try:
                current = current[int(part)]
            except (ValueError, IndexError):
                return None
        else:
            return None
    return current


def _snapshot_value(snapshot: Mapping[str, Any], symbol: str, field: str) -> Any:
    values: Mapping[str, Any] = _as_mapping(snapshot.get("values"))
    if f"{symbol}.{field}" in values:
        return values[f"{symbol}.{field}"]
    if field in values and not symbol:
        return values[field]
    fields: Mapping[str, Any] = _as_mapping(snapshot.get("fields"))
    symbol_fields: Mapping[str, Any] = _as_mapping(fields.get(symbol))
    if field in symbol_fields:
        return symbol_fields[field]
    if field in fields and not symbol:
        return fields[field]
    prices: Mapping[str, Any] = _as_mapping(snapshot.get("prices"))
    price_payload: Any = prices.get(symbol)
    if field in {"price", "current_price", "close", "latest_close"}:
        if isinstance(price_payload, Mapping):
            for key in ["current_price", "regular_market_price", "close", "latest_close", "price"]:
                if key in price_payload:
                    return price_payload[key]
        if price_payload not in (None, ""):
            return price_payload
    technical: Mapping[str, Any] = _as_mapping(snapshot.get("technical_health"))
    symbol_technical: Mapping[str, Any] = _as_mapping(technical.get(symbol))
    if field in symbol_technical:
        return symbol_technical[field]
    metrics: Mapping[str, Any] = _as_mapping(symbol_technical.get("metrics"))
    if field in metrics:
        return metrics[field]
    return None


def _announcement_text(snapshot: Mapping[str, Any], symbol: str) -> str:
    announcements: Mapping[str, Any] = _as_mapping(snapshot.get("announcements"))
    rows: list[Any] = _as_list(announcements.get(symbol))
    parts: list[str] = []
    for row in rows:
        if isinstance(row, Mapping):
            parts.extend(_text(row.get(key)) for key in ["title", "summary", "body"] if _text(row.get(key)))
        elif _text(row):
            parts.append(_text(row))
    return "\n".join(parts)


def evaluate_probe(probe: Mapping[str, Any], snapshot: Mapping[str, Any]) -> tuple[Optional[bool], str]:
    probe_type: str = _text(probe.get("type"))
    if not probe_type:
        return None, "resolution_probe.type is empty"
    if probe_type == "static_value":
        outcome: Optional[bool] = _operator(probe.get("value"), _text(probe.get("operator")), probe.get("threshold"))
        return outcome, f"static_value {probe.get('value')} {_text(probe.get('operator'))} {probe.get('threshold')}"
    if probe_type == "price_threshold":
        symbol: str = _text(probe.get("symbol"))
        value: Any = _snapshot_value(snapshot, symbol, "current_price")
        outcome = _operator(value, _text(probe.get("operator")), probe.get("threshold"))
        return outcome, f"{symbol} current_price={value} {_text(probe.get('operator'))} {probe.get('threshold')}"
    if probe_type == "field_threshold":
        symbol = _text(probe.get("symbol"))
        field: str = _text(probe.get("field"))
        value = _snapshot_value(snapshot, symbol, field)
        outcome = _operator(value, _text(probe.get("operator")), probe.get("threshold"))
        return outcome, f"{symbol}.{field}={value} {_text(probe.get('operator'))} {probe.get('threshold')}"
    if probe_type == "json_path_threshold":
        value = _path_value(snapshot, _text(probe.get("path")))
        outcome = _operator(value, _text(probe.get("operator")), probe.get("threshold"))
        return outcome, f"{_text(probe.get('path'))}={value} {_text(probe.get('operator'))} {probe.get('threshold')}"
    if probe_type == "announcement_keyword":
        symbol = _text(probe.get("symbol"))
        keywords: list[str] = [_text(item) for item in _as_list(probe.get("keywords")) if _text(item)]
        text: str = _announcement_text(snapshot, symbol)
        lowered: str = text.lower()
        matched: list[str] = [keyword for keyword in keywords if keyword.lower() in lowered]
        if not keywords:
            return None, "announcement_keyword requires keywords"
        return bool(matched), f"{symbol} matched_keywords={matched}"
    return None, f"unsupported resolution_probe.type: {probe_type}"


def _probe_symbol(claim: Mapping[str, Any], probe: Mapping[str, Any]) -> str:
    return _text(probe.get("symbol")) or _text(claim.get("source_symbol"))


def _fetchable_price_symbols(records: Sequence[Mapping[str, Any]], due_before: str) -> set[str]:
    """Collect symbols whose due claims can be resolved from a current price."""
    symbols: set[str] = set()
    for record in records:
        for claim in _as_list(record.get("claims")):
            if not isinstance(claim, Mapping) or claim.get("status") == "resolved":
                continue
            if _date_key(claim.get("resolution_date")) > due_before:
                continue
            probe: Mapping[str, Any] = _as_mapping(claim.get("resolution_probe"))
            probe_type: str = _text(probe.get("type"))
            field: str = _text(probe.get("field"))
            if probe_type == "price_threshold" or (probe_type == "field_threshold" and field in PRICE_FIELDS):
                symbol: str = _probe_symbol(claim, probe)
                if symbol:
                    symbols.add(symbol)
    return symbols


def build_fetched_snapshot(records: Sequence[Mapping[str, Any]], due_before: str) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Fetch current prices for machine-checkable due claims via the light quote route."""
    try:
        from market_quotes import fetch_current_price
    except ModuleNotFoundError:  # pragma: no cover - supports python -m scripts.resolve_due_claims
        from scripts.market_quotes import fetch_current_price

    prices: dict[str, Any] = {}
    fetch_failures: list[dict[str, str]] = []
    for symbol in sorted(_fetchable_price_symbols(records, due_before)):
        try:
            quote: Mapping[str, Any] = fetch_current_price(symbol)
            prices[symbol] = {"current_price": quote.get("current_price"), "source": quote.get("source")}
        except Exception as exc:
            fetch_failures.append({"symbol": symbol, "error": f"{type(exc).__name__}: {exc}"})
    return {"prices": prices}, fetch_failures


def _merge_snapshots(fetched: Mapping[str, Any], supplied: Mapping[str, Any]) -> dict[str, Any]:
    """User-supplied snapshot values take precedence over fetched values."""
    merged: dict[str, Any] = json.loads(json.dumps(fetched, ensure_ascii=False))
    for key, value in supplied.items():
        if key == "prices" and isinstance(value, Mapping) and isinstance(merged.get("prices"), dict):
            merged["prices"].update(dict(value))
        else:
            merged[key] = value
    return merged


def _open_records(ledger_path: Path) -> list[dict[str, Any]]:
    if not ledger_path.exists():
        return []
    conn: sqlite3.Connection = sqlite3.connect(ledger_path)
    conn.row_factory = sqlite3.Row
    try:
        rows: list[sqlite3.Row] = conn.execute(
            "SELECT id, status, record_json FROM forecasts WHERE status != 'resolved' ORDER BY updated_at, id"
        ).fetchall()
    finally:
        conn.close()
    records: list[dict[str, Any]] = []
    for row in rows:
        record: Any = json.loads(str(row["record_json"]))
        if isinstance(record, dict):
            records.append(record)
    return records


def _resolve_forecast(
    forecast_id: str,
    claim_outcomes: Sequence[Mapping[str, Any]],
    *,
    ledger_path: Path,
    root: Path,
) -> None:
    payload: dict[str, Any] = {
        "claim_outcomes": list(claim_outcomes),
        "selected_scenario": "",
        "outcome_summary": f"Resolved {len(claim_outcomes)} machine-checkable claim(s).",
        "notes": "Resolved by serenity-chan scripts/resolve_due_claims.py.",
    }
    with tempfile.TemporaryDirectory(prefix="serenity-claim-resolution-") as temp_dir:
        resolution_path: Path = Path(temp_dir) / "resolution.json"
        resolution_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        completed: subprocess.CompletedProcess[str] = subprocess.run(
            [
                sys.executable,
                str(_forecast_ledger_script(root)),
                "resolve",
                "--path",
                str(ledger_path),
                "--id",
                forecast_id,
                "--resolution-file",
                str(resolution_path),
            ],
            check=False,
            capture_output=True,
            text=True,
        )
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.strip() or completed.stdout.strip() or "forecast ledger resolve failed")


def resolve_due_claims(
    *,
    ledger_path: Path,
    snapshot: Mapping[str, Any],
    due_before: str,
    root: Path,
    write_ledger: bool,
    fetch: bool = False,
) -> dict[str, Any]:
    resolved_claims: list[dict[str, Any]] = []
    manual_review_claims: list[dict[str, Any]] = []
    forecast_count: int = 0
    due_claim_count: int = 0
    records: list[dict[str, Any]] = _open_records(ledger_path)
    fetch_failures: list[dict[str, str]] = []
    if fetch:
        fetched_snapshot, fetch_failures = build_fetched_snapshot(records, due_before)
        snapshot = _merge_snapshots(fetched_snapshot, snapshot)
    for record in records:
        forecast_count += 1
        forecast_id: str = _text(record.get("id"))
        outcomes_for_forecast: list[dict[str, Any]] = []
        for claim in _as_list(record.get("claims")):
            if not isinstance(claim, Mapping) or claim.get("status") == "resolved":
                continue
            if _date_key(claim.get("resolution_date")) > due_before:
                continue
            due_claim_count += 1
            probe: Mapping[str, Any] = _as_mapping(claim.get("resolution_probe"))
            if not probe:
                manual_review_claims.append(
                    {
                        "forecast_id": forecast_id,
                        "claim_id": _text(claim.get("id")),
                        "reason": "missing resolution_probe",
                    }
                )
                continue
            outcome, evidence = evaluate_probe(probe, snapshot)
            if outcome is None:
                manual_review_claims.append(
                    {
                        "forecast_id": forecast_id,
                        "claim_id": _text(claim.get("id")),
                        "reason": evidence,
                    }
                )
                continue
            claim_outcome: dict[str, Any] = {
                "id": _text(claim.get("id")),
                "outcome": bool(outcome),
                "evidence": evidence,
                "notes": "machine-checkable resolution probe",
            }
            outcomes_for_forecast.append(claim_outcome)
            resolved_claims.append({"forecast_id": forecast_id, **claim_outcome})
        if outcomes_for_forecast and write_ledger:
            _resolve_forecast(forecast_id, outcomes_for_forecast, ledger_path=ledger_path, root=root)
    return {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "ledger_path": str(ledger_path),
        "due_before": due_before,
        "summary": {
            "due_claim_count": due_claim_count,
            "resolved_count": len(resolved_claims),
            "manual_review_count": len(manual_review_claims),
            "forecast_count": forecast_count,
            "fetch_failure_count": len(fetch_failures),
        },
        "resolved_claims": resolved_claims,
        "manual_review_claims": manual_review_claims,
        "fetch_failures": fetch_failures,
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Resolve due machine-checkable forecast claims")
    parser.add_argument("--ledger")
    parser.add_argument("--snapshot", help="JSON snapshot with prices, fields, announcements, or values")
    parser.add_argument("--fetch", action="store_true", help="fetch current prices for machine-checkable due claims")
    parser.add_argument("--due-before")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--out")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        root: Path = Path(__file__).resolve().parents[1]
        payload: dict[str, Any] = resolve_due_claims(
            ledger_path=_ledger_path(args.ledger),
            snapshot=_load_json(Path(args.snapshot) if args.snapshot else None),
            due_before=_due_before(args.due_before),
            root=root,
            write_ledger=not bool(args.dry_run),
            fetch=bool(args.fetch),
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
