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

