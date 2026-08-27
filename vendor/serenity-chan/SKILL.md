---
name: serenity-chan-stock-skill
description: Use when performing data-first equity research for A-share, US, HK, or cross-market stock screening, open opportunity discovery, theme scans, candidate narrowing, single-company thesis challenges, candidate comparisons, evidence/falsification dashboards, valuation work, conservative technical-structure timing, or strategy/forecast follow-through. Always route market data and filings through market-specific sources before making current price, financial, rating, entry, allocation, or forecast claims. Not for crypto, funds/ETF plans, or general market chat without a research object.
---

# Serenity Chan Stock Skill

## Core Contract

Turn a stock, theme, candidate pool, or strategy question into research that is grounded in real data, AI investigation, evidence constraints, action conditions, and reviewable follow-up.

`scripts/serenity.py` is the primary interface: one command per intent. Low-level stage commands remain available and are documented in `references/01_data_first_market_router.md` §10.

Operating sequence for every research task:

1. First use in a new environment: `python scripts/serenity.py doctor --skip-network`.
2. Parse the request into one route and run the matching `serenity.py` command.
3. Acquire real data before making current price, valuation, financial, rating, entry, allocation, or forecast claims. Never invent them.
4. Keep market-specific source routing: A-share, US, and HK use their own disclosure and market context.
5. Separate observed facts, inference, and judgment.
6. Complete AI research work before formal delivery when the task asks for analysis, comparison, recommendations, strategy, or action.
7. Validate every structured artifact before using it in a user-facing answer; formal reports carry delivery proof.
8. Deliver in Chinese by default while preserving machine enum fields in English.

The skill supports research assistance, evidence organization, candidate comparison, action framing, and forecast review. Users remain responsible for investment decisions.

## Route Selection

Choose exactly one primary route. Read only the references needed for that route.

| User Intent | Route | Read First | Primary Command |
|---|---|---|---|
| First run, environment check, source readiness | Runtime doctor | `references/01_data_first_market_router.md` | `python scripts/serenity.py doctor` (`--skip-network` for offline) |
| Current price, market, data availability, source check | Data audit | `references/01_data_first_market_router.md` | `python scripts/serenity.py ask "<question>" --symbols <symbol>` (renders a data audit) |
| Single stock quick look | Quick single | `references/01_data_first_market_router.md` | `python scripts/serenity.py ask "<question>" --symbols <symbol>` |
| Single stock deep analysis, thesis challenge, valuation, timing | Single memo | `references/02`, `references/03`, `references/04`, `references/06` | `python scripts/serenity.py ask "<question>" --formal --symbols <symbol>` (prepares fetch + audit + scorecard workspace, then write the memo per `references/05` §1) |
| Open opportunity discovery, broad trend, "what can I buy" | Opportunity discovery | `references/17`, `references/01` | `python scripts/serenity.py ask "<question>" [--market-scope CN_A] [--exclude-board STAR] [--max-price N] [--theme <key>]` |
| Theme scan, industry chain, candidate discovery | Theme scan | `references/17`, `references/01` | `python scripts/build_theme_candidate_universe.py <theme> --out <universe.json>` then `python scripts/run_theme_research_analysis.py <theme> --out-dir <run_dir> --research-mode formal` |
| Multiple candidate comparison (quick) | Quick comparison | `references/01` | `python scripts/serenity.py ask "<question>" --symbols <a> <b> ...` (renders a research brief) |
| Multiple candidate comparison (formal) | Formal comparison | `references/02`, `references/03`, `references/04`, `references/15` | `python scripts/serenity.py ask "<question>" --formal --symbols <a> <b> ...` then write dossiers, then `python scripts/serenity.py continue <run_dir>` |
| Recommendation, allocation, action plan, trend forecast | Strategy forecast | `references/16`, `companion-skills/laplace-forecast/SKILL.md` | Strategy loop below, on top of a delivered formal comparison |
| "What should I do now" without a new research object | Decision brief + counsel | (no extra reading) | `python scripts/serenity.py next`, then the AI writes `decision_counsel.json` over the brief and validates it (see Decision Counsel below); record calls with `python scripts/serenity.py decide <n> --did\|--skip` |
| Watchlist follow-up, due reviews, claim resolution, calibration | Review | `references/16` | `python scripts/serenity.py review [--fetch] [--apply <review_outcome.json>]` (watchlist defaults to the state file) |

When a task crosses routes, complete the earlier evidence route first. Open-ended opportunity requests must build a candidate funnel before formal comparison (`ask` prints the exact follow-up command with `--candidate-funnel`). Strategy recommendations built from stocks must complete candidate comparison before entering strategy forecast.

