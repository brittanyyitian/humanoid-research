import { runPipelineTasks } from "./services/pipeline-service.mjs";

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/run_pipeline.mjs --task-id <pipeline_task_id>
  node scripts/run_pipeline.mjs --all

Options:
  --pipeline <name>  Run queued tasks for one pipeline
  --force            Re-run selected task(s) even if already completed
  --dry-run          Print execution result without writing files
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

if (!args.taskId && !args.all && !args.pipeline) {
  console.error("Missing --task-id, --pipeline or --all");
  console.error(usage());
  process.exit(1);
}

try {
  const result = await runPipelineTasks({
    taskId: args.taskId,
    pipeline: args.pipeline,
    all: Boolean(args.all),
    force: Boolean(args.force),
    dryRun: Boolean(args.dryRun),
  });

  if (args.dryRun) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `Pipeline run complete. selected=${result.selectedCount}, completed=${result.successCount}, skipped=${result.skippedCount}, failed=${result.failureCount}`
    );
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
    } else if (item === "--all") {
      result.all = true;
    } else if (item === "--force") {
      result.force = true;
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
