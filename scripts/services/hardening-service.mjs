import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, readJsonDir, readJsonFile } from "../data-utils.mjs";
import { ingestInput } from "./ingestion-service.mjs";
import { runPipelineTasks } from "./pipeline-service.mjs";
import { projectObservations } from "./observation-service.mjs";
import { loadRouterContext, routeArtifact } from "./router-service.mjs";

export async function runHardeningChecks() {
  const data = await loadData();
  const checks = [];

  checks.push(await checkRouterReplay(data));
  checks.push(await checkDedup(data));
  checks.push(await checkIngestionIdempotency(data));
  checks.push(await checkPipelineIdempotency(data));
  checks.push(await checkObservationReplay(data));
  checks.push(await checkContamination(data));
  checks.push(await checkLifecycle(data));
  checks.push(await checkRecovery(data));
  checks.push(await checkRuleIsolation(data));

  const errors = checks.flatMap((check) => check.errors.map((message) => ({ check: check.id, message })));
  const warnings = checks.flatMap((check) => check.warnings.map((message) => ({ check: check.id, message })));

  return {
    status: errors.length ? "failed" : "passed",
    generatedAt: new Date().toISOString(),
    summary: {
      checks: checks.length,
      passed: checks.filter((check) => check.status === "passed").length,
      failed: checks.filter((check) => check.status === "failed").length,
      warnings: warnings.length,
      errors: errors.length,
    },
    checks,
    errors,
    warnings,
  };
}

async function loadData() {
  const rows = {
    rawArtifacts: await readDataDir("raw_artifacts"),
    routeDecisions: await readDataDir("route_decisions"),
    pipelineTasks: await readDataDir("pipeline_tasks"),
    pipelineRuns: await readDataDir("pipeline_runs"),
    observationRuns: await readDataDir("observation_runs"),
    schedulerRuns: await readDataDir("scheduler_runs"),
    claims: await readDataDir("claims"),
    evidence: await readDataDir("evidence"),
    events: await readDataDir("events"),
    fetchRuns: await readDataDir("fetch_runs"),
    stateTransitions: await readDataDir("state_transitions"),
  };
  const dashboardObservations = await readJsonFile(path.join(DATA_DIR, "dashboard", "observations.json"));
  const dashboardObservationProjection = await readJsonFile(path.join(DATA_DIR, "dashboard", "observation_projection.json"));
  const schedulerConfig = await readJsonFile(path.join(DATA_DIR, "scheduler", "sources.json"));
  const schedulerState = await readJsonFile(path.join(DATA_DIR, "scheduler", "state.json"));
  const pipelineMap = await readJsonFile(path.join(DATA_DIR, "pipelines", "pipeline_map.json"));
  const routerRules = await readJsonFile(path.join(DATA_DIR, "router", "rules.json"));

  return {
    ...rows,
    dashboardObservations,
    dashboardObservationProjection,
    schedulerConfig,
    schedulerState,
    pipelineMap,
    routerRules,
    maps: {
      rawById: mapById(rows.rawArtifacts),
      routeByRawId: mapBy(rows.routeDecisions, (row) => row.rawArtifactId),
      routeById: mapById(rows.routeDecisions),
      taskByRouteId: mapBy(rows.pipelineTasks, (row) => row.routeDecisionId),
      taskById: mapById(rows.pipelineTasks),
      runByTaskId: groupBy(rows.pipelineRuns, (row) => row.pipelineTaskId),
      claimById: mapById(rows.claims),
      evidenceById: mapById(rows.evidence),
      evidenceByClaimId: groupBy(rows.evidence, (row) => row.claimId),
      eventById: mapById(rows.events),
      fetchRunById: mapById(rows.fetchRuns),
      stateTransitionsByClaimId: groupBy(
        rows.stateTransitions.filter((row) => row.subjectType === "claim"),
        (row) => row.subjectId
      ),
    },
  };
}

async function readDataDir(relativeDir) {
  try {
    return (await readJsonDir(relativeDir)).map((row) => row.data);
  } catch {
    return [];
  }
}

