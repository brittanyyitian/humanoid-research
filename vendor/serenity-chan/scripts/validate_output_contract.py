#!/usr/bin/env python3
"""Validate a Serenity + Chan Markdown report before delivery.

The checker is intentionally conservative: it does not try to judge the
investment thesis. It only verifies the safety contract that prevents the most
damaging failures: missing data-quality disclosure, high ratings despite data
failure, current buy-point claims without price history, weak evidence upgraded
into strong conclusions, and prohibited investment-advice wording.
"""

from __future__ import annotations

import argparse
import json
import re
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Sequence

try:
    from market_source_policy import wrong_source_lines
    from build_delivery_proof import verify_delivery_proof
except ModuleNotFoundError:  # pragma: no cover - supports python -m scripts.validate_output_contract
    from scripts.market_source_policy import wrong_source_lines
    from scripts.build_delivery_proof import verify_delivery_proof

STATUSES = ("OK", "PARTIAL", "STALE", "FAILED", "PENDING", "NOT_APPLICABLE", "NOT_REQUESTED")
UNAVAILABLE_STATUSES = {"FAILED", "PENDING", "NOT_APPLICABLE", "NOT_REQUESTED"}
RATING_ORDER = {
    "OBSERVE_ONLY": 0,
    "D": 1,
    "C": 2,
    "B": 3,
    "A": 4,
    "S": 5,
}

FORBIDDEN_PHRASES = [
    "必涨",
    "马上梭哈",
    "无风险",
    "确定翻倍",
    "内幕消息",
    "内幕信息",
]

WEAK_SOURCE_RE = re.compile(r"(KOL|社媒|截图|群聊|传闻|rumor|social|Weak|Unverified|L3|L4|互动平台|普通媒体|概念梳理|券商概念|F10)", re.I)
WEAK_CONCLUSION_RE = re.compile(r"(KOL|社媒|截图|群聊|传闻|rumor|social|互动平台|普通媒体|概念梳理|券商概念|F10)", re.I)
PRIMARY_SOURCE_RE = re.compile(r"(L0|L1|原始公告|官方公告|年报|招股书|合同|中标|监管文件|客户正式披露|SEC\s+EDGAR|10-K|10-Q|8-K|CNINFO|巨潮|\b(?:SSE|SZSE|BSE|HKEX)\b|filing)", re.I)


@dataclass
class Finding:
    severity: str
    code: str
    message: str


@dataclass
class ValidationResult:
    ok: bool
    findings: List[Finding]
    extracted: Dict[str, Optional[str]]


def _field_lines(text: str) -> Iterable[str]:
    for line in text.splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("|"):
            continue
        yield re.sub(r"^(?:[-*+]\s+|\d+\.\s+)", "", stripped).strip()


def _labeled_value(labels: Sequence[str], values: Sequence[str], text: str) -> Optional[str]:
    value_pattern = "|".join(re.escape(value) for value in values)
    for line in _field_lines(text):
        for label in labels:
            pattern = rf"^{re.escape(label)}\s*[：:]\s*\**\s*({value_pattern})\b"
            match = re.search(pattern, line, re.IGNORECASE)
            if match:
                return match.group(1).upper()
    return None


def _status_for(labels: Sequence[str], text: str) -> Optional[str]:
    return _labeled_value(labels, STATUSES, text)


def _rating_for(labels: Sequence[str], text: str) -> Optional[str]:
    return _labeled_value(labels, tuple(RATING_ORDER), text)


def _rating_above(value: Optional[str], cap: str) -> bool:
    if value is None:
        return False
    return RATING_ORDER.get(value, -1) > RATING_ORDER[cap]


def _has_heading(text: str, keywords: Sequence[str]) -> bool:
    for line in text.splitlines():
        stripped = line.strip()
        if not re.match(r"^#{2,6}\s+", stripped):
            continue
        stripped = stripped.lstrip("#").strip(" *\t ")
        if any(keyword.lower() in stripped.lower() for keyword in keywords):
            return True
    return False


def _has_any_markdown_heading(text: str, keywords: Sequence[str]) -> bool:
    for line in text.splitlines():
        stripped = line.strip()
        if not re.match(r"^#{1,6}\s+", stripped):
            continue
        stripped = stripped.lstrip("#").strip(" *\t ")
        if any(keyword.lower() in stripped.lower() for keyword in keywords):
            return True
    return False


