#!/usr/bin/env python3
"""Preflight environment checks for serenity-chan-stock-skill."""

from __future__ import annotations

import argparse
import datetime as dt
import importlib.util
import json
import os
import socket
import ssl
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence


CONTRACT_TYPE: str = "serenity_doctor_report"
SCHEMA_VERSION: str = "1.0"
MIN_PYTHON: tuple[int, int] = (3, 10)
NETWORK_PROBES: tuple[tuple[str, str], ...] = (
    ("sec_edgar", "https://www.sec.gov/files/company_tickers.json"),
    ("cninfo", "https://www.cninfo.com.cn/new/index"),
    ("eastmoney", "https://quote.eastmoney.com/"),
    ("yahoo_chart", "https://query1.finance.yahoo.com/v8/finance/chart/NVDA?range=1d&interval=1d"),
)


def _check(name: str, status: str, message: str, details: Optional[Mapping[str, Any]] = None) -> dict[str, Any]:
    payload: dict[str, Any] = {"name": name, "status": status, "message": message}
    if details:
        payload["details"] = dict(details)
    return payload


def _module_available(module_name: str) -> bool:
    return importlib.util.find_spec(module_name) is not None


def _data_root() -> Path:
    override: Optional[str] = os.getenv("SERENITY_DATA_DIR")
    return Path(override).expanduser() if override else Path.home() / ".cache" / "serenity-chan" / "data"


def _probe_url(name: str, url: str, *, timeout: float) -> dict[str, Any]:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": os.getenv("SEC_USER_AGENT") or os.getenv("EDGAR_IDENTITY") or "serenity-chan doctor",
            "Accept": "*/*",
        },
        method="GET",
    )
    try:
        context = ssl.create_default_context()
        with urllib.request.urlopen(request, timeout=timeout, context=context) as response:
            status_code: int = int(getattr(response, "status", 0) or 0)
            if 200 <= status_code < 500:
                return _check(
                    f"network:{name}",
                    "PASS",
                    f"{name} endpoint responded with HTTP {status_code}.",
                    {"url": url, "http_status": status_code},
                )
            return _check(
                f"network:{name}",
                "WARN",
                f"{name} endpoint returned HTTP {status_code}.",
                {"url": url, "http_status": status_code},
            )
    except (urllib.error.URLError, TimeoutError, socket.timeout, ssl.SSLError, OSError) as exc:
        return _check(
            f"network:{name}",
            "WARN",
            f"{name} endpoint is not reachable from this environment: {type(exc).__name__}: {exc}",
            {"url": url},
        )


def build_report(*, skip_network: bool = False, timeout: float = 5.0) -> dict[str, Any]:
    checks: list[dict[str, Any]] = []
    recommended_actions: list[str] = []

    python_ok: bool = sys.version_info >= (*MIN_PYTHON, 0)
    checks.append(_check(
        "python",
        "PASS" if python_ok else "FAIL",
        f"Python {sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}; required >= {MIN_PYTHON[0]}.{MIN_PYTHON[1]}.",
        {"executable": sys.executable},
    ))
    if not python_ok:
        recommended_actions.append("Use Python 3.10 or newer before running any Serenity scripts.")

    certifi_ok: bool = _module_available("certifi")
    checks.append(_check(
        "optional_dependency:certifi",
        "PASS" if certifi_ok else "WARN",
        "certifi is available for HTTPS CA discovery." if certifi_ok else "certifi is not installed; HTTPS still uses the system CA store.",
    ))

    pdfplumber_ok: bool = _module_available("pdfplumber")
    checks.append(_check(
        "optional_dependency:pdfplumber",
        "PASS" if pdfplumber_ok else "WARN",
        "pdfplumber is available for official PDF financial-report line extraction."
        if pdfplumber_ok
        else "pdfplumber is not installed; official PDF financial reports may stay as evidence packages until line extraction is available.",
    ))
    if not pdfplumber_ok:
        recommended_actions.append("Install pdfplumber in the runtime that executes Serenity when A-share/HK official PDF line extraction is required.")

    sec_identity: str = os.getenv("SEC_USER_AGENT") or os.getenv("EDGAR_IDENTITY") or ""
    sec_ok: bool = bool(sec_identity.strip())
    checks.append(_check(
        "sec_identity",
        "PASS" if sec_ok else "WARN",
        "SEC identity is configured." if sec_ok else "SEC_USER_AGENT or EDGAR_IDENTITY is not configured; US SEC fetches may be rate-limited or rejected.",
    ))
    if not sec_ok:
        recommended_actions.append("Set SEC_USER_AGENT to a real contact string before US SEC data fetches.")

    data_root: Path = _data_root()
    try:
        data_root.mkdir(parents=True, exist_ok=True)
        writable: bool = os.access(data_root, os.W_OK)
    except OSError:
        writable = False
    checks.append(_check(
        "data_root",
        "PASS" if writable else "FAIL",
        f"Audit bundle data root is {'writable' if writable else 'not writable'}: {data_root}",
        {"path": str(data_root), "from_env": bool(os.getenv("SERENITY_DATA_DIR"))},
    ))
    if not writable:
        recommended_actions.append("Set SERENITY_DATA_DIR to a writable persistent directory.")

    pdf_python: str = os.getenv("SERENITY_PDF_PYTHON", "")
    if pdf_python:
        exists: bool = Path(pdf_python).expanduser().exists()
        checks.append(_check(
            "serenity_pdf_python",
            "PASS" if exists else "WARN",
            f"SERENITY_PDF_PYTHON points to {'an existing' if exists else 'a missing'} interpreter.",
            {"path": pdf_python},
        ))

    if skip_network:
        for name, url in NETWORK_PROBES:
            checks.append(_check(f"network:{name}", "SKIP", "Network probe skipped by request.", {"url": url}))
    else:
        for name, url in NETWORK_PROBES:
            checks.append(_probe_url(name, url, timeout=timeout))

    severity_order: dict[str, int] = {"PASS": 0, "SKIP": 0, "WARN": 1, "FAIL": 2}
    worst: int = max(severity_order.get(str(check.get("status")), 2) for check in checks)
    status: str = "FAIL" if worst >= 2 else "WARN" if worst == 1 else "PASS"
    capabilities: dict[str, bool] = {
        "real_data_fetch": python_ok and writable,
        "pdf_financial_extraction": python_ok and pdfplumber_ok,
        "sec_edgar": python_ok and sec_ok,
        "persistent_audit_bundle": writable,
    }
    return {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "generated_at": dt.datetime.now(dt.timezone.utc).isoformat(),
        "status": status,
        "checks": checks,
        "capabilities": capabilities,
        "recommended_actions": recommended_actions,
    }


