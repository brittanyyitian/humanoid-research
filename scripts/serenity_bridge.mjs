import { runSerenityBridge } from "./services/serenity-bridge-service.mjs";

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/serenity_bridge.mjs --manifest <serenity_manifest.json>

Options:
  --base-dir <dir>       Base directory for Serenity data_path values
  --entity-id <id>       Override entity mapping
  --captured-at <time>   Bridge import time, default current Shanghai time
  --run-pipeline         Run queued filing/financial pipeline tasks after import
  --force-pipeline       Re-run selected pipeline tasks even if already completed
  --dry-run              Print payload summary without writing files
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

if (!args.manifest) {
  console.error("Missing required option: --manifest");
  console.error(usage());
  process.exit(1);
}

try {
  const result = await runSerenityBridge({
    manifestPath: args.manifest,
    baseDir: args.baseDir,
    entityId: args.entityId,
    capturedAt: args.capturedAt,
    runPipeline: Boolean(args.runPipeline),
    forcePipeline: Boolean(args.forcePipeline),
    dryRun: Boolean(args.dryRun),
  });

  if (args.dryRun) {
    console.log(JSON.stringify(result.summary, null, 2));
  } else {
    const summary = result.summary;
    console.log(`Serenity Bridge import complete for ${summary.entityId} (${summary.symbol})`);
    console.log(`Raw artifacts: ${summary.rawArtifacts}`);
    console.log(`Stock snapshots: ${summary.stockSnapshots}`);
    console.log(`Pipeline tasks: ${summary.pipelineTasks}`);
    console.log(`Data gaps: ${summary.dataGaps}`);
    if (args.runPipeline) {
      console.log(
        `Pipeline: completed=${summary.pipelineCompleted}, skipped=${summary.pipelineSkipped}, failed=${summary.pipelineFailed}`
      );
    }
    if (summary.skipped) {
      console.log(`Skipped datasets: ${summary.skipped}`);
    }
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
    } else if (item === "--run-pipeline") {
      result.runPipeline = true;
    } else if (item === "--force-pipeline") {
      result.forcePipeline = true;
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