async function checkRouterReplay(data) {
  const errors = [];
  const context = await loadRouterContext();

  for (const artifact of data.rawArtifacts) {
    const existing = data.maps.routeByRawId.get(artifact.id);
    if (!existing) {
      errors.push(`raw_artifact ${artifact.id} has no route_decision`);
      continue;
    }
    const replay = routeArtifact(artifact, context, { createdAt: existing.createdAt });
    if (!sameJson(stableRoute(existing), stableRoute(replay))) {
      errors.push(`route replay drift for ${artifact.id}: expected ${existing.id}, got ${replay.id}`);
    }
  }

  return result("router_replay", errors, [], { artifacts: data.rawArtifacts.length });
}

async function checkDedup(data) {
  const errors = [];
  const warnings = [];

  duplicateErrors(errors, "raw_artifact URL/title/publishedAt", data.rawArtifacts, (row) =>
    [normalizeUrl(row.url), row.title, row.publishedAt || ""].join("|")
  );
  duplicateErrors(errors, "raw_artifact contentHash", data.rawArtifacts, (row) => row.contentHash);
  duplicateErrors(errors, "route_decision rawArtifactId", data.routeDecisions, (row) => row.rawArtifactId);
  duplicateErrors(errors, "pipeline_task routeDecisionId", data.pipelineTasks, (row) => row.routeDecisionId);
  duplicateErrors(errors, "claim normalized fact", data.claims, (row) =>
    [String(row.normalizedFact || row.text).toLowerCase(), stableList(row.entityIds), stableList(row.artifactIds)].join("|")
  );
  duplicateErrors(errors, "evidence semantic key", data.evidence, (row) =>
    [row.claimId, row.rawArtifactId, row.sourceId, row.relation, row.quote || ""].join("|")
  );
  duplicateErrors(errors, "observation eventId", data.dashboardObservations.rows || [], (row) => row.eventId);

  const observationClaimIds = (data.dashboardObservations.rows || []).flatMap((row) => row.claimIds || []);
  duplicateErrors(errors, "observation claim reference", observationClaimIds.map((claimId) => ({ id: claimId })), (row) => row.id);

  if (data.observationRuns.length > 3) {
    warnings.push(`observation_runs has ${data.observationRuns.length} records; keep only meaningful replay checkpoints`);
  }

  return result("dedup", errors, warnings, {
    rawArtifacts: data.rawArtifacts.length,
    claims: data.claims.length,
    evidence: data.evidence.length,
  });
}

async function checkIngestionIdempotency(data) {
  const errors = [];
  const sourceStates = data.schedulerState.sources || {};

  for (const source of data.schedulerConfig.sources || []) {
    if (source.enabled === false) continue;
    const capturedAt = sourceStates[source.id]?.lastRunAt || data.schedulerConfig.updatedAt;
    const first = await ingestStableSummary(source, capturedAt);
    const second = await ingestStableSummary(source, capturedAt);
    if (!sameJson(first, second)) {
      errors.push(`ingestion dry-run is not idempotent for scheduler source ${source.id}`);
    }
    const state = sourceStates[source.id];
    if (state?.lastRawArtifactId && first.rawArtifactId !== state.lastRawArtifactId) {
      errors.push(`ingestion replay rawArtifactId drift for ${source.id}: ${first.rawArtifactId} != ${state.lastRawArtifactId}`);
    }
    if (state?.lastRouteDecisionId && first.routeDecisionId !== state.lastRouteDecisionId) {
      errors.push(`ingestion replay routeDecisionId drift for ${source.id}: ${first.routeDecisionId} != ${state.lastRouteDecisionId}`);
    }
    if (state?.lastPipelineTaskId && first.pipelineTaskId !== state.lastPipelineTaskId) {
      errors.push(`ingestion replay pipelineTaskId drift for ${source.id}: ${first.pipelineTaskId} != ${state.lastPipelineTaskId}`);
    }
  }

  return result("ingestion_idempotency", errors, [], { schedulerSources: data.schedulerConfig.sources?.length || 0 });
}