Every `ask`/`continue`/`review` run writes a `pipeline_ledger.json` (stages, commands, exit codes, durations) into its run directory; failures print the exact underlying command to rerun.

## Data-First Rules

Before analysis, obtain or explicitly fail the relevant data package:

- Market identity, normalized symbol, exchange, and currency.
- Current quote and adjusted price history when price, entry, or technical timing is requested.
- Financials, filings/announcements, valuation inputs, total shares, total market cap, and source level.
- Customer, order, bid-win, capacity, and revenue-transmission evidence when the thesis depends on commercial adoption.
- Attempt ledger, data gaps, manual retrieval tasks, research debt, and data consumption audit.

Never invent current price, market cap, customers, orders, financial rows, source strength, or buy points. A failed or unrequested critical dataset constrains rating and action state until the data path is repaired or explicitly scoped out by the user.

Market routing is mandatory:

- A-share uses CNINFO/SSE/SZSE/BSE disclosure context, A-share quote and valuation sources, and A-share capital-action parsing.
- US uses SEC/IR disclosure context and US quote/filing conventions.
- HK uses HKEXnews, HK quote conventions, HKD valuation, share-count disclosures, placement, monthly return, and next-day disclosure context.

Use `references/01_data_first_market_router.md` for source ladders, forbidden source substitutions, adapter boundaries, and data-gap semantics.

## Formal AI Research Loop

Formal comparison must include AI research execution. Use `references/15_ai_overlay_execution_protocol.md` for details.

Required loop:

1. `python scripts/serenity.py ask "<question>" --formal --symbols <a> <b> ...` — fetches data, builds the queue, prepares the workspace, and prints the taskbook path (exit code 10 = AI research required).
2. Read the workspace, taskbook, manifests, review/committee packets, source catalog, customer/order/capacity evidence, deterministic matrices, and prompt package.
3. Write one `ai_research_dossier.json` per candidate (`assets/ai_research_dossier.schema.json`), projected into exactly one result: `ai_research_overlay.json` (evidence sufficient) or `ai_review_outcome.json` (insufficient or conflicting).
4. Validate each artifact while writing:

```bash
python scripts/validate_ai_research_dossier.py <dossier.json> --manifest <manifest.json>
python scripts/score_ai_research_dossier.py <dossier.json> --manifest <manifest.json>
python scripts/validate_ai_overlay.py <overlay.json> --manifest <manifest.json>
python scripts/validate_ai_review_outcome.py <outcome.json>
```

5. `python scripts/serenity.py continue <run_dir>` — merges validated packages, validates delivery, builds the delivery proof (real validator runs + artifact hashes), renders the report, appends the proof block, and verifies the proof (`--verify-proof` recomputes hashes). If packages are incomplete it names the exact missing candidate artifacts and exits with code 10.

Formal delivery requires every candidate to have a validated dossier, a passing dossier quality score, one validated projected result, a final comparison report, and delivery proof. Internal baselines, queues, diagnostic artifacts, and unexecuted AI work stay inside the execution workspace. A quick `ask` (without `--formal`) delivers a `research_brief` only and must never be presented as a formal decision.

Calibration feedback: when a calibration policy exists (see Strategy Loop), `validate_ai_overlay.py` raises its L0/L1 confidence floor and `score_ai_research_dossier.py` raises its delivery score line from `SERENITY_CALIBRATION_POLICY`. Historical forecast error prices future confidence; never bypass a tightened bar by deleting the policy file.

## Opportunity Discovery And Narrowing

Use this route for broad requests such as current market opportunities, cheap A-share ideas, non-STAR-board constraints, or "what else is worth looking at".

`serenity.py ask` with no `--symbols` runs discovery: it builds a macro theme map from the user's intent, market constraints, price preference, excluded themes, and explicit themes, assigns weights across investable themes, runs light real-data preflight (quote, adjusted history, filings, customer/order/capacity evidence, valuation inputs), scores the funnel, and prints the shortlist plus the exact formal follow-up command with `--candidate-funnel`.

The funnel is the boundary between idea discovery and formal research. It records the macro theme map, original universe, hard constraints, preflight data status, score breakdown, shortlist, deferred candidates, excluded directions, and next evidence. Formal research receives only the funnel shortlist. Funnel scoring combines theme fit, value-chain layer, data readiness, evidence strength, affordability, and risk penalty; low nominal price is capped as an affordability signal only.

