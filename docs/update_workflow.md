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
data/pipeline_runs/prun_*.json
data/claims/claim_*.json
data/evidence/evd_*.json
data/inbox/claim_candidates.json
```

Pipeline output is still only a candidate. It must remain in inbox until manual
review promotes it into events, relations, follow-ups or stocks.

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
