import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./data-utils.mjs";
import { ingestInput, payloadSummary } from "./services/ingestion-service.mjs";
import { runPipelineTasks } from "./services/pipeline-service.mjs";
import { nowShanghai } from "./services/router-service.mjs";

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/intake_news_candidates.mjs [--run-pipeline]

Options:
  --candidate-id <id>       Process one news candidate
  --source-id <id>          Process one official source id
  --entity-ids <ids>        Process candidates for comma-separated entity ids
  --limit <n>               Max candidates to ingest
  --include-undated         Also ingest candidates without publishedAt
  --run-pipeline            Run generated pipeline task(s) into claim/evidence candidates
  --force                   Re-ingest candidates that already have rawArtifactId
  --dry-run                 Print the plan without writing files
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

const inboxPath = path.join(DATA_DIR, "inbox", "news_candidates.json");
const inbox = await readJsonFile(inboxPath);
const capturedAt = nowShanghai();
const candidates = Array.isArray(inbox.candidates) ? inbox.candidates : [];
const results = [];
let selectedCount = 0;

for (const candidate of candidates) {
  const decision = selectionDecision(candidate);
  if (!decision.selected) {
    if (decision.report) results.push(decision.report);
    continue;
  }
  if (args.limit && selectedCount >= Number(args.limit)) break;
  selectedCount += 1;
  results.push(await ingestCandidate(candidate));
}

if (!args.dryRun) {
  inbox.capturedAt = capturedAt;
  inbox.candidateCount = candidates.length;
  await writeJsonFile(inboxPath, inbox);
}

const summary = {
  dryRun: Boolean(args.dryRun),
  selectedCount,
  ingestedCount: results.filter((item) => item.status === "ingested").length,
  pipelineCompletedCount: results.filter((item) => item.pipelineStatus === "completed").length,
  skippedCount: results.filter((item) => item.status === "skipped").length,
  failedCount: results.filter((item) => item.status === "failed").length,
  results,
};

if (args.dryRun) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(
    `News intake complete. selected=${summary.selectedCount}, ingested=${summary.ingestedCount}, pipelineCompleted=${summary.pipelineCompletedCount}, skipped=${summary.skippedCount}, failed=${summary.failedCount}`
  );
}

async function ingestCandidate(candidate) {
  const url = candidate.url || candidate.sourceUrl;
  const entityIds = normalizeEntityIds(candidate.entityIds || candidate.entityId);
  try {
    const payloads = await ingestInput({
      inputType: "url",
      url,
      title: candidate.title,
      publisher: candidate.publisher || candidate.sourceName,
      entityIds,
      artifactType: candidate.artifactType || "news_page",
      sourceType: candidate.ingestionSourceType || "news",
      sourceLevel: candidate.suggestedEvidenceLevel || candidate.sourceLevel || "A",
      publishedAt: candidate.publishedAt || null,
      capturedAt,
      notes: `Official News Intake v0 from ${candidate.id}; listSourceId=${candidate.sourceId || "unknown"}.`,
      autoRoute: true,
      enqueuePipeline: true,
      forceRoute: Boolean(args.force),
      forceTask: Boolean(args.force),
      dryRun: Boolean(args.dryRun),
    });
    const ingestSummary = payloadSummary(payloads);
    const result = {
      candidateId: candidate.id,
      title: candidate.title,
      url,
      ...ingestSummary,
      ingestionStatus: ingestSummary.status || "queued",
      status: "ingested",
    };

    if (!args.dryRun) {
      candidate.status = "ingested";
      candidate.ingestionStatus = ingestSummary.status || "queued";
      candidate.ingestedAt = capturedAt;
      candidate.rawArtifactId = ingestSummary.rawArtifactId;
      candidate.routeDecisionId = ingestSummary.routeDecisionId;
      candidate.pipelineTaskId = ingestSummary.pipelineTaskId;
      candidate.pipeline = ingestSummary.pipeline;
      delete candidate.lastIngestError;
    }

    if (args.runPipeline && ingestSummary.pipelineTaskId) {
      if (args.dryRun) {
        result.pipelineStatus = "planned";
      } else {
        const pipelineResult = await runPipelineTasks({ taskId: ingestSummary.pipelineTaskId });
        const taskResult = pipelineResult.results[0] || {};
        result.pipelineStatus = taskResult.status || "unknown";
        result.claimIds = taskResult.claimIds || [];
        result.evidenceIds = taskResult.evidenceIds || [];
        result.ruleOutputIds = taskResult.ruleOutputIds || [];
        result.pipelineRunIds = [taskResult.pipelineRunId].filter(Boolean);
        candidate.pipelineStatus = result.pipelineStatus;
        candidate.claimIds = result.claimIds;
        candidate.evidenceIds = result.evidenceIds;
        candidate.ruleOutputIds = result.ruleOutputIds;
        candidate.pipelineRunIds = result.pipelineRunIds;
      }
    }

    return result;
  } catch (error) {
    if (!args.dryRun) {
      candidate.lastIngestError = String(error.message || error);
      candidate.lastIngestAttemptedAt = capturedAt;
    }
    return {
      candidateId: candidate.id,
      title: candidate.title,
      url,
      status: "failed",
      error: String(error.message || error),
    };
  }
}

function selectionDecision(candidate) {
  if (args.candidateId && candidate.id !== args.candidateId) {
    return { selected: false };
  }
  if (args.sourceId && candidate.sourceId !== args.sourceId) {
    return { selected: false };
  }
  if (args.entityIds) {
    const wanted = new Set(normalizeEntityIds(args.entityIds));
    const candidateEntities = normalizeEntityIds(candidate.entityIds || candidate.entityId);
    if (!candidateEntities.some((entityId) => wanted.has(entityId))) return { selected: false };
  }
  if ((candidate.rawArtifactId || candidate.status === "ingested") && !args.force) {
    return {
      selected: false,
      report: {
        candidateId: candidate.id,
        title: candidate.title,
        status: "skipped",
        reason: "already ingested",
      },
    };
  }
  const url = candidate.url || candidate.sourceUrl;
  if (!String(url || "").startsWith("http")) {
    return {
      selected: false,
      report: {
        candidateId: candidate.id,
        title: candidate.title,
        status: "skipped",
        reason: "missing article url",
      },
    };
  }
  if (!candidate.publishedAt && !args.includeUndated) {
    return {
      selected: false,
      report: {
        candidateId: candidate.id,
        title: candidate.title,
        status: "skipped",
        reason: "missing publishedAt",
      },
    };
  }
  return { selected: true };
}

function normalizeEntityIds(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      result.help = true;
    } else if (item === "--dry-run") {
      result.dryRun = true;
    } else if (item === "--include-undated") {
      result.includeUndated = true;
    } else if (item === "--run-pipeline") {
      result.runPipeline = true;
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