async function checkPipelineIdempotency(data) {
  const errors = [];

  for (const task of data.pipelineTasks) {
    if (!task.claimIds?.length && task.status === "completed") {
      errors.push(`completed pipeline_task ${task.id} has no claimIds`);
      continue;
    }
    if (!task.claimIds?.length) continue;

    const replay = await runPipelineTasks({
      taskId: task.id,
      force: true,
      dryRun: true,
      now: task.startedAt || task.finishedAt || task.updatedAt,
    });
    const row = replay.results[0];
    if (!row) {
      errors.push(`pipeline replay selected no result for ${task.id}`);
      continue;
    }
    if (!sameJson(stableList(row.claimIds), stableList(task.claimIds))) {
      errors.push(`pipeline replay claimIds drift for ${task.id}`);
    }
    if (!sameJson(stableList(row.evidenceIds), stableList(task.evidenceIds))) {
      errors.push(`pipeline replay evidenceIds drift for ${task.id}`);
    }
    if (task.pipelineRunIds?.length && !task.pipelineRunIds.includes(row.pipelineRunId)) {
      errors.push(`pipeline replay run id drift for ${task.id}: ${row.pipelineRunId}`);
    }
  }

  return result("pipeline_idempotency", errors, [], { tasks: data.pipelineTasks.length });
}

async function checkObservationReplay(data) {
  const errors = [];
  const latestRun = latestBy(data.observationRuns, (row) => row.generatedAt);

  if (!latestRun) {
    errors.push("no observation_run exists");
    return result("observation_replay", errors, [], {});
  }

  const replay = await projectObservations({ dryRun: true, generatedAt: latestRun.generatedAt });
  if (!sameJson(stableObservationRun(replay.run), stableObservationRun(latestRun))) {
    errors.push(`observation projection replay drift for ${latestRun.id}`);
  }
  if (data.dashboardObservationProjection.latestRunId !== latestRun.id) {
    errors.push("dashboard/observation_projection.json latestRunId does not match latest observation run");
  }

  return result("observation_replay", errors, [], {
    latestRunId: latestRun.id,
    excludedClaims: latestRun.excludedClaimCount,
  });
}

async function checkContamination(data) {
  const errors = [];
  const observationRows = data.dashboardObservations.rows || [];
  const projectedClaimIds = new Set(observationRows.flatMap((row) => row.claimIds || []));
  const excludedClaimIds = new Set(data.dashboardObservationProjection.excludedClaims?.map((row) => row.claimId) || []);

  for (const row of observationRows) {
    if (!data.maps.eventById.has(row.eventId)) errors.push(`observation ${row.id} points to unknown event ${row.eventId}`);
    for (const claimId of row.claimIds || []) {
      const claim = data.maps.claimById.get(claimId);
      if (!claim) {
        errors.push(`observation ${row.id} points to unknown claim ${claimId}`);
        continue;
      }
      if (claim.reviewStatus !== "promoted" || !claim.promotedEventIds?.includes(row.eventId)) {
        errors.push(`observation ${row.id} includes unpromoted claim ${claimId}`);
      }
      for (const evidence of data.maps.evidenceByClaimId.get(claimId) || []) {
        if (evidence.claimId !== claimId) errors.push(`evidence ${evidence.id} is cross-linked to wrong claim`);
      }
    }
  }

  for (const claimId of excludedClaimIds) {
    if (projectedClaimIds.has(claimId)) errors.push(`excluded claim ${claimId} appears in observation projection`);
  }
  for (const claim of data.claims) {
    if ((claim.artifactIds || []).some((artifactId) => String(artifactId).startsWith("obs_"))) {
      errors.push(`claim ${claim.id} uses an observation as artifact source`);
    }
  }

  return result("contamination", errors, [], {
    observations: observationRows.length,
    excludedClaims: excludedClaimIds.size,
  });
}

