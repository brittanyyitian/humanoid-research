#!/usr/bin/env bash
set -u

ROOT="/Users/edy/humanoid-research"
LOG_DIR="/tmp"
STAMP="$(date '+%Y-%m-%d %H:%M:%S %Z')"

cd "$ROOT"

echo "[$STAMP] humanoid-research daily update started"

run_step() {
  local name="$1"
  shift
  echo
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] STEP: $name"
  "$@"
  local code=$?
  if [ "$code" -ne 0 ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] STEP FAILED: $name code=$code"
    return "$code"
  fi
  echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] STEP OK: $name"
}

status=0

run_step "watchlist daily market snapshot" /usr/local/bin/npm run watchlist:daily || status=1
run_step "recent market history backfill" /usr/local/bin/npm run market:backfill -- --days 14 || status=1
run_step "official news candidate fetch" /usr/local/bin/npm run fetch:news || status=1
run_step "listed company announcement candidate fetch" /usr/local/bin/npm run fetch:announcements || status=1
run_step "official news candidate intake" /usr/local/bin/npm run intake:news -- --limit 240 --run-pipeline || status=1
run_step "high-priority material body fetch" /usr/local/bin/npm run fetch:material-bodies -- --limit 120 --limit-per-entity 2 --priority high || status=1
run_step "dashboard generation" /usr/local/bin/npm run generate || status=1
run_step "serenity provider data audit" /usr/local/bin/npm run serenity:provider -- --all --limit 5 || status=1
run_step "serenity scorecard refresh from latest local data" /usr/local/bin/npm run serenity:formal -- --all --scorecard-only || status=1
run_step "serenity official full-text deep review refresh" /usr/local/bin/npm run serenity:deep-reviews -- --all --force --only-evidence-generated || status=1
run_step "serenity daily stock judgment" /usr/local/bin/npm run serenity:stock-radar -- --all --force --refresh-ai-review-market || status=1
run_step "serenity judgment snapshot" /usr/local/bin/npm run serenity:judgments || status=1
run_step "serenity analysis runner" /usr/local/bin/npm run serenity:analyze -- --all || status=1
run_step "observation projection" /usr/local/bin/npm run observation:project || status=1
run_step "dashboard generation after observation projection" /usr/local/bin/npm run generate || status=1
run_step "hardening check" /usr/local/bin/npm run hardening:check || status=1

echo
echo "[$(date '+%Y-%m-%d %H:%M:%S %Z')] humanoid-research daily update finished status=$status"
exit "$status"
