# Vendored Skill Provenance

- Upstream: the standalone `laplace-forecast` skill (local canonical copy: `~/.claude/skills/laplace-forecast`).
- Vendored snapshot date: 2026-06-29 (added with "Add strategy companion and improve README architecture").
- Local modifications relative to upstream:
  - `scripts/forecast_ledger.py`: claim normalization preserves two additional
    optional claim fields — `resolution_probe` (machine-checkable resolution
    spec consumed by `scripts/resolve_due_claims.py`) and `source_symbol`
    (symbol hint for automatic price fetching). Both are additive and ignored
    by upstream tooling.

## Sync policy

Keep this copy byte-identical to upstream except for the modifications listed
above. When upstream evolves, re-vendor and re-apply the listed diff. To push
the extension upstream (recommended, it is generally useful):

```bash
cp companion-skills/laplace-forecast/scripts/forecast_ledger.py \
   ~/.claude/skills/laplace-forecast/scripts/forecast_ledger.py
```

After upstreaming, remove the entry from the modification list so drift checks
stay honest.