async function checkLifecycle(data) {
  const errors = [];
  const warnings = [];
  const inboxClaimIds = new Set();
  const claimInbox = await readOptionalJson(path.join(DATA_DIR, "inbox", "claim_candidates.json"));
  for (const candidate of claimInbox?.candidates || []) inboxClaimIds.add(candidate.claimId);

  for (const claim of data.claims) {
    const transitions = data.maps.stateTransitionsByClaimId.get(claim.id) || [];
    if ((claim.reviewStatus === "promoted" || claim.status === "verified") && transitions.length === 0) {
      errors.push(`promoted/verified claim ${claim.id} has no state_transition`);
    }
    if (claim.status === "candidate" && !inboxClaimIds.has(claim.id)) {
      errors.push(`candidate claim ${claim.id} is not present in inbox/claim_candidates.json`);
    }
    if (claim.resolvedAt && transitions.length === 0) {
      errors.push(`resolved claim ${claim.id} has no state_transition`);
    }
    if (["refuted", "superseded", "stale"].includes(claim.status) && !claim.resolvedAt) {
      errors.push(`${claim.status} claim ${claim.id} must have resolvedAt`);
    }
  }

  if (!data.claims.some((claim) => ["superseded", "refuted", "stale"].includes(claim.status))) {
    warnings.push("no superseded/refuted/stale claim sample exists yet; lifecycle path is unexercised");
  }

  return result("lifecycle", errors, warnings, { claims: data.claims.length });
}

async function checkRecovery(data) {
  const errors = [];

  for (const run of data.fetchRuns) {
    if (["failed", "partial"].includes(run.status) && !run.error && !(run.gaps || []).length) {
      errors.push(`fetch_run ${run.id} is ${run.status} without error or gaps`);
    }
  }
  for (const task of data.pipelineTasks) {
    if (task.status === "failed" && !task.error) errors.push(`failed pipeline_task ${task.id} has no error`);
    if (task.status === "queued" && task.finishedAt) errors.push(`queued pipeline_task ${task.id} has finishedAt`);
    if (task.status === "completed" && (!task.claimIds?.length || !task.evidenceIds?.length || !task.pipelineRunIds?.length)) {
      errors.push(`completed pipeline_task ${task.id} is missing output ids`);
    }
  }
  for (const run of data.pipelineRuns) {
    if (run.status === "failed" && !run.error) errors.push(`failed pipeline_run ${run.id} has no error`);
    if (run.status === "completed" && (!run.claimIds?.length || !run.evidenceIds?.length)) {
      errors.push(`completed pipeline_run ${run.id} has no claim/evidence output`);
    }
  }
  for (const run of data.schedulerRuns) {
    const failedResults = (run.results || []).filter((row) => row.status === "failed");
    if (failedResults.some((row) => !row.error)) errors.push(`scheduler_run ${run.id} has failed result without error`);
    if (run.failureCount !== failedResults.length) errors.push(`scheduler_run ${run.id} failureCount does not match results`);
  }
  for (const run of data.observationRuns) {
    if (run.status === "failed" && !run.violations?.length) errors.push(`failed observation_run ${run.id} has no violations`);
  }

  return result("recovery", errors, [], {
    fetchRuns: data.fetchRuns.length,
    pipelineRuns: data.pipelineRuns.length,
    schedulerRuns: data.schedulerRuns.length,
  });
}

