#!/usr/bin/env python3
"""Build the daily decision brief: multi-dimensional reality -> next actions.

This is the decision-support surface of the skill. It aggregates every piece
of objective state the system already tracks — live market regime, portfolio
context, watchlist with live prices, due reviews, machine-resolvable claims,
calibration, unfinished research runs, deliveries that never entered tracking
— and synthesizes a prioritized, executable action queue.

It never mutates decision state: claim resolution is previewed with a dry
run and the ledger/watchlist are read-only. Its only writes are its own
outputs, including `state/last_brief.json` so `serenity decide` can reference
briefed actions by number. Executing an action always happens through the
command printed next to it.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

CONTRACT_TYPE: str = "serenity_decision_brief"
SCHEMA_VERSION: str = "1.0"
INCOMPLETE_RUN_STATUSES: set[str] = {"AGENT_RESEARCH_REQUIRED", "SINGLE_MEMO_WORKSPACE_READY"}


def _text(value: Any) -> str:
    return str(value or "").strip()


def _as_list(value: Any) -> list[Any]:
    return value if isinstance(value, list) else []


def _as_mapping(value: Any) -> Mapping[str, Any]:
    return value if isinstance(value, Mapping) else {}


def _load_json(path: Path) -> Mapping[str, Any]:
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def cache_base() -> Path:
    override: Optional[str] = os.getenv("SERENITY_DATA_DIR")
    return Path(override).expanduser() if override else Path.home() / ".cache" / "serenity-chan"


def state_dir() -> Path:
    override: Optional[str] = os.getenv("SERENITY_STATE_DIR")
    return Path(override).expanduser() if override else cache_base() / "state"


def find_incomplete_runs(runs_dir: Path) -> list[dict[str, str]]:
    """Runs whose pipeline ledger says the AI handoff was never finished."""
    incomplete: list[dict[str, str]] = []
    if not runs_dir.is_dir():
        return incomplete
    for ledger_path in sorted(runs_dir.glob("*/pipeline_ledger.json")):
        try:
            ledger: Mapping[str, Any] = _load_json(ledger_path)
        except Exception:
            continue
        status: str = _text(ledger.get("status"))
        if status in INCOMPLETE_RUN_STATUSES:
            incomplete.append({
                "run_dir": str(ledger_path.parent),
                "status": status,
                "label": _text(ledger.get("label")),
                "next_action": _text(ledger.get("next_action")),
            })
    return incomplete


def find_orphan_deliveries(runs_dir: Path, watchlist_symbols: Sequence[str]) -> list[dict[str, str]]:
    """Formal deliveries whose candidates never entered the tracked watchlist."""
    tracked: set[str] = {_text(symbol).upper() for symbol in watchlist_symbols if _text(symbol)}
    orphans: list[dict[str, str]] = []
    if not runs_dir.is_dir():
        return orphans
    for ledger_path in sorted(runs_dir.glob("*/pipeline_ledger.json")):
        try:
            ledger = _load_json(ledger_path)
        except Exception:
            continue
        if _text(ledger.get("status")) != "FORMAL_DELIVERED":
            continue
        report_path: Path = ledger_path.parent / "comparison_final.json"
        if not report_path.exists():
            continue
        try:
            report: Mapping[str, Any] = _load_json(report_path)
        except Exception:
            continue
        symbols: list[str] = [
            _text(row.get("symbol")).upper()
            for row in _as_list(report.get("candidates"))
            if isinstance(row, Mapping) and _text(row.get("symbol"))
        ]
        missing: list[str] = sorted(symbol for symbol in symbols if symbol and symbol not in tracked)
        if missing:
            orphans.append({
                "run_dir": str(ledger_path.parent),
                "report": str(report_path),
                "untracked_symbols": ", ".join(missing),
            })
    return orphans


def build_action_queue(
    *,
    due_items: Sequence[Mapping[str, Any]],
    resolvable_claims: Sequence[Mapping[str, Any]],
    manual_claims: Sequence[Mapping[str, Any]],
    watch_rows: Sequence[Mapping[str, Any]],
    incomplete_runs: Sequence[Mapping[str, str]],
    orphan_deliveries: Sequence[Mapping[str, str]],
    calibration_summary: Mapping[str, Any],
    regime_status: str,
    has_watchlist: bool,
    state_watchlist_path: str,
) -> list[dict[str, Any]]:
    """Synthesize the prioritized next-action queue.

    Priority order encodes decision logic: settle what is already due, bank
    the free information (auto-resolvable claims), re-check conditions that
    prices may have met, finish research that is already paid for, track
    finished research, and only then start something new.
    """
    queue: list[dict[str, Any]] = []
    regime_note: str = ""
    if regime_status == "RISK_OFF":
        regime_note = "市场环境偏弱：升级/建仓类动作需要更强证据，优先降级与退出条件。"
    elif regime_status == "MIXED":
        regime_note = "市场环境分化：优先相对强弱与失效条件，避免一致性行动假设。"

    for item in due_items:
        symbol: str = _text(item.get("symbol"))
        queue.append({
            "priority": 1,
            "kind": "DUE_REVIEW",
            "symbol": symbol,
            "title": f"{symbol} 的 {_text(item.get('horizon'))} 复盘已到期（{_text(item.get('due_date'))}）",
            "detail": "; ".join(str(task) for task in _as_list(item.get("review_tasks"))[:3]),
            "command": (
                f"python scripts/serenity.py review --watchlist {state_watchlist_path} "
                f"--apply <review_outcome.json>"
            ),
        })
    for claim in resolvable_claims:
        queue.append({
            "priority": 2,
            "kind": "RESOLVABLE_CLAIM",
            "symbol": "",
            "title": f"预测 {_text(claim.get('forecast_id'))}/{_text(claim.get('id'))} 可自动结算：{_text(claim.get('evidence'))}",
            "detail": "干跑预览结果，执行 review --fetch 正式入账并更新校准。",
            "command": "python scripts/serenity.py review --fetch",
        })
    for row in watch_rows:
        for hit in _as_list(row.get("condition_hits")):
            hit_row: Mapping[str, Any] = _as_mapping(hit)
            queue.append({
                "priority": 3,
                "kind": "CONDITION_HIT",
                "symbol": _text(row.get("symbol")),
                "title": (
                    f"{_text(row.get('symbol'))} 的{'升级' if hit_row.get('kind') == 'upgrade' else '降级'}条件已命中："
                    f"{_text(hit_row.get('description'))}（{_text(hit_row.get('evidence'))}）"
                ),
                "detail": (regime_note + " " if regime_note else "") + "机器判定命中；请复核后用 review --apply 记录状态变化。",
                "command": f"python scripts/serenity.py review --watchlist {state_watchlist_path} --apply <review_outcome.json>",
            })
    for claim in manual_claims:
        queue.append({
            "priority": 4,
            "kind": "MANUAL_CLAIM",
            "symbol": "",
            "title": f"预测 {_text(claim.get('forecast_id'))}/{_text(claim.get('claim_id'))} 到期需人工结算",
            "detail": _text(claim.get("reason")),
            "command": "python companion-skills/laplace-forecast/scripts/forecast_ledger.py resolve --path <ledger> --id <forecast_id> --resolution-file <resolution.json>",
        })
    for row in watch_rows:
        if not row.get("condition_check_suggested") or _as_list(row.get("condition_hits")):
            continue
        heat: Mapping[str, Any] = _as_mapping(row.get("volume_heat"))
        heat_note: str = f"；量能 {heat.get('heat_state')}（20日量比 {heat.get('vol_ratio_20d')}）" if heat.get("status") == "OK" else ""
        title: str = (
            f"{_text(row.get('symbol'))} 现价 {row.get('current_price')}"
            f"（日内 {row.get('change_pct')}%{heat_note}）：对照其升级/降级条件复核"
        )
        queue.append({
            "priority": 5,
            "kind": "CONDITION_CHECK",
            "symbol": _text(row.get("symbol")),
            "title": title,
            "detail": (regime_note + " " if regime_note else "") + "; ".join(
                str(cond) for cond in _as_list(row.get("upgrade_conditions"))[:2]
            ),
            "command": f"python scripts/serenity.py ask \"复核\" --symbols {_text(row.get('symbol'))}",
        })
    for run in incomplete_runs:
        queue.append({
            "priority": 6,
            "kind": "UNFINISHED_RESEARCH",
            "symbol": "",
            "title": f"未完成研究：{_text(run.get('label'))}（{_text(run.get('status'))}）",
            "detail": _text(run.get("next_action")),
            "command": f"python scripts/serenity.py continue {_text(run.get('run_dir'))}"
            if run.get("status") == "AGENT_RESEARCH_REQUIRED"
            else _text(run.get("next_action")),
        })
    for orphan in orphan_deliveries:
        queue.append({
            "priority": 7,
            "kind": "UNTRACKED_DELIVERY",
            "symbol": "",
            "title": f"正式交付未进入跟踪：{_text(orphan.get('untracked_symbols'))}",
            "detail": "研究结论若不进观察名单，复盘与校准都不会发生。",
            "command": f"python scripts/update_watchlist_from_report.py {_text(orphan.get('report'))} --state",
        })
    resolved_count: Any = calibration_summary.get("resolved_claim_count")
    if isinstance(resolved_count, int) and resolved_count < 5:
        queue.append({
            "priority": 8,
            "kind": "CALIBRATION_SAMPLE",
            "symbol": "",
            "title": f"校准样本不足（已结算 {resolved_count} 条）：证据门槛还不能由历史误差定价",
            "detail": "每次策略判断至少写入 1-2 条带 resolution_probe 的可检验 claim。",
            "command": "",
        })
    if not has_watchlist and not queue:
        queue.append({
            "priority": 9,
            "kind": "START_RESEARCH",
            "symbol": "",
            "title": "当前没有任何跟踪状态：从一个问题开始建立观察名单",
            "detail": "研究→正式对比→update_watchlist --state 之后，决策简报才有内容可看。",
            "command": "python scripts/serenity.py ask \"<你的问题>\" [--symbols ...]",
        })
    queue.sort(key=lambda row: row["priority"])
    return queue


def portfolio_analytics(
    portfolio: Optional[Mapping[str, Any]],
    position_changes: Mapping[str, Any],
    benchmark_day_pct: Optional[float],
) -> dict[str, Any]:
    """Portfolio day move vs benchmark plus concentration flags.

    Day move is the weight-summed position change with cash contributing
    zero; positions without a live quote are excluded and reported so the
    number is never silently wrong."""
    base: dict[str, Any] = {
        "provided": bool(portfolio),
        "position_count": len(_as_list(_as_mapping(portfolio).get("positions"))),
        "cash_pct": _as_mapping(_as_mapping(portfolio).get("constraints")).get("cash_pct"),
        "top_positions": [
            {"symbol": _text(row.get("symbol")), "weight_pct": row.get("weight_pct")}
            for row in _as_list(_as_mapping(portfolio).get("positions"))[:3]
            if isinstance(row, Mapping)
        ],
        "day_pct": None,
        "benchmark_day_pct": benchmark_day_pct,
        "excess_day_pct": None,
        "unpriced_positions": [],
        "concentration_flags": [],
    }
    if not portfolio:
        return base
    weighted: float = 0.0
    covered_weight: float = 0.0
    unpriced: list[str] = []
    max_cap: Any = _as_mapping(_as_mapping(portfolio).get("constraints")).get("max_single_position_pct")
    cap: float = float(max_cap) if isinstance(max_cap, (int, float)) and max_cap else 30.0
    for row in _as_list(_as_mapping(portfolio).get("positions")):
        item: Mapping[str, Any] = _as_mapping(row)
        symbol: str = _text(item.get("symbol"))
        weight: Any = item.get("weight_pct")
        if not symbol or not isinstance(weight, (int, float)):
            continue
        if float(weight) > cap:
            base["concentration_flags"].append(
                f"{symbol} 权重 {weight}% 超过单仓上限 {cap}%"
            )
        change: Any = position_changes.get(symbol)
        if isinstance(change, (int, float)):
            weighted += float(weight) / 100.0 * float(change)
            covered_weight += float(weight)
        else:
            unpriced.append(symbol)
    if covered_weight > 0:
        base["day_pct"] = round(weighted, 2)
        if isinstance(benchmark_day_pct, (int, float)):
            base["excess_day_pct"] = round(weighted - float(benchmark_day_pct), 2)
    base["unpriced_positions"] = unpriced
    return base


def build_decision_brief(
    *,
    generated_at: str,
    regime: Optional[Mapping[str, Any]],
    portfolio: Optional[Mapping[str, Any]],
    watch_rows: Sequence[Mapping[str, Any]],
    quote_failures: Sequence[Mapping[str, str]],
    due_items: Sequence[Mapping[str, Any]],
    resolvable_claims: Sequence[Mapping[str, Any]],
    manual_claims: Sequence[Mapping[str, Any]],
    calibration_summary: Mapping[str, Any],
    incomplete_runs: Sequence[Mapping[str, str]],
    orphan_deliveries: Sequence[Mapping[str, str]],
    state_watchlist_path: str,
    notes: Sequence[str] = (),
    position_changes: Optional[Mapping[str, Any]] = None,
    benchmark_day_pct: Optional[float] = None,
    decision_scoreboard: Sequence[Mapping[str, Any]] = (),
) -> dict[str, Any]:
    regime_summary: Mapping[str, Any] = _as_mapping(_as_mapping(regime).get("summary"))
    regime_status: str = _text(regime_summary.get("regime_status")) or "NOT_MEASURED"
    actions: list[dict[str, Any]] = build_action_queue(
        due_items=due_items,
        resolvable_claims=resolvable_claims,
        manual_claims=manual_claims,
        watch_rows=watch_rows,
        incomplete_runs=incomplete_runs,
        orphan_deliveries=orphan_deliveries,
        calibration_summary=calibration_summary,
        regime_status=regime_status,
        has_watchlist=bool(watch_rows),
        state_watchlist_path=state_watchlist_path,
    )
    return {
        "contract_type": CONTRACT_TYPE,
        "schema_version": SCHEMA_VERSION,
        "generated_at": generated_at,
        "market_regime": {
            "status": regime_status,
            "decision_boundary": _text(_as_mapping(regime).get("decision_boundary"))
            or "市场环境未测量；不能把宏观/指数环境当作支持行动的证据。",
            "benchmarks": [
                {
                    "name": _text(row.get("name")),
                    "trend_state": _text(_as_mapping(row.get("technical_health")).get("trend_state")),
                    "latest_close": _as_mapping(row.get("technical_health")).get("latest_close"),
                }
                for row in _as_list(_as_mapping(regime).get("benchmarks"))
                if isinstance(row, Mapping)
            ],
        },
        "portfolio": portfolio_analytics(portfolio, dict(position_changes or {}), benchmark_day_pct),
        "watchlist": {
            "tracked_count": len(watch_rows),
            "rows": list(watch_rows),
            "quote_failures": list(quote_failures),
        },
        "review": {
            "due_count": len(due_items),
            "due_items": list(due_items),
        },
        "claims": {
            "resolvable_count": len(resolvable_claims),
            "manual_count": len(manual_claims),
        },
        "calibration": dict(calibration_summary),
        "research_state": {
            "incomplete_runs": list(incomplete_runs),
            "untracked_deliveries": list(orphan_deliveries),
        },
        "decisions": {
            "scoreboard": list(decision_scoreboard),
        },
        "notes": [str(note) for note in notes if _text(note)],
        "actions": actions,
    }


def render_brief_markdown(brief: Mapping[str, Any]) -> str:
    regime: Mapping[str, Any] = _as_mapping(brief.get("market_regime"))
    portfolio: Mapping[str, Any] = _as_mapping(brief.get("portfolio"))
    watchlist: Mapping[str, Any] = _as_mapping(brief.get("watchlist"))
    calibration: Mapping[str, Any] = _as_mapping(brief.get("calibration"))
    lines: list[str] = [
        "# 决策简报",
        "",
        f"- 生成时间：{_text(brief.get('generated_at'))[:19]}",
        f"- 市场环境：**{_text(regime.get('status'))}** — {_text(regime.get('decision_boundary'))}",
    ]
    benchmarks: list[Any] = _as_list(regime.get("benchmarks"))
    if benchmarks:
        parts: list[str] = [
            f"{_text(row.get('name'))} {_text(row.get('trend_state'))}"
            for row in benchmarks
            if isinstance(row, Mapping)
        ]
        lines.append(f"- 基准：{'；'.join(parts)}")
    if portfolio.get("provided"):
        tops: str = "、".join(
            f"{_text(row.get('symbol'))} {row.get('weight_pct')}%"
            for row in _as_list(portfolio.get("top_positions"))
            if isinstance(row, Mapping)
        )
        perf: str = ""
        if portfolio.get("day_pct") is not None:
            perf = f"；组合日内 {portfolio.get('day_pct')}%"
            if portfolio.get("excess_day_pct") is not None:
                perf += f"（对基准超额 {portfolio.get('excess_day_pct')}%）"
        lines.append(f"- 组合：{portfolio.get('position_count')} 个持仓，现金 {portfolio.get('cash_pct')}%；前三仓 {tops}{perf}")
        for flag in _as_list(portfolio.get("concentration_flags")):
            lines.append(f"- ⚠ 集中度：{flag}")
        unpriced: list[Any] = _as_list(portfolio.get("unpriced_positions"))
        if unpriced:
            lines.append(f"- 组合日内数据不含未取到现价的持仓：{'、'.join(str(sym) for sym in unpriced)}")
    else:
        lines.append("- 组合：未提供持仓上下文——本简报不包含任何加减仓建议。")
    resolved: Any = calibration.get("resolved_claim_count")
    brier: Any = calibration.get("avg_final_brier")
    lines.append(f"- 校准：已结算 {resolved if resolved is not None else 0} 条 claim，avg Brier {brier if brier is not None else '—'}")
    lines.append("")
    rows: list[Any] = _as_list(watchlist.get("rows"))
    if rows:
        lines.extend([
            "## 观察名单现状",
            "| 标的 | 状态 | 现价 | 日内% | 量能 | 条件命中 | 上次复盘 | 升级条件（首条） |",
            "|---|---|---:|---:|---|---|---|---|",
        ])
        for row in rows:
            item: Mapping[str, Any] = _as_mapping(row)
            first_condition: str = ""
            conditions: list[Any] = _as_list(item.get("upgrade_conditions"))
            if conditions:
                first_condition = str(conditions[0])[:40]
            heat: Mapping[str, Any] = _as_mapping(item.get("volume_heat"))
            heat_cell: str = _text(heat.get("heat_state")) if heat.get("status") == "OK" else "—"
            hit_count: int = len(_as_list(item.get("condition_hits")))
            probe_count: int = hit_count + len(_as_list(item.get("condition_misses")))
            hit_cell: str = f"{hit_count}/{probe_count}" if probe_count else "未配置"
            lines.append(
                "| {symbol} | {state} | {price} | {chg} | {heat} | {hits} | {reviewed} | {cond} |".format(
                    symbol=_text(item.get("symbol")),
                    state=_text(item.get("watch_state")),
                    price=item.get("current_price", "—"),
                    chg=item.get("change_pct", "—"),
                    heat=heat_cell,
                    hits=hit_cell,
                    reviewed=_text(item.get("last_reviewed_at"))[:10] or "从未",
                    cond=first_condition.replace("|", "\\|") or "—",
                )
            )
        lines.append("")
    scoreboard: list[Any] = _as_list(_as_mapping(brief.get("decisions")).get("scoreboard"))
    if scoreboard:
        lines.extend([
            "## 决策成绩单（最近记录）",
            "| 日期 | 决定 | 类型 | 标的 | 决策时价 | 现价 | 此后% | 备注 |",
            "|---|---|---|---|---:|---:|---:|---|",
        ])
        for row in scoreboard:
            item = _as_mapping(row)
            lines.append(
                "| {d} | {dec} | {kind} | {sym} | {p0} | {p1} | {pct} | {note} |".format(
                    d=_text(item.get("decided_at")) or "—",
                    dec=_text(item.get("decision")),
                    kind=_text(item.get("action_kind")),
                    sym=_text(item.get("symbol")) or "—",
                    p0=item.get("price_at_decision") if item.get("price_at_decision") is not None else "—",
                    p1=item.get("current_price") if item.get("current_price") is not None else "—",
                    pct=item.get("since_pct") if item.get("since_pct") is not None else "—",
                    note=_text(item.get("note")).replace("|", "\\|") or "—",
                )
            )
        lines.extend(["", "> 此后% 只陈述价格事实，不评判决策对错；跳过的动作涨了不代表当时该做，反之亦然——结合当时的证据边界读。", ""])
    actions: list[Any] = _as_list(brief.get("actions"))
    lines.append("## 下一步动作（按优先级）")
    if not actions:
        lines.append("- 无待办：状态干净。可以发起新研究，或等待触发器。")
    for index, action in enumerate(actions, start=1):
        item = _as_mapping(action)
        lines.append(f"{index}. **[{_text(item.get('kind'))}]** {_text(item.get('title'))}")
        if _text(item.get("detail")):
            lines.append(f"   - {_text(item.get('detail'))}")
        if _text(item.get("command")):
            lines.append(f"   - 执行：`{_text(item.get('command'))}`")
    notes: list[Any] = _as_list(brief.get("notes"))
    if notes:
        lines.extend(["", "## 数据说明"])
        lines.extend(f"- {note}" for note in notes)
    lines.extend([
        "",
        "> 本简报只读、无副作用：结算/写回均通过所列命令执行。它呈现客观状态与待办，不构成投资建议。",
    ])
    return "\n".join(lines)


def validate_decision_brief(payload: Mapping[str, Any]) -> list[str]:
    errors: list[str] = []
    if payload.get("contract_type") != CONTRACT_TYPE:
        errors.append(f"contract_type must be {CONTRACT_TYPE}")
    if payload.get("schema_version") != SCHEMA_VERSION:
        errors.append(f"schema_version must be {SCHEMA_VERSION}")
    if not _text(payload.get("generated_at")):
        errors.append("generated_at must not be empty")
    actions: Any = payload.get("actions")
    if not isinstance(actions, list):
        errors.append("actions must be an array")
    else:
        last_priority: int = 0
        for index, action in enumerate(actions):
            row: Mapping[str, Any] = _as_mapping(action)
            priority: Any = row.get("priority")
            if not isinstance(priority, int) or priority < 1:
                errors.append(f"actions[{index}].priority must be a positive integer")
                continue
            if priority < last_priority:
                errors.append("actions must be sorted by priority")
            last_priority = priority
            for key in ["kind", "title"]:
                if not _text(row.get(key)):
                    errors.append(f"actions[{index}].{key} must not be empty")
    for key in ["market_regime", "watchlist", "review", "claims", "research_state"]:
        if not isinstance(payload.get(key), Mapping):
            errors.append(f"{key} must be an object")
    return errors


def evaluate_condition_probes(
    item: Mapping[str, Any],
    *,
    symbol: str,
    current_price: Any,
    evaluate_probe,
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    """Machine-check structured watch conditions against the live quote.

    Probes reuse the resolution-probe grammar; a probe without a symbol
    defaults to the watch item's own symbol. Unresolvable probes are
    reported as UNRESOLVED rather than silently dropped.
    """
    hits: list[dict[str, Any]] = []
    snapshot: dict[str, Any] = {}
    if isinstance(current_price, (int, float)):
        snapshot = {"prices": {symbol: {"current_price": float(current_price)}}}
    for raw in _as_list(item.get("condition_probes")):
        probe_row: Mapping[str, Any] = _as_mapping(raw)
        probe: dict[str, Any] = dict(_as_mapping(probe_row.get("probe")))
        if not probe:
            continue
        probe.setdefault("symbol", symbol)
        outcome, evidence = evaluate_probe(probe, snapshot)
        hits.append({
            "kind": _text(probe_row.get("kind")) or "upgrade",
            "description": _text(probe_row.get("description")),
            "outcome": outcome,
            "evidence": evidence,
        })
    return [hit for hit in hits if hit["outcome"] is True], [hit for hit in hits if hit["outcome"] is not True]


def _gather_watch_rows(watchlist: Mapping[str, Any], *, fetch_quotes: bool) -> tuple[list[dict[str, Any]], list[dict[str, str]]]:
    rows: list[dict[str, Any]] = []
    failures: list[dict[str, str]] = []
    fetch_current_price = None
    fetch_daily_rows = None
    volume_heat = None
    evaluate_probe = None
    try:
        from resolve_due_claims import evaluate_probe as _eval
    except ModuleNotFoundError:  # pragma: no cover
        from scripts.resolve_due_claims import evaluate_probe as _eval
    evaluate_probe = _eval
    if fetch_quotes:
        try:
            from market_quotes import fetch_current_price as _fetch, fetch_daily_rows as _rows
            from technical_health import volume_heat as _heat
        except ModuleNotFoundError:  # pragma: no cover
            from scripts.market_quotes import fetch_current_price as _fetch, fetch_daily_rows as _rows
            from scripts.technical_health import volume_heat as _heat
        fetch_current_price = _fetch
        fetch_daily_rows = _rows
        volume_heat = _heat
    for item in _as_list(watchlist.get("items")):
        row: Mapping[str, Any] = _as_mapping(item)
        if row.get("removed") is True or not _text(row.get("symbol")):
            continue
        entry: dict[str, Any] = {
            "symbol": _text(row.get("symbol")),
            "watch_state": _text(row.get("watch_state")),
            "last_reviewed_at": _text(row.get("last_reviewed_at")),
            "upgrade_conditions": _as_list(row.get("upgrade_conditions"))[:3],
            "downgrade_conditions": _as_list(row.get("downgrade_conditions"))[:3],
            "current_price": None,
            "change_pct": None,
            "condition_check_suggested": False,
            "condition_hits": [],
            "condition_misses": [],
            "volume_heat": {"status": "NOT_MEASURED"},
        }
        if fetch_current_price is not None:
            try:
                quote: Mapping[str, Any] = fetch_current_price(entry["symbol"])
                price: Any = quote.get("current_price")
                prev: Any = quote.get("prev_close")
                entry["current_price"] = price
                if isinstance(price, (int, float)) and isinstance(prev, (int, float)) and prev:
                    entry["change_pct"] = round((float(price) - float(prev)) / float(prev) * 100.0, 2)
                entry["condition_check_suggested"] = bool(
                    entry["upgrade_conditions"] or entry["downgrade_conditions"]
                )
            except Exception as exc:
                failures.append({"symbol": entry["symbol"], "error": f"{type(exc).__name__}: {exc}"})
            if fetch_daily_rows is not None and volume_heat is not None:
                try:
                    entry["volume_heat"] = volume_heat(fetch_daily_rows(entry["symbol"], days=260))
                except Exception as exc:
                    entry["volume_heat"] = {"status": "DATA_GATED", "note": f"{type(exc).__name__}: {exc}"[:120]}
        hits, misses = evaluate_condition_probes(
            row, symbol=entry["symbol"], current_price=entry["current_price"], evaluate_probe=evaluate_probe
        )
        entry["condition_hits"] = hits
        entry["condition_misses"] = misses
        rows.append(entry)
    return rows, failures


def main(argv: Optional[Sequence[str]] = None) -> int:  # noqa: PLR0915 - single assembly path
    parser: argparse.ArgumentParser = argparse.ArgumentParser(description="Build the Serenity decision brief")
    parser.add_argument("--state-dir", help="state directory (default: $SERENITY_STATE_DIR or <cache>/state)")
    parser.add_argument("--runs-dir", help="runs directory to scan (default: <cache>/runs)")
    parser.add_argument("--ledger", help="forecast ledger path")
    parser.add_argument("--skip-network", action="store_true", help="no live regime/quote/claim fetching")
    parser.add_argument("--due-before", default="today")
    parser.add_argument("--out", help="write brief JSON")
    parser.add_argument("--md-out", help="write brief Markdown")
    args: argparse.Namespace = parser.parse_args(argv)

    try:
        from build_market_regime import build_market_regime
        from build_market_snapshot import build_market_snapshot
        from build_calibration_report import build_calibration_report
        from run_review_cycle import build_review_cycle
        from resolve_due_claims import _ledger_path, resolve_due_claims
        from update_watchlist_from_report import validate_watchlist
        from decision_log import read_entries, scoreboard_rows
    except ModuleNotFoundError:  # pragma: no cover - python -m scripts.build_decision_brief
        from scripts.build_market_regime import build_market_regime
        from scripts.build_market_snapshot import build_market_snapshot
        from scripts.build_calibration_report import build_calibration_report
        from scripts.run_review_cycle import build_review_cycle
        from scripts.resolve_due_claims import _ledger_path, resolve_due_claims
        from scripts.update_watchlist_from_report import validate_watchlist
        from scripts.decision_log import read_entries, scoreboard_rows

    notes: list[str] = []
    try:
        states: Path = Path(args.state_dir).expanduser() if args.state_dir else state_dir()
        runs_dir: Path = Path(args.runs_dir).expanduser() if args.runs_dir else cache_base() / "runs"

        regime: Optional[Mapping[str, Any]] = None
        benchmark_day_pct: Optional[float] = None
        if not args.skip_network:
            try:
                import tempfile

                snapshot: dict[str, Any] = build_market_snapshot(("csi300", "csi500", "chinext", "hsi"))
                for bench in snapshot["benchmarks"]:
                    quote_row: Mapping[str, Any] = _as_mapping(bench.get("quote"))
                    price_now: Any = quote_row.get("current_price")
                    price_prev: Any = quote_row.get("prev_close")
                    if isinstance(price_now, (int, float)) and isinstance(price_prev, (int, float)) and price_prev:
                        benchmark_day_pct = round((float(price_now) - float(price_prev)) / float(price_prev) * 100.0, 2)
                        break
                if snapshot["benchmarks"]:
                    with tempfile.TemporaryDirectory(prefix="serenity-brief-") as temp_dir:
                        snapshot_path: Path = Path(temp_dir) / "market_snapshot.json"
                        snapshot_path.write_text(json.dumps(snapshot, ensure_ascii=False), encoding="utf-8")
                        regime = build_market_regime(snapshot_path=snapshot_path)
                for failure in snapshot.get("failed", []):
                    notes.append(f"基准不可达：{failure.get('key')}（{str(failure.get('error'))[:80]}）")
            except Exception as exc:
                notes.append(f"市场环境测量失败：{type(exc).__name__}: {exc}")
        else:
            notes.append("离线模式：未测量市场环境，未取观察名单现价。")

        portfolio: Optional[Mapping[str, Any]] = None
        portfolio_path: Path = states / "portfolio_context.json"
        if portfolio_path.exists():
            try:
                portfolio = _load_json(portfolio_path)
            except Exception as exc:
                notes.append(f"持仓上下文不可读：{exc}")

        watch_rows: list[dict[str, Any]] = []
        quote_failures: list[dict[str, str]] = []
        due_items: list[Mapping[str, Any]] = []
        watchlist_path: Path = states / "watchlist.json"
        if watchlist_path.exists():
            watchlist: Mapping[str, Any] = _load_json(watchlist_path)
            watch_errors: list[str] = validate_watchlist(watchlist)
            if watch_errors:
                notes.append(f"观察名单校验失败（{watchlist_path}）：{'; '.join(watch_errors[:2])}")
            else:
                watch_rows, quote_failures = _gather_watch_rows(watchlist, fetch_quotes=not args.skip_network)
                review_cycle: Mapping[str, Any] = build_review_cycle(
                    watchlist, due_before=args.due_before, source_watchlist_path=str(watchlist_path)
                )
                due_items = [_as_mapping(item) for item in _as_list(review_cycle.get("due_items"))]

        ledger_path: Path = _ledger_path(args.ledger)
        resolvable: list[Mapping[str, Any]] = []
        manual: list[Mapping[str, Any]] = []
        calibration_summary: Mapping[str, Any] = {}
        if ledger_path.exists():
            preview: Mapping[str, Any] = resolve_due_claims(
                ledger_path=ledger_path,
                snapshot={},
                due_before=dt.date.today().isoformat() if args.due_before == "today" else args.due_before,
                root=Path(__file__).resolve().parents[1],
                write_ledger=False,
                fetch=not args.skip_network,
            )
            resolvable = [_as_mapping(row) for row in _as_list(preview.get("resolved_claims"))]
            manual = [_as_mapping(row) for row in _as_list(preview.get("manual_review_claims"))]
            calibration_summary = _as_mapping(build_calibration_report(ledger_path).get("summary"))
        else:
            notes.append("预测账本不存在：策略判断尚未留下可结算 claim。")

        position_changes: dict[str, Any] = {}
        current_prices: dict[str, Any] = {
            row["symbol"]: row.get("current_price")
            for row in watch_rows
            if isinstance(row.get("current_price"), (int, float))
        }
        if portfolio and not args.skip_network:
            try:
                from market_quotes import fetch_current_price as _quote
            except ModuleNotFoundError:  # pragma: no cover
                from scripts.market_quotes import fetch_current_price as _quote
            for row in _as_list(_as_mapping(portfolio).get("positions")):
                symbol: str = _text(_as_mapping(row).get("symbol"))
                if not symbol:
                    continue
                try:
                    quote: Mapping[str, Any] = _quote(symbol)
                    price_now = quote.get("current_price")
                    price_prev = quote.get("prev_close")
                    if isinstance(price_now, (int, float)):
                        current_prices.setdefault(symbol, price_now)
                    if isinstance(price_now, (int, float)) and isinstance(price_prev, (int, float)) and price_prev:
                        position_changes[symbol] = round((float(price_now) - float(price_prev)) / float(price_prev) * 100.0, 2)
                except Exception as exc:
                    notes.append(f"持仓 {symbol} 现价不可得：{type(exc).__name__}")

        log_entries: list[dict[str, Any]] = read_entries(limit=10)
        if log_entries and not args.skip_network:
            try:
                from market_quotes import fetch_current_price as _quote2
            except ModuleNotFoundError:  # pragma: no cover
                from scripts.market_quotes import fetch_current_price as _quote2
            for entry in log_entries:
                symbol = _text(entry.get("symbol"))
                if symbol and symbol not in current_prices:
                    try:
                        current_prices[symbol] = _quote2(symbol).get("current_price")
                    except Exception:
                        pass
        scoreboard: list[dict[str, Any]] = scoreboard_rows(log_entries, current_prices, limit=10)

        watch_symbols: list[str] = [row["symbol"] for row in watch_rows]
        brief: dict[str, Any] = build_decision_brief(
            generated_at=dt.datetime.now(dt.timezone.utc).isoformat(),
            regime=regime,
            portfolio=portfolio,
            watch_rows=watch_rows,
            quote_failures=quote_failures,
            due_items=due_items,
            resolvable_claims=resolvable,
            manual_claims=manual,
            calibration_summary=calibration_summary,
            incomplete_runs=find_incomplete_runs(runs_dir),
            orphan_deliveries=find_orphan_deliveries(runs_dir, watch_symbols),
            state_watchlist_path=str(watchlist_path),
            notes=notes,
            position_changes=position_changes,
            benchmark_day_pct=benchmark_day_pct,
            decision_scoreboard=scoreboard,
        )
        errors: list[str] = validate_decision_brief(brief)
        if errors:
            raise ValueError("; ".join(errors))
        markdown: str = render_brief_markdown(brief)
        try:
            last_brief_path: Path = states / "last_brief.json"
            last_brief_path.parent.mkdir(parents=True, exist_ok=True)
            last_brief_path.write_text(json.dumps(brief, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        except Exception as exc:
            print(f"warning: could not write last_brief pointer: {exc}", file=sys.stderr)
    except Exception as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    if args.out:
        out_path: Path = Path(args.out)
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(json.dumps(brief, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    if args.md_out:
        md_path: Path = Path(args.md_out)
        md_path.parent.mkdir(parents=True, exist_ok=True)
        md_path.write_text(markdown + "\n", encoding="utf-8")
    print(markdown)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
