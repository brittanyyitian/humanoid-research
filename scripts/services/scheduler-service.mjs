import path from "node:path";
import { DATA_DIR, readJsonDir, readJsonFile, writeJsonFile } from "../data-utils.mjs";
import { ingestInput, payloadSummary } from "./ingestion-service.mjs";
import { dateFrom, hash, nowShanghai } from "./router-service.mjs";

const SCHEDULER_CONFIG_PATH = path.join(DATA_DIR, "scheduler", "sources.json");
const SCHEDULER_STATE_PATH = path.join(DATA_DIR, "scheduler", "state.json");
const SCHEDULER_RUN_DIR = path.join(DATA_DIR, "scheduler_runs");

export async function runSchedulerTick(options = {}) {
  const startedAt = options.now || nowShanghai();
  const config = await loadSchedulerConfig();
  const state = await loadSchedulerState();
  const cadenceById = new Map((config.cadences || []).map((cadence) => [cadence.id, cadence]));
  const enabledSources = (config.sources || []).filter((source) => source.enabled !== false);
  const filteredSources = filterSources(enabledSources, options);
  const candidates = filteredSources.map((source) => {
    const cadence = cadenceById.get(source.cadenceKey);
    const sourceState = state.sources?.[source.id] || {};
    return {
      source,
      cadence,
      sourceState,
      due: options.force || isDue(sourceState.lastRunAt, cadence?.seconds, startedAt),
      reason: dueReason(sourceState.lastRunAt, cadence?.seconds, startedAt, Boolean(options.force)),
      nextDueAt: nextDueAt(sourceState.lastRunAt, cadence?.seconds),
    };
  });
  const dueCandidates = candidates.filter((candidate) => candidate.due).slice(0, limitFor(options.limit));
  const run = buildRunSkeleton({
    startedAt,
    dryRun: Boolean(options.dryRun),
    sourceCount: enabledSources.length,
    selectedCount: filteredSources.length,
    dueCount: dueCandidates.length,
    skippedCount: candidates.filter((candidate) => !candidate.due).length,
    cadenceKeys: unique(filteredSources.map((source) => source.cadenceKey)),
  });

  for (const candidate of dueCandidates) {
    const result = await runSource(candidate.source, {
      capturedAt: startedAt,
      dryRun: Boolean(options.dryRun),
      forceRoute: Boolean(options.forceRoute),
      forceTask: Boolean(options.forceTask),
    });
    result.reason = candidate.reason;
    run.results.push(result);

    if (!options.dryRun) {
      updateStateForResult(state, candidate.source.id, result, startedAt, run.id);
    }
  }

  run.finishedAt = nowShanghai();
  run.attemptedCount = run.results.length;
  run.successCount = run.results.filter((result) => result.status === "success").length;
  run.failureCount = run.results.filter((result) => result.status === "failed").length;
  run.status = runStatus(run, Boolean(options.dryRun));

  if (!options.dryRun) {
    state.updatedAt = run.finishedAt;
    await writeJsonFile(SCHEDULER_STATE_PATH, state);
    await writeJsonFile(path.join(SCHEDULER_RUN_DIR, `${run.id}.json`), run);
  }

  return {
    run,
    candidates: candidates.map((candidate) => ({
      sourceId: candidate.source.id,
      cadenceKey: candidate.source.cadenceKey,
      due: candidate.due,
      reason: candidate.reason,
      nextDueAt: candidate.nextDueAt,
      lastRunAt: candidate.sourceState.lastRunAt || null,
    })),
  };
}

export async function loadSchedulerConfig() {
  return readJsonFile(SCHEDULER_CONFIG_PATH);
}

export async function loadSchedulerState() {
  try {
    return await readJsonFile(SCHEDULER_STATE_PATH);
  } catch {
    return { updatedAt: nowShanghai(), sources: {} };
  }
}

export async function readSchedulerRuns() {
  try {
    return (await readJsonDir("scheduler_runs")).map((row) => row.data);
  } catch {
    return [];
  }
}

