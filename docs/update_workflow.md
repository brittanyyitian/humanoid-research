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
2. Add the fact under `data/events/`, `data/relations/`, `data/followups/` or `data/stocks/`.
3. Reference the source by `sourceIds`.
4. Run `npm run validate`.
5. Run `npm run generate`.

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
- Every promoted event still needs `sourceIds`, `sourceUrl`, `sourceName`, `evidenceLevel`, and `capturedAt`.
- Market quotes are structured data, but the stored row still needs the provider link and capture time.
- Dashboard reads only formal generated cache under `data/dashboard/`; inbox is review input, not truth.
