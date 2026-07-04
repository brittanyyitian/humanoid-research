import { ingestInput, payloadSummary } from "./services/ingestion-service.mjs";

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/ingest_input.mjs --url <url> [--entity-ids <id,id>]

Options:
  --input-type <url|rss|api|manual>  Default: url
  --title <title>
  --publisher <publisher>
  --entity-ids <id,id>               Required when entity cannot be inferred
  --artifact-type <type>             Default: inferred
  --source-type <type>               Default: inferred
  --source-id <id>                   Reuse or set a source id
  --source-level <A-D>               Default: inferred
  --published-at <time>
  --captured-at <time>               Default: current Shanghai time
  --notes <text>
  --no-route                         Capture only, without route_decision
  --no-pipeline-task                 Route only, without queueing a pipeline task
  --force-route                      Rewrite route decision for this artifact
  --force-task                       Rewrite pipeline task for this route
  --dry-run                          Print payloads without writing files
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

if (!args.url) {
  console.error("Missing required option: url");
  console.error(usage());
  process.exit(1);
}

try {
  const payloads = await ingestInput({
    inputType: args.inputType,
    url: args.url,
    title: args.title,
    publisher: args.publisher,
    entityIds: args.entityIds,
    artifactType: args.artifactType,
    sourceType: args.sourceType,
    sourceId: args.sourceId,
    sourceLevel: args.sourceLevel,
    publishedAt: args.publishedAt,
    capturedAt: args.capturedAt,
    notes: args.notes,
    autoRoute: !args.noRoute,
    enqueuePipeline: !args.noPipelineTask,
    forceRoute: Boolean(args.forceRoute),
    forceTask: Boolean(args.forceTask),
    dryRun: Boolean(args.dryRun),
  });

  if (args.dryRun) {
    console.log(JSON.stringify(payloads, null, 2));
  } else {
    const summary = payloadSummary(payloads);
    console.log(`Ingested artifact ${summary.rawArtifactId}`);
    if (summary.routeDecisionId) console.log(`Route decision: ${summary.routeDecisionId}`);
    if (summary.pipelineTaskId) console.log(`Pipeline task: ${summary.pipelineTaskId}`);
    if (summary.pipeline) console.log(`Pipeline: ${summary.pipeline}`);
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
    } else if (item === "--no-route") {
      result.noRoute = true;
    } else if (item === "--no-pipeline-task") {
      result.noPipelineTask = true;
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