async function checkRuleIsolation(data) {
  const errors = [];
  const warnings = [];
  const routeTypes = new Set(data.pipelineMap.routes?.map((row) => row.type) || []);
  const routerTypes = new Set((data.routerRules.routes || []).map((row) => row.type));
  if (data.routerRules.defaultRoute?.type) routerTypes.add(data.routerRules.defaultRoute.type);

  for (const type of routeTypes) {
    if (!routerTypes.has(type)) errors.push(`router rules do not cover route type ${type}`);
  }
  for (const route of data.pipelineMap.routes || []) {
    if (!Array.isArray(route.claimTypes) || route.claimTypes.length === 0) {
      errors.push(`pipeline_map route ${route.type} has no claimTypes`);
    }
  }
  if (!Array.isArray(data.routerRules.sourceKinds) || data.routerRules.sourceKinds.length === 0) {
    errors.push("router rules must declare sourceKinds");
  }

  const routerSource = await fs.readFile(path.join(DATA_DIR, "..", "scripts", "services", "router-service.mjs"), "utf8");
  if (/hasAny\([^)]*\[[^\]]+\]/s.test(routerSource)) {
    errors.push("router-service contains inline keyword arrays; move route keywords to data/router/rules.json");
  }
  if (!routerSource.includes('path.join(DATA_DIR, "router", "rules.json")')) {
    errors.push("router-service does not load data/router/rules.json");
  }
  if ((data.routerRules.routes || []).some((rule) => !rule.signal)) {
    warnings.push("some router rules have no signal metadata");
  }

  return result("rule_isolation", errors, warnings, {
    routeTypes: routeTypes.size,
    routerRules: data.routerRules.routes?.length || 0,
  });
}

async function ingestStableSummary(source, capturedAt) {
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
    capturedAt,
    notes: source.notes,
    dryRun: true,
  });
  return {
    sourceId: payloads.source?.data.id || null,
    rawArtifactId: payloads.raw_artifact?.data.id || null,
    fetchRunId: payloads.fetch_run?.data.id || null,
    routeDecisionId: payloads.route_decision?.data.id || null,
    pipelineTaskId: payloads.pipeline_task?.data.id || null,
    pipeline: payloads.pipeline_task?.data.pipeline || payloads.route_decision?.data.pipeline || null,
  };
}

function stableRoute(route) {
  return {
    id: route.id,
    rawArtifactId: route.rawArtifactId,
    type: route.type,
    entityId: route.entityId,
    entityIds: route.entityIds || [],
    pipeline: route.pipeline,
    confidence: route.confidence,
    reason: route.reason,
    matchedSignals: route.matchedSignals || [],
    sourceKind: route.sourceKind,
    status: route.status,
    nextAction: route.nextAction,
  };
}

function stableObservationRun(run) {
  return {
    status: run.status,
    targetDate: run.targetDate,
    observationCount: run.observationCount,
    projectedCount: run.projectedCount,
    excludedClaimCount: run.excludedClaimCount,
    violationCount: run.violationCount,
    rows: (run.rows || []).map((row) => ({
      observationId: row.observationId,
      eventId: row.eventId,
      gate: row.gate,
      status: row.status,
      claimIds: row.claimIds || [],
      evidenceIds: row.evidenceIds || [],
      stateTransitionIds: row.stateTransitionIds || [],
      violations: row.violations || [],
    })),
    excludedClaims: run.excludedClaims || [],
    violations: run.violations || [],
  };
}

function result(id, errors, warnings, details) {
  return {
    id,
    status: errors.length ? "failed" : "passed",
    errors,
    warnings,
    details,
  };
}

function duplicateErrors(errors, label, rows, keyFn) {
  const groups = groupBy(rows, keyFn);
  for (const [key, items] of groups.entries()) {
    if (!key || items.length <= 1) continue;
    errors.push(`${label} duplicate "${key}" in ${items.map((item) => item.id || item.claimId || key).join(", ")}`);
  }
}

function groupBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    const list = map.get(key) || [];
    list.push(row);
    map.set(key, list);
  }
  return map;
}

function mapBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) map.set(keyFn(row), row);
  return map;
}

function mapById(rows) {
  return mapBy(rows, (row) => row.id);
}

function stableList(value) {
  return [...(value || [])].sort();
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizeUrl(value) {
  return String(value || "").replace(/\/+$/, "").toLowerCase();
}

function latestBy(rows, keyFn) {
  return rows.slice().sort((a, b) => String(keyFn(b)).localeCompare(String(keyFn(a))))[0] || null;
}

async function readOptionalJson(file) {
  try {
    return await readJsonFile(file);
  } catch {
    return null;
  }
}
