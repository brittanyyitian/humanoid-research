#!/usr/bin/env python3
"""Run static contract evals for serenity-chan-stock-skill."""

from __future__ import annotations

import argparse
import json
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Mapping, Optional, Sequence

try:
    import data_layer as data_layer_module
    from validate_output_contract import delivery_proof_block_errors, validate_text
    from validate_output_contract_json import validate_contract
    from validate_comparison_report import validate_file as validate_comparison_report_file
    from data_router import validate_financials, validate_valuation_inputs, _build_data_gaps, _build_research_debt, _cap_for_statuses, _fetch_with_attempt_ledger
    from build_falsification_dashboard import build_from_output_contract
    from a_share_capital_actions import analyze_announcements
    from a_share_capital_action_quantifier import quantify_capital_actions
    from build_ai_overlay_prompt import build_ai_overlay_prompt
    from build_comparison_report import build_comparison_report, validate_comparison_report, _action_gate_profile, _customer_evidence_summary, _debt_gate_profile, _financial_currency, _growth_hypothesis
    from build_ai_committee_packet import build_ai_committee_packet
    from build_ai_review_packet import build_ai_review_packet
    from build_research_debt_runbook import build_runbook_rows
    from candidate_ranker import rank_candidates
    from currency_normalizer import normalize_valuation_payload
    from data_consumption import financial_consumption_audit, ranking_validity_from_consumption, valuation_consumption_audit
    from financial_amounts import financial_unit_multiplier, normalize_financial_amount
    from financial_periods import latest_annual, latest_quarter, normalize_financial_period
    from serenity_chan_scorecard import score
    from technical_health import analyze_price_rows
    from validate_ai_overlay import validate_overlay
    from validate_ai_research_dossier import validate_dossier
    from score_ai_research_dossier import score_dossier
    from validate_ai_review_outcome import validate_review_outcome
    from validate_strategy_readiness import evaluate_strategy_readiness
    from validate_laplace_strategy_judgment import validate_strategy_judgment
    from validate_agent_research_queue import validate_agent_research_queue
    from validate_research_delivery import validate_delivery_payload
    from update_watchlist_from_report import build_watchlist, validate_watchlist, merge_previous_watchlist
    from run_review_cycle import build_review_cycle, validate_review_cycle, apply_review_outcome, validate_review_outcome as validate_watch_review_outcome
    from build_laplace_strategy_input import build_strategy_input
    from build_provider_health import build_provider_health, validate_provider_health
    from register_manual_evidence import build_manual_evidence, register_manual_evidence, validate_manual_evidence
    from build_delivery_proof import build_delivery_proof, validate_delivery_proof, verify_delivery_proof, rerun_proof_validators
    from append_delivery_proof import render_proof_block
    from validate_agent_behavior_transcript import validate_agent_behavior_case
    from doctor import build_report as build_doctor_report, validate_doctor_report
    from chan_structure_detector import detect_chan_structure, validate_chan_structure
    from run_benchmark_suite import _run_case as run_benchmark_case
    from validate_and_merge_ai_overlay import build_validated_merged_report
    from render_research_report import render_report
    from build_theme_candidate_universe import build_universe
    from build_macro_theme_map import build_macro_theme_map
    from build_opportunity_discovery_plan import build_plan
    from build_candidate_funnel import build_candidate_funnel, _quality_floor, _select_shortlist_indexes
    from build_market_regime import build_market_regime
    from sync_strategy_ledger import build_sync_report
    from resolve_due_claims import resolve_due_claims, _fetchable_price_symbols
    from build_calibration_report import build_calibration_report, build_calibration_policy
    from build_market_snapshot import validate_market_snapshot
    from build_portfolio_context import _read_holdings
    from serenity import infer_route as orchestrator_infer_route, strategy_hint as orchestrator_strategy_hint
    from build_decision_brief import build_action_queue, validate_decision_brief, build_decision_brief as build_decision_brief_payload, portfolio_analytics
    from decision_log import scoreboard_rows as decision_scoreboard_rows, build_entry as build_decision_entry, validate_entry as validate_decision_entry
    from validate_decision_counsel import validate_decision_counsel
    from technical_health import volume_heat
    from update_watchlist_from_report import scorecard_to_watchlist_item
    from validate_portfolio_context import validate_portfolio_context
    from validate_macro_theme_map import validate_macro_theme_map
    from validate_opportunity_discovery_plan import validate_opportunity_discovery_plan
    from validate_candidate_funnel import validate_candidate_funnel
    from validate_theme_candidate_universe import validate_universe
    from run_theme_research_analysis import _select_candidate_symbols
    from run_research_analysis import _validate_candidate_funnel_scope
    from data_layer import CninfoFinancialReportsProvider, EastmoneyF10FinancialsProvider, HkexFinancialReportsProvider, Market, SymbolInfo, default_real_providers, _sec_submission_matches_symbol
except ModuleNotFoundError:  # pragma: no cover - supports python -m scripts.run_static_evals
    from scripts import data_layer as data_layer_module
    from scripts.validate_output_contract import delivery_proof_block_errors, validate_text
    from scripts.validate_output_contract_json import validate_contract
    from scripts.validate_comparison_report import validate_file as validate_comparison_report_file
    from scripts.data_router import validate_financials, validate_valuation_inputs, _build_data_gaps, _build_research_debt, _cap_for_statuses, _fetch_with_attempt_ledger
    from scripts.build_falsification_dashboard import build_from_output_contract
    from scripts.a_share_capital_actions import analyze_announcements
    from scripts.a_share_capital_action_quantifier import quantify_capital_actions
    from scripts.build_ai_overlay_prompt import build_ai_overlay_prompt
    from scripts.build_comparison_report import build_comparison_report, validate_comparison_report, _action_gate_profile, _customer_evidence_summary, _debt_gate_profile, _financial_currency, _growth_hypothesis
    from scripts.build_ai_committee_packet import build_ai_committee_packet
    from scripts.build_ai_review_packet import build_ai_review_packet
    from scripts.build_research_debt_runbook import build_runbook_rows
    from scripts.candidate_ranker import rank_candidates
    from scripts.currency_normalizer import normalize_valuation_payload
    from scripts.data_consumption import financial_consumption_audit, ranking_validity_from_consumption, valuation_consumption_audit
    from scripts.financial_amounts import financial_unit_multiplier, normalize_financial_amount
    from scripts.financial_periods import latest_annual, latest_quarter, normalize_financial_period
    from scripts.serenity_chan_scorecard import score
    from scripts.technical_health import analyze_price_rows
    from scripts.validate_ai_overlay import validate_overlay
    from scripts.validate_ai_research_dossier import validate_dossier
    from scripts.score_ai_research_dossier import score_dossier
    from scripts.validate_ai_review_outcome import validate_review_outcome
    from scripts.validate_strategy_readiness import evaluate_strategy_readiness
    from scripts.validate_laplace_strategy_judgment import validate_strategy_judgment
    from scripts.validate_agent_research_queue import validate_agent_research_queue
    from scripts.validate_research_delivery import validate_delivery_payload
    from scripts.update_watchlist_from_report import build_watchlist, validate_watchlist, merge_previous_watchlist
    from scripts.run_review_cycle import build_review_cycle, validate_review_cycle, apply_review_outcome, validate_review_outcome as validate_watch_review_outcome
    from scripts.build_laplace_strategy_input import build_strategy_input
    from scripts.build_provider_health import build_provider_health, validate_provider_health
    from scripts.register_manual_evidence import build_manual_evidence, register_manual_evidence, validate_manual_evidence
    from scripts.build_delivery_proof import build_delivery_proof, validate_delivery_proof, verify_delivery_proof, rerun_proof_validators
    from scripts.append_delivery_proof import render_proof_block
    from scripts.validate_agent_behavior_transcript import validate_agent_behavior_case
    from scripts.doctor import build_report as build_doctor_report, validate_doctor_report
    from scripts.chan_structure_detector import detect_chan_structure, validate_chan_structure
    from scripts.run_benchmark_suite import _run_case as run_benchmark_case
    from scripts.validate_and_merge_ai_overlay import build_validated_merged_report
    from scripts.render_research_report import render_report
    from scripts.build_theme_candidate_universe import build_universe
    from scripts.build_macro_theme_map import build_macro_theme_map
    from scripts.build_opportunity_discovery_plan import build_plan
    from scripts.build_candidate_funnel import build_candidate_funnel, _quality_floor, _select_shortlist_indexes
    from scripts.build_market_regime import build_market_regime
    from scripts.sync_strategy_ledger import build_sync_report
    from scripts.resolve_due_claims import resolve_due_claims, _fetchable_price_symbols
    from scripts.build_calibration_report import build_calibration_report, build_calibration_policy
    from scripts.build_market_snapshot import validate_market_snapshot
    from scripts.build_portfolio_context import _read_holdings
    from scripts.serenity import infer_route as orchestrator_infer_route, strategy_hint as orchestrator_strategy_hint
    from scripts.build_decision_brief import build_action_queue, validate_decision_brief, build_decision_brief as build_decision_brief_payload, portfolio_analytics
    from scripts.decision_log import scoreboard_rows as decision_scoreboard_rows, build_entry as build_decision_entry, validate_entry as validate_decision_entry
    from scripts.validate_decision_counsel import validate_decision_counsel
    from scripts.technical_health import volume_heat
    from scripts.update_watchlist_from_report import scorecard_to_watchlist_item
    from scripts.validate_portfolio_context import validate_portfolio_context
    from scripts.validate_macro_theme_map import validate_macro_theme_map
    from scripts.validate_opportunity_discovery_plan import validate_opportunity_discovery_plan
    from scripts.validate_candidate_funnel import validate_candidate_funnel
    from scripts.validate_theme_candidate_universe import validate_universe
    from scripts.run_theme_research_analysis import _select_candidate_symbols
    from scripts.run_research_analysis import _validate_candidate_funnel_scope
    from scripts.data_layer import CninfoFinancialReportsProvider, EastmoneyF10FinancialsProvider, HkexFinancialReportsProvider, Market, SymbolInfo, default_real_providers, _sec_submission_matches_symbol


def _get_path(payload: Any, path: str) -> Any:
    current: Any = payload
    for part in path.split("."):
        if isinstance(current, list):
            try:
                current = current[int(part)]
            except (ValueError, IndexError):
                return None
        elif isinstance(current, dict):
            current = current.get(part)
        else:
            return None
    return current


def _set_path(payload: Any, path: str, value: Any) -> None:
    current: Any = payload
    parts: Any = path.split(".")
    for part in parts[:-1]:
        if isinstance(current, list):
            current = current[int(part)]
        elif isinstance(current, dict):
            current = current[part]
        else:
            raise ValueError(f"cannot traverse mutation path: {path}")
    last: Any = parts[-1]
    if isinstance(current, list):
        current[int(last)] = value
    elif isinstance(current, dict):
        current[last] = value
    else:
        raise ValueError(f"cannot set mutation path: {path}")


def _contains_mapping(payload: Any, path: str, expected: dict[str, Any]) -> bool:
    value: Any = _get_path(payload, path)
    if not isinstance(value, list):
        return False
    for item in value:
        if isinstance(item, dict) and all(item.get(k) == v for k, v in expected.items()):
            return True
    return False


