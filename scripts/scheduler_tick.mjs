import { runSchedulerTick } from "./services/scheduler-service.mjs";

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/scheduler_tick.mjs

Options:
  --source-id <id>       Run one configured scheduler source
  --cadence-key <key>    Filter by cadence: market, filing, industry
  --limit <n>            Maximum due sources to ingest
  --now <time>           Override current Shanghai time
  --force                Treat selected sources as due
  --force-route          Rewrite route decisions during ingestion
  --force-task           Rewrite pipeline tasks during ingestion
  --dry-run              Plan and exercise ingestion payloads without writing files
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

try {
  const { run, candidates } = await runSchedulerTick({
    sourceId: args.sourceId,
    cadenceKey: args.cadenceKey,
    limit: args.limit,
    now: args.now,
    force: Boolean(args.force),
    forceRoute: Boolean(args.forceRoute),
    forceTask: Boolean(args.forceTask),
    dryRun: Boolean(args.dryRun),
  });

  if (args.dryRun) {
    console.log(JSON.stringify({ run, candidates }, null, 2));
  } else {
    console.log(`Scheduler run ${run.id}: ${run.status}`);
    console.log(`Due: ${run.dueCount}, attempted: ${run.attemptedCount}, success: ${run.successCount}, failed: ${run.failureCount}`);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      result.help = true;
    } else if (item === "--dry-run") {
      result.dryRun = true;
    } else if (item === "--force") {
      result.force = true;
    } else if (item === "--force-route") {
      result.forceRoute = true;
    } else if (item === "--force-task") {
      result.forceTask = true;
    } else if (item.startsWith("--")) {
      const key = item
        .slice(2)
        .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      result[key] = argv[index + 1];
      index += 1;
    }
  }
  return result;
}
