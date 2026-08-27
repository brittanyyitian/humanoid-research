#!/usr/bin/env python3
"""Single-command orchestrator for serenity-chan-stock-skill.

This is the primary entry point. It routes one research request into the
existing pipeline scripts, runs every deterministic stage in order, and
records a pipeline ledger so a run can be audited or resumed.

Verbs:
  doctor    environment preflight (passthrough to scripts/doctor.py)
  ask       one question -> research brief, formal queue, or discovery funnel
  continue  finish a formal run after AI dossiers are written
  review    watchlist review + due-claim resolution + calibration + health

Exit codes:
  0   terminal success
  1   error
  10  AGENT_RESEARCH_REQUIRED: AI dossiers must be written, then `continue`
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Mapping, Optional, Sequence

LEDGER_CONTRACT_TYPE: str = "serenity_pipeline_ledger"
LEDGER_SCHEMA_VERSION: str = "1.0"
AGENT_RESEARCH_EXIT_CODE: int = 10
STAGE_TIMEOUT_SECONDS: int = 1800

_STRATEGY_HINT_RE = re.compile(
    r"(怎么操作|怎么办|如何配置|仓位|加仓|减仓|建仓|清仓|allocat|position siz|rebalance|what should i do)",
    re.IGNORECASE,
)


def _repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def _now_utc() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat()


def _text(value: Any) -> str:
    return str(value or "").strip()


def _slug(value: str, *, max_length: int = 40) -> str:
    cleaned: str = re.sub(r"[^0-9A-Za-z一-鿿]+", "-", value).strip("-")
    return (cleaned or "run")[:max_length]


def _default_run_dir(label: str) -> Path:
    root_override: Optional[str] = os.getenv("SERENITY_DATA_DIR")
    base: Path = Path(root_override).expanduser() if root_override else Path.home() / ".cache" / "serenity-chan"
    stamp: str = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    return base / "runs" / f"{stamp}-{_slug(label)}"


def _load_json(path: Path) -> Mapping[str, Any]:
    payload: Any = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(payload, Mapping):
        raise ValueError(f"{path} must contain a JSON object")
    return payload


def _write_json(path: Path, payload: Mapping[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def infer_route(question: str, symbols: Sequence[str], *, formal: bool) -> str:
    """Map one request onto exactly one pipeline route.

    Pure function so route behavior stays testable without network access.
    """
    symbol_count: int = len([symbol for symbol in symbols if _text(symbol)])
    if symbol_count >= 2:
        return "formal_comparison" if formal else "quick_comparison"
    if symbol_count == 1:
        return "formal_single" if formal else "quick_single"
    if not _text(question):
        raise ValueError("ask needs a question or at least one --symbols value")
    return "discovery"


def strategy_hint(question: str) -> bool:
    return bool(_STRATEGY_HINT_RE.search(question or ""))


class Pipeline:
    """Runs stages as subprocesses and records an auditable ledger."""

    def __init__(self, *, run_dir: Path, label: str, route: str) -> None:
        self.run_dir: Path = run_dir
        self.root: Path = _repo_root()
        self.stages: list[dict[str, Any]] = []
        self.label: str = label
        self.route: str = route
        self.run_dir.mkdir(parents=True, exist_ok=True)

    def ledger_path(self) -> Path:
        return self.run_dir / "pipeline_ledger.json"

    def run_stage(
        self,
        name: str,
        script: str,
        args: Sequence[str],
        *,
        allow_exit_codes: Sequence[int] = (0,),
    ) -> dict[str, Any]:
        command: list[str] = [sys.executable, str(self.root / "scripts" / script), *[str(part) for part in args]]
        started: float = time.monotonic()
        completed: subprocess.CompletedProcess[str] = subprocess.run(
            command,
            cwd=str(self.root),
            check=False,
            capture_output=True,
            text=True,
            timeout=STAGE_TIMEOUT_SECONDS,
        )
        record: dict[str, Any] = {
            "name": name,
            "command": command,
            "exit_code": int(completed.returncode),
            "duration_s": round(time.monotonic() - started, 2),
            "status": "PASS" if completed.returncode in set(allow_exit_codes) else "FAIL",
            "stdout_tail": completed.stdout.strip()[-2000:],
            "stderr_tail": completed.stderr.strip()[-2000:],
        }
        self.stages.append(record)
        self.flush(status="RUNNING", next_action="")
        if record["status"] == "FAIL":
            raise PipelineStageError(name, record)
        return record

    def flush(self, *, status: str, next_action: str) -> None:
        _write_json(
            self.ledger_path(),
            {
                "contract_type": LEDGER_CONTRACT_TYPE,
                "schema_version": LEDGER_SCHEMA_VERSION,
                "generated_at": _now_utc(),
                "label": self.label,
                "route": self.route,
                "run_dir": str(self.run_dir),
                "status": status,
                "next_action": next_action,
                "stage_count": len(self.stages),
                "stages": self.stages,
            },
        )


class PipelineStageError(RuntimeError):
    def __init__(self, stage_name: str, record: Mapping[str, Any]) -> None:
        self.stage_name: str = stage_name
        self.record: Mapping[str, Any] = record
        super().__init__(f"stage {stage_name} failed with exit {record.get('exit_code')}")


def _print_stage_failure(error: PipelineStageError, ledger_path: Path) -> None:
    record: Mapping[str, Any] = error.record
    print(f"ERROR: stage `{error.stage_name}` failed (exit {record.get('exit_code')}).", file=sys.stderr)
    stderr_tail: str = _text(record.get("stderr_tail"))
    stdout_tail: str = _text(record.get("stdout_tail"))
    if stderr_tail:
        print(f"stderr: {stderr_tail[-800:]}", file=sys.stderr)
    elif stdout_tail:
        print(f"stdout: {stdout_tail[-800:]}", file=sys.stderr)
    command: Any = record.get("command")
    if isinstance(command, list):
        print("rerun manually: " + " ".join(str(part) for part in command), file=sys.stderr)
    print(f"pipeline ledger: {ledger_path}", file=sys.stderr)


def _analysis_args(args: argparse.Namespace, out_dir: Path, *, mode: str) -> list[str]:
    call: list[str] = [*args.symbols, "--out-dir", str(out_dir), "--research-mode", mode]
    if args.sec_user_agent:
        call.extend(["--sec-user-agent", args.sec_user_agent])
    if args.candidate_funnel:
        call.extend(["--candidate-funnel", args.candidate_funnel])
    return call


def _summary_line(path: Path, keys: Sequence[str]) -> str:
    try:
        payload: Mapping[str, Any] = _load_json(path)
    except Exception:
        return ""
    parts: list[str] = []
    for key in keys:
        if key in payload:
            parts.append(f"{key}={payload.get(key)}")
    return " ".join(parts)


def cmd_ask(args: argparse.Namespace) -> int:
    route: str = infer_route(args.question, args.symbols, formal=args.formal)
    label: str = _slug(args.question or "-".join(args.symbols))
    run_dir: Path = Path(args.out_dir).expanduser() if args.out_dir else _default_run_dir(label)
    pipeline: Pipeline = Pipeline(run_dir=run_dir, label=args.question or " ".join(args.symbols), route=route)
    print(f"route: {route}")
    print(f"run dir: {run_dir}")
    try:
        if route == "discovery":
            return _run_discovery(pipeline, args)
        if route in {"quick_single", "quick_comparison"}:
            return _run_quick(pipeline, args)
        return _run_formal(pipeline, args)
    except PipelineStageError as error:
        pipeline.flush(status="FAILED", next_action=f"repair stage {error.stage_name}")
        _print_stage_failure(error, pipeline.ledger_path())
        return 1


def _run_discovery(pipeline: Pipeline, args: argparse.Namespace) -> int:
    discovery_args: list[str] = [args.question, "--out-dir", str(pipeline.run_dir)]
    if args.market_scope:
        # run_opportunity_discovery uses nargs="+": one flag, many values
        discovery_args.extend(["--market-scope", *args.market_scope])
    for board in args.exclude_board:
        discovery_args.extend(["--exclude-board", board])
    if args.max_price is not None:
        discovery_args.extend(["--max-price", str(args.max_price)])
    if args.theme:
        discovery_args.extend(["--theme", args.theme])
    if args.preflight_limit is not None:
        discovery_args.extend(["--preflight-candidate-limit", str(args.preflight_limit)])
    if args.shortlist_target is not None:
        discovery_args.extend(["--shortlist-target", str(args.shortlist_target)])
    pipeline.run_stage("opportunity_discovery", "run_opportunity_discovery.py", discovery_args)
    funnel_path: Path = pipeline.run_dir / "candidate_funnel.json"
    shortlist: list[str] = []
    if funnel_path.exists():
        try:
            funnel: Mapping[str, Any] = _load_json(funnel_path)
            shortlist = [str(symbol) for symbol in funnel.get("shortlist_symbols", []) if _text(symbol)]
        except Exception:
            shortlist = []
    next_action: str = (
        f"python scripts/serenity.py ask \"{args.question}\" --formal --symbols {' '.join(shortlist)} "
        f"--candidate-funnel {funnel_path}"
        if shortlist
        else "expand the theme universe or repair preflight data, then rerun discovery"
    )
    pipeline.flush(status="DISCOVERY_DONE", next_action=next_action)
    print(f"shortlist: {shortlist or 'EMPTY'}")
    print(f"funnel: {funnel_path}")
    print(f"next: {next_action}")
    return 0


def _diagnostic_summary_paths(run_dir: Path) -> tuple[str, list[str]]:
    summary_path: Path = run_dir / "diagnostic_baseline.json"
    baseline_report: str = ""
    manifests: list[str] = []
    if summary_path.exists():
        try:
            summary: Mapping[str, Any] = _load_json(summary_path)
        except Exception:
            return "", []
        baseline_report = _text(summary.get("diagnostic_baseline_report"))
        for row in summary.get("fetch_summaries", []) if isinstance(summary.get("fetch_summaries"), list) else []:
            if isinstance(row, Mapping) and _text(row.get("manifest")):
                manifests.append(_text(row.get("manifest")))
    return baseline_report, manifests


def _run_quick(pipeline: Pipeline, args: argparse.Namespace) -> int:
    pipeline.run_stage("diagnostic_analysis", "run_research_analysis.py", _analysis_args(args, pipeline.run_dir, mode="diagnostic"))
    baseline_report, manifests = _diagnostic_summary_paths(pipeline.run_dir)
    brief: Path = pipeline.run_dir / "research_brief.md"
    if baseline_report:
        pipeline.run_stage(
            "render_research_brief",
            "render_research_report.py",
            ["--comparison-report", baseline_report, "--mode", "research_brief", "--out", str(brief)],
        )
    elif manifests:
        # single-symbol quick runs have no comparison baseline; render a data audit instead
        pipeline.run_stage("render_data_audit", "render_data_audit.py", [manifests[0], "--out", str(brief)])
    else:
        pipeline.flush(status="FAILED", next_action="diagnostic run produced neither baseline report nor manifests")
        print("ERROR: diagnostic run produced no renderable output", file=sys.stderr)
        return 1
    next_action: str = (
        f"python scripts/serenity.py ask \"{args.question}\" --formal --symbols {' '.join(args.symbols)}"
    )
    pipeline.flush(status="BRIEF_READY", next_action=next_action)
    print(f"research brief: {brief}")
    if strategy_hint(args.question):
        print("note: strategy/allocation answers need the formal route first; run the --formal command below.")
    print(f"next (formal): {next_action}")
    return 0


def _run_formal_single(pipeline: Pipeline, args: argparse.Namespace) -> int:
    """Formal deep-dive on one company uses the single-memo workflow.

    The comparison pipeline requires two or more candidates, so a formal
    single run prepares everything the memo needs: full fetch, data audit,
    and a scorecard workspace, then hands the memo writing to the AI.
    """
    pipeline.run_stage("diagnostic_analysis", "run_research_analysis.py", _analysis_args(args, pipeline.run_dir, mode="diagnostic"))
    _, manifests = _diagnostic_summary_paths(pipeline.run_dir)
    if not manifests:
        pipeline.flush(status="FAILED", next_action="fetch produced no manifest")
        print("ERROR: fetch produced no manifest", file=sys.stderr)
        return 1
    audit: Path = pipeline.run_dir / "data_audit.md"
    pipeline.run_stage("render_data_audit", "render_data_audit.py", [manifests[0], "--out", str(audit)])
    scorecard_path: Path = pipeline.run_dir / "scorecard.json"
    template_path: Path = pipeline.root / "assets" / "scorecard_template.json"
    scorecard_path.write_text(template_path.read_text(encoding="utf-8"), encoding="utf-8")
    next_action: str = (
        f"fill {scorecard_path} per references/05 single memo, then validate: "
        f"python scripts/serenity_chan_scorecard.py {scorecard_path} --format md; "
        f"python scripts/validate_output_contract.py <memo.md>"
    )
    pipeline.flush(status="SINGLE_MEMO_WORKSPACE_READY", next_action=next_action)
    print(f"data audit: {audit}")
    print(f"scorecard workspace: {scorecard_path}")
    print("single-company formal research uses the memo workflow (references/05 §1):")
    print(f"  1) read {manifests[0]}")
    print(f"  2) fill {scorecard_path} and render: python scripts/serenity_chan_scorecard.py {scorecard_path} --format md")
    print("  3) write the memo per references/05 §1, then: python scripts/validate_output_contract.py <memo.md>")
    return AGENT_RESEARCH_EXIT_CODE


def _run_formal(pipeline: Pipeline, args: argparse.Namespace) -> int:
    if len([symbol for symbol in args.symbols if _text(symbol)]) < 2:
        return _run_formal_single(pipeline, args)
    pipeline.run_stage("formal_analysis", "run_research_analysis.py", _analysis_args(args, pipeline.run_dir, mode="formal"))
    queue_path: Path = pipeline.run_dir / "agent_research_queue.json"
    if not queue_path.exists():
        pipeline.flush(status="FAILED", next_action="formal analysis did not produce agent_research_queue.json")
        print("ERROR: expected agent_research_queue.json was not produced", file=sys.stderr)
        return 1
    pipeline.run_stage(
        "prepare_agent_workspace",
        "execute_agent_research_queue.py",
        [
            "prepare",
            str(queue_path),
            "--workspace-out", str(pipeline.run_dir / "agent_overlay_workspace.json"),
            "--taskbook-out", str(pipeline.run_dir / "agent_research_taskbook.md"),
            "--status-out", str(pipeline.run_dir / "agent_research_execution_status.json"),
        ],
    )
    next_action: str = f"write one validated dossier + projection per candidate, then: python scripts/serenity.py continue {pipeline.run_dir}"
    pipeline.flush(status="AGENT_RESEARCH_REQUIRED", next_action=next_action)
    print(f"taskbook: {pipeline.run_dir / 'agent_research_taskbook.md'}")
    print("AI research required: read the taskbook, write ai_research_dossier + overlay/outcome per candidate.")
    print(f"then: python scripts/serenity.py continue {pipeline.run_dir}")
    return AGENT_RESEARCH_EXIT_CODE


def cmd_continue(args: argparse.Namespace) -> int:
    run_dir: Path = Path(args.run_dir).expanduser()
    queue_path: Path = run_dir / "agent_research_queue.json"
    if not queue_path.exists():
        print(f"ERROR: {queue_path} not found; `continue` resumes a formal run directory", file=sys.stderr)
        return 1
    pipeline: Pipeline = Pipeline(run_dir=run_dir, label=f"continue {run_dir.name}", route="formal_continue")
    report_path: Path = run_dir / "comparison_final.json"
    draft_path: Path = run_dir / "comparison_draft.md"
    final_md_path: Path = run_dir / "comparison_final.md"
    proof_path: Path = run_dir / "delivery_proof.json"
    try:
        merge_record: dict[str, Any] = pipeline.run_stage(
            "merge_agent_research",
            "execute_agent_research_queue.py",
            [
                "run",
                str(queue_path),
                "--workspace-out", str(run_dir / "agent_overlay_workspace.json"),
                "--taskbook-out", str(run_dir / "agent_research_taskbook.md"),
                "--status-out", str(run_dir / "agent_research_execution_status.json"),
                "--report-out", str(report_path),
                "--markdown-out", str(run_dir / "comparison_merged.md"),
            ],
            allow_exit_codes=(0, 1),
        )
        if not report_path.exists():
            status_line: str = _summary_line(run_dir / "agent_research_execution_status.json", ["workflow_status"])
            pipeline.flush(status="AGENT_RESEARCH_REQUIRED", next_action="complete the remaining AI packages named in agent_research_execution_status.json")
            print(f"AI research still incomplete ({status_line or 'no merged report'}).")
            print(f"status file: {run_dir / 'agent_research_execution_status.json'}")
            print(f"merge output tail: {_text(merge_record.get('stdout_tail'))[-400:]}")
            return AGENT_RESEARCH_EXIT_CODE
        pipeline.run_stage("validate_delivery", "validate_research_delivery.py", [str(report_path)])
        pipeline.run_stage("build_delivery_proof", "build_delivery_proof.py", [str(report_path), "--out", str(proof_path)])
        pipeline.run_stage(
            "render_full_report",
            "render_research_report.py",
            ["--comparison-report", str(report_path), "--mode", "full_research", "--out", str(draft_path)],
        )
        pipeline.run_stage("append_delivery_proof", "append_delivery_proof.py", [str(draft_path), str(proof_path), "--out", str(final_md_path)])
        pipeline.run_stage(
            "verify_output_contract",
            "validate_output_contract.py",
            [str(final_md_path), "--require-delivery-proof", "--proof", str(proof_path), "--verify-proof"],
        )
    except PipelineStageError as error:
        pipeline.flush(status="FAILED", next_action=f"repair stage {error.stage_name}")
        _print_stage_failure(error, pipeline.ledger_path())
        return 1
    pipeline.flush(status="FORMAL_DELIVERED", next_action=f"read {final_md_path}; for strategy/allocation run the laplace bridge (references/16)")
    print(f"formal report: {final_md_path}")
    print(f"delivery proof: {proof_path}")
    print(f"comparison json: {report_path}")
    return 0


def _state_dir() -> Path:
    override: Optional[str] = os.getenv("SERENITY_STATE_DIR")
    if override:
        return Path(override).expanduser()
    base: Path = Path(os.getenv("SERENITY_DATA_DIR", str(Path.home() / ".cache" / "serenity-chan"))).expanduser()
    return base / "state"


def cmd_next(args: argparse.Namespace) -> int:
    """Decision brief: aggregate every tracked reality into one action queue."""
    workspace: Path = Path(args.workspace).expanduser() if args.workspace else _default_run_dir("next")
    pipeline: Pipeline = Pipeline(run_dir=workspace, label="decision brief", route="next")
    brief_json: Path = workspace / "decision_brief.json"
    brief_md: Path = workspace / "decision_brief.md"
    brief_args: list[str] = ["--out", str(brief_json), "--md-out", str(brief_md), "--due-before", args.due_before]
    if args.skip_network:
        brief_args.append("--skip-network")
    if args.ledger:
        brief_args.extend(["--ledger", args.ledger])
    try:
        record: dict[str, Any] = pipeline.run_stage("decision_brief", "build_decision_brief.py", brief_args)
    except PipelineStageError as error:
        pipeline.flush(status="FAILED", next_action="repair stage decision_brief")
        _print_stage_failure(error, pipeline.ledger_path())
        return 1
    pipeline.flush(status="BRIEF_READY", next_action=f"write decision_counsel over {brief_json}, validate, then act")
    try:
        # stage stdout is tail-truncated in the ledger; the file is the full brief
        print(brief_md.read_text(encoding="utf-8"))
    except OSError:
        print(_text(record.get("stdout_tail")))
    print(f"\ndecision brief: {brief_md}")
    print("AI counsel step: read the brief JSON, write decision_counsel.json per assets/decision_counsel.schema.json, then:")
    print(f"  python scripts/validate_decision_counsel.py <decision_counsel.json> --brief {brief_json} --md-out <counsel.md>")
    print(f"record your calls afterwards: python scripts/serenity.py decide <n> --did|--skip --note \"...\"")
    return 0


def cmd_decide(args: argparse.Namespace) -> int:
    """Record what was done with a briefed action; the journal feeds the scoreboard."""
    try:
        from decision_log import append_entry, build_entry
    except ModuleNotFoundError:  # pragma: no cover
        from scripts.decision_log import append_entry, build_entry
    last_brief_path: Path = _state_dir() / "last_brief.json"
    if not last_brief_path.exists():
        print(f"ERROR: {last_brief_path} not found; run `serenity next` first", file=sys.stderr)
        return 1
    brief: Mapping[str, Any] = _load_json(last_brief_path)
    actions: list[Any] = brief.get("actions") if isinstance(brief.get("actions"), list) else []
    index: int = args.action_number
    if index < 1 or index > len(actions):
        print(f"ERROR: action number must be 1..{len(actions)} (see {last_brief_path})", file=sys.stderr)
        return 1
    action: Mapping[str, Any] = actions[index - 1] if isinstance(actions[index - 1], Mapping) else {}
    price: Optional[float] = None
    symbol: str = _text(action.get("symbol"))
    if symbol:
        try:
            from market_quotes import fetch_current_price
        except ModuleNotFoundError:  # pragma: no cover
            from scripts.market_quotes import fetch_current_price
        try:
            quote: Mapping[str, Any] = fetch_current_price(symbol)
            raw_price: Any = quote.get("current_price")
            price = float(raw_price) if isinstance(raw_price, (int, float)) else None
        except Exception as exc:
            print(f"note: price at decision unavailable for {symbol}: {type(exc).__name__}")
    entry = build_entry(
        action=action,
        decision="DONE" if args.did else "SKIPPED",
        note=args.note,
        brief_generated_at=_text(brief.get("generated_at")),
        price_at_decision=price,
    )
    target = append_entry(entry)
    print(f"recorded: [{entry['decision']}] {entry['action_title'][:60]}")
    if price is not None:
        print(f"price at decision: {symbol} = {price}")
    print(f"journal: {target}")
    return 0


def cmd_review(args: argparse.Namespace) -> int:
    state_watchlist: Path = _state_dir() / "watchlist.json"
    used_state_default: bool = False
    if not args.watchlist and state_watchlist.exists():
        args.watchlist = str(state_watchlist)
        used_state_default = True
        print(f"watchlist (state default): {state_watchlist}")
    if args.apply and not args.watchlist:
        print("ERROR: --apply requires --watchlist (the outcome is written back into that watchlist)", file=sys.stderr)
        return 1
    workspace: Path = Path(args.workspace).expanduser() if args.workspace else _default_run_dir("review")
    pipeline: Pipeline = Pipeline(run_dir=workspace, label="review", route="review")
    review_out: Path = workspace / "review_cycle.json"
    resolved_out: Path = workspace / "resolved_claims.json"
    calibration_out: Path = workspace / "calibration_report.json"
    policy_out: Path = workspace / "calibration_policy.json"
    health_out: Path = workspace / "provider_health.json"
    ran_any: bool = False
    try:
        if args.watchlist:
            effective_watchlist: str = args.watchlist
            if args.apply:
                updated_watchlist: Path = workspace / "watchlist_updated.json"
                pipeline.run_stage(
                    "apply_review_outcome",
                    "run_review_cycle.py",
                    [args.watchlist, "--apply", args.apply, "--out", str(updated_watchlist)],
                )
                effective_watchlist = str(updated_watchlist)
                print(f"watchlist updated: {updated_watchlist}")
                if used_state_default or Path(args.watchlist).resolve() == state_watchlist.resolve():
                    # applied outcomes must land back in the canonical state,
                    # otherwise the next decision brief reads stale reality
                    backup: Path = state_watchlist.with_suffix(".json.bak")
                    backup.write_text(state_watchlist.read_text(encoding="utf-8"), encoding="utf-8")
                    state_watchlist.write_text(updated_watchlist.read_text(encoding="utf-8"), encoding="utf-8")
                    print(f"state watchlist written back: {state_watchlist} (backup: {backup})")
            pipeline.run_stage(
                "review_cycle",
                "run_review_cycle.py",
                [effective_watchlist, "--due-before", args.due_before, "--out", str(review_out)],
            )
            ran_any = True
        ledger_path: Path = Path(args.ledger).expanduser() if args.ledger else Path(
            os.getenv("SERENITY_FORECAST_LEDGER_PATH", "~/.cache/serenity-chan/forecast-ledger.sqlite")
        ).expanduser()
        if ledger_path.exists():
            resolve_args: list[str] = ["--ledger", str(ledger_path), "--due-before", args.due_before, "--out", str(resolved_out)]
            if args.snapshot:
                resolve_args.extend(["--snapshot", args.snapshot])
            elif args.fetch:
                resolve_args.append("--fetch")
            else:
                resolve_args.append("--dry-run")
            pipeline.run_stage("resolve_due_claims", "resolve_due_claims.py", resolve_args)
            pipeline.run_stage(
                "calibration_report",
                "build_calibration_report.py",
                ["--ledger", str(ledger_path), "--out", str(calibration_out), "--policy-out", str(policy_out)],
            )
            ran_any = True
        # scan the whole cache base: data_router bundles live under <base>/data
        # while orchestrated runs keep theirs under <base>/runs/<run>/data
        cache_base: Path = Path(os.getenv("SERENITY_DATA_DIR", str(Path.home() / ".cache" / "serenity-chan"))).expanduser()
        if cache_base.exists():
            pipeline.run_stage("provider_health", "build_provider_health.py", [str(cache_base), "--out", str(health_out)])
            ran_any = True
    except PipelineStageError as error:
        pipeline.flush(status="FAILED", next_action=f"repair stage {error.stage_name}")
        _print_stage_failure(error, pipeline.ledger_path())
        return 1
    if not ran_any:
        print("nothing to review: no --watchlist given, no forecast ledger found, no data root yet")
        pipeline.flush(status="EMPTY", next_action="pass --watchlist and/or create a forecast ledger first")
        return 0
    pipeline.flush(status="REVIEW_DONE", next_action="act on due review items and manual-review claims")
    for path in [review_out, resolved_out, calibration_out, policy_out, health_out]:
        if path.exists():
            print(f"{path.name}: {path}")
    return 0


def cmd_doctor(args: argparse.Namespace) -> int:
    command: list[str] = [sys.executable, str(_repo_root() / "scripts" / "doctor.py"), *args.doctor_args]
    return subprocess.run(command, cwd=str(_repo_root()), check=False).returncode


def build_parser() -> argparse.ArgumentParser:
    parser: argparse.ArgumentParser = argparse.ArgumentParser(
        prog="serenity",
        description="serenity-chan single-command research orchestrator",
    )
    subparsers = parser.add_subparsers(dest="verb", required=True)

    ask = subparsers.add_parser("ask", help="turn one question into a research brief, formal queue, or discovery funnel")
    ask.add_argument("question", nargs="?", default="", help="natural-language research question")
    ask.add_argument("--symbols", nargs="*", default=[], help="explicit symbols; 1 = single company, 2+ = comparison")
    ask.add_argument("--formal", action="store_true", help="run the formal AI-research route instead of a quick brief")
    ask.add_argument("--out-dir", help="run directory (default: ~/.cache/serenity-chan/runs/<ts>-<slug>)")
    ask.add_argument("--market-scope", nargs="*", default=["CN_A"], help="discovery market scope")
    ask.add_argument("--exclude-board", nargs="*", default=[], help="discovery board exclusions, e.g. STAR")
    ask.add_argument("--max-price", type=float, help="discovery price cap")
    ask.add_argument("--theme", help="discovery hard theme scope")
    ask.add_argument("--candidate-funnel", help="candidate funnel JSON for formal runs on a discovery shortlist")
    ask.add_argument("--preflight-limit", type=int, help="discovery: cap the number of candidates fetched in light preflight")
    ask.add_argument("--shortlist-target", type=int, help="discovery: target shortlist size")
    ask.add_argument("--sec-user-agent", default=os.getenv("SEC_USER_AGENT", ""), help="SEC identity for US fetches")
    ask.set_defaults(func=cmd_ask)

    cont = subparsers.add_parser("continue", help="resume a formal run after AI dossiers are written")
    cont.add_argument("run_dir", help="formal run directory printed by `ask --formal`")
    cont.set_defaults(func=cmd_continue)

    nxt = subparsers.add_parser("next", help="decision brief: current reality -> prioritized next actions")
    nxt.add_argument("--skip-network", action="store_true", help="offline brief (no live regime/quotes/claim preview)")
    nxt.add_argument("--ledger", help="forecast ledger path override")
    nxt.add_argument("--due-before", default="today", help="YYYY-MM-DD or today")
    nxt.add_argument("--workspace", help="output directory (default: ~/.cache/serenity-chan/runs/<ts>-next)")
    nxt.set_defaults(func=cmd_next)

    decide = subparsers.add_parser("decide", help="record DONE/SKIPPED for an action from the last decision brief")
    decide.add_argument("action_number", type=int, help="1-based action index from the last brief")
    group = decide.add_mutually_exclusive_group(required=True)
    group.add_argument("--did", action="store_true", help="the action was executed")
    group.add_argument("--skip", dest="skip", action="store_true", help="the action was consciously skipped")
    decide.add_argument("--note", default="", help="one-line reason; future you will read this")
    decide.set_defaults(func=cmd_decide)

    review = subparsers.add_parser("review", help="due reviews + claim resolution + calibration + provider health")
    review.add_argument("--watchlist", help="watchlist JSON to check for due review triggers")
    review.add_argument("--apply", help="serenity_review_outcome JSON to write back into the watchlist")
    review.add_argument("--ledger", help="forecast ledger path (default: ~/.cache/serenity-chan/forecast-ledger.sqlite)")
    review.add_argument("--due-before", default="today", help="YYYY-MM-DD or today")
    review.add_argument("--snapshot", help="resolution snapshot JSON for due claims")
    review.add_argument("--fetch", action="store_true", help="fetch quotes for machine-checkable claims automatically")
    review.add_argument("--workspace", help="output directory (default: ~/.cache/serenity-chan/runs/<ts>-review)")
    review.set_defaults(func=cmd_review)

    doctor = subparsers.add_parser("doctor", help="environment preflight (passthrough)")
    doctor.add_argument("doctor_args", nargs=argparse.REMAINDER, help="arguments passed to scripts/doctor.py")
    doctor.set_defaults(func=cmd_doctor)
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser: argparse.ArgumentParser = build_parser()
    args: argparse.Namespace = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except ValueError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
