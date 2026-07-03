# Data Architecture

The repository follows SSOT first, dashboard derived.

```text
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
```

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