def _build_strategy_eval_files(root: Path, case: Mapping[str, Any], temp_root: Path) -> tuple[Path, Path]:
    manifests: Any = case.get("manifests", [])
    overlays: Any = case.get("overlay_values", [])
    outcomes: Any = case.get("outcome_values", [])
    dossiers: Any = case.get("dossier_values", [])
    if not isinstance(manifests, list) or len(manifests) < 2:
        raise ValueError("strategy ledger static eval requires at least two manifests")
    if not isinstance(overlays, list) or not isinstance(outcomes, list) or not isinstance(dossiers, list):
        raise ValueError("strategy ledger static eval requires overlay_values, outcome_values, and dossier_values arrays")
    report_payload: dict[str, Any] = build_validated_merged_report(
        [root / str(path) for path in manifests],
        [str(item) for item in overlays],
        [str(item) for item in outcomes],
        [str(item) for item in dossiers],
    )
    report_path: Path = temp_root / "comparison_report.json"
    report_path.write_text(json.dumps(report_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    strategy_input_payload: dict[str, Any] = build_strategy_input(
        report_payload,
        source_report_path=report_path,
        theme=str(case.get("theme") or "静态评测候选池"),
        horizon=str(case.get("horizon") or "3-6个月"),
        geography="",
        decision_use="watchlist triggers and calibration",
        default_profile="balanced",
    )
    strategy_input_path: Path = temp_root / "laplace_strategy_input.json"
    strategy_input_path.write_text(json.dumps(strategy_input_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    judgment_payload: dict[str, Any] = {
        "contract_type": "serenity_laplace_strategy_judgment",
        "schema_version": "1.0",
        "source_strategy_input_path": str(strategy_input_path.resolve()),
        "as_of_date": "2026-06-30",
        "forecast": "当前候选池更适合保持证据触发型观察。",
        "decision": "保持观察，等待证据和市场结构同时改善。",
        "decision_model": "以 Serenity 数据门控、市场环境和 Laplace 场景权重共同决定后续触发器。",
        "observed": ["候选池已完成正式比较与 AI 研究交付。"],
        "inferred": ["证据链与价格结构共同决定行动优先级。"],
        "judgment": ["当前应使用触发器和复盘 claim 管理后续变化。"],
        "dominant_variables": [
            {
                "variable": "证据兑现",
                "role": "bottleneck",
                "direction": "direct evidence improves confidence",
                "confidence": "HIGH",
                "why": "证据兑现决定研究优先级能否升级。"
            },
            {
                "variable": "市场结构",
                "role": "timing",
                "direction": "stronger structure improves action room",
                "confidence": "MEDIUM",
                "why": "结构改善决定触发器是否可执行。"
            },
            {
                "variable": "估值与增长缺口",
                "role": "tripwire",
                "direction": "market ahead of evidence reduces action room",
                "confidence": "MEDIUM",
                "why": "估值领先证据会压低赔率。"
            }
        ],
        "scenarios": {
            "base": {"summary": "保持观察并验证证据。", "probability": 0.55, "conditions": ["核心证据逐步补齐。"]},
            "upside": {"summary": "证据与结构同时改善。", "probability": 0.25, "conditions": ["出现明确触发信号。"]},
            "downside": {"summary": "证据未兑现或市场走弱。", "probability": 0.2, "conditions": ["触发失效条件。"]}
        },
        "triggers": {
            "30d": ["检查核心证据是否改善。"],
            "90d": ["复核财务与订单兑现。"],
            "180d": ["复盘主题兑现与市场结构。"]
        },
        "invalidation": ["核心证据未兑现且市场结构转弱。"],
        "next_evidence": ["跟踪核心证据与市场结构。"],
        "action_plan": ["保持观察，满足触发器后再升级。"],
        "confidence": "MEDIUM",
        "ledger_claims": [
            {
                "claim": "静态评测 probe 会在到期复盘时被机器结算为真。",
                "probability": 0.7,
                "resolution_date": "2026-06-30",
                "resolution_criteria": "snapshot.values.static_probe >= 1",
                "resolution_probe": {
                    "type": "json_path_threshold",
                    "path": "values.static_probe",
                    "operator": ">=",
                    "threshold": 1
                }
            }
        ]
    }
    judgment_path: Path = temp_root / "laplace_strategy_judgment.json"
    judgment_path.write_text(json.dumps(judgment_payload, ensure_ascii=False, indent=2), encoding="utf-8")
    return strategy_input_path, judgment_path


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: Any = argparse.ArgumentParser(description="Run static Serenity + Chan eval cases")
    parser.add_argument("--cases", default="evals/static_cases.json", help="JSON case file")
    args: Any = parser.parse_args(argv)

    root: Any = Path.cwd()
    cases_path: Any = root / args.cases
    cases: Any = json.loads(cases_path.read_text(encoding="utf-8"))
    failures: Any = 0

    for case in cases:
        name: str = str(case["name"])
        expect_pass: bool = bool(case["expect_pass"])
        kind: str = str(case.get("kind", "report"))
        findings: list[str] = []
        result_payload: dict[str, Any] = {}
        actual_pass: bool = False

        if kind == "report":
            report_path: Any = root / case["report"]
            result: Any = validate_text(
                report_path.read_text(encoding="utf-8"),
                require_delivery_proof=bool(case.get("require_delivery_proof")),
            )
            actual_pass = result.ok
            findings = [f"{f.severity.upper()} {f.code}: {f.message}" for f in result.findings]
            result_payload = result.extracted
        elif kind == "scorecard":
            scorecard_path: Any = root / case["scorecard"]
            try:
                result_payload = score(json.loads(scorecard_path.read_text(encoding="utf-8")))
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "output_json":
            contract_path: Any = root / case["contract"]
            try:
                result_payload = validate_contract(json.loads(contract_path.read_text(encoding="utf-8")))
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "financial_validation":
            payload: Any = case.get("payload", {})
            try:
                with tempfile.TemporaryDirectory(prefix="serenity-static-financial-") as temp_dir:
                    financial_path: Any = Path(temp_dir) / "financials.json"
                    financial_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
                    result = validate_financials(financial_path)
                result_payload = {
                    "status": result.status.value,
                    "rating_cap": result.rating_cap.value,
                    "warnings": result.warnings,
                    "stats": result.stats,
                }
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "valuation_inputs_validation":
            payload = case.get("payload", {})
            try:
                with tempfile.TemporaryDirectory(prefix="serenity-static-valuation-") as temp_dir:
                    valuation_path: Any = Path(temp_dir) / "valuation_inputs.json"
                    valuation_path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
                    result = validate_valuation_inputs(valuation_path)
                result_payload = {
                    "status": result.status.value,
                    "warnings": result.warnings,
                    "errors": result.errors,
                    "stats": result.stats,
                }
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "data_gaps":
            result_items: Any = case.get("result_items", [])
            statuses: Any = case.get("statuses", {})
            requested: Any = case.get("requested_datasets", [])
            critical: Any = case.get("critical_datasets", [])
            if not isinstance(result_items, list) or not isinstance(statuses, dict):
                raise ValueError("data_gaps static eval requires result_items array and statuses object")
            if not isinstance(requested, list) or not isinstance(critical, list):
                raise ValueError("data_gaps static eval requires requested_datasets and critical_datasets arrays")
            try:
                data_gaps: Any = _build_data_gaps(
                    [item for item in result_items if isinstance(item, dict)],
                    {str(k): str(v) for k, v in statuses.items()},
                    requested_dataset_values=[str(item) for item in requested],
                    critical_datasets=[str(item) for item in critical],
                )
                research_debt: Any = _build_research_debt(data_gaps)
                result_payload = {
                    "data_gaps": data_gaps,
                    "research_debt": research_debt,
                    "gap_count": len(data_gaps),
                    "research_debt_count": len(research_debt),
                }
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "dashboard_from_output_json":
            contract_path = root / case["contract"]
            try:
                dashboard: Any = build_from_output_contract(json.loads(contract_path.read_text(encoding="utf-8")))
                monitors: Any = dashboard.get("monitors", [])
                result_payload = {
                    "ok": True,
                    "has_valuation_monitor": any(
                        isinstance(monitor, dict) and monitor.get("category") == "valuation"
                        for monitor in monitors
                    ),
                }
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "report_kind":
            titles: Any = case.get("titles", {})
            if not isinstance(titles, dict):
                raise ValueError("report_kind static eval requires titles object")
            result_payload = {
                str(title): EastmoneyF10FinancialsProvider._report_kind(str(title))
                for title in titles
            }
            mismatches: Any = {
                title: {"expected": expected, "actual": result_payload.get(title)}
                for title, expected in titles.items()
                if result_payload.get(title) != expected
            }
            actual_pass = not mismatches
            if mismatches:
                findings = [json.dumps(mismatches, ensure_ascii=False, sort_keys=True)]
        elif kind == "official_report_selection":
            reports: Any = case.get("reports", [])
            if not isinstance(reports, list):
                raise ValueError("official_report_selection static eval requires reports array")
            selected: Any = EastmoneyF10FinancialsProvider._select_reports_for_download(
                [report for report in reports if isinstance(report, dict)],
                int(case.get("limit", 2)),
            )
            result_payload = {
                "selected_report_kinds": [str(report.get("report_kind") or "") for report in selected],
                "selected_titles": [str(report.get("title") or "") for report in selected],
            }
            actual_pass = True
        elif kind == "periodic_report_title":
            titles = case.get("titles", {})
            if not isinstance(titles, dict):
                raise ValueError("periodic_report_title static eval requires titles object")
            issuer_name: Any = str(case.get("issuer_name") or "")
            result_payload = {
                str(title): CninfoFinancialReportsProvider._is_periodic_report_title(str(title), issuer_name=issuer_name)
                for title in titles
            }
            mismatches = {
                title: {"expected": expected, "actual": result_payload.get(title)}
                for title, expected in titles.items()
                if result_payload.get(title) != expected
            }
            actual_pass = not mismatches
            if mismatches:
                findings = [json.dumps(mismatches, ensure_ascii=False, sort_keys=True)]
        elif kind == "cn_statement_start":
            pages: Any = case.get("pages", [])
            if not isinstance(pages, list):
                raise ValueError("cn_statement_start static eval requires pages array")
            index: Any = CninfoFinancialReportsProvider._cn_statement_start_index(
                [page for page in pages if isinstance(page, dict)],
                str(case.get("title", "合并资产负债表")),
                [str(signal) for signal in case.get("signals", ["资产总计", "资产合计", "负债合计", "所有者权益", "股东权益"])],
            )
            page_list: Any = [page for page in pages if isinstance(page, dict)]
            result_payload = {
                "start_index": index,
                "start_page": page_list[index].get("page_number") if index is not None and index < len(page_list) else None,
            }
            actual_pass = index is not None
        elif kind == "cninfo_english_value_extraction":
            pages = [page for page in case.get("pages", []) if isinstance(page, dict)]
            if not pages:
                raise ValueError("cninfo_english_value_extraction static eval requires pages array")
            assets: Any
            _: Any
            assets, _ = CninfoFinancialReportsProvider._extract_cn_value(
                pages,
                [["Totalassets"]],
                exclude_groups=[["liabilities", "equity"]],
            )
            liabilities: Any
            liabilities, _ = CninfoFinancialReportsProvider._extract_cn_value(
                pages,
                [["Totalliabilities"]],
                exclude_groups=[["currentliabilities"], ["non-currentliabilities"], ["liabilities&equity"]],
            )
            equity: Any
            equity, _ = CninfoFinancialReportsProvider._extract_cn_value(
                pages,
                [["Totalequity"]],
                exclude_groups=[["attributable"], ["liabilities&equity"]],
            )
            parent_equity: Any
            parent_equity, _ = CninfoFinancialReportsProvider._extract_cn_value(
                pages,
                [["Totalequityattributabletotheparentcompany"]],
            )
            result_payload = {
                "assets": assets,
                "liabilities": liabilities,
                "equity": equity,
                "parent_equity": parent_equity,
            }
            actual_pass = all(value is not None for value in result_payload.values())
        elif kind in {"bank_profile_extraction", "financial_sector_profile_extraction"}:
            pages = case.get("pages", [])
            if not isinstance(pages, list):
                raise ValueError(f"{kind} static eval requires pages array")
            profile: Any = CninfoFinancialReportsProvider._extract_financial_sector_profile(
                [page for page in pages if isinstance(page, dict)],
                unit=str(case.get("unit", "million_yuan")),
            )
            result_payload = profile if isinstance(profile, dict) else {}
            actual_pass = bool(profile)
        elif kind == "candidate_rank":
            scorecards: Any = case.get("scorecards", [])
            if not isinstance(scorecards, list) or not scorecards:
                raise ValueError("candidate_rank static eval requires scorecards array")
            try:
                payloads: Any = [
                    json.loads((root / str(path)).read_text(encoding="utf-8"))
                    for path in scorecards
                ]
                result_payload = rank_candidates(payloads)
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "technical_health":
            series: Any = case.get("series", {})
            if not isinstance(series, dict):
                raise ValueError("technical_health static eval requires series object")
            start: Any = float(series.get("start", 100.0))
            step: Any = float(series.get("step", 0.0))
            count: Any = int(series.get("count", 80))
            rows: Any = []
            for idx in range(count):
                close: Any = start + idx * step
                month: Any = 1 + idx // 28
                day: Any = 1 + idx % 28
                rows.append({
                    "date": f"2026-{month:02d}-{day:02d}",
                    "close": close,
                    "high": close * 1.01,
                    "low": close * 0.99,
                    "volume": 1000000 + idx,
                })
            benchmark_rows: list[dict[str, Any]] = []
            benchmark_series: Any = case.get("benchmark_series", {})
            if isinstance(benchmark_series, dict):
                benchmark_start: float = float(benchmark_series.get("start", start))
                benchmark_step: float = float(benchmark_series.get("step", 0.0))
                for idx in range(count):
                    benchmark_close: float = benchmark_start + idx * benchmark_step
                    month = 1 + idx // 28
                    day = 1 + idx % 28
                    benchmark_rows.append({
                        "date": f"2026-{month:02d}-{day:02d}",
                        "close": benchmark_close,
                        "high": benchmark_close * 1.01,
                        "low": benchmark_close * 0.99,
                        "volume": 1000000 + idx,
                    })
            result_payload = analyze_price_rows(rows, benchmark_rows=benchmark_rows if benchmark_rows else None)
            actual_pass = bool(result_payload.get("buy_point_claim_allowed")) is False
        elif kind == "market_regime":
            snapshot_payload: Any = case.get("snapshot", {})
            if not isinstance(snapshot_payload, dict):
                raise ValueError("market_regime static eval requires snapshot object")
            try:
                with tempfile.TemporaryDirectory(prefix="serenity-static-market-regime-") as temp_dir:
                    snapshot_path: Path = Path(temp_dir) / "market_snapshot.json"
                    snapshot_path.write_text(json.dumps(snapshot_payload, ensure_ascii=False, indent=2), encoding="utf-8")
                    result_payload = build_market_regime(snapshot_path=snapshot_path)
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "portfolio_context_validation":
            payload = case.get("payload", {})
            if not isinstance(payload, dict):
                raise ValueError("portfolio_context_validation static eval requires payload object")
            errors = validate_portfolio_context(payload)
            result_payload = {"ok": not errors, "errors": errors}
            actual_pass = not errors
            findings = errors
        elif kind == "financial_period_selection":
            rows = case.get("rows", [])
            if not isinstance(rows, list):
                raise ValueError("financial_period_selection static eval requires rows array")
            period_rows: Any = [row for row in rows if isinstance(row, dict)]
            annual: Any = latest_annual(period_rows, market=str(case.get("market", "")))
            q1: Any = latest_quarter(period_rows, "q1", market=str(case.get("market", "")))
            annual_meta: Any = normalize_financial_period(annual or {}, market=str(case.get("market", "")))
            q1_meta: Any = normalize_financial_period(q1 or {}, market=str(case.get("market", "")))
            result_payload = {
                "latest_annual_period": annual.get("period") if isinstance(annual, dict) else None,
                "latest_annual_selection_rule": annual_meta.get("selection_rule"),
                "latest_annual_period_type": annual_meta.get("period_type"),
                "latest_q1_period": q1.get("period") if isinstance(q1, dict) else None,
                "latest_q1_period_type": q1_meta.get("period_type"),
            }
            actual_pass = annual is not None
        elif kind == "capital_actions":
            announcements: Any = case.get("announcements", [])
            if not isinstance(announcements, list):
                raise ValueError("capital_actions static eval requires announcements array")
            result_payload = analyze_announcements({"recent_announcements": announcements})
            actual_pass = True
        elif kind == "capital_action_quantification":
            capital_actions: Any = case.get("capital_actions", {})
            if not isinstance(capital_actions, dict):
                raise ValueError("capital_action_quantification static eval requires capital_actions object")
            result_payload = quantify_capital_actions(str(case.get("symbol") or "TEST"), capital_actions)
            actual_pass = True
        elif kind == "customer_evidence_summary":
            evidence_payload: Any = case.get("payload", {})
            if not isinstance(evidence_payload, dict):
                raise ValueError("customer_evidence_summary static eval requires payload object")
            with tempfile.TemporaryDirectory(prefix="serenity-static-customer-") as temp_dir:
                temp_path: Path = Path(temp_dir)
                data_path: Path = temp_path / "customer_evidence.json"
                manifest_path: Path = temp_path / "manifest.json"
                data_path.write_text(json.dumps(evidence_payload, ensure_ascii=False, indent=2), encoding="utf-8")
                manifest_payload: dict[str, Any] = {
                    "symbol": {"symbol": str(evidence_payload.get("symbol") or "TEST.SZ"), "market": evidence_payload.get("market", "CN_A"), "currency": "CNY"},
                    "out_dir": str(temp_path),
                    "data_acquisition": {
                        "status_by_dataset": {"customer_order_capacity_evidence": "OK"},
                    },
                    "data_quality": {},
                    "results": [
                        {
                            "dataset": "customer_order_capacity_evidence",
                            "status": "OK",
                            "source": evidence_payload.get("source_name", "Disclosure_Customer_Order_Capacity_Evidence_L0"),
                            "source_level": evidence_payload.get("source_level", "L0_OFFICIAL_DISCLOSURE"),
                            "data_path": str(data_path),
                        }
                    ],
                }
                manifest_path.write_text(json.dumps(manifest_payload, ensure_ascii=False, indent=2), encoding="utf-8")
                result_payload = _customer_evidence_summary(manifest_payload)
            actual_pass = True
        elif kind == "customer_evidence_provider":
            payload: Any = case.get("payload", {})
            if not isinstance(payload, dict):
                raise ValueError("customer_evidence_provider static eval requires payload object")
            market: Market = Market(str(case.get("market") or "US"))
            symbol = SymbolInfo(
                input_value=str(case.get("symbol") or "NVDA"),
                symbol=str(case.get("symbol") or "NVDA"),
                market=market,
                exchange=str(case.get("exchange") or market.value),
                currency=str(case.get("currency") or "USD"),
            )
            provider = data_layer_module.DisclosureCustomerEvidenceProvider()
            records = provider._records_from_payload(market, payload)
            result_payload = provider._build_payload(symbol, records, source_name=str(case.get("source_name") or "static_disclosure"))
            actual_pass = True
        elif kind == "debt_gate_profile":
            rows: Any = case.get("rows", [])
            if not isinstance(rows, list):
                raise ValueError("debt_gate_profile static eval requires rows array")
            result_payload = _debt_gate_profile(rows)
            actual_pass = True
        elif kind == "rating_cap_for_statuses":
            statuses: Any = case.get("statuses", {})
            required_datasets: Any = case.get("required_datasets", [])
            validation_caps: Any = case.get("validation_caps", [])
            if not isinstance(statuses, dict) or not isinstance(required_datasets, list) or not isinstance(validation_caps, list):
                raise ValueError("rating_cap_for_statuses requires statuses object and required_datasets/validation_caps arrays")
            result_payload = {
                "rating_cap": _cap_for_statuses(
                    {str(key): str(value) for key, value in statuses.items()},
                    [str(item) for item in validation_caps],
                    required_datasets=[str(item) for item in required_datasets],
                    downgrade_not_requested=bool(case.get("downgrade_not_requested", True)),
                ).value
            }
            actual_pass = True
        elif kind == "theme_selection":
            theme: str = str(case.get("theme") or "")
            policy: str = str(case.get("selection_policy") or "theme-cluster")
            max_candidates: int = int(case.get("max_candidates") or 0)
            universe: dict[str, Any] = build_universe(theme)
            selected: list[str] = _select_candidate_symbols(universe, max_candidates=max_candidates, selection_policy=policy)
            result_payload = {"selected_symbols": selected, "selected_count": len(selected)}
            actual_pass = True
        elif kind == "macro_theme_map":
            macro_payload: dict[str, Any] = build_macro_theme_map(
                prompt=str(case.get("prompt") or ""),
                explicit_themes=[str(item) for item in case.get("themes", [])],
                max_price=case.get("max_price"),
                min_price=case.get("min_price"),
                excluded_boards=[str(item) for item in case.get("excluded_boards", [])],
            )
            macro_errors: list[str] = validate_macro_theme_map(macro_payload)
            result_payload = {
                "ok": not macro_errors,
                "errors": macro_errors,
                "intent_mode": macro_payload.get("intent", {}).get("mode"),
                "broad_scan": macro_payload.get("intent", {}).get("broad_scan"),
                "theme_seed_keys": macro_payload.get("intent", {}).get("theme_seed_keys", []),
                "excluded_theme_keys": macro_payload.get("intent", {}).get("excluded_theme_keys", []),
                "selected_theme_keys": macro_payload.get("selected_theme_keys", []),
                "price_style": macro_payload.get("constraint_interpretation", {}).get("price_style"),
                "ai_expansion_enabled": macro_payload.get("ai_expansion_policy", {}).get("enabled"),
                "ai_expansion_mode": macro_payload.get("ai_expansion_policy", {}).get("expansion_mode"),
                "curated_theme_role": macro_payload.get("ai_expansion_policy", {}).get("curated_theme_role"),
            }
            actual_pass = not macro_errors
            findings = macro_errors
        elif kind == "opportunity_discovery_plan":
            plan_payload: dict[str, Any] = build_plan(
                prompt=str(case.get("prompt") or ""),
                market_scope=[str(item) for item in case.get("market_scope", ["CN_A"])],
                excluded_boards=[str(item) for item in case.get("excluded_boards", [])],
                horizon=str(case.get("horizon") or "3-6个月"),
                risk_profile=str(case.get("risk_profile") or "balanced"),
                max_price=case.get("max_price"),
                min_price=case.get("min_price"),
                explicit_themes=[str(item) for item in case.get("themes", [])],
                preflight_candidate_limit=int(case.get("preflight_candidate_limit") or 24),
                shortlist_target=int(case.get("shortlist_target") or 8),
            )
            plan_errors: list[str] = validate_opportunity_discovery_plan(plan_payload)
            result_payload = {
                "ok": not plan_errors,
                "errors": plan_errors,
                "discovery_mode": plan_payload.get("discovery_mode"),
                "theme_keys": [
                    str(item.get("theme_key") or "")
                    for item in plan_payload.get("trend_hypotheses", [])
                    if isinstance(item, dict)
                ],
                "theme_sources": [
                    str(item.get("theme_source") or "")
                    for item in plan_payload.get("trend_hypotheses", [])
                    if isinstance(item, dict)
                ],
                "macro_intent_mode": plan_payload.get("macro_theme_map", {}).get("intent", {}).get("mode"),
                "macro_broad_scan": plan_payload.get("macro_theme_map", {}).get("intent", {}).get("broad_scan"),
                "macro_excluded_theme_keys": plan_payload.get("macro_theme_map", {}).get("intent", {}).get("excluded_theme_keys", []),
                "macro_selected_theme_keys": plan_payload.get("macro_theme_map", {}).get("selected_theme_keys", []),
                "ai_expansion_enabled": plan_payload.get("universe_policy", {}).get("ai_expansion_policy", {}).get("enabled"),
                "ai_expansion_mode": plan_payload.get("universe_policy", {}).get("ai_expansion_policy", {}).get("expansion_mode"),
                "ai_expansion_tasks_count": len(plan_payload.get("universe_policy", {}).get("ai_expansion_tasks", [])),
                "discovery_datasets": plan_payload.get("universe_policy", {}).get("preflight_profile", {}).get("discovery_datasets", []),
                "formal_required_datasets": plan_payload.get("universe_policy", {}).get("preflight_profile", {}).get("formal_required_datasets", []),
                "market_scope": plan_payload.get("request", {}).get("market_scope", []),
                "excluded_boards": plan_payload.get("request", {}).get("excluded_boards", []),
            }
            actual_pass = not plan_errors
            findings = plan_errors
        elif kind == "theme_candidate_universe":
            payload: Any = case.get("payload", {})
            if not isinstance(payload, Mapping):
                result_payload = {"ok": False, "errors": ["payload must be an object"]}
                findings = result_payload["errors"]
                actual_pass = False
            else:
                universe_errors: list[str] = validate_universe(payload)
                result_payload = {
                    "ok": not universe_errors,
                    "errors": universe_errors,
                }
                findings = universe_errors
                actual_pass = not universe_errors
        elif kind == "candidate_funnel":
            with tempfile.TemporaryDirectory(prefix="serenity-static-funnel-") as temp_dir:
                temp_root: Path = Path(temp_dir)
                plan_payload: dict[str, Any] = build_plan(
                    prompt=str(case.get("prompt") or ""),
                    market_scope=[str(item) for item in case.get("market_scope", ["CN_A"])],
                    excluded_boards=[str(item) for item in case.get("excluded_boards", [])],
                    horizon=str(case.get("horizon") or "3-6个月"),
                    risk_profile=str(case.get("risk_profile") or "balanced"),
                    max_price=case.get("max_price"),
                    min_price=case.get("min_price"),
                    explicit_themes=[str(item) for item in case.get("themes", [])],
                    preflight_candidate_limit=int(case.get("preflight_candidate_limit") or 24),
                    shortlist_target=int(case.get("shortlist_target") or 8),
                )
                plan_path: Path = temp_root / "opportunity_discovery_plan.json"
                plan_path.write_text(json.dumps(plan_payload, ensure_ascii=False, indent=2), encoding="utf-8")
                snapshot_path: Path = temp_root / "preflight_snapshot.json"
                snapshot_path.write_text(json.dumps(case.get("preflight_snapshot", {}), ensure_ascii=False, indent=2), encoding="utf-8")
                universe_paths: list[Path] = []
                for index, universe_payload in enumerate(case.get("universes", [])):
                    universe_path: Path = temp_root / f"theme_candidate_universe_external_{index}.json"
                    universe_path.write_text(json.dumps(universe_payload, ensure_ascii=False, indent=2), encoding="utf-8")
                    universe_paths.append(universe_path)
                funnel_payload: dict[str, Any] = build_candidate_funnel(
                    plan_path=plan_path,
                    universe_paths=universe_paths,
                    preflight_root=None,
                    preflight_snapshot_path=snapshot_path,
                )
            funnel_errors: list[str] = validate_candidate_funnel(funnel_payload)
            result_payload = {
                "ok": not funnel_errors,
                "errors": funnel_errors,
                "shortlist_symbols": funnel_payload.get("shortlist_symbols", []),
                "stage_summary": funnel_payload.get("stage_summary", []),
                "source_universe_paths": funnel_payload.get("source_universe_paths", []),
                "candidate_rows": [
                    {
                        "symbol": str(row.get("symbol") or ""),
                        "theme_key": str(row.get("theme_key") or ""),
                        "final_bucket": str(row.get("final_bucket") or ""),
                    }
                    for row in funnel_payload.get("candidate_rows", [])
                    if isinstance(row, dict)
                ],
                "excluded_count": len([
                    row for row in funnel_payload.get("candidate_rows", [])
                    if isinstance(row, dict) and row.get("final_bucket") == "constraint_excluded"
                ]),
            }
            actual_pass = not funnel_errors
            findings = funnel_errors
        elif kind == "candidate_funnel_quality_floor":
            result_payload = _quality_floor(
                case.get("row", {}),
                case.get("preflight", {}),
            )
            actual_pass = True
        elif kind == "candidate_funnel_shortlist_selection":
            rows: Any = case.get("rows", [])
            if not isinstance(rows, list):
                raise ValueError("candidate_funnel_shortlist_selection requires rows array")
            normalized_rows: list[dict[str, Any]] = [row for row in rows if isinstance(row, dict)]
            selected: set[int] = _select_shortlist_indexes(
                normalized_rows,
                int(case.get("shortlist_target") or 1),
            )
            result_payload = {
                "selected_symbols": [
                    str(normalized_rows[index].get("symbol") or "")
                    for index in sorted(selected)
                ]
            }
            actual_pass = True
        elif kind == "candidate_funnel_scope":
            with tempfile.TemporaryDirectory(prefix="serenity-static-funnel-scope-") as temp_dir:
                temp_root: Path = Path(temp_dir)
                funnel_path: Path = temp_root / "candidate_funnel.json"
                funnel_payload: dict[str, Any] = dict(case.get("candidate_funnel", {}))
                funnel_path.write_text(json.dumps(funnel_payload, ensure_ascii=False, indent=2), encoding="utf-8")
                try:
                    _validate_candidate_funnel_scope(
                        str(funnel_path),
                        [str(item) for item in case.get("symbols", [])],
                    )
                    result_payload = {"accepted": True, "error": ""}
                    actual_pass = True
                except Exception as exc:
                    result_payload = {"accepted": False, "error": str(exc)}
                    findings = [str(exc)]
                    actual_pass = False
        elif kind == "data_consumption_ranking_validity":
            financial_payload: Any = case.get("financial_payload", {})
            financial_row: Any = case.get("financial_row", {})
            if not isinstance(financial_row, dict):
                raise ValueError("data_consumption_ranking_validity requires financial_row object")
            consumption: Any = financial_consumption_audit(
                symbol=str(case.get("symbol") or "TEST"),
                raw_status=str(case.get("raw_status") or "NOT_REQUESTED"),
                financial_payload=financial_payload,
                financial_row=financial_row,
            )
            result_payload = {
                "consumption": consumption,
                "ranking_validity": ranking_validity_from_consumption([consumption]),
            }
            actual_pass = True
        elif kind == "valuation_consumption_audit":
            valuation_payload: Any = case.get("valuation_payload", {})
            valuation_row: Any = case.get("valuation_row", {})
            growth_row: Any = case.get("growth_row", {})
            if not isinstance(valuation_row, dict) or not isinstance(growth_row, dict):
                raise ValueError("valuation_consumption_audit requires valuation_row and growth_row objects")
            result_payload = valuation_consumption_audit(
                symbol=str(case.get("symbol") or "TEST"),
                raw_status=str(case.get("raw_status") or "NOT_REQUESTED"),
                valuation_payload=valuation_payload,
                valuation_row=valuation_row,
                growth_row=growth_row,
            )
            actual_pass = True
        elif kind == "comparison_report":
            manifests = case.get("manifests", [])
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("comparison_report static eval requires at least two manifests")
            try:
                manifest_paths = [root / str(path) for path in manifests]
                if case.get("clear_manifest_research_debt"):
                    with tempfile.TemporaryDirectory(prefix="serenity-static-comparison-") as temp_dir:
                        temp_paths: Any = []
                        for manifest_path in manifest_paths:
                            payload = json.loads(manifest_path.read_text(encoding="utf-8"))
                            acquisition: Any = payload.get("data_acquisition") if isinstance(payload.get("data_acquisition"), dict) else {}
                            acquisition["research_debt"] = []
                            acquisition["manual_retrieval_tasks"] = []
                            acquisition["research_debt_count"] = 0
                            acquisition["manual_task_count"] = 0
                            payload["data_acquisition"] = acquisition
                            temp_path: Any = Path(temp_dir) / manifest_path.name
                            temp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
                            temp_paths.append(temp_path)
                        result_payload = build_comparison_report(temp_paths)
                else:
                    result_payload = build_comparison_report(manifest_paths)
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "comparison_report_file_validation":
            manifests = case.get("manifests", [])
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("comparison_report_file_validation static eval requires at least two manifests")
            try:
                manifest_paths: list[Path] = [root / str(path) for path in manifests]
                report: dict[str, Any] = build_comparison_report(manifest_paths)
                with tempfile.TemporaryDirectory(prefix="serenity-static-comparison-validator-") as temp_dir:
                    report_path: Path = Path(temp_dir) / "comparison_report.json"
                    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
                    errors: list[str] = validate_comparison_report_file(report_path)
                result_payload = {
                    "ok": not errors,
                    "error_count": len(errors),
                }
                actual_pass = not errors
                findings = errors
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "render_report_mode":
            manifests: Any = case.get("manifests", [])
            mode: str = str(case.get("mode") or "candidate_comparison")
            overlays: Any = case.get("overlay_values", [])
            outcomes: Any = case.get("outcome_values", [])
            dossiers: Any = case.get("dossier_values", [])
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("render_report_mode static eval requires at least two manifests")
            if not isinstance(overlays, list) or not isinstance(outcomes, list) or not isinstance(dossiers, list):
                raise ValueError("render_report_mode static eval requires overlay_values, outcome_values, and dossier_values arrays when supplied")
            try:
                manifest_paths: list[Path] = [root / str(path) for path in manifests]
                if overlays or outcomes:
                    report_payload: dict[str, Any] = build_validated_merged_report(
                        manifest_paths,
                        [str(item) for item in overlays],
                        [str(item) for item in outcomes],
                        [str(item) for item in dossiers],
                    )
                    with tempfile.TemporaryDirectory(prefix="serenity-static-render-") as temp_dir:
                        report_path: Path = Path(temp_dir) / "comparison_final.json"
                        report_path.write_text(json.dumps(report_payload, ensure_ascii=False, indent=2), encoding="utf-8")
                        markdown = render_report(manifests=[], comparison_report=report_path, mode=mode)
                        comparison_markdown = render_report(manifests=[], comparison_report=report_path, mode="candidate_comparison")
                else:
                    markdown = render_report(manifests=manifest_paths, mode=mode)
                    comparison_markdown = render_report(manifests=manifest_paths, mode="candidate_comparison")
                result_payload = {
                    "mode": mode,
                    "line_count": len(markdown.splitlines()),
                    "candidate_line_count": len(comparison_markdown.splitlines()),
                    "differs_from_candidate_comparison": markdown != comparison_markdown,
                    "has_full_research_workbench": "# 完整研究工作台" in markdown,
                    "has_candidate_sections": "## 688019.SH" in markdown and "## 688322.SH" in markdown,
                    "has_dataset_statuses": "财报 `正常`" in markdown and "公告 `正常`" in markdown,
                    "has_gate_reasons": "门控原因：" in markdown and "门控原因：无" not in markdown,
                    "has_gate_classes": "证据门控=证据验证" in markdown,
                }
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "action_gate_profile":
            debt_rows: Any = case.get("research_debt", [])
            if not isinstance(debt_rows, list):
                raise ValueError("action_gate_profile static eval requires research_debt array")
            try:
                result_payload = _action_gate_profile(
                    case.get("technical", {}) if isinstance(case.get("technical", {}), dict) else {},
                    case.get("capital", {}) if isinstance(case.get("capital", {}), dict) else {},
                    case.get("layer", {}) if isinstance(case.get("layer", {}), dict) else {},
                    case.get("growth", {}) if isinstance(case.get("growth", {}), dict) else {},
                    _debt_gate_profile([row for row in debt_rows if isinstance(row, dict)]),
                )
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "comparison_report_validation":
            manifests = case.get("manifests", [])
            mutations: Any = case.get("mutations", [])
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("comparison_report_validation static eval requires at least two manifests")
            if not isinstance(mutations, list):
                raise ValueError("comparison_report_validation static eval requires mutations array")
            report: Any = build_comparison_report([root / str(path) for path in manifests])
            for mutation in mutations:
                if not isinstance(mutation, dict) or "path" not in mutation:
                    raise ValueError("comparison_report_validation mutation requires path")
                _set_path(report, str(mutation["path"]), mutation.get("value"))
            errors: Any = validate_comparison_report(report)
            result_payload = {"ok": not errors, "errors": errors}
            actual_pass = not errors
            if errors:
                findings = errors
        elif kind == "comparison_report_with_overlays":
            manifests = case.get("manifests", [])
            overlays: Any = case.get("overlays", {})
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("comparison_report_with_overlays static eval requires at least two manifests")
            if not isinstance(overlays, dict):
                raise ValueError("comparison_report_with_overlays static eval requires overlays object")
            try:
                result_payload = build_comparison_report(
                    [root / str(path) for path in manifests],
                    {str(symbol): overlay for symbol, overlay in overlays.items() if isinstance(overlay, dict)},
                )
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "comparison_report_with_ai_outcomes":
            manifests = case.get("manifests", [])
            outcomes: Any = case.get("ai_review_outcomes", {})
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("comparison_report_with_ai_outcomes static eval requires at least two manifests")
            if not isinstance(outcomes, dict):
                raise ValueError("comparison_report_with_ai_outcomes static eval requires ai_review_outcomes object")
            try:
                result_payload = build_comparison_report(
                    [root / str(path) for path in manifests],
                    ai_review_outcomes={str(symbol): outcome for symbol, outcome in outcomes.items() if isinstance(outcome, dict)},
                )
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "validated_ai_merge":
            manifests = case.get("manifests", [])
            overlays: Any = case.get("overlay_values", [])
            outcomes: Any = case.get("outcome_values", [])
            dossiers: Any = case.get("dossier_values", [])
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("validated_ai_merge static eval requires at least two manifests")
            if not isinstance(overlays, list) or not isinstance(outcomes, list) or not isinstance(dossiers, list):
                raise ValueError("validated_ai_merge static eval requires overlay_values, outcome_values, and dossier_values arrays")
            try:
                result_payload = build_validated_merged_report(
                    [root / str(path) for path in manifests],
                    [str(item) for item in overlays],
                    [str(item) for item in outcomes],
                    [str(item) for item in dossiers],
                )
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "ai_overlay_validation":
            payload_file: Any = case.get("payload_file")
            payload = json.loads((root / str(payload_file)).read_text(encoding="utf-8")) if payload_file else case.get("payload", {})
            mutations: Any = case.get("mutations", [])
            if not isinstance(payload, dict):
                raise ValueError("ai_overlay_validation static eval requires payload object")
            if not isinstance(mutations, list):
                raise ValueError("ai_overlay_validation mutations must be an array when supplied")
            for mutation in mutations:
                if not isinstance(mutation, dict) or "path" not in mutation:
                    raise ValueError("ai_overlay_validation mutation requires path")
                _set_path(payload, str(mutation["path"]), mutation.get("value"))
            try:
                result_payload = validate_overlay(payload)
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "ai_overlay_validation_with_context":
            payload = case.get("payload", {})
            evidence_context = case.get("evidence_context", {})
            if not isinstance(payload, dict) or not isinstance(evidence_context, dict):
                raise ValueError("ai_overlay_validation_with_context static eval requires payload and evidence_context objects")
            try:
                result_payload = validate_overlay(
                    payload,
                    evidence_context={str(key): str(value) for key, value in evidence_context.items()},
                )
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "ai_research_dossier_validation":
            payload_file: Any = case.get("payload_file")
            payload = json.loads((root / str(payload_file)).read_text(encoding="utf-8")) if payload_file else case.get("payload", {})
            evidence_context: Any = case.get("evidence_context")
            mutations: Any = case.get("mutations", [])
            if not isinstance(payload, dict):
                raise ValueError("ai_research_dossier_validation static eval requires payload object")
            if evidence_context is not None and not isinstance(evidence_context, dict):
                raise ValueError("ai_research_dossier_validation evidence_context must be an object when supplied")
            if not isinstance(mutations, list):
                raise ValueError("ai_research_dossier_validation mutations must be an array when supplied")
            for mutation in mutations:
                if not isinstance(mutation, dict) or "path" not in mutation:
                    raise ValueError("ai_research_dossier_validation mutation requires path")
                _set_path(payload, str(mutation["path"]), mutation.get("value"))
            try:
                result_payload = validate_dossier(
                    payload,
                    evidence_context={str(key): str(value) for key, value in evidence_context.items()} if isinstance(evidence_context, dict) else None,
                )
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "ai_research_dossier_score":
            payload_file = case.get("payload_file")
            payload = json.loads((root / str(payload_file)).read_text(encoding="utf-8")) if payload_file else case.get("payload", {})
            evidence_context = case.get("evidence_context")
            mutations = case.get("mutations", [])
            if not isinstance(payload, dict):
                raise ValueError("ai_research_dossier_score static eval requires payload object")
            if evidence_context is not None and not isinstance(evidence_context, dict):
                raise ValueError("ai_research_dossier_score evidence_context must be an object when supplied")
            if not isinstance(mutations, list):
                raise ValueError("ai_research_dossier_score mutations must be an array when supplied")
            for mutation in mutations:
                if not isinstance(mutation, dict) or "path" not in mutation:
                    raise ValueError("ai_research_dossier_score mutation requires path")
                _set_path(payload, str(mutation["path"]), mutation.get("value"))
            try:
                result_payload = score_dossier(
                    payload,
                    evidence_context={str(key): str(value) for key, value in evidence_context.items()} if isinstance(evidence_context, dict) else None,
                )
                min_score: float = float(case.get("min_score", 70.0))
                actual_pass = bool(result_payload.get("delivery_allowed")) and float(result_payload.get("score") or 0.0) >= min_score
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "ai_review_outcome_validation":
            payload = case.get("payload", {})
            if not isinstance(payload, dict):
                raise ValueError("ai_review_outcome_validation static eval requires payload object")
            try:
                result_payload = validate_review_outcome(payload)
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "strategy_judgment_validation":
            payload = case.get("payload", {})
            if not isinstance(payload, dict):
                raise ValueError("strategy_judgment_validation static eval requires payload object")
            errors = validate_strategy_judgment(payload)
            result_payload = {"ok": not errors, "errors": errors}
            actual_pass = not errors
            findings = errors
        elif kind == "strategy_readiness":
            manifests = case.get("manifests", [])
            overlays = case.get("overlay_values", [])
            outcomes = case.get("outcome_values", [])
            dossiers = case.get("dossier_values", [])
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("strategy_readiness static eval requires at least two manifests")
            try:
                report_payload: dict[str, Any] = build_validated_merged_report(
                    [root / str(path) for path in manifests],
                    [str(item) for item in overlays],
                    [str(item) for item in outcomes],
                    [str(item) for item in dossiers],
                )
                result_payload = evaluate_strategy_readiness(report_payload)
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "strategy_ledger_pipeline":
            try:
                with tempfile.TemporaryDirectory(prefix="serenity-static-ledger-pipeline-") as temp_dir:
                    temp_root = Path(temp_dir)
                    strategy_input_path, judgment_path = _build_strategy_eval_files(root, case, temp_root)
                    ledger_path = temp_root / "forecast-ledger.sqlite"
                    sync_payload: dict[str, Any] = build_sync_report(
                        strategy_input_path,
                        judgment_path,
                        ledger_path=ledger_path,
                        root=root,
                        write_ledger=True,
                    )
                    snapshot_payload: dict[str, Any] = {"values": {"static_probe": 1}}
                    resolved_payload: dict[str, Any] = resolve_due_claims(
                        ledger_path=ledger_path,
                        snapshot=snapshot_payload,
                        due_before="today",
                        root=root,
                        write_ledger=True,
                    )
                    calibration_payload: dict[str, Any] = build_calibration_report(ledger_path)
                result_payload = {
                    "sync_status": sync_payload.get("sync_status"),
                    "claim_count": sync_payload.get("claim_count"),
                    "resolved_count": resolved_payload.get("summary", {}).get("resolved_count"),
                    "manual_review_count": resolved_payload.get("summary", {}).get("manual_review_count"),
                    "resolved_claim_count": calibration_payload.get("summary", {}).get("resolved_claim_count"),
                    "confidence_policy_status": calibration_payload.get("confidence_policy", {}).get("status"),
                }
                actual_pass = (
                    result_payload["sync_status"] == "SYNCED"
                    and result_payload["claim_count"] == 1
                    and result_payload["resolved_count"] == 1
                    and result_payload["manual_review_count"] == 0
                    and result_payload["resolved_claim_count"] == 1
                )
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "watchlist":
            manifests = case.get("manifests", [])
            overlays = case.get("overlay_values", [])
            outcomes = case.get("outcome_values", [])
            dossiers = case.get("dossier_values", [])
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("watchlist static eval requires at least two manifests")
            try:
                report_payload = build_validated_merged_report(
                    [root / str(path) for path in manifests],
                    [str(item) for item in overlays],
                    [str(item) for item in outcomes],
                    [str(item) for item in dossiers],
                )
                result_payload = build_watchlist(report_payload)
                errors = validate_watchlist(result_payload)
                actual_pass = not errors
                findings = errors
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "review_cycle":
            manifests = case.get("manifests", [])
            overlays = case.get("overlay_values", [])
            outcomes = case.get("outcome_values", [])
            dossiers = case.get("dossier_values", [])
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("review_cycle static eval requires at least two manifests")
            try:
                report_payload = build_validated_merged_report(
                    [root / str(path) for path in manifests],
                    [str(item) for item in overlays],
                    [str(item) for item in outcomes],
                    [str(item) for item in dossiers],
                )
                watchlist = build_watchlist(report_payload)
                result_payload = build_review_cycle(watchlist, due_before=str(case.get("due_before", "today")))
                errors = validate_review_cycle(result_payload)
                actual_pass = not errors
                findings = errors
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "review_outcome_application":
            manifests = case.get("manifests", [])
            overlays = case.get("overlay_values", [])
            outcomes = case.get("outcome_values", [])
            dossiers = case.get("dossier_values", [])
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("review_outcome_application static eval requires at least two manifests")
            try:
                report_payload = build_validated_merged_report(
                    [root / str(path) for path in manifests],
                    [str(item) for item in overlays],
                    [str(item) for item in outcomes],
                    [str(item) for item in dossiers],
                )
                watchlist = build_watchlist(report_payload)
                first_symbol: str = str(watchlist.get("items", [{}])[0].get("symbol") or "")
                outcome_payload: dict[str, Any] = {
                    "contract_type": "serenity_review_outcome",
                    "schema_version": "1.0",
                    "reviewed_at": "2026-07-03T00:00:00+00:00",
                    "source_watchlist_path": "/tmp/watchlist.json",
                    "outcomes": [
                        {
                            "symbol": first_symbol,
                            "horizon": "30d",
                            "judgment_delta": "UNCHANGED",
                            "action_delta": "HOLD_WATCH",
                            "checked_evidence": ["静态评测复盘证据。"],
                            "next_state": "WATCHLIST",
                            "next_review_date": "2026-08-02",
                            "notes": "保持观察。"
                        }
                    ]
                }
                outcome_errors: list[str] = validate_watch_review_outcome(outcome_payload)
                updated_watchlist: dict[str, Any] = apply_review_outcome(watchlist, outcome_payload)
                updated_watchlist_errors: list[str] = validate_watchlist(updated_watchlist)
                cycle_before_next: dict[str, Any] = build_review_cycle(updated_watchlist, due_before="2026-07-15")
                cycle_after_next: dict[str, Any] = build_review_cycle(updated_watchlist, due_before="2026-12-31")
                duplicate_outcome_payload: dict[str, Any] = json.loads(json.dumps(outcome_payload, ensure_ascii=False))
                duplicate_outcome_payload["outcomes"].append(dict(duplicate_outcome_payload["outcomes"][0]))
                duplicate_errors: list[str] = validate_watch_review_outcome(duplicate_outcome_payload)
                invalid_date_payload: dict[str, Any] = json.loads(json.dumps(outcome_payload, ensure_ascii=False))
                invalid_date_payload["outcomes"][0]["next_review_date"] = "not-a-date"
                invalid_date_errors: list[str] = validate_watch_review_outcome(invalid_date_payload)
                unknown_symbol_payload: dict[str, Any] = json.loads(json.dumps(outcome_payload, ensure_ascii=False))
                unknown_symbol_payload["outcomes"][0]["symbol"] = "999999.SH"
                unknown_symbol_rejected: bool = False
                try:
                    apply_review_outcome(watchlist, unknown_symbol_payload)
                except ValueError:
                    unknown_symbol_rejected = True
                result_payload = {
                    "outcome_errors": outcome_errors,
                    "updated_watchlist_errors": updated_watchlist_errors,
                    "history_count": len(updated_watchlist.get("items", [{}])[0].get("history", [])),
                    "reviewed_symbol_30d_due_before_next": any(
                        isinstance(item, Mapping)
                        and str(item.get("symbol") or "") == first_symbol
                        and str(item.get("horizon") or "") == "30d"
                        for item in cycle_before_next.get("due_items", [])
                    ),
                    "reviewed_symbol_30d_due_after_next": any(
                        isinstance(item, Mapping)
                        and str(item.get("symbol") or "") == first_symbol
                        and str(item.get("horizon") or "") == "30d"
                        for item in cycle_after_next.get("due_items", [])
                    ),
                    "duplicate_outcome_rejected": any("duplicates symbol+horizon" in error for error in duplicate_errors),
                    "invalid_date_rejected": any("next_review_date must be an ISO date" in error for error in invalid_date_errors),
                    "unknown_symbol_rejected": unknown_symbol_rejected,
                }
                actual_pass = (
                    not outcome_errors
                    and not updated_watchlist_errors
                    and result_payload["reviewed_symbol_30d_due_before_next"] is False
                    and result_payload["reviewed_symbol_30d_due_after_next"] is True
                    and result_payload["duplicate_outcome_rejected"] is True
                    and result_payload["invalid_date_rejected"] is True
                    and result_payload["unknown_symbol_rejected"] is True
                )
                findings = outcome_errors + updated_watchlist_errors + duplicate_errors + invalid_date_errors
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "delivery_proof":
            manifests = case.get("manifests", [])
            overlays = case.get("overlay_values", [])
            outcomes = case.get("outcome_values", [])
            dossiers = case.get("dossier_values", [])
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("delivery_proof static eval requires at least two manifests")
            try:
                with tempfile.TemporaryDirectory(prefix="serenity-static-proof-") as temp_dir:
                    report_payload = build_validated_merged_report(
                        [root / str(path) for path in manifests],
                        [str(item) for item in overlays],
                        [str(item) for item in outcomes],
                        [str(item) for item in dossiers],
                    )
                    report_path = Path(temp_dir) / "comparison_report.json"
                    report_path.write_text(json.dumps(report_payload, ensure_ascii=False, indent=2), encoding="utf-8")
                    result_payload = build_delivery_proof(report_path, python_executable=sys.executable)
                    verify_errors: list[str] = verify_delivery_proof(result_payload)
                errors = validate_delivery_proof(result_payload) + verify_errors
                actual_pass = not errors and bool(result_payload.get("all_passed"))
                findings = errors
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "delivery_proof_block":
            proof_payload: Any = case.get("payload", {})
            if not isinstance(proof_payload, Mapping):
                result_payload = {"ok": False, "errors": ["payload must be an object"]}
                findings = result_payload["errors"]
                actual_pass = False
            else:
                try:
                    block: str = render_proof_block(proof_payload)
                    result_payload = {"ok": True, "block_contains_proof_status": "proof_status" in block}
                    actual_pass = True
                except Exception as exc:
                    result_payload = {"ok": False, "error": f"{type(exc).__name__}: {exc}"}
                    findings = [result_payload["error"]]
                    actual_pass = False
        elif kind == "rendered_comparison_output_contract":
            manifests = case.get("manifests", [])
            overlays = case.get("overlay_values", [])
            outcomes = case.get("outcome_values", [])
            dossiers = case.get("dossier_values", [])
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("rendered_comparison_output_contract static eval requires at least two manifests")
            try:
                with tempfile.TemporaryDirectory(prefix="serenity-static-rendered-contract-") as temp_dir:
                    report_payload = build_validated_merged_report(
                        [root / str(path) for path in manifests],
                        [str(item) for item in overlays],
                        [str(item) for item in outcomes],
                        [str(item) for item in dossiers],
                    )
                    report_path = Path(temp_dir) / "comparison_report.json"
                    report_path.write_text(json.dumps(report_payload, ensure_ascii=False, indent=2), encoding="utf-8")
                    proof = build_delivery_proof(report_path, python_executable=sys.executable)
                    markdown = render_report(manifests=[], comparison_report=report_path, mode="full_research")
                    markdown_with_proof = markdown + "\n\n" + render_proof_block(proof)
                    proof_block_errors: list[str] = delivery_proof_block_errors(markdown_with_proof, proof)
                    result = validate_text(markdown_with_proof, require_delivery_proof=True)
                result_payload = result.extracted
                actual_pass = result.ok and not proof_block_errors
                findings = [f"{f.severity.upper()} {f.code}: {f.message}" for f in result.findings] + proof_block_errors
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "delivery_proof_visible_block_binding":
            manifests = case.get("manifests", [])
            overlays = case.get("overlay_values", [])
            outcomes = case.get("outcome_values", [])
            dossiers = case.get("dossier_values", [])
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("delivery_proof_visible_block_binding static eval requires at least two manifests")
            try:
                with tempfile.TemporaryDirectory(prefix="serenity-static-proof-binding-") as temp_dir:
                    report_payload = build_validated_merged_report(
                        [root / str(path) for path in manifests],
                        [str(item) for item in overlays],
                        [str(item) for item in outcomes],
                        [str(item) for item in dossiers],
                    )
                    report_path = Path(temp_dir) / "comparison_report.json"
                    report_path.write_text(json.dumps(report_payload, ensure_ascii=False, indent=2), encoding="utf-8")
                    proof = build_delivery_proof(report_path, python_executable=sys.executable)
                    markdown = render_report(manifests=[], comparison_report=report_path, mode="full_research")
                    block = render_proof_block(proof)
                    artifacts = proof.get("artifacts") if isinstance(proof.get("artifacts"), list) else []
                    first_sha = ""
                    for artifact in artifacts:
                        if isinstance(artifact, Mapping):
                            first_sha = str(artifact.get("sha256") or "")
                            if first_sha:
                                break
                    if not first_sha:
                        raise ValueError("proof fixture did not produce artifact sha256")
                    tampered_block = block.replace(first_sha, "0" * 64, 1)
                    errors = delivery_proof_block_errors(markdown + "\n\n" + tampered_block, proof)
                result_payload = {"ok": not errors, "error_count": len(errors)}
                actual_pass = not errors
                findings = errors
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "provider_health":
            attempts = case.get("attempts", [])
            if not isinstance(attempts, list):
                raise ValueError("provider_health static eval requires attempts array")
            try:
                with tempfile.TemporaryDirectory(prefix="serenity-static-provider-health-") as temp_dir:
                    temp_path = Path(temp_dir)
                    if bool(case.get("as_directory")):
                        manifest_path = temp_path / "case" / "manifest.json"
                        manifest_path.parent.mkdir(parents=True, exist_ok=True)
                        manifest_path.write_text(
                            json.dumps({"data_acquisition": {"attempt_ledger": attempts}}, ensure_ascii=False, indent=2),
                            encoding="utf-8",
                        )
                        ledger_path = manifest_path.parent / "attempt_ledger.json"
                        ledger_path.write_text(json.dumps(attempts, ensure_ascii=False, indent=2), encoding="utf-8")
                        result_payload = build_provider_health(temp_path)
                    else:
                        ledger_path = temp_path / "attempt_ledger.json"
                        ledger_path.write_text(json.dumps(attempts, ensure_ascii=False, indent=2), encoding="utf-8")
                        result_payload = build_provider_health(ledger_path)
                errors = validate_provider_health(result_payload)
                actual_pass = not errors
                findings = errors
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "manual_evidence_registration":
            manifest = case.get("manifest")
            if not isinstance(manifest, str):
                raise ValueError("manual_evidence_registration static eval requires manifest path")
            try:
                with tempfile.TemporaryDirectory(prefix="serenity-static-manual-evidence-") as temp_dir:
                    temp_root = Path(temp_dir)
                    evidence_path = temp_root / "manual_evidence.txt"
                    evidence_path.write_text(str(case.get("evidence_text", "official registered evidence")), encoding="utf-8")
                    manifest_payload = json.loads((root / manifest).read_text(encoding="utf-8"))
                    evidence = build_manual_evidence(
                        dataset=str(case.get("dataset", "filings_announcements")),
                        source_name=str(case.get("source_name", "ManualOfficialEvidence")),
                        source_level=str(case.get("source_level", "L0_OFFICIAL_DISCLOSURE")),
                        status=str(case.get("status", "OK")),
                        evidence_path=evidence_path,
                        claim_boundary=str(case.get("claim_boundary", "Manual official evidence closes the filing evidence gap.")),
                    )
                    errors = validate_manual_evidence(evidence)
                    result_payload = register_manual_evidence(manifest_payload, evidence, manifest_base=temp_root)
                errors.extend(validate_manual_evidence(evidence))
                actual_pass = not errors
                findings = errors
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "agent_behavior_case":
            case_path = case.get("case_file")
            if not isinstance(case_path, str):
                raise ValueError("agent_behavior_case static eval requires case_file")
            try:
                payload = json.loads((root / case_path).read_text(encoding="utf-8"))
                errors = validate_agent_behavior_case(payload)
                result_payload = {"ok": not errors, "errors": errors}
                actual_pass = not errors
                findings = errors
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "doctor":
            try:
                result_payload = build_doctor_report(skip_network=True)
                errors = validate_doctor_report(result_payload)
                actual_pass = not errors and result_payload.get("status") in {"PASS", "WARN"}
                findings = errors
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "chan_structure":
            rows = case.get("rows", [])
            if not isinstance(rows, list):
                raise ValueError("chan_structure static eval requires rows array")
            try:
                result_payload = detect_chan_structure([row for row in rows if isinstance(row, dict)])
                errors = validate_chan_structure(result_payload)
                actual_pass = not errors
                findings = errors
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "benchmark_case":
            benchmark_file: Any = case.get("benchmark_file")
            benchmark_payload: Mapping[str, Any]
            if benchmark_file:
                benchmark_payload = json.loads((root / str(benchmark_file)).read_text(encoding="utf-8"))
            else:
                benchmark_payload = case.get("payload", {})
            if not isinstance(benchmark_payload, dict):
                raise ValueError("benchmark_case static eval requires benchmark payload object")
            result_payload = run_benchmark_case(benchmark_payload)
            actual_pass = bool(result_payload.get("ok"))
            findings = [str(item) for item in result_payload.get("validation_errors", []) + result_payload.get("assertion_errors", [])]
        elif kind == "agent_research_queue_validation":
            payload = case.get("payload", {})
            if not isinstance(payload, dict):
                raise ValueError("agent_research_queue_validation static eval requires payload object")
            errors = validate_agent_research_queue(payload)
            result_payload = {"ok": not errors, "errors": errors}
            actual_pass = not errors
            findings = errors
        elif kind == "research_delivery_validation":
            payload = case.get("payload", {})
            source_path: str = str(case.get("source_path") or "")
            manifests = case.get("manifests", [])
            overlays: Any = case.get("overlay_values", [])
            outcomes: Any = case.get("outcome_values", [])
            dossiers: Any = case.get("dossier_values", [])
            if manifests:
                if not isinstance(manifests, list) or len(manifests) < 2:
                    raise ValueError("research_delivery_validation manifests must contain at least two items")
                if not isinstance(overlays, list) or not isinstance(outcomes, list) or not isinstance(dossiers, list):
                    raise ValueError("research_delivery_validation requires overlay_values, outcome_values, and dossier_values arrays with manifests")
                payload = build_validated_merged_report(
                    [root / str(path) for path in manifests],
                    [str(item) for item in overlays],
                    [str(item) for item in outcomes],
                    [str(item) for item in dossiers],
                )
            if not isinstance(payload, dict):
                raise ValueError("research_delivery_validation static eval requires payload object or manifests")
            errors = validate_delivery_payload(payload, source_path=source_path)
            result_payload = {"ok": not errors, "errors": errors}
            actual_pass = not errors
            findings = errors
        elif kind == "ai_review_packet":
            manifest = case.get("manifest")
            if not isinstance(manifest, str):
                raise ValueError("ai_review_packet static eval requires manifest path")
            try:
                result_payload = build_ai_review_packet(root / manifest)
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "ai_overlay_prompt":
            manifest = case.get("manifest")
            if not isinstance(manifest, str):
                raise ValueError("ai_overlay_prompt static eval requires manifest path")
            try:
                result_payload = build_ai_overlay_prompt(root / manifest)
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "ai_committee_packet":
            manifest: Any = case.get("manifest")
            if not isinstance(manifest, str):
                raise ValueError("ai_committee_packet static eval requires manifest path")
            try:
                packet: dict[str, Any] = build_ai_committee_packet(root / manifest)
                contract: Mapping[str, Any] = packet.get("overlay_output_contract") if isinstance(packet.get("overlay_output_contract"), Mapping) else {}
                allowed_fields: set[str] = {str(item) for item in contract.get("allowed_fields", []) if str(item)}
                required_outputs: set[str] = {str(item) for item in packet.get("required_overlay_outputs", []) if str(item)}
                committee_outputs: set[str] = {str(item) for item in packet.get("committee_review_outputs", []) if str(item)}
                result_payload = {
                    **packet,
                    "overlay_contract_ok": bool(required_outputs) and required_outputs <= allowed_fields,
                    "committee_outputs_are_separate": bool(committee_outputs) and not bool(committee_outputs & allowed_fields),
                }
                actual_pass = bool(result_payload["overlay_contract_ok"] and result_payload["committee_outputs_are_separate"])
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "ai_overlay_merge":
            manifests = case.get("manifests", [])
            overlays = case.get("overlays", {})
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("ai_overlay_merge static eval requires at least two manifests")
            if not isinstance(overlays, dict):
                raise ValueError("ai_overlay_merge static eval requires overlays object")
            try:
                result_payload = build_comparison_report(
                    [root / str(path) for path in manifests],
                    {str(symbol): overlay for symbol, overlay in overlays.items() if isinstance(overlay, dict)},
                )
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "research_debt_runbook":
            manifests = case.get("manifests", [])
            overlays = case.get("overlays", {})
            if not isinstance(manifests, list) or len(manifests) < 2:
                raise ValueError("research_debt_runbook static eval requires at least two manifests")
            if not isinstance(overlays, dict):
                raise ValueError("research_debt_runbook static eval requires overlays object when supplied")
            try:
                report_payload: dict[str, Any] = build_comparison_report(
                    [root / str(path) for path in manifests],
                    {str(symbol): overlay for symbol, overlay in overlays.items() if isinstance(overlay, dict)},
                )
                runbook: list[dict[str, Any]] = build_runbook_rows(report_payload)
                result_payload = {
                    "runbook": runbook,
                    "runbook_count": len(runbook),
                    "datasets": [str(item.get("dataset") or "") for item in runbook],
                }
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "financial_amount_normalization":
            amount: Any = normalize_financial_amount(case.get("value"), case.get("unit"))
            multiplier: float = financial_unit_multiplier(case.get("unit"))
            result_payload = {
                "amount": amount,
                "multiplier": multiplier,
            }
            actual_pass = amount is not None
        elif kind == "financial_currency_resolution":
            financial_payload: Any = case.get("financial", {})
            latest_annual_payload: Any = case.get("latest_annual", {})
            if not isinstance(financial_payload, dict) or not isinstance(latest_annual_payload, dict):
                raise ValueError("financial_currency_resolution static eval requires financial and latest_annual objects")
            result_payload = {
                "financial_currency": _financial_currency(financial_payload, latest_annual_payload),
            }
            actual_pass = True
        elif kind == "currency_normalization":
            valuation_payload: Any = case.get("valuation", {})
            financial_payload: Any = case.get("financial", {})
            if not isinstance(valuation_payload, dict) or not isinstance(financial_payload, dict):
                raise ValueError("currency_normalization static eval requires valuation and financial objects")
            result_payload = normalize_valuation_payload(
                symbol=str(case.get("symbol") or valuation_payload.get("symbol") or ""),
                valuation_payload=valuation_payload,
                financial_payload=financial_payload,
                allow_network=bool(case.get("allow_network", False)),
            )
            actual_pass = True
        elif kind == "growth_hypothesis_amount_basis":
            financial: Any = case.get("financial", {})
            valuation: Any = case.get("valuation", {})
            profile: Any = case.get("profile", {})
            if not isinstance(financial, dict) or not isinstance(valuation, dict) or not isinstance(profile, dict):
                raise ValueError("growth_hypothesis_amount_basis requires financial, valuation, and profile objects")
            with tempfile.TemporaryDirectory(prefix="serenity-static-growth-unit-") as temp_dir:
                temp_root: Path = Path(temp_dir)
                valuation_path: Path = temp_root / "valuation_inputs.json"
                valuation_path.write_text(json.dumps(valuation, ensure_ascii=False), encoding="utf-8")
                manifest: dict[str, Any] = {
                    "_manifest_path": str((temp_root / "manifest.json").resolve()),
                    "symbol": {
                        "symbol": str(case.get("symbol") or valuation.get("symbol") or "0700.HK"),
                        "market": str(case.get("market") or "HK"),
                        "currency": str(valuation.get("currency") or "HKD"),
                    },
                    "data_acquisition": {
                        "status_by_dataset": {
                            "valuation_inputs": "OK",
                        },
                    },
                    "results": [
                        {
                            "dataset": "valuation_inputs",
                            "status": "OK",
                            "source": str(valuation.get("source") or "Static_Valuation_L0L2"),
                            "source_level": str(valuation.get("source_level") or "L0L2_STATIC"),
                            "as_of_date": str(valuation.get("as_of_date") or ""),
                            "data_path": str(valuation_path),
                        }
                    ],
                }
                result_payload = _growth_hypothesis(manifest, financial, profile)
            actual_pass = True
        elif kind == "provider_chain":
            symbol: Any = SymbolInfo(
                input_value=str(case.get("symbol", "NVDA")),
                symbol=str(case.get("symbol", "NVDA")),
                market=Market(str(case.get("market", "US"))),
                exchange=str(case.get("exchange", "US")),
                currency=str(case.get("currency", "USD")),
            )
            provider_names: Any = [provider.name for provider in default_real_providers(symbol)]
            result_payload = {
                "providers": provider_names,
                "has_required_providers": all(
                    str(name) in provider_names for name in case.get("required_providers", [])
                ),
            }
            actual_pass = bool(result_payload["has_required_providers"])
            if not actual_pass:
                findings = [f"provider chain missing required providers; actual={provider_names}"]
        elif kind == "hk_issued_shares_extraction":
            extracted: Any = data_layer_module.HkexValuationInputsProvider._extract_issued_shares_from_text(str(case.get("text") or ""))
            result_payload = extracted or {}
            actual_pass = extracted is not None
        elif kind == "hk_financial_summary_extraction":
            pages: Any = case.get("pages", [])
            if not isinstance(pages, list):
                raise ValueError("hk_financial_summary_extraction static eval requires pages array")
            fields: Dict[str, float]
            evidence: Dict[str, Dict[str, Any]]
            period: Optional[str]
            fields, evidence, period = HkexFinancialReportsProvider._extract_hkex_financial_summary_fields(
                [page for page in pages if isinstance(page, dict)]
            )
            result_payload = {
                "period": period,
                "fields": fields,
                "evidence_keys": sorted(evidence),
            }
            actual_pass = bool(fields)
        elif kind == "hk_valuation_quote_fallback":
            symbol = SymbolInfo(
                input_value=str(case.get("symbol", "0700.HK")),
                symbol=str(case.get("symbol", "0700.HK")),
                market=Market.HK,
                exchange="HKEX",
                currency="HKD",
            )
            provider: Any = data_layer_module.HkexValuationInputsProvider()
            provider._lookup_listing = lambda code: {"stock_id": "700", "stock_code": "00700", "stock_name": "Tencent"}  # type: ignore[method-assign]
            provider._latest_share_count_reports = lambda stock_id: []  # type: ignore[method-assign]
            provider._latest_issued_shares_from_reports = lambda reports, **kwargs: None  # type: ignore[method-assign]
            original_yahoo_provider: Any = data_layer_module.YahooChartProvider
            use_cached_quote: Any = bool(case.get("use_cached_quote"))

            class StaticYahooProvider:
                name: Any = "Yahoo_Static_L2"
                level: Any = data_layer_module.SourceLevel.L2

                def __init__(self, *args: Any, **kwargs: Any) -> None:
                    self.name = str(kwargs.get("name") or self.name)

                def fetch(self, symbol: Any, dataset: Any, **kwargs: Any) -> Any:
                    if use_cached_quote:
                        raise RuntimeError("cached quote should be consumed without refetching Yahoo")
                    return data_layer_module.DataResult(
                        True,
                        dataset,
                        symbol.symbol,
                        self.name,
                        self.level,
                        data_layer_module.utc_now(),
                        as_of_date="2026-06-23",
                        data={
                            "symbol": symbol.symbol,
                            "name": "Tencent",
                            "currency": "HKD",
                            "exchange": "HKEX",
                            "regular_market_price": 100.0,
                            "regular_market_time": 1782144000,
                            "market_cap": 1000.0,
                        },
                        currency="HKD",
                    )

            try:
                data_layer_module.YahooChartProvider = StaticYahooProvider  # type: ignore[assignment]
                provider_kwargs: dict[str, Any] = {"raw_dir": None}
                if use_cached_quote:
                    provider_kwargs["current_quote_result"] = {
                        "data": {
                            "symbol": symbol.symbol,
                            "name": "Tencent",
                            "currency": "HKD",
                            "exchange": "HKEX",
                            "regular_market_price": 100.0,
                            "regular_market_time": 1782144000,
                            "market_cap": 1000.0,
                        },
                        "as_of_date": "2026-06-23",
                        "source_name": "Yahoo_Cached_L2",
                        "source_level": data_layer_module.SourceLevel.L2.value,
                        "currency": "HKD",
                    }
                result = provider.fetch(symbol, data_layer_module.Dataset.VALUATION_INPUTS, **provider_kwargs)
            finally:
                data_layer_module.YahooChartProvider = original_yahoo_provider  # type: ignore[assignment]
            result_payload = result.data if result.ok and isinstance(result.data, dict) else {"errors": result.errors}
            actual_pass = bool(result.ok)
        elif kind == "hk_announcements_targeted_fallback":
            symbol = SymbolInfo(
                input_value=str(case.get("symbol", "0700.HK")),
                symbol=str(case.get("symbol", "0700.HK")),
                market=Market.HK,
                exchange="HKEX",
                currency="HKD",
            )
            provider = data_layer_module.HkexAnnouncementsProvider()
            provider._lookup_listing = lambda code: {"stock_id": "700", "stock_code": "00700", "stock_name": "Tencent"}  # type: ignore[method-assign]

            def fake_query(*, stock_id: str, from_date: str, to_date: str, title: str = "", row_range: int = 100) -> dict[str, Any]:
                if not title:
                    raise RuntimeError("broad search unavailable")
                if title != "Annual Report":
                    return {"recordCnt": 0, "result": "[]"}
                return {
                    "recordCnt": 1,
                    "result": json.dumps([
                        {
                            "NEWS_ID": "static-hkex-annual",
                            "DATE_TIME": "26/08/2025 16:30",
                            "STOCK_CODE": "00700",
                            "STOCK_NAME": "TENCENT",
                            "TITLE": "ANNUAL REPORT 2025",
                            "LONG_TEXT": "Financial Statements/ESG Information - Annual Report",
                            "FILE_TYPE": "PDF",
                            "FILE_INFO": "PDF",
                            "FILE_LINK": "/listedco/listconews/sehk/2025/0826/static.pdf",
                        }
                    ]),
                }

            provider._query_title_search = fake_query  # type: ignore[method-assign]
            result = provider.fetch(symbol, data_layer_module.Dataset.FILINGS, raw_dir=None)
            result_payload = result.data if result.ok and isinstance(result.data, dict) else {"errors": result.errors}
            actual_pass = bool(result.ok)
        elif kind == "hk_report_download_selection":
            reports = [dict(item) for item in case.get("reports", []) if isinstance(item, dict)]
            selected = data_layer_module.HkexFinancialReportsProvider._select_reports_for_download(
                reports,
                int(case.get("limit", 1)),
            )
            result_payload = {
                "selected_count": len(selected),
                "selected_kinds": [str(item.get("report_kind") or "") for item in selected],
                "selected_titles": [str(item.get("title") or "") for item in selected],
            }
            actual_pass = bool(selected)
        elif kind == "provider_timeout_attempt":
            class SlowProvider:
                name: Any = "Static_Slow_Provider_L2"
                level: Any = data_layer_module.SourceLevel.L2
                markets: Any = [Market.US]
                datasets: Any = [data_layer_module.Dataset.CURRENT_QUOTE]

                def fetch(self, symbol: Any, dataset: Any, **kwargs: Any) -> Any:
                    time.sleep(float(case.get("sleep_seconds", 2)))
                    return data_layer_module.DataResult(
                        True,
                        dataset,
                        symbol.symbol,
                        self.name,
                        self.level,
                        data_layer_module.utc_now(),
                        data={"regular_market_price": 1.0},
                        currency=symbol.currency,
                    )

            symbol = SymbolInfo(
                input_value=str(case.get("symbol", "NVDA")),
                symbol=str(case.get("symbol", "NVDA")),
                market=Market.US,
                exchange="US",
                currency="USD",
            )
            attempts: Any
            result, attempts = _fetch_with_attempt_ledger(
                [SlowProvider()],
                symbol,
                data_layer_module.Dataset.CURRENT_QUOTE,
                provider_timeout_seconds=int(case.get("provider_timeout_seconds", 1)),
            )
            result_payload = {
                "result_ok": result.ok,
                "attempts": attempts,
                "first_gap_type": _get_path(attempts, "0.gap_type"),
                "first_reason": _get_path(attempts, "0.reason"),
            }
            actual_pass = (
                not result.ok
                and result_payload["first_gap_type"] == "ACCESS_FAILURE"
                and "exceeded" in str(result_payload["first_reason"]).lower()
            )
        elif kind == "sec_identity_match":
            symbol = SymbolInfo(
                input_value=str(case.get("symbol", "NVDA")),
                symbol=str(case.get("symbol", "NVDA")),
                market=Market.US,
                exchange="US",
                currency="USD",
            )
            result_payload = {
                "matches": _sec_submission_matches_symbol(symbol, {
                    "tickers": case.get("submission_tickers", []),
                }),
            }
            actual_pass = bool(result_payload["matches"]) == bool(case.get("expected_match"))
            if not actual_pass:
                findings = [f"SEC identity match result was {result_payload['matches']}"]
        elif kind == "sec_cik_candidate_recovery":
            original_bootstrap: Any = data_layer_module._sec_cik_from_bootstrap
            original_exchange: Any = data_layer_module._sec_cik_from_ticker_exchange_json
            original_company: Any = data_layer_module._sec_cik_from_company_tickers_json
            original_txt: Any = data_layer_module._sec_cik_from_ticker_txt
            original_submissions: Any = data_layer_module._fetch_sec_submissions_payload
            submission_tickers: Any = {
                f"{int(str(cik)):010d}": tickers
                for cik, tickers in dict(case.get("submission_tickers_by_cik", {})).items()
            }
            try:
                data_layer_module._sec_cik_from_bootstrap = lambda ticker: case.get("bootstrap_cik")
                data_layer_module._sec_cik_from_ticker_exchange_json = lambda ticker, *, user_agent: case.get("directory_cik")
                data_layer_module._sec_cik_from_company_tickers_json = lambda ticker, *, user_agent: None
                data_layer_module._sec_cik_from_ticker_txt = lambda ticker, *, user_agent: None

                def fake_submissions(cik: str, *, user_agent: str) -> dict[str, Any]:
                    return {"tickers": submission_tickers.get(f"{int(str(cik)):010d}", [])}

                data_layer_module._fetch_sec_submissions_payload = fake_submissions
                resolved: Any = data_layer_module._sec_cik_from_ticker(str(case.get("symbol", "NVDA")), user_agent="static-eval")
            finally:
                data_layer_module._sec_cik_from_bootstrap = original_bootstrap
                data_layer_module._sec_cik_from_ticker_exchange_json = original_exchange
                data_layer_module._sec_cik_from_company_tickers_json = original_company
                data_layer_module._sec_cik_from_ticker_txt = original_txt
                data_layer_module._fetch_sec_submissions_payload = original_submissions
            result_payload = {"resolved_cik": resolved}
            actual_pass = resolved == case.get("expected_cik")
            if not actual_pass:
                findings = [f"resolved CIK {resolved!r}, expected {case.get('expected_cik')!r}"]
        elif kind == "sec_shares_outstanding":
            companyfacts: Any = case.get("companyfacts", {})
            if not isinstance(companyfacts, dict):
                raise ValueError("sec_shares_outstanding static eval requires companyfacts object")
            share_fact: Any = data_layer_module._latest_sec_shares_outstanding(companyfacts)
            result_payload = share_fact if isinstance(share_fact, dict) else {}
            actual_pass = bool(share_fact)
        elif kind == "sec_financial_period_rows":
            companyfacts = case.get("companyfacts", {})
            if not isinstance(companyfacts, dict):
                raise ValueError("sec_financial_period_rows static eval requires companyfacts object")
            rows = data_layer_module._period_rows_from_sec_facts(companyfacts)
            result_payload = {
                "row_count": len(rows),
                "latest_row": rows[-1] if rows else {},
            }
            actual_pass = bool(rows)
        elif kind == "sec_ads_ratio_text":
            extracted = data_layer_module._extract_ads_ratio_from_text(str(case.get("text") or ""))
            result_payload = extracted if isinstance(extracted, dict) else {}
            actual_pass = bool(extracted)
        elif kind == "sec_ads_ratio_required":
            symbol = SymbolInfo(
                input_value=str(case.get("symbol", "ASML")),
                symbol=str(case.get("symbol", "ASML")),
                market=Market.US,
                exchange="US",
                currency="USD",
            )
            result_payload = {
                "required": data_layer_module._ads_ratio_required(symbol, {
                    "filings": {"recent": {"form": case.get("forms", [])}},
                    "tickers": case.get("submission_tickers", []),
                }),
            }
            actual_pass = bool(result_payload["required"]) == bool(case.get("expected_required"))
            if not actual_pass:
                findings = [f"ADS ratio required result was {result_payload['required']}"]
        elif kind == "tencent_valuation_fields":
            alias: Any = str(case.get("alias", "sh688322"))
            fields: Any = [""] * int(case.get("field_count", 88))
            for key, value in (case.get("fields", {}) if isinstance(case.get("fields"), dict) else {}).items():
                fields[int(key)] = str(value)
            provider = data_layer_module.TencentQuoteKlineProvider()
            payload = (f'v_{alias}="' + "~".join(fields) + '";').encode("gb18030")
            provider._read_bytes = lambda url: payload  # type: ignore[method-assign]
            symbol = SymbolInfo(
                input_value=str(case.get("symbol", "688322")),
                symbol=str(case.get("normalized_symbol", "688322.SH")),
                market=Market.CN_A,
                exchange="SSE",
                currency="CNY",
            )
            result = provider._fetch_valuation_inputs(symbol, data_layer_module.Dataset.VALUATION_INPUTS, alias, raw_dir=None)
            result_payload = result.data if result.ok and isinstance(result.data, dict) else {"errors": result.errors}
            actual_pass = bool(result.ok)
        elif kind == "orchestrator_route":
            try:
                route_value: Any = orchestrator_infer_route(
                    str(case.get("question", "")),
                    [str(item) for item in case.get("symbols", [])] if isinstance(case.get("symbols"), list) else [],
                    formal=bool(case.get("formal")),
                )
                result_payload = {"route": route_value, "strategy_hint": orchestrator_strategy_hint(str(case.get("question", "")))}
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "resolve_fetch_symbols":
            records: Any = case.get("records", [])
            if not isinstance(records, list):
                raise ValueError("resolve_fetch_symbols static eval requires records array")
            fetch_symbols: Any = sorted(_fetchable_price_symbols(records, str(case.get("due_before", "2099-12-31"))))
            result_payload = {"symbols": fetch_symbols}
            actual_pass = True
        elif kind == "calibration_policy_gate":
            payload_file = case.get("payload_file")
            payload = json.loads((root / str(payload_file)).read_text(encoding="utf-8")) if payload_file else case.get("payload", {})
            policy_payload: Any = case.get("policy") if isinstance(case.get("policy"), dict) else None
            try:
                result_payload = validate_overlay(payload, calibration_policy=policy_payload)
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "calibration_policy_build":
            report_payload: Any = case.get("report", {})
            if not isinstance(report_payload, dict):
                raise ValueError("calibration_policy_build static eval requires report object")
            result_payload = build_calibration_policy(report_payload)
            actual_pass = True
        elif kind == "market_snapshot_validation":
            payload = case.get("payload", {})
            if not isinstance(payload, dict):
                raise ValueError("market_snapshot_validation static eval requires payload object")
            errors = validate_market_snapshot(payload)
            result_payload = {"ok": not errors, "errors": errors}
            actual_pass = not errors
            findings = errors
        elif kind == "watchlist_previous_merge":
            watchlist_payload: Any = case.get("watchlist", {})
            previous_payload: Any = case.get("previous", {})
            if not isinstance(watchlist_payload, dict) or not isinstance(previous_payload, dict):
                raise ValueError("watchlist_previous_merge static eval requires watchlist and previous objects")
            result_payload = merge_previous_watchlist(json.loads(json.dumps(watchlist_payload)), previous_payload)
            actual_pass = True
        elif kind == "portfolio_holdings_csv":
            csv_text: Any = case.get("csv")
            if not isinstance(csv_text, str):
                raise ValueError("portfolio_holdings_csv static eval requires csv text")
            try:
                with tempfile.TemporaryDirectory(prefix="serenity-static-holdings-") as temp_dir:
                    csv_path: Path = Path(temp_dir) / "holdings.csv"
                    csv_path.write_text(csv_text, encoding="utf-8")
                    holdings_rows: Any = _read_holdings(csv_path)
                result_payload = {"rows": holdings_rows, "row_count": len(holdings_rows)}
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "proof_rerun_allowlist":
            proof_payload: Any = case.get("proof", {})
            if not isinstance(proof_payload, dict):
                raise ValueError("proof_rerun_allowlist static eval requires proof object")
            errors = rerun_proof_validators(proof_payload)
            result_payload = {"ok": not errors, "errors": errors}
            actual_pass = not errors
            findings = errors
        elif kind == "decision_brief_actions":
            queue_args: Any = case.get("inputs", {})
            if not isinstance(queue_args, dict):
                raise ValueError("decision_brief_actions static eval requires inputs object")
            actions_result: Any = build_action_queue(
                due_items=queue_args.get("due_items", []),
                resolvable_claims=queue_args.get("resolvable_claims", []),
                manual_claims=queue_args.get("manual_claims", []),
                watch_rows=queue_args.get("watch_rows", []),
                incomplete_runs=queue_args.get("incomplete_runs", []),
                orphan_deliveries=queue_args.get("orphan_deliveries", []),
                calibration_summary=queue_args.get("calibration_summary", {}),
                regime_status=str(queue_args.get("regime_status", "NOT_MEASURED")),
                has_watchlist=bool(queue_args.get("has_watchlist")),
                state_watchlist_path=str(queue_args.get("state_watchlist_path", "state/watchlist.json")),
            )
            result_payload = {"actions": actions_result, "kinds": [row.get("kind") for row in actions_result]}
            actual_pass = True
        elif kind == "decision_brief_contract":
            brief_payload: Any = case.get("brief", {})
            if not isinstance(brief_payload, dict):
                raise ValueError("decision_brief_contract static eval requires brief object")
            errors = validate_decision_brief(brief_payload)
            result_payload = {"ok": not errors, "errors": errors}
            actual_pass = not errors
            findings = errors
        elif kind == "scorecard_watchlist_item":
            scorecard_payload: Any = case.get("scorecard", {})
            if not isinstance(scorecard_payload, dict):
                raise ValueError("scorecard_watchlist_item static eval requires scorecard object")
            try:
                result_payload = scorecard_to_watchlist_item(scorecard_payload)
                actual_pass = True
            except Exception as exc:
                actual_pass = False
                findings = [f"{type(exc).__name__}: {exc}"]
        elif kind == "volume_heat":
            heat_rows: Any = case.get("rows", [])
            if not isinstance(heat_rows, list):
                raise ValueError("volume_heat static eval requires rows array")
            result_payload = volume_heat(heat_rows)
            actual_pass = result_payload.get("status") == "OK"
            findings = [] if actual_pass else [str(result_payload.get("note"))]
        elif kind == "decision_scoreboard":
            entries: Any = case.get("entries", [])
            prices: Any = case.get("current_prices", {})
            if not isinstance(entries, list) or not isinstance(prices, dict):
                raise ValueError("decision_scoreboard static eval requires entries array and current_prices object")
            result_payload = {"rows": decision_scoreboard_rows(entries, prices, limit=int(case.get("limit", 10)))}
            actual_pass = True
        elif kind == "portfolio_analytics":
            result_payload = portfolio_analytics(
                case.get("portfolio") if isinstance(case.get("portfolio"), dict) else None,
                case.get("position_changes", {}) if isinstance(case.get("position_changes"), dict) else {},
                case.get("benchmark_day_pct"),
            )
            actual_pass = True
        elif kind == "decision_counsel_validation":
            counsel_payload: Any = case.get("counsel", {})
            brief_payload: Any = case.get("brief") if isinstance(case.get("brief"), dict) else None
            if not isinstance(counsel_payload, dict):
                raise ValueError("decision_counsel_validation static eval requires counsel object")
            errors = validate_decision_counsel(counsel_payload, brief=brief_payload)
            result_payload = {"ok": not errors, "errors": errors}
            actual_pass = not errors
            findings = errors
        else:
            raise ValueError(f"unknown static eval kind: {kind}")

        expected_result: Any = case.get("expected_result", {})
        expected_contains: Any = case.get("expected_contains", [])
        result_matches: Any = all(_get_path(result_payload, k) == v for k, v in expected_result.items())
        contains_matches: Any = True
        if actual_pass and expected_contains:
            if not isinstance(expected_contains, list):
                raise ValueError("expected_contains must be an array")
            contains_matches = all(
                isinstance(item, dict)
                and isinstance(item.get("value"), dict)
                and _contains_mapping(result_payload, str(item.get("path")), item["value"])
                for item in expected_contains
            )
        passed: Any = actual_pass == expect_pass and (not actual_pass or (result_matches and contains_matches))
        marker: Any = "PASS" if passed else "FAIL"
        print(f"[{marker}] {name}: expected {'pass' if expect_pass else 'fail'}, got {'pass' if actual_pass else 'fail'}")
        if not passed:
            failures += 1
            if expected_result and actual_pass and not result_matches:
                print(f"  - expected result fields: {expected_result}")
                print(f"  - actual result fields: {result_payload}")
            if expected_contains and actual_pass and not contains_matches:
                print(f"  - expected contained fields: {expected_contains}")
                print(f"  - actual result fields: {result_payload}")
            for finding in findings:
                print(f"  - {finding}")

    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
