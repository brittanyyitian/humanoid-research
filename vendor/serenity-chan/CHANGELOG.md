# Changelog

All notable changes to serenity-chan-stock-skill. Dates are UTC+8.

## [Unreleased] - 2026-07-03 (round-7 audit)

Claims-vs-implementation audit round. Every README claim now has either a
live run behind it or an explicit tier label.

### Verified live (first time)
- Formal comparison completed end-to-end with real ammunition: real fetch,
  two authored-and-validated dossiers (scores 78.9/77.4), one overlay plus
  one honest FAILED_INSUFFICIENT_EVIDENCE outcome, merge, delivery proof
  (real validator runs), render, proof append, and strict verification with
  hash recompute + allowlisted validator re-runs. Semantics held:
  decision_mode=research_lead, both candidates RESEARCH_GATED, no decision
  object fabricated from a gated/failed pair.
- Orchestrated opportunity discovery (README example) live: 74s with
  --preflight-limit 4, real shortlist, correct formal follow-up command.
- Strategy deterministic chain on the live report: readiness correctly
  excludes allocation mode for a research-gated pool.

### Fixed
- `serenity.py next` printed the stage's tail-truncated stdout, cutting off
  the brief's header for longer briefs; it now prints the rendered file.
- `serenity.py ask` (discovery) gains `--preflight-limit` /
  `--shortlist-target` passthrough; the underlying default of 24 preflight
  candidates made orchestrated discovery needlessly slow.
- English README quickstart caught up with `next`/`decide` and the state
  watchlist default.
- Removed a dead constant in the orchestrator.

## [Unreleased] - 2026-07-03 (round-3 uplift)

The theme of this round is subtraction and closure: one command per intent,
real data behind every mechanism, and review memory that survives regeneration.

### Added
- Decision counsel contract (`assets/decision_counsel.schema.json` +
  `scripts/validate_decision_counsel.py`): the AI writes professional
  counsel over one decision brief — one EXECUTE/DEFER/SKIP stance per
  briefed action with rationale/risk/invalidation — validated against the
  brief: sizing language rejected without portfolio context, HIGH
  confidence rejected without >=5 resolved calibration claims.
- Decision journal (`scripts/decision_log.py` + `serenity.py decide`):
  DONE/SKIPPED per briefed action with price-at-decision; the next brief
  shows a counterfactual scoreboard (price move since each decision).
- Machine-checked watch conditions: watchlist items may carry
  `condition_probes` (resolution-probe grammar); hits become priority-3
  CONDITION_HIT actions with evidence strings.
- Volume/price heat sensor (`technical_health.volume_heat`, unit-free):
  20d volume ratio + volume/price percentiles -> NORMAL/ELEVATED/
  CROWDED_SURGE/DRIED_UP, shown per tracked symbol in the brief.
- Portfolio analytics in the brief: weight-summed day move vs benchmark
  with excess, concentration flags vs the single-position cap, and
  unpriced-position disclosure; `build_portfolio_context --state`.
- Decision brief (`scripts/serenity.py next` / `scripts/build_decision_brief.py`):
  aggregates live market regime, the tracked watchlist with live prices,
  due reviews, auto-resolvable claim previews, calibration state, unfinished
  research runs, and untracked deliveries into one prioritized, executable
  action queue. Read-only by design; every action carries its command.
- State directory (`$SERENITY_STATE_DIR`, default `<cache>/state/`):
  `update_watchlist_from_report --state` (auto-previous + backup),
  `--add-scorecard` so single-memo research enters tracking instead of
  dead-ending, `serenity review` state defaults with apply write-back.
- `scripts/serenity.py`: single-command orchestrator (`ask` / `continue` /
  `review` / `doctor`). One question now runs route inference, fetch, analysis,
  rendering, and the delivery-proof chain with an auditable
  `pipeline_ledger.json` per run; exit code 10 marks the AI-dossier handoff.
- `scripts/render_data_audit.py`: renderer for the data-audit and quick
  single-company routes (the reporting stack previously required two or more
  candidates, so single-symbol runs had no renderable output).
- `scripts/market_quotes.py` + `scripts/build_market_snapshot.py`: benchmark
  index registry (CSI300/CSI500/ChiNext/STAR50/HSI/SPX/NDX) and live snapshot
  builder. `build_market_regime.py` now has a real data source instead of a
  hand-assembled snapshot file; failed feeds are excluded so an unreachable
  benchmark cannot masquerade as a risk-off vote.
- `scripts/resolve_due_claims.py --fetch`: due machine-checkable claims fetch
  their own current prices through the light quote route; unresolvable claims
  fall through to manual review with reasons.
- `scripts/build_portfolio_context.py --from-csv`: three-column holdings CSV
  to validated `portfolio_context`, with live market-value weights.
- Calibration feedback loop: `build_calibration_report.py --policy-out` emits
  `serenity_calibration_policy`; `validate_ai_overlay.py` raises its L0/L1
  confidence floor and `score_ai_research_dossier.py` raises its delivery
  score line from that policy (flag or `SERENITY_CALIBRATION_POLICY`).
  Historical forecast error now prices future confidence.
- `update_watchlist_from_report.py --previous`: regenerated watchlists carry
  review history, timestamps, and explicit REMOVED decisions forward.
- `build_delivery_proof.py --verify --rerun-validators`: re-executes recorded
  validators (allowlisted scripts only, current interpreter only) so a proof
  cannot claim PASS rows that were never run.
- `.github/workflows/review-cycle.yml`: weekly scheduled review cycle against
  committed state, artifact upload, and automatic due-review issues.
- Evals: 218 → 241 static cases covering every new mechanism including
  adversarial cases; agent behavior library grows from 1 to 10 with
  pressure-to-skip-gates scenarios.
- `companion-skills/laplace-forecast/UPSTREAM.md`: vendoring provenance and
  the exact local diff against the upstream skill.

### Changed
- `assets/watchlist_item.schema.json`: adds `previous_merge`.
- SKILL.md routes now lead with the orchestrator; low-level commands remain
  documented in `references/01` as the advanced interface.
- README rewritten around one real worked example (see round-3 review §4.2).

### Known limits
- BJ-board symbols stay on the full data_router path (no light quote route).
- `announcement_keyword` probes are not auto-fetched; they resolve from a
  supplied snapshot or fall to manual review.
- CI review-cycle runs against committed `state/`; local ledgers are the
  primary loop.
