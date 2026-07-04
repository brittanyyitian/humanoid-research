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