- `THEME_UNIVERSE_RESEARCH_REQUIRED`: build a validated `theme_candidate_universe` with AI research, then rerun discovery with `--universe`.
- `CANDIDATE_FUNNEL_EMPTY`: expand the theme universe or repair preflight data before formal comparison.
- If AI dossiers materially change layer mapping or evidence quality, update the funnel with `scripts/update_candidate_funnel_from_ai_dossiers.py` before rerunning formal research.

Curated theme seeds live in `assets/theme_packs.json` with per-pack freshness; stale packs are flagged in the universe output.

## Candidate Comparison Logic

Compare candidates in layers:

```text
candidate pool coherence
→ value-chain layer and bottleneck fit
→ evidence confidence
→ financial quality
→ valuation payoff
→ technical timing
→ research priority
→ action readiness
```

Only same-layer candidates with sufficient evidence and open action conditions may produce a formal decision candidate. Mixed-layer, cross-theme, or data-diagnostic pools produce research priority, next evidence, and scope boundaries.

Use `assets/comparison_output_contract.schema.json` and `scripts/validate_comparison_report.py` as the final report contract. Final reports must include AI review status, AI dossier consumption, data acquisition summary, customer evidence matrix, valuation matrix, currency normalization, growth hypothesis, technical timing, capital actions, data consumption audit, readiness matrix, research debt, runbook, ranking, report readiness, and final decision.

## Strategy Forecast Loop

Use this route when the user asks what to do, how to allocate, which direction is actionable, what can change the thesis, or how the next 30/90/180 days may evolve.

Required loop:

```bash
python scripts/build_market_snapshot.py --out <market_snapshot.json>          # live benchmark indices
python scripts/build_market_regime.py --snapshot <market_snapshot.json> --out <market_regime.json>
python scripts/build_portfolio_context.py --from-csv <holdings.csv> --cash <amount> --out <portfolio_context.json>   # only when portfolio-level actions are requested
python scripts/build_laplace_strategy_input.py <comparison_final.json> \
  --market-regime <market_regime.json> \
  [--portfolio-context <portfolio_context.json>] \
  --out <laplace_strategy_input.json>
python scripts/validate_strategy_readiness.py <comparison_final.json>
python scripts/validate_laplace_strategy_input.py <laplace_strategy_input.json>
python scripts/build_laplace_strategy_prompt.py <laplace_strategy_input.json> --out <laplace_strategy_prompt.json>
python scripts/validate_laplace_strategy_judgment.py <laplace_strategy_judgment.json> --strategy-input <laplace_strategy_input.json>
python scripts/render_strategy_report.py <laplace_strategy_judgment.json> --strategy-input <laplace_strategy_input.json> --out <strategy_report.md>
python scripts/sync_strategy_ledger.py --strategy-input <laplace_strategy_input.json> --judgment <laplace_strategy_judgment.json> --out <strategy_ledger_sync.json>
```

Read `references/16_laplace_strategy_bridge.md` and the companion Laplace skill before writing strategy judgment. Strategy output must consume `strategy_readiness.allowed_strategy_modes`, preserve Serenity evidence constraints, open research debt, triggers, invalidation, scenarios, action plan, and review cadence.

Hard boundaries:

- Market regime is optional only when the question is unrelated to current market direction; without it, state that the market environment was not measured.
- Portfolio context is required for add, reduce, rebalance, position-size, and allocation-weight actions. Without it, keep the strategy at candidate, watchlist, trigger, and evidence-first levels and say so.
- Ledger claims should include `resolution_probe` (and `source_symbol`) whenever the claim can be checked from prices, fields, announcements, or a snapshot, so follow-up resolution is automatic.

Follow-up and calibration run through one command:

```bash
python scripts/update_watchlist_from_report.py <comparison_final.json> [--previous <old_watchlist.json>] --out <watchlist.json>
python scripts/serenity.py review --watchlist <watchlist.json> --fetch [--apply <review_outcome.json>]
```

Decision counsel contract: `serenity.py next` aggregates reality (live regime, tracked watchlist with prices/volume heat/machine-checked condition hits, portfolio vs benchmark with concentration flags, due reviews, resolvable claims, decision scoreboard). The AI then writes `decision_counsel.json` (`assets/decision_counsel.schema.json`) — market view, observed/inferred/judgment, one EXECUTE/DEFER/SKIP stance per briefed action with rationale/risk/invalidation, portfolio-level counsel — and validates with `scripts/validate_decision_counsel.py --brief <last_brief.json> --md-out <counsel.md>`. Hard rules: position-sizing language is rejected without portfolio context; HIGH confidence is rejected until at least 5 calibration claims are resolved; every briefed action must get exactly one stance. Watchlist items may carry `condition_probes` (resolution-probe grammar) so upgrade/downgrade conditions are machine-checked in every brief. Record what you actually did with `serenity.py decide <n> --did|--skip --note`; the journal feeds the next brief's scoreboard with counterfactual price moves.