def _has_any_signal(text: str, signals: Sequence[str]) -> bool:
    lowered = text.lower()
    return any(signal.lower() in lowered for signal in signals)


def _has_delivery_proof(text: str) -> bool:
    if not _has_heading(text, ["交付验证凭证", "Delivery Proof"]):
        return False
    proof_section = text[text.lower().find("proof_status"):] if "proof_status" in text.lower() else text
    return bool(
        re.search(r"proof_status\s*[：:]\s*PASS\b", proof_section, re.I)
        and re.search(r"exit\s*=\s*0\b", proof_section, re.I)
        and re.search(r"\bsha256\s*=\s*[0-9a-f]{64}\b", proof_section)
    )


def delivery_proof_block_errors(text: str, proof_payload: Dict[str, Any]) -> List[str]:
    errors: List[str] = []
    if not _has_delivery_proof(text):
        errors.append("markdown report is missing a passing delivery-proof block")
        return errors

    proof_start: int = text.lower().find("proof_status")
    proof_text: str = text[proof_start:] if proof_start >= 0 else text
    if str(proof_payload.get("proof_status") or "").upper() != "PASS":
        errors.append("delivery proof JSON must have proof_status PASS")
    if proof_payload.get("all_passed") is not True:
        errors.append("delivery proof JSON must have all_passed true")
    if not re.search(r"all_passed\s*[：:]\s*true\b", proof_text, re.I):
        errors.append("markdown proof block must disclose all_passed: true")

    artifacts = proof_payload.get("artifacts")
    if not isinstance(artifacts, list) or not artifacts:
        errors.append("delivery proof JSON must contain artifacts")
    else:
        for index, artifact in enumerate(artifacts):
            if not isinstance(artifact, dict):
                errors.append(f"delivery proof artifacts[{index}] must be an object")
                continue
            role = str(artifact.get("role") or "").strip()
            sha256 = str(artifact.get("sha256") or "").strip()
            if role and role not in proof_text:
                errors.append(f"markdown proof block must include artifact role {role}")
            if not re.fullmatch(r"[0-9a-f]{64}", sha256):
                errors.append(f"delivery proof artifact sha256 is invalid for {role or index}")
            elif sha256 not in proof_text:
                errors.append(f"markdown proof block must include artifact sha256 for {role or index}")

    validators = proof_payload.get("validators")
    if not isinstance(validators, list) or not validators:
        errors.append("delivery proof JSON must contain validators")
    else:
        for index, validator in enumerate(validators):
            if not isinstance(validator, dict):
                errors.append(f"delivery proof validators[{index}] must be an object")
                continue
            name = str(validator.get("name") or "").strip()
            status = str(validator.get("status") or "").strip()
            exit_code = validator.get("exit_code")
            if name and name not in proof_text:
                errors.append(f"markdown proof block must include validator {name}")
            if status and f"status={status}" not in proof_text:
                errors.append(f"markdown proof block must include validator status for {name or index}")
            if isinstance(exit_code, int) and f"exit={exit_code}" not in proof_text:
                errors.append(f"markdown proof block must include validator exit code for {name or index}")
    return errors


def _table_cells(line: str) -> List[str]:
    stripped = line.strip()
    if not stripped.startswith("|") or "|" not in stripped[1:]:
        return []
    cells = [cell.strip() for cell in stripped.strip("|").split("|")]
    if not cells or all(re.fullmatch(r":?-{3,}:?", cell or "") for cell in cells):
        return []
    return cells


def _is_theme_scan(text: str) -> bool:
    headings_and_opening = "\n".join(
        line for line in text.splitlines()[:24]
        if line.strip().startswith("#") or line.strip().startswith("-") or line.strip()
    )
    return bool(re.search(
        r"(主题扫描|产业链(?:瓶颈扫描|研究|扫描)|Theme Scan|theme scan|candidate universe|Candidate Universe|候选公司池|哪些.+值得研究|最值得研究|which stocks)",
        headings_and_opening,
        re.I,
    ))


def _is_news_to_financial_task(text: str) -> bool:
    opening = "\n".join(text.splitlines()[:30])
    return bool(re.search(
        r"(新闻转财报|News[- ]To[- ]Financial|news[- ]to[- ]financial|事件分析|政策发布|产品发布|订单新闻|AI infrastructure news|product launch|policy event)",
        opening,
        re.I,
    ))


