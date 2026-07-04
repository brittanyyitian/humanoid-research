# Data Architecture

The repository follows SSOT first, dashboard derived.

```text
Evidence Layer
  raw_artifacts / claims / evidence / fetch_runs / milestones / state_transitions

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