State directory: the canonical tracked reality lives in `$SERENITY_STATE_DIR` (default `<cache>/state/`) — `watchlist.json`, optional `portfolio_context.json` (write with `build_portfolio_context.py --from-csv ... --state`), `last_brief.json`, and `decision_log.jsonl`. `update_watchlist_from_report --state` writes there (auto-merging the previous state with a `.bak` backup), `--add-scorecard <scorecard.json>` adds a single-memo conclusion so single-company research enters tracking instead of dead-ending, `serenity.py review` defaults to the state watchlist and writes applied outcomes back, and `serenity.py next` reads all of it. Research that never reaches the state directory is invisible to future decisions.

`review` computes due 30/90/180-day tasks (respecting review history), auto-resolves due machine-checkable claims with live prices, writes the calibration report and policy, and aggregates provider health. Apply review outcomes with `--apply` so watch states, history, and REMOVED decisions persist; pass `--previous` when regenerating a watchlist so review memory survives.

## Output Requirements

Every user-facing report should make these answers clear:

- What is known from real data.
- What is inferred by AI research.
- What judgment follows from the evidence.
- Which candidate or layer deserves research first.
- Whether action conditions are present.
- Which evidence blocks rating or action.
- What would upgrade, delay, reduce, or invalidate the thesis.
- What to check in 30, 90, and 180 days.

Use `references/05_output_templates.md` for report modes and `references/06_risk_compliance_no_guess.md` for evidence, rating, and compliance boundaries.

## Validation Gates

The orchestrator runs stage gates automatically and records them in the pipeline ledger. Run these directly when working on artifacts by hand:

```bash
python scripts/serenity.py doctor --skip-network
python scripts/validate_output_contract.py <formal_report.md> --require-delivery-proof --proof <delivery_proof.json> --verify-proof
python scripts/build_delivery_proof.py --verify <delivery_proof.json> --rerun-validators
python scripts/score_ai_research_dossier.py <dossier.json> --manifest <manifest.json>
python scripts/validate_comparison_report.py <comparison_final.json>
python scripts/validate_research_delivery.py <comparison_final.json>
python scripts/validate_laplace_strategy_judgment.py <judgment.json> --strategy-input <laplace_strategy_input.json>
python scripts/validate_skill.py .
python scripts/run_static_evals.py
```

The full per-artifact validator inventory (macro theme map, candidate funnel, portfolio context, market regime, manual evidence registration, provider health, agent behavior transcripts, benchmarks) is listed in `references/01_data_first_market_router.md` §10. When a gate fails, repair the artifact or lower the claim to the validated evidence boundary.

## Reference Map

- `references/01_data_first_market_router.md`: market routing, source ladders, forbidden substitutions, data gaps, full command inventory.
- `references/02_serenity_bottleneck_workflow.md`: value-chain bottleneck logic and Serenity thesis formation.
- `references/03_fundamental_valuation_framework.md`: financial realization, valuation, growth tiers, scenario reasoning.
- `references/04_chan_technical_framework.md`: conservative structure evidence, DMA/ATR technical health, and timing discipline.
- `references/05_output_templates.md`: user-facing report modes.
- `references/06_risk_compliance_no_guess.md`: evidence levels, rating caps, compliance boundaries.
- `references/15_ai_overlay_execution_protocol.md`: dossier, overlay, outcome, merge, delivery loop.
- `references/16_laplace_strategy_bridge.md`: Serenity-to-Laplace strategy handoff, review cycle, calibration.
- `references/17_industry_domain_packs.md`: built-in industry routes and candidate universe construction.
- `assets/ai_research_dossier_score.schema.json`, `assets/strategy_readiness.schema.json`, `assets/watchlist_item.schema.json`: research quality, strategy readiness, and watchlist contracts.
- `assets/delivery_proof.schema.json`, `assets/provider_health.schema.json`, `assets/manual_evidence.schema.json`, `assets/review_cycle.schema.json`, `assets/calibration_report.schema.json`: formal proof, source health, evidence return, review cycle, and calibration contracts.
- `companion-skills/laplace-forecast/UPSTREAM.md`: vendored-skill provenance and local diff.
