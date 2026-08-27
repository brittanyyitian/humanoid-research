# Laplace Strategy Bridge

Use this bridge when Serenity research must become a forecast, strategy, allocation, or action plan.

## Purpose

Serenity provides observed market data, evidence gates, research debt, valuation state, technical state, and candidate priority. Laplace provides scenario weighting, decision-owner modeling, dominant-variable arbitration, triggers, invalidation, and forecast ledgering.

The current AI agent performs the bridge. Deterministic scripts prepare the structured input; the AI reads the input and the companion skill, then writes the strategy judgment in Chinese.

## Repository Layout

- Companion skill: `companion-skills/laplace-forecast/`
- Strategy input schema: `assets/laplace_strategy_input.schema.json`
- Strategy readiness schema: `assets/strategy_readiness.schema.json`
- Strategy input builder: `scripts/build_laplace_strategy_input.py`
- Strategy readiness validator: `scripts/validate_strategy_readiness.py`
- Strategy input validator: `scripts/validate_laplace_strategy_input.py`
- Strategy prompt builder: `scripts/build_laplace_strategy_prompt.py`
- Strategy judgment schema: `assets/laplace_strategy_judgment.schema.json`
- Strategy judgment validator: `scripts/validate_laplace_strategy_judgment.py`
- Strategy report renderer: `scripts/render_strategy_report.py`
- Market regime builder: `scripts/build_market_regime.py`
- Portfolio context validator: `scripts/validate_portfolio_context.py`
- Ledger sync: `scripts/sync_strategy_ledger.py`
- Due-claim resolver: `scripts/resolve_due_claims.py`
- Calibration report: `scripts/build_calibration_report.py`
- Watchlist builder: `scripts/update_watchlist_from_report.py`
- Review cycle builder: `scripts/run_review_cycle.py`

## Required Flow

1. Produce a validated Serenity `comparison_final.json` with `report_readiness.stage=FINAL_REPORT_READY`.
2. Validate formal delivery:

```bash
python scripts/validate_research_delivery.py comparison_final.json
```

3. Evaluate strategy readiness. It decides whether the completed report supports allocation, watchlist, evidence-trigger, or research-plan mode:

```bash
python scripts/validate_strategy_readiness.py comparison_final.json
```

4. Build market regime when the question depends on the current market environment:

```bash
python scripts/build_market_regime.py --snapshot market_snapshot.json --out market_regime.json
```

5. Validate portfolio context before portfolio-level actions:

```bash
python scripts/validate_portfolio_context.py portfolio_context.json
```

6. Build the strategy input; internal baselines, agent queues, `NOT_RUN`, and quick diagnostic outputs are rejected:

```bash
python scripts/build_laplace_strategy_input.py comparison_final.json \
  --theme "A股机器人与AI算力" \
  --horizon "3-6个月" \
  --decision-use "watchlist allocation and action triggers" \
  --market-regime market_regime.json \
  --out laplace_strategy_input.json
```

Use `--portfolio-context portfolio_context.json` when the answer needs add, reduce, rebalance, position-size, or allocation-weight actions.

7. Validate the strategy input:

```bash
python scripts/validate_laplace_strategy_input.py laplace_strategy_input.json
```

8. Build the strategy prompt package:

```bash
python scripts/build_laplace_strategy_prompt.py laplace_strategy_input.json \
  --out laplace_strategy_prompt.json
```

9. Read `companion-skills/laplace-forecast/SKILL.md`.
10. Read `companion-skills/laplace-forecast/references/first-order-lenses.md` when the question involves a theme, industry, market trend, or allocation.
11. Read `companion-skills/laplace-forecast/references/evidence-loop.md` when evidence is partial, contradictory, proxy-based, or decision-grade.
12. Read `companion-skills/laplace-forecast/references/ledger-schema.md` when the result should be revisited or scored later.
13. Produce `laplace_strategy_judgment.json` using `assets/laplace_strategy_judgment.schema.json`; user-facing fields use Chinese and preserve observed / inferred / judgment labels.
14. Validate and render the strategy result:

```bash
python scripts/validate_laplace_strategy_judgment.py laplace_strategy_judgment.json \
  --strategy-input laplace_strategy_input.json

python scripts/render_strategy_report.py laplace_strategy_judgment.json \
  --strategy-input laplace_strategy_input.json \
  --out strategy_report.md
```

## Output Requirements

The strategy answer must include:

- `Forecast`: directional view and probability range.
- `Decision`: watch, avoid, enter slowly, rebalance, hedge, or wait.
- `Decision model`: default profile, horizon, constraints, and reversibility.
- `Observed`: facts from Serenity matrices.
- `Inferred`: implications from facts and proxies.
- `Judgment`: scenario weighting and action preference.
- `Dominant variables`: 3-7 variables that actually move the view.
- `Scenarios`: base, upside, downside.
- `Triggers`: 30 / 90 / 180 day signals.
- `Invalidation`: events that should break the thesis.
- `Next evidence`: the cheapest useful evidence to check next.
- `Action plan`: candidate buckets, position discipline, add/trim rules, and data gates.
- Market context: broad regime, benchmark health, and relative-strength implications when available.
- Portfolio context: account scope, current positions, risk constraints, and action boundary when available.

## Strategy Judgment Contract

`laplace_strategy_judgment.json` is the executable strategy artifact. It must contain:

- `forecast`, `decision`, and `decision_model` as concise Chinese text.
- `observed`, `inferred`, and `judgment` as separate arrays.
- `dominant_variables` with variable, role, direction, confidence, and why.
- `scenarios.base`, `scenarios.upside`, and `scenarios.downside`; probabilities must sum to approximately 1.
- `triggers.30d`, `triggers.90d`, and `triggers.180d`.
- `invalidation`, `next_evidence`, `action_plan`, `confidence`, and `ledger_claims`.

When Serenity ranking validity is `PARTIAL` or `INVALID`, the validator requires a gated watch/wait/evidence-first decision. The strategy layer keeps research leads separate from action candidates.

Portfolio-level actions require validated portfolio context. Without it, strategy judgment stays at candidate ranking, watchlist, evidence trigger, and invalidation levels.

## Readiness And Watchlist

`strategy_readiness` is the action boundary:

- `ACTION_READY`: allocation mode, watchlist mode, evidence-trigger mode, and research-plan mode are available.
- `WATCHLIST_READY`: tracking, upgrade/downgrade conditions, and review cadence are available.
- `EVIDENCE_FIRST`: next evidence and trigger design are available.
- `BLOCKED`: return to data, AI research, or candidate-pool repair.

When readiness allows watchlist mode, create a tracked watchlist:

```bash
python scripts/update_watchlist_from_report.py comparison_final.json --out watchlist.json
```

The watchlist preserves upgrade conditions, downgrade conditions, next evidence, evidence debt, and 30/90/180 day triggers.

Convert watchlist triggers into due review tasks:

```bash
python scripts/run_review_cycle.py watchlist.json --due-before today --out review_cycle.json
```

Apply a completed review outcome back into the watchlist:

```bash
python scripts/run_review_cycle.py watchlist.json --apply review_outcome.json --out watchlist_updated.json
```

The review cycle is the operational handoff for revisiting price, filings, valuation inputs, customer/order/capacity evidence, technical structure, upgrade conditions, downgrade conditions, and unresolved research debt.

## Guardrails

- Do not treat a Serenity ranking as a portfolio allocation by itself.
- Do not upgrade a candidate through Laplace when Serenity has a hard data gate.
- Do not erase research debt; convert it into next evidence and invalidation.
- Do not use market heat as evidence-supported growth.
- Do not output personalized financial advice, return promises, or trade execution instructions.
- Use Chinese for user-facing text.

## Ledger Policy

When the strategy affects a reusable watchlist, medium-term theme view, or allocation plan, create or update a Laplace forecast ledger record:

```bash
python scripts/sync_strategy_ledger.py \
  --strategy-input laplace_strategy_input.json \
  --judgment laplace_strategy_judgment.json \
  --ledger forecast-ledger.sqlite \
  --out strategy_ledger_sync.json
```

Ledger records need observable claims, numeric probabilities, resolution dates, and resolution criteria. Add `resolution_probe` to claims that can be checked from price, structured fields, announcement keywords, or a supplied snapshot.

Resolve due machine-checkable claims and update calibration:

```bash
python scripts/resolve_due_claims.py \
  --ledger forecast-ledger.sqlite \
  --snapshot resolution_snapshot.json \
  --due-before 2026-07-03 \
  --out resolved_claims.json

python scripts/build_calibration_report.py \
  --ledger forecast-ledger.sqlite \
  --out calibration_report.json
```

`python scripts/serenity.py review --watchlist <watchlist.json> --fetch` runs the whole follow-up in one command: due review tasks (respecting review history), automatic price-based claim resolution, the calibration report plus machine-consumed policy, and provider health. Use the ledger agenda together with `scripts/run_review_cycle.py` when revisiting old work by hand: Laplace tracks probabilistic claims; Serenity tracks evidence and action gates due for review.