def validate_doctor_report(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != CONTRACT_TYPE:
        errors.append(f"contract_type must be {CONTRACT_TYPE}")
    if payload.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    if payload.get("status") not in {"PASS", "WARN", "FAIL"}:
        errors.append("status must be PASS, WARN, or FAIL")
    checks: Any = payload.get("checks")
    if not isinstance(checks, list) or not checks:
        errors.append("checks must be a non-empty array")
    else:
        for index, check in enumerate(checks):
            if not isinstance(check, Mapping):
                errors.append(f"checks[{index}] must be an object")
                continue
            if not str(check.get("name") or "").strip():
                errors.append(f"checks[{index}].name must not be empty")
            if check.get("status") not in {"PASS", "WARN", "FAIL", "SKIP"}:
                errors.append(f"checks[{index}].status is invalid")
            if not str(check.get("message") or "").strip():
                errors.append(f"checks[{index}].message must not be empty")
    capabilities: Any = payload.get("capabilities")
    if not isinstance(capabilities, Mapping):
        errors.append("capabilities must be an object")
    else:
        for key in ["real_data_fetch", "pdf_financial_extraction", "sec_edgar", "persistent_audit_bundle"]:
            if not isinstance(capabilities.get(key), bool):
                errors.append(f"capabilities.{key} must be boolean")
    if not isinstance(payload.get("recommended_actions"), list):
        errors.append("recommended_actions must be an array")
    return errors


def _print_human(payload: Mapping[str, Any]) -> None:
    print(f"Serenity doctor: {payload.get('status')}")
    for check in payload.get("checks", []):
        if isinstance(check, Mapping):
            print(f"- {check.get('status')} {check.get('name')}: {check.get('message')}")
    actions: Any = payload.get("recommended_actions")
    if isinstance(actions, list) and actions:
        print("Recommended actions:")
        for action in actions:
            print(f"- {action}")


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Check Serenity runtime environment")
    parser.add_argument("--skip-network", action="store_true", help="skip external endpoint probes")
    parser.add_argument("--timeout", type=float, default=5.0, help="network probe timeout in seconds")
    parser.add_argument("--json", action="store_true", help="emit JSON report")
    parser.add_argument("--out", help="write JSON report to this path")
    args = parser.parse_args(argv)

    report: dict[str, Any] = build_report(skip_network=args.skip_network, timeout=args.timeout)
    errors: list[str] = validate_doctor_report(report)
    if errors:
        print("ERROR: invalid doctor report: " + "; ".join(errors), file=sys.stderr)
        return 1
    if args.out:
        path = Path(args.out)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.json:
        print(json.dumps(report, ensure_ascii=False, indent=2))
    else:
        _print_human(report)
    return 1 if report["status"] == "FAIL" else 0


if __name__ == "__main__":
    raise SystemExit(main())
