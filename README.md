# China Humanoid Robotics Research OS

Local-first research dashboard for domestic humanoid robotics.

This project is not a news site and not a stock-picking tool. It is a research record system:

- Evidence layer stores raw materials, claims and evidence.
- Data layer stores verified facts.
- Research layer records changes, evidence movement and follow-up lifecycle.
- Dashboard layer displays only derived views.

See [PRODUCT_PRINCIPLES.md](PRODUCT_PRINCIPLES.md) for the product boundary:

- The system organizes facts, not conclusions.
- The system supports research, not investment decisions.
- 系统组织事实，不组织观点。
- 系统支持研究，不替代投资决策。

## Core Rule

No source link, no official data.

Formal data must include:

- `date`
- `sourceIds`
- `evidenceLevel`
- `fact`
- `module`
- `entityIds`

Dashboard files are generated artifacts. Do not hand-edit them.

Observation cards are not the source of truth. If an observation is wrong, fix the
underlying `claim`, `evidence`, `source`, `event` or `followup`, then regenerate
the dashboard cache.

## Commands

```bash
npm install --cache .npm-cache
npm run validate
npm run generate
npm run dev
npm run build
```

## Directory

```text
data/
  raw_artifacts/  original webpages, filings, PDFs or bridge outputs
  claims/         fact candidates extracted from raw artifacts
  evidence/       source-level support, mention, refutation or update records
  fetch_runs/     fetch/bridge/manual-link run ledger
  milestones/     public future verification windows
  state_transitions/ claim/follow-up/event status changes
  entities/      SSOT company and segment records
  entity_aliases/ alias registry for later extractor work
  products/      product records for later extractor work
  events/        verified industry events
  relations/     verified cooperation and supply-chain relations
  followups/     follow-up lifecycle records
  sources/       immutable source records
  stocks/        stock snapshots with sources
  notes/         user research notes, not formal facts
  research/      derived research layer
  dashboard/     generated dashboard cache
  live/          intraday temporary files, ignored by git
```

## Daily Flow

```text
09:30-15:00  update local live market snapshots
15:05        write close snapshot
20:30        update verified events and follow-ups
20:35        npm run validate
20:36        npm run generate
21:00        commit daily final data
```
