# Data Architecture

The repository follows SSOT first, dashboard derived.

```text
Evidence Layer
  raw_artifacts / route_decisions / pipeline_tasks / pipeline_runs / observation_runs / fetch_runs / scheduler_runs / claims / evidence / milestones / state_transitions

Data Layer
  entities / events / sources / relations / stocks

Research Layer
  company_daily / change_log / evidence_history / insights

Dashboard Layer
  dashboard/today.json
  dashboard/market.json
  dashboard/heat.json
  dashboard/timeline.json
  dashboard/followup.json
  dashboard/watchlist.json
  dashboard/observations.json
  dashboard/freshness.json
  dashboard/window_summary.json
  dashboard/upcoming.json
  dashboard/ingestion.json
  dashboard/pipelines.json
  dashboard/observation_projection.json
  dashboard/scheduler.json
```

## SSOT Boundary

`Observation` is a projection, not a fact source.

If a card is wrong, do not hand-edit `data/dashboard/observations.json`. Fix the
underlying layer:

```text
raw_artifact -> claim -> evidence -> review -> event/followup -> observation
```

The evidence layer answers:

- Where is the original material?
- What claim was extracted from it?
- Which evidence supports, mentions, refutes or updates the claim?
- When was it published, first seen, captured and processed?
- How did the claim status change?
- What future milestone still needs verification?

## Claim and Evidence

`claim` stores the fact candidate and review state. It should not carry
`sourceLevel` directly.

`evidence` stores source strength:

```text
claim = what might be true
evidence = how one source supports / mentions / refutes / updates that claim
```

This lets one claim have multiple A/B/C/D evidence records without flattening the
truth model into a single source score.

## Time Fields

Keep these time meanings separate:

```text
occurredAt   when the event actually happened
publishedAt  when the source published it
firstSeenAt  when this system first noticed it
capturedAt   when the artifact was fetched or manually captured
processedAt  when a claim was extracted or reviewed
dueAt        when a future verification window closes
resolvedAt   when the claim/follow-up/milestone was resolved
```

This prevents an old source captured today from being displayed as a new event.

## Serenity Bridge Boundary

Serenity may feed:

```text
market quotes
filings and announcements
financial report facts
share capital / market cap facts
source health
fetch failures
data gaps
```

It must not feed:

```text
technical buy points
valuation conclusions
portfolio or position advice
ratings
AI investment judgments
```

Serenity output must be converted into this repository's evidence layer before it
can affect dashboard projections.

## Ingestion Boundary

Ingestion is the v2.1 entry layer:

```text
URL / RSS / API / manual input
-> raw_artifact
-> route_decision
-> pipeline_task
-> claim/evidence
```

It is not a crawler and it is not a scheduler. Its only job is to make every
outside input enter the same evidence pipeline before any claim or observation
can be created.

The current entry command is:

```bash
npm run ingest:input -- --url "https://example.com/product" --entity-ids "unitree"
```

`capture:artifact` remains a compatibility tool for manual captures, but v2.1
automation should enter through `ingest:input`.

## Scheduler Boundary

Scheduler is the v2.1 heartbeat layer:

```text
scheduler source config
-> scheduler tick
-> ingestion entry
-> raw_artifact
-> route_decision
-> pipeline_task
```

It does not fetch broad web pages, extract claims, run pipelines or promote
observations. It only decides which configured source is due and hands that
source to ingestion.

The cadence buckets are:

```text
market    30-60 seconds
filing    10-30 minutes
industry  1-3 hours
```

Source configuration lives in `data/scheduler/sources.json`, run history lives
under `data/scheduler_runs/`, and last-run state lives in
`data/scheduler/state.json`.

The one-shot heartbeat command is:

```bash
npm run scheduler:tick
```

This one-shot shape is intentional: cron, GitHub Actions, a local daemon or a
future service can all call the same tick without duplicating scheduling logic.

## Router Boundary

Router is the first v2.1 automation layer:

```text
raw_artifact -> route_decision -> pipeline -> claim/evidence
```

It only decides where a raw artifact should go. It does not promote facts and it
does not create observations directly.

Supported route types:

```text
company
product
filing
event
policy
supply_chain
```

The route decision shape must include the user-facing minimum:

```json
{
  "type": "product",
  "entity": "Unitree",
  "pipeline": "product_pipeline"
}
```

Full decisions are stored under `data/route_decisions/` and the configured
mapping lives in `data/pipelines/pipeline_map.json`.

Router classification rules live in `data/router/rules.json`. Code executes
those rules; route keywords and source-kind rules should not drift back into
imperative code.

## Hardening Boundary

Hardening is the v2.2 stabilization gate:

```text
full replay
dedup
contamination check
lifecycle check
recovery check
rule isolation
```

The hardening command is:

```bash
npm run hardening:check
```

It is read-only. It must not write facts, dashboard projections, run records or
inbox items. `npm run check` includes this gate.

## Pipeline Task Boundary

`pipeline_tasks` are durable handoff records created by ingestion after routing.
They mean "this artifact is ready for a pipeline", not "the fact is true".

```text
route_decision
-> pipeline_task(status=queued)
-> pipeline_run
-> claim/evidence candidate
-> inbox review
```

Pipeline tasks can be replayed, retried, completed or marked as needing review.
Pipeline runs create claim/evidence candidates only. They must not promote
events, relations, follow-ups or observations.

## Observation Projection Boundary

Observation projection is the final v2.1 automation gate:

```text
formal event
+ promoted claim/evidence/state_transition
-> observation projection
-> observation card
```

The projection audit lives under `data/observation_runs/` and the latest
dashboard-facing audit is `data/dashboard/observation_projection.json`.

Candidate claims are explicitly excluded until review promotes them into a
formal event, relation, follow-up or stock snapshot. Observation projection must
not read directly from `pipeline_tasks`, `pipeline_runs` or inbox candidates.

## Source

Each source is immutable and stored in `data/sources/src_*.json`.

Events, relations, follow-ups and stock snapshots reference `sourceIds`. They do not duplicate URLs.

## Event

Events are typed. Supported event types:

```text
order
ipo
funding
conference
policy
partnership
demo
factory
hiring
patent
product
delivery
announcement
financial_report
```

## Follow-up Lifecycle

```text
pending -> confirmed -> completed -> archived
```

Additional terminal states:

```text
cancelled
stale
```

## Market Data Boundary

Stock data is stored as market facts only. The app does not infer causality between stock moves and industry events.

Forbidden words in market copy:

```text
because
caused
benefit
catalyst
利好
催化
受益
导致
因为
```