async function runSource(source, options) {
  const base = {
    sourceId: source.id,
    cadenceKey: source.cadenceKey,
    inputType: source.inputType,
    url: source.url,
    status: options.dryRun ? "planned" : "success",
    rawArtifactId: null,
    routeDecisionId: null,
    pipelineTaskId: null,
    pipeline: null,
    error: null,
  };

  try {
    const payloads = await ingestInput({
      inputType: source.inputType,
      url: source.url,
      title: source.title,
      publisher: source.publisher,
      entityIds: source.entityIds,
      artifactType: source.artifactType,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
      sourceLevel: source.sourceLevel,
      publishedAt: source.publishedAt,
      capturedAt: options.capturedAt,
      notes: source.notes || `Scheduled ingestion from ${source.id}.`,
      forceRoute: options.forceRoute,
      forceTask: options.forceTask,
      dryRun: options.dryRun,
    });
    return {
      ...base,
      ...payloadSummary(payloads),
      status: options.dryRun ? "planned" : "success",
    };
  } catch (error) {
    return {
      ...base,
      status: "failed",
      error: error.message,
    };
  }
}

function buildRunSkeleton({ startedAt, dryRun, sourceCount, selectedCount, dueCount, skippedCount, cadenceKeys }) {
  const date = dateFrom(startedAt);
  return {
    id: `sched_${date.replaceAll("-", "_")}_${hash(`${startedAt}|${cadenceKeys.join(",")}|${dueCount}`, 12)}`,
    mode: "tick",
    dryRun,
    status: "running",
    startedAt,
    finishedAt: null,
    sourceCount,
    selectedCount,
    dueCount,
    attemptedCount: 0,
    successCount: 0,
    failureCount: 0,
    skippedCount,
    cadenceKeys,
    results: [],
  };
}

function filterSources(sources, options) {
  return sources.filter((source) => {
    if (options.sourceId && source.id !== options.sourceId) return false;
    if (options.cadenceKey && source.cadenceKey !== options.cadenceKey) return false;
    return true;
  });
}

function isDue(lastRunAt, seconds, nowValue) {
  if (!seconds) return false;
  if (!lastRunAt) return true;
  const lastTime = Date.parse(lastRunAt);
  const nowTime = Date.parse(nowValue);
  if (!Number.isFinite(lastTime) || !Number.isFinite(nowTime)) return true;
  return nowTime - lastTime >= seconds * 1000;
}

function dueReason(lastRunAt, seconds, nowValue, force) {
  if (force) return "forced";
  if (!lastRunAt) return "never_run";
  if (!seconds) return "missing_cadence";
  return isDue(lastRunAt, seconds, nowValue) ? "cadence_due" : "cadence_not_due";
}

function nextDueAt(lastRunAt, seconds) {
  if (!lastRunAt || !seconds) return null;
  const lastTime = Date.parse(lastRunAt);
  if (!Number.isFinite(lastTime)) return null;
  return shanghaiDateTime(lastTime + seconds * 1000);
}

function shanghaiDateTime(time) {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(time));
  return `${parts.replace(" ", "T")}+08:00`;
}

function updateStateForResult(state, sourceId, result, nowValue, runId) {
  const existing = state.sources?.[sourceId] || {};
  const success = result.status === "success";
  state.sources = state.sources || {};
  state.sources[sourceId] = {
    ...existing,
    lastCheckedAt: nowValue,
    lastRunAt: nowValue,
    lastSuccessAt: success ? nowValue : existing.lastSuccessAt || null,
    lastSchedulerRunId: runId,
    lastStatus: result.status,
    lastRawArtifactId: result.rawArtifactId || existing.lastRawArtifactId || null,
    lastRouteDecisionId: result.routeDecisionId || existing.lastRouteDecisionId || null,
    lastPipelineTaskId: result.pipelineTaskId || existing.lastPipelineTaskId || null,
    consecutiveFailures: success ? 0 : Number(existing.consecutiveFailures || 0) + 1,
  };
}

function runStatus(run, dryRun) {
  if (dryRun) return "dry_run";
  if (run.dueCount === 0) return "skipped";
  if (run.failureCount === 0) return "success";
  if (run.successCount > 0) return "partial";
  return "failed";
}

function limitFor(value) {
  if (value === undefined || value === null || value === "") return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : Number.POSITIVE_INFINITY;
}

function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}