def _is_candidate_comparison_report(text: str) -> bool:
    return (
        _has_any_markdown_heading(text, ["候选公司对比决策报告", "候选公司对比", "Candidate Comparison"])
        and _has_heading(text, ["研究队列排序", "Candidate Ranking", "Priority Ranking"])
        and _has_heading(text, ["数据消费审计", "Data Consumption"])
    )


def _claims_current_buy_point(text: str) -> bool:
    labels = ["当前买点", "Current buy point", "Current Buy Point"]
    claim_pattern = re.compile(r"(一买|二买|三买|first|second|third|1st|2nd|3rd)", re.I)
    negation_pattern = re.compile(r"(数据不足|无买点|等待|not enough|insufficient|no buy|wait)", re.I)
    for line in _field_lines(text):
        for label in labels:
            match = re.search(rf"^{re.escape(label)}\s*[：:]\s*(.+)$", line, re.I)
            if match:
                value = match.group(1)
                if claim_pattern.search(value) and not negation_pattern.search(value):
                    return True
    return False


def _has_strong_evidence_line(text: str) -> bool:
    for line in text.splitlines():
        cells = _table_cells(line)
        if len(cells) >= 4:
            source = cells[1] if len(cells) > 1 else ""
            level = cells[2] if len(cells) > 2 else ""
            if WEAK_SOURCE_RE.search(source) or level.upper() in {"L3", "L4"}:
                continue
            if level.upper() in {"L0", "L1"} or PRIMARY_SOURCE_RE.search(source):
                return True
            continue

        if WEAK_SOURCE_RE.search(line):
            continue
        if PRIMARY_SOURCE_RE.search(line) and re.search(r"(确认|证实|支持|披露|disclosed|reported|Verified)", line, re.I):
            return True
    return False


