# Update Workflow

## Permanent Data

Store permanently:

- company records
- public events
- official announcements
- partnerships
- orders
- financial reports
- stock close snapshots
- sources
- evidence level
- follow-up history
- daily dashboard final snapshots

## Temporary Data

Do not commit:

- intraday every-minute market data
- logs
- API keys
- cookies
- generated local cache under `data/live/`

## Manual Data Entry Gate

Before adding a fact:

1. Create or reuse a source file under `data/sources/`.
2. Save the original material under `data/raw_artifacts/`.
3. Extract one or more fact candidates under `data/claims/`.
4. Add `data/evidence/` records that support, mention, refute or update each claim.
5. Promote only reviewed claims into `data/events/`, `data/relations/`, `data/followups/` or `data/stocks/`.
6. Run `npm run validate`.
7. Run `npm run generate`.

If validation fails, the fact should not appear in Dashboard.

## V2.2 Hardening Gate

Run hardening before treating the pipeline as stable:

```bash
npm run hardening:check
```

For full machine-readable output:

```bash
npm run hardening:check -- --json
```

The hardening gate is read-only and checks:

```text
router replay
dedup
ingestion idempotency
pipeline idempotency
rule contract
observation replay
contamination
claim lifecycle
failure recovery
rule isolation
```

`npm run check` runs validation, rule stress tests, hardening, then build. A
hardening error means the system may be producing unstable or polluted research
data.

## V2 Semantic Stress Gate

Use the Rule Contract stress suite before expanding pipelines or adding new
sources:

```bash
npm run rule:stress
```

The suite reads `data/rule_contract/stress_cases.json`, calls
`applySkillRule(...)` directly, and asserts that generated `rule_outputs` can
express:

```text
product specs
delivery windows
partner/customer hints
financial reconciliation requirements
time-field separation
conflicting evidence
review-only fallback for unsupported pipeline signals
```

Stress tests are read-only. They must not create claims, evidence, inbox rows or
observations. A failing stress case means the contract cannot yet represent that
kind of real-world material, so the next step should be rule refinement rather
than UI, scheduler or data-source expansion.

## V2.1 Ingestion Entry

Use ingestion as the unified entry layer for URL/RSS/API/manual inputs. It turns
an input into a raw artifact, routes it, then queues the pipeline handoff.

```bash
npm run ingest:input -- \
  --url "https://example.com/product" \
  --title "Official product page title" \
  --publisher "Company name" \
  --entity-ids "unitree" \
  --artifact-type product_page \
  --source-type webpage \
  --published-at "2026-07-04T10:00:00+08:00"
```

Supported entry types:

```text
url
rss
api
manual
```

The output chain is:

```text
source
raw_artifact
raw_artifacts/payloads/<raw_id>.json
fetch_run(sourceType=ingestion)
inbox artifact candidate
route_decision
pipeline_task(status=queued)
```

For a non-writing check:

```bash
npm run ingest:input -- --url "https://example.com/product" --entity-ids "unitree" --dry-run
```

This step does not extract claims and does not promote observations. It only
creates the durable handoff into the routed pipeline.

If the source body has not been fetched, ingestion still writes a local payload
record for the captured metadata. The matching `fetch_run` must include an
`attemptLedger` and a `raw_payload_not_fetched` gap, so later reviewers do not
mistake metadata-only intake for full source retrieval.

## V2.1 Scheduler Tick

Use Scheduler as the system heartbeat. It reads configured sources, checks
whether each source is due, then calls ingestion for due items.

```bash
npm run scheduler:tick
```

For a non-writing check:

```bash
npm run scheduler:tick -- --dry-run --force
```

Run only one source:

```bash
npm run scheduler:tick -- --source-id industry_unitree_h2plus_product --force
```

Scheduler writes:

```text
data/scheduler/state.json
data/scheduler_runs/sched_*.json
```

The frequencies are configured in `data/scheduler/sources.json`:

```text
market    30-60 seconds
filing    10-30 minutes
industry  1-3 hours
```

Scheduler must not extract claims, promote facts or edit observations. Those
remain downstream pipeline and review steps.

## V2.1 Pipeline Run

Use Pipeline Run after Router and Scheduler have queued `pipeline_tasks`.

Run one task:

```bash
npm run pipeline:run -- --task-id ptask_2026_07_04_9aa9c4575978
```

Run all queued tasks:

```bash
npm run pipeline:run -- --all
```

For a non-writing check:

```bash
npm run pipeline:run -- --task-id ptask_2026_07_04_9aa9c4575978 --dry-run
```

Pipeline writes:

```text
data/rule_outputs/rout_*.json
data/pipeline_runs/prun_*.json
data/claims/claim_*.json
data/evidence/evd_*.json
data/inbox/claim_candidates.json
```

Pipeline output is still only a candidate. It must remain in inbox until manual
review promotes it into events, relations, follow-ups or stocks.

## V2 Skill Rule Contract

All pipelines must generate `rule_outputs` before writing claim/evidence
candidates. The contract is:

```text
raw_artifact + source + payload
-> skill_rule_contract_v0
-> claimCandidates
-> evidenceCandidates
-> unknowns
-> followupHints
-> dataGaps
-> extractedFields
-> timeFields
-> reviewRequirements
```

Rules:

- `sourceLevel` stays on evidence, not on claim.
- Unknown fields must be explicit instead of hidden in prose.
- Extracted fields are review hints, not promoted facts.
- Review requirements must travel into `inbox/claim_candidates.json`.
- Data gaps from fetch runs must remain attached to the rule output.
- A completed `pipeline_task` must reference at least one `ruleOutputId`.

The rule engine currently covers `product_pipeline` and `filing_pipeline` with
dedicated rules. Other pipelines use a generic rule output until their domain
rules are added.

## V2 Serenity Bridge

Use Serenity Bridge as the real-world listed-company adapter. It imports
Serenity fetch manifests into this repository's evidence pipeline without
accepting Serenity's decision layer.

```bash
npm run serenity:bridge -- \
  --manifest data/serenity_bridge/samples/orbbec_688322/manifest.json \
  --run-pipeline
```

For a non-writing check:

```bash
npm run serenity:bridge -- \
  --manifest data/serenity_bridge/samples/orbbec_688322/manifest.json \
  --dry-run
```

Bridge v0 writes:

```text
data/sources/src_serenity_*.json
data/raw_artifacts/raw_*_serenity_*.json
data/raw_artifacts/payloads/raw_*_serenity_*.json
data/fetch_runs/fetch_*_serenity_*.json
data/route_decisions/route_*.json
data/pipeline_tasks/ptask_*.json for filings/financials
data/stocks/stk_*_serenity_quote.json
data/dashboard/serenity_bridge.json after generate
```

Rules:

- `current_quote` becomes a stock snapshot and does not generate a claim.
- `filings_announcements` becomes filing claim candidates in inbox.
- `financials` becomes a low-confidence financial claim candidate when the source is L3.
- Serenity data gaps stay on `fetch_runs.gaps` and `dashboard/serenity_bridge.json`.
- `valuation_inputs`, `rating`, `portfolio`, `buy_point`, and sizing outputs are blocked by `data/serenity_bridge/dataset_map.json`.
- Nothing from Bridge is promoted into `events`, `followups`, or `observations` automatically.

## V2.1 Observation Projection

Use Observation Projection after `npm run generate` has refreshed dashboard
observations.

```bash
npm run observation:project
```

For a non-writing check:

```bash
npm run observation:project -- --dry-run
```

Observation projection writes:

```text
data/observation_runs/obsrun_*.json
data/dashboard/observation_projection.json
```

Projection can include only:

```text
formal events
promoted verified claims
supporting evidence attached to promoted claims
state transitions attached to promoted claims
```

Pipeline candidates stay excluded until review promotes them. A projection run
with unpromoted claims, missing claims, or missing evidence in observation rows
must fail validation. `data/dashboard/observations.json` is regenerated with the
same gate, so the website only receives displayable Observation cards.

## Inbox Fetch Gate

Use inbox for raw or semi-structured fetch results:

1. Run `npm run fetch:market` for Watchlist A-share quote candidates.
2. Run `npm run fetch:market:promote` only when structured quotes should update the formal daily stock snapshot.
3. Run `npm run fetch:news` for official news page candidates.
4. Review files under `data/inbox/`.
5. Promote only verified facts into the formal data layer.

Rules:

- News candidates never enter `data/events/` automatically.
- Claim candidates do not become truth until reviewed and promoted.
- Every promoted event still needs `sourceIds`, `sourceUrl`, `sourceName`, `evidenceLevel`, and `capturedAt`.
- Market quotes are structured data, but the stored row still needs the provider link and capture time.
- Dashboard reads only formal generated cache under `data/dashboard/`; inbox is review input, not truth.

## First V1 Evidence Loop

The first complete loop should stay narrow:

```text
manual official/product link
-> raw_artifact
-> claim
-> evidence
-> manual review
-> event/followup
-> observation
```

Only after this loop validates cleanly should the project add heavier fetchers or
Serenity Bridge automation.

## Manual Evidence CLI

Use these scripts for the first manual-link workflow or for compatibility with
older v1 evidence-loop commands. New v2.1 automation should prefer
`ingest:input`.

Capture an official source or product page:

```bash
npm run capture:artifact -- \
  --url "https://example.com/product" \
  --title "Official product page title" \
  --publisher "Company name" \
  --entity-ids "unitree" \
  --artifact-type product_page \
  --source-type webpage \
  --published-at "2026-07-04T10:00:00+08:00"
```

Extract a reviewed claim candidate from that artifact:

```bash
npm run extract:claims -- \
  --artifact-id raw_2026_07_04_example_com_abcd123456 \
  --claim-type product_release \
  --claim "Company released product X." \
  --entity-ids "unitree" \
  --confidence medium
```

Promote a claim only after manual review:

```bash
npm run promote:claim -- \
  --claim-id claim_2026_07_04_product_release_abcd123456 \
  --event-type product \
  --module "整机厂" \
  --title "Company released product X" \
  --importance 3
```

All three scripts support `--dry-run`.

## Router CLI

Route one captured raw artifact:

```bash
npm run route:artifact -- --artifact-id raw_2026_07_04_example_com_abcd123456
```

Route all artifacts that do not already have route decisions:

```bash
npm run route:artifact -- --all
```

Router output goes to `data/route_decisions/`. It decides the pipeline only; it
does not extract claims and does not promote formal events.
