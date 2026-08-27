#!/usr/bin/env python3
"""Build a validated portfolio_context from a simple holdings CSV.

Portfolio-level actions (add, trim, rebalance, position size) are gated on a
portfolio context, but hand-writing the schema is high friction. This tool
turns a three-column CSV into a validated context, using live prices from the
light quote route to compute market-value weights.

CSV columns (header required): symbol,quantity[,cost_basis][,name]
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import json
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

try:
    from market_quotes import fetch_current_price
    from validate_portfolio_context import validate_portfolio_context
except ModuleNotFoundError:  # pragma: no cover - supports python -m scripts.build_portfolio_context
    from scripts.market_quotes import fetch_current_price
    from scripts.validate_portfolio_context import validate_portfolio_context


CONTRACT_TYPE: str = "serenity_portfolio_context"
SCHEMA_VERSION: str = "1.0"


def _read_holdings(path: Path) -> list[dict[str, Any]]:
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        rows: list[dict[str, Any]] = []
        for line_number, row in enumerate(reader, start=2):
            symbol: str = str(row.get("symbol") or "").strip().upper()
            if not symbol:
                continue
            try:
                quantity: float = float(str(row.get("quantity") or "0").replace(",", ""))
            except ValueError as exc:
                raise ValueError(f"line {line_number}: quantity is not numeric") from exc
            if quantity <= 0:
                raise ValueError(f"line {line_number}: quantity must be positive for {symbol}")
            cost_raw: str = str(row.get("cost_basis") or "").strip()
            rows.append({
                "symbol": symbol,
                "name": str(row.get("name") or "").strip(),
                "quantity": quantity,
                "cost_basis": float(cost_raw.replace(",", "")) if cost_raw else None,
            })
    if not rows:
        raise ValueError("holdings CSV contains no positions (need header: symbol,quantity[,cost_basis][,name])")
    return rows


def build_portfolio_context(
    holdings: Sequence[Mapping[str, Any]],
    *,
    cash: float,
    account_scope: str,
    risk_profile: str,
    max_single_position_pct: Optional[float],
) -> dict[str, Any]:
    priced: list[dict[str, Any]] = []
    price_errors: list[str] = []
    for row in holdings:
        symbol: str = str(row["symbol"])
        try:
            quote: Mapping[str, Any] = fetch_current_price(symbol)
            price: float = float(quote["current_price"])
        except Exception as exc:
            price_errors.append(f"{symbol}: {type(exc).__name__}: {exc}")
            continue
        priced.append({**dict(row), "current_price": price, "market_value": price * float(row["quantity"])})
    if price_errors:
        raise RuntimeError(
            "current prices are required for market-value weights; failed symbols: " + "; ".join(price_errors)
        )
    total_value: float = sum(item["market_value"] for item in priced) + max(0.0, cash)
    if total_value <= 0:
        raise ValueError("total portfolio value must be positive")
    positions: list[dict[str, Any]] = []
    for item in sorted(priced, key=lambda row: -row["market_value"]):
        position: dict[str, Any] = {
            "symbol": item["symbol"],
            "weight_pct": round(item["market_value"] / total_value * 100.0, 2),
            "current_price": item["current_price"],
        }
        if item.get("name"):
            position["name"] = item["name"]
        if item.get("cost_basis") is not None:
            position["cost_basis"] = item["cost_basis"]
        positions.append(position)
    cash_pct: float = round(max(0.0, cash) / total_value * 100.0, 2)
    top_weight: float = positions[0]["weight_pct"] if positions else 0.0
    boundary: str = (
        f"组合共 {len(positions)} 个持仓，现金占比 {cash_pct}%，最大单仓 {top_weight}%；"
        "加减仓与再平衡建议须以本上下文的权重为基准输出差量动作。"
    )
    return {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "provided": True,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "account_scope": account_scope,
        "positions": positions,
        "constraints": {
            "max_single_position_pct": max_single_position_pct,
            "cash_pct": cash_pct,
            "risk_profile": risk_profile,
        },
        "decision_boundary": boundary,
    }


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Build portfolio_context from a holdings CSV")
    parser.add_argument("--from-csv", required=True, help="CSV with header symbol,quantity[,cost_basis][,name]")
    parser.add_argument("--cash", type=float, default=0.0, help="cash amount in portfolio currency")
    parser.add_argument("--account-scope", default="personal", help="account scope label")
    parser.add_argument("--risk-profile", default="balanced", choices=["conservative", "balanced", "aggressive"])
    parser.add_argument("--max-single-position-pct", type=float, help="single-position weight cap")
    parser.add_argument("--out", help="write portfolio_context JSON")
    parser.add_argument("--state", action="store_true", help="write to the canonical state portfolio_context.json (with .bak backup)")
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        payload: dict[str, Any] = build_portfolio_context(
            _read_holdings(Path(args.from_csv)),
            cash=args.cash,
            account_scope=args.account_scope,
            risk_profile=args.risk_profile,
            max_single_position_pct=args.max_single_position_pct,
        )
        errors: list[str] = validate_portfolio_context(payload)
        if errors:
            raise ValueError("; ".join(errors))
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1
    text: str = json.dumps(payload, ensure_ascii=False, indent=2)
    out_path: Optional[Path] = Path(args.out) if args.out else None
    if args.state:
        import os as _os
        state_override: str = _os.getenv("SERENITY_STATE_DIR", "")
        state_base: Path = Path(state_override).expanduser() if state_override else Path(
            _os.getenv("SERENITY_DATA_DIR", str(Path.home() / ".cache" / "serenity-chan"))
        ).expanduser() / "state"
        out_path = state_base / "portfolio_context.json"
        if out_path.exists():
            out_path.with_suffix(".json.bak").write_text(out_path.read_text(encoding="utf-8"), encoding="utf-8")
    if out_path:
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text + "\n", encoding="utf-8")
        print(json.dumps({"ok": True, "out": str(out_path), "positions": len(payload["positions"])}, ensure_ascii=False))
    else:
        print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