def validate_text(text: str, *, require_delivery_proof: bool = False) -> ValidationResult:
    findings: List[Finding] = []
    extracted: Dict[str, Optional[str]] = {
        "rating": _rating_for(["评级", "最终评级", "Final rating", "Final Rating"], text),
        "rating_cap": _rating_for([
            "评级上限",
            "本报告评级上限",
            "因数据限制，本报告评级上限",
            "Rating cap",
            "Rating Cap",
            "Max rating allowed",
            "Max Rating Allowed",
        ], text),
        "current_price": _status_for(["当前价格", "Current price", "Price data"], text),
        "adjusted_history": _status_for(["历史复权行情", "复权历史行情", "Adjusted history", "Technical data"], text),
        "financials": _status_for(["财报数据", "最新财报", "Financial data", "Financials"], text),
        "filings": _status_for(["公告/filing", "公告", "Filing", "Filings"], text),
    }

    if _is_candidate_comparison_report(text):
        comparison_headings = [
            (["结论先行", "Conclusion"], "comparison_missing_conclusion", "comparison report must include conclusion section"),
            (["研究队列排序", "Candidate Ranking", "Priority Ranking"], "comparison_missing_ranking", "comparison report must include candidate ranking"),
            (["行动门控", "Action Gate"], "comparison_missing_action_gate", "comparison report must include action gate section"),
            (["AI 研究状态", "AI Research"], "comparison_missing_ai_status", "comparison report must include AI research status"),
            (["数据消费审计", "Data Consumption"], "comparison_missing_data_consumption", "comparison report must include data consumption audit"),
            (["数据追索与研究债务", "Research Debt"], "comparison_missing_research_debt", "comparison report must include research debt section"),
            (["技术健康", "Technical"], "comparison_missing_technical", "comparison report must include technical health section"),
        ]
        for keywords, code, message in comparison_headings:
            if not _has_heading(text, keywords):
                findings.append(Finding("error", code, message))
        if not _has_any_signal(text, ["报告状态", "排序可信度", "正式决策对象"]):
            findings.append(Finding("error", "comparison_missing_readiness_summary", "comparison report must disclose readiness, ranking validity, and decision object"))
        for phrase in FORBIDDEN_PHRASES:
            if phrase in text:
                findings.append(Finding("error", "forbidden_phrase", f"forbidden phrase appears: {phrase}"))
        if require_delivery_proof and not _has_delivery_proof(text):
            findings.append(Finding("error", "missing_delivery_proof", "formal delivery must include a passing delivery-proof block"))
        ok = not any(f.severity == "error" for f in findings)
        return ValidationResult(ok=ok, findings=findings, extracted=extracted)

    required_headings = [
        (["数据质量与限制", "Data Quality"], "missing_data_quality", "missing data-quality section"),
        (["证据", "Evidence"], "missing_evidence", "missing evidence section"),
        (["证伪", "Falsification"], "missing_falsification", "missing falsification section"),
        (["最终动作", "当前动作", "Action"], "missing_action", "missing action section"),
    ]
    for keywords, code, message in required_headings:
        if not _has_heading(text, keywords):
            findings.append(Finding("error", code, message))

    for phrase in FORBIDDEN_PHRASES:
        if phrase in text:
            findings.append(Finding("error", "forbidden_phrase", f"forbidden phrase appears: {phrase}"))

    if require_delivery_proof and not _has_delivery_proof(text):
        findings.append(Finding("error", "missing_delivery_proof", "formal delivery must include a passing delivery-proof block"))

    rating = extracted["rating"]
    rating_cap = extracted["rating_cap"]
    if rating is None:
        findings.append(Finding("error", "missing_rating", "missing final rating"))
    if rating_cap is None:
        findings.append(Finding("error", "missing_rating_cap", "missing rating cap"))
    if rating and rating_cap and _rating_above(rating, rating_cap):
        findings.append(Finding("error", "rating_exceeds_cap", f"rating {rating} exceeds cap {rating_cap}"))

    current_price = extracted["current_price"]
    adjusted_history = extracted["adjusted_history"]
    financials = extracted["financials"]
    filings = extracted["filings"]
    buy_point_claimed = _claims_current_buy_point(text)

    required_statuses = {
        "current_price": "missing current-price status",
        "adjusted_history": "missing adjusted-history status",
        "financials": "missing financial-data status",
        "filings": "missing filing/announcement status",
    }
    for key, message in required_statuses.items():
        if extracted[key] is None:
            findings.append(Finding("error", f"missing_{key}_status", message))

    if current_price in UNAVAILABLE_STATUSES and buy_point_claimed:
        findings.append(Finding("error", "buy_point_without_current_price", "current buy point claimed while current price is unavailable"))
    if adjusted_history in UNAVAILABLE_STATUSES and buy_point_claimed:
        findings.append(Finding("error", "buy_point_without_adjusted_history", "Chan buy point claimed without adjusted price history"))
    if current_price in UNAVAILABLE_STATUSES and _rating_above(rating_cap, "B"):
        findings.append(Finding("error", "rating_cap_not_downgraded_for_price", "rating cap must be B or lower when current price is unavailable"))
    if adjusted_history in UNAVAILABLE_STATUSES and _rating_above(rating_cap, "B"):
        findings.append(Finding("error", "rating_cap_not_downgraded_for_adjusted_history", "rating cap must be B or lower when adjusted history is unavailable"))
    if financials in UNAVAILABLE_STATUSES and _rating_above(rating, "B"):
        findings.append(Finding("error", "high_rating_without_financials", "S/A rating is not allowed when latest financials are unavailable"))
    if financials in UNAVAILABLE_STATUSES and _rating_above(rating_cap, "B"):
        findings.append(Finding("error", "rating_cap_not_downgraded_for_financials", "rating cap must be B or lower when latest financials are unavailable"))
    if filings in UNAVAILABLE_STATUSES and _rating_above(rating, "B"):
        findings.append(Finding("error", "high_rating_without_filings", "S/A rating is not allowed when primary filings are unavailable"))
    if filings in UNAVAILABLE_STATUSES and _rating_above(rating_cap, "B"):
        findings.append(Finding("error", "rating_cap_not_downgraded_for_filings", "rating cap must be B or lower when primary filings are unavailable"))

    weak_evidence_only = WEAK_CONCLUSION_RE.search(text)
    if weak_evidence_only and not _has_strong_evidence_line(text):
        if _rating_above(rating, "C"):
            findings.append(Finding("error", "weak_evidence_high_rating", "weak evidence appears upgraded above C without strong support"))
        if _rating_above(rating_cap, "C"):
            findings.append(Finding("error", "weak_evidence_cap_not_downgraded", "rating cap must be C or lower when weak evidence lacks strong support"))

    if not all(marker in text for marker in ["我确定的事实", "我的推断", "还缺"]):
        findings.append(Finding("warning", "missing_uncertainty_statement", "uncertainty statement should include confirmed facts, inference, and missing evidence"))

    wrong_sources = wrong_source_lines(text)
    if wrong_sources:
        findings.append(Finding("error", "market_source_mismatch", "market-specific source route is mixed or wrong: " + " | ".join(wrong_sources[:3])))

    if _is_theme_scan(text):
        theme_requirements = [
            (["产业链地图", "Value-chain Map", "Value Chain Map"], "theme_missing_value_chain_map", "theme scan must map value-chain layers before ranking companies"),
            (["瓶颈层级排序", "Layer Ranking", "Bottleneck Layer Ranking"], "theme_missing_layer_ranking", "theme scan must rank bottleneck layers before companies"),
            (["候选公司池", "Candidate Universe", "Candidate Pool"], "theme_missing_candidate_universe", "theme scan must show the candidate universe before research candidates"),
        ]
        for keywords, code, message in theme_requirements:
            if not _has_heading(text, keywords):
                findings.append(Finding("error", code, message))

    if _is_news_to_financial_task(text):
        news_requirements = [
            (["已发生需求", "Observed Demand"], "news_missing_observed_demand", "news-to-financial analysis must identify observed demand change"),
            (["财务传导", "Financial Transmission", "Revenue Transmission"], "news_missing_financial_transmission", "news-to-financial analysis must map demand into revenue, margin, cash flow, or balance-sheet lines"),
            (["小市值弹性", "Small-Cap Elasticity"], "news_missing_small_cap_elasticity", "news-to-financial analysis must explain company-size elasticity or why it is absent"),
            (["验证路径", "Validation Path"], "news_missing_validation_path", "news-to-financial analysis must include a 1-4 quarter validation path"),
        ]
        for keywords, code, message in news_requirements:
            if not _has_heading(text, keywords):
                findings.append(Finding("error", code, message))

    if re.search(r"\bH[45]\b|H4|H5|平台级扩张|结构性爆发", text, re.I) and not _has_strong_evidence_line(text):
        if _rating_above(rating, "B"):
            findings.append(Finding("error", "h4_h5_high_rating_without_strong_evidence", "H4/H5 growth claims cannot support S/A rating without strong evidence"))
        if _rating_above(rating_cap, "B"):
            findings.append(Finding("error", "h4_h5_cap_not_downgraded", "rating cap must be B or lower when H4/H5 claims lack strong evidence"))

    ok = not any(f.severity == "error" for f in findings)
    return ValidationResult(ok=ok, findings=findings, extracted=extracted)


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Validate a Serenity + Chan Markdown report contract")
    parser.add_argument("report", help="Markdown report path")
    parser.add_argument("--json", action="store_true", help="emit machine-readable result")
    parser.add_argument("--require-delivery-proof", action="store_true", help="require a passing delivery-proof block")
    parser.add_argument("--proof", help="delivery_proof.json to verify against real artifacts")
    parser.add_argument("--verify-proof", action="store_true", help="recompute proof artifact hashes and validator status")
    args = parser.parse_args(argv)

    report_path = Path(args.report)
    text = report_path.read_text(encoding="utf-8")
    result = validate_text(text, require_delivery_proof=args.require_delivery_proof)
    if args.verify_proof:
        if not args.proof:
            result.findings.append(Finding("error", "missing_proof_json", "--verify-proof requires --proof <delivery_proof.json>"))
        else:
            try:
                proof_payload = json.loads(Path(args.proof).read_text(encoding="utf-8"))
                if not isinstance(proof_payload, dict):
                    raise ValueError("delivery proof must be a JSON object")
                artifacts: Any = proof_payload.get("artifacts")
                has_markdown_artifact: bool = any(
                    isinstance(item, dict) and item.get("role") == "markdown_report"
                    for item in artifacts if isinstance(artifacts, list)
                )
                proof_errors = verify_delivery_proof(
                    proof_payload,
                    markdown_report=report_path if has_markdown_artifact else None,
                )
                proof_errors.extend(delivery_proof_block_errors(text, proof_payload))
            except Exception as exc:
                proof_errors = [f"{type(exc).__name__}: {exc}"]
            for error in proof_errors:
                result.findings.append(Finding("error", "delivery_proof_verification_failed", error))
        result.ok = not any(f.severity == "error" for f in result.findings)
    if args.json:
        print(json.dumps({
            "ok": result.ok,
            "findings": [asdict(f) for f in result.findings],
            "extracted": result.extracted,
        }, ensure_ascii=False, indent=2))
    else:
        status = "OK" if result.ok else "FAILED"
        print(f"{status}: {args.report}")
        for finding in result.findings:
            print(f"- {finding.severity.upper()} {finding.code}: {finding.message}")
    return 0 if result.ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
