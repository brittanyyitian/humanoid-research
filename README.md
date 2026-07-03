# China Humanoid Robotics Research OS

Local-first research dashboard for domestic humanoid robotics.

This project is not a news site and not a stock-picking tool. It is a research record system:

- Data layer stores verified facts.
- Research layer records changes, evidence movement and follow-up lifecycle.
- Dashboard layer displays only derived views.

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
  entities/      SSOT company and segment records
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

