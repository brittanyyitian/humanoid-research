import { readJsonDir, readJsonFile, DATA_DIR } from "./data-utils.mjs";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

const allowedEvidence = new Set(["A", "B", "C", "D"]);
const allowedArtifactTypes = new Set([
  "webpage",
  "product_page",
  "news_page",
  "filing",
  "pdf",
  "video_transcript",
  "wechat",
  "market_quote",
  "serenity_output",
]);
const allowedClaimTypes = new Set([
  "product_release",
  "product_spec",
  "delivery",
  "order",
  "partnership",
  "filing",
  "financial",
  "market_snapshot",
  "milestone",
  "source_health",
  "data_gap",
  "other",
]);
const allowedClaimStatus = new Set(["candidate", "needs_review", "verified", "refuted", "superseded", "stale"]);
const allowedReviewStatus = new Set(["inbox", "promoted", "rejected", "merged", "needs_followup"]);
const allowedClaimConfidence = new Set(["high", "medium", "low", "unknown"]);
const allowedEvidenceRelation = new Set(["supports", "mentions", "refutes", "updates"]);
const allowedEvidenceStrength = new Set(["strong", "medium", "weak"]);
const allowedFetchSourceTypes = new Set([
  "company_official",
  "product_release",
  "filing",
  "market",
  "serenity_bridge",
  "manual_link",
  "ingestion",
]);
const allowedFetchStatus = new Set(["success", "partial", "failed", "manual", "skipped"]);
const allowedMilestoneStatus = new Set(["upcoming", "due", "resolved", "stale", "cancelled"]);
const allowedMilestonePrecision = new Set(["day", "month", "quarter", "year", "window"]);
const allowedTransitionSubjectTypes = new Set(["claim", "followup", "event", "milestone", "source"]);
const allowedRouteTypes = new Set(["company", "product", "filing", "event", "policy", "supply_chain"]);
const allowedPipelineNames = new Set([
  "company_pipeline",
  "product_pipeline",
  "filing_pipeline",
  "event_pipeline",
  "policy_pipeline",
  "supply_chain_pipeline",
]);
const allowedRouteConfidence = new Set(["high", "medium", "low"]);
const allowedRouteSourceKind = new Set(["official", "filing", "media", "social", "internal", "market", "unknown"]);
const allowedRouteStatus = new Set(["routed", "needs_review", "skipped", "manual_override"]);
const allowedPipelineTaskStatus = new Set(["queued", "running", "completed", "failed", "skipped", "needs_review"]);
const allowedPipelineRunStatus = new Set(["completed", "failed", "skipped"]);
const allowedObservationRunStatus = new Set(["completed", "failed"]);
const allowedInputTypes = new Set(["url", "rss", "api", "manual"]);
const allowedIngestionSourceTypes = new Set(["webpage", "pdf", "video", "filing", "wechat", "news", "exchange", "government"]);
const allowedSchedulerCadenceKeys = new Set(["market", "filing", "industry"]);
const allowedSchedulerRunStatus = new Set(["success", "partial", "failed", "skipped", "dry_run"]);
const allowedSchedulerResultStatus = new Set(["success", "failed", "planned"]);
const allowedEventTypes = new Set([
  "order",
  "ipo",
  "funding",
  "conference",
  "policy",
  "partnership",
  "demo",
  "factory",
  "hiring",
  "patent",
  "product",
  "delivery",
  "announcement",
  "financial_report",
]);
const allowedFollowupStatus = new Set([
  "pending",
  "confirmed",
  "completed",
  "archived",
  "cancelled",
  "stale",
]);

const errors = [];

function fail(file, message) {
  errors.push(`${file}: ${message}`);
}

function requireString(record, file, key) {
  if (typeof record[key] !== "string" || record[key].trim() === "") {
    fail(file, `missing string field "${key}"`);
  }
}

function registerId(record, file, key, idSet, label) {
  requireString(record, file, key);
  if (typeof record[key] !== "string" || record[key].trim() === "") return;
  if (idSet.has(record[key])) {
    fail(file, `duplicate ${label} id "${record[key]}"`);
  }
  idSet.add(record[key]);
}

function requireKnownIds(record, file, key, idSet, label, { required = false } = {}) {
  const value = record[key];
  if (!Array.isArray(value)) {
    if (required) fail(file, `${key} must be a non-empty array`);
    return;
  }
  if (required && value.length === 0) {
    fail(file, `${key} must be a non-empty array`);
    return;
  }
  for (const id of value) {
    if (!idSet.has(id)) {
      fail(file, `unknown ${label} "${id}"`);
    }
  }
}

function requireSourceIds(record, file, sourceIds) {
  if (!Array.isArray(record.sourceIds) || record.sourceIds.length === 0) {
    fail(file, "sourceIds must be a non-empty array");
    return;
  }
  for (const sourceId of record.sourceIds) {
    if (!sourceIds.has(sourceId)) {
      fail(file, `unknown sourceId "${sourceId}"`);
    }
  }
}

const sources = await readJsonDir("sources");
const sourceIds = new Set();

for (const { file, data } of sources) {
  requireString(data, file, "id");
  requireString(data, file, "title");
  requireString(data, file, "publisher");
  requireString(data, file, "url");
  if (!String(data.url || "").startsWith("http")) {
    fail(file, "url must be clickable http(s)");
  }
  if (!allowedEvidence.has(data.evidenceLevel)) {
    fail(file, "evidenceLevel must be A/B/C/D");
  }
  if (sourceIds.has(data.id)) {
    fail(file, `duplicate source id "${data.id}"`);
  }
  sourceIds.add(data.id);
}

const entitiesIndex = await readJsonFile(path.join(DATA_DIR, "entities", "index.json"));
const entityIds = new Set((entitiesIndex.entities || []).map((entity) => entity.id));

for (const entity of entitiesIndex.entities || []) {
  if (!entity.id || !entity.name || !entity.kind) {
    fail("data/entities/index.json", "each entity needs id, name and kind");
  }
}

const events = await readJsonDir("events");
for (const { file, data } of events) {
  requireString(data, file, "id");
  requireString(data, file, "date");
  requireString(data, file, "module");
  requireString(data, file, "title");
  requireString(data, file, "fact");
  if (!allowedEventTypes.has(data.eventType)) {
    fail(file, `invalid eventType "${data.eventType}"`);
  }
  if (!allowedEvidence.has(data.evidenceLevel)) {
    fail(file, "evidenceLevel must be A/B/C/D");
  }
  if (!Array.isArray(data.entityIds) || data.entityIds.length === 0) {
    fail(file, "entityIds must be a non-empty array");
  } else {
    for (const entityId of data.entityIds) {
      if (!entityIds.has(entityId)) {
        fail(file, `unknown entityId "${entityId}"`);
      }
    }
  }
  requireSourceIds(data, file, sourceIds);
}
const eventIds = new Set(events.map(({ data }) => data.id));

const relations = await readJsonDir("relations");
for (const { file, data } of relations) {
  requireString(data, file, "id");
  requireString(data, file, "entityAId");
  requireString(data, file, "entityBId");
  requireString(data, file, "relationType");
  if (!entityIds.has(data.entityAId)) fail(file, `unknown entityAId "${data.entityAId}"`);
  if (!entityIds.has(data.entityBId)) fail(file, `unknown entityBId "${data.entityBId}"`);
  if (!allowedEvidence.has(data.evidenceLevel)) fail(file, "evidenceLevel must be A/B/C/D");
  requireSourceIds(data, file, sourceIds);
}

const followups = await readJsonDir("followups");
for (const { file, data } of followups) {
  requireString(data, file, "id");
  requireString(data, file, "subject");
  if (!allowedFollowupStatus.has(data.status)) {
    fail(file, `invalid follow-up status "${data.status}"`);
  }
  requireSourceIds(data, file, sourceIds);
}
const followupIds = new Set(followups.map(({ data }) => data.id));

const stocks = await readJsonDir("stocks");
for (const { file, data } of stocks) {
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows) {
    requireString(row, file, "id");
    requireString(row, file, "date");
    requireString(row, file, "entityId");
    requireString(row, file, "stockCode");
    if (!entityIds.has(row.entityId)) fail(file, `unknown entityId "${row.entityId}"`);
    requireSourceIds(row, file, sourceIds);
  }
}

const fetchRuns = await readJsonDir("fetch_runs");
const rawArtifacts = await readJsonDir("raw_artifacts");
const claims = await readJsonDir("claims");
const evidence = await readJsonDir("evidence");
const milestones = await readJsonDir("milestones");
const stateTransitions = await readJsonDir("state_transitions");
const routeDecisions = await readJsonDir("route_decisions");
const pipelineTasks = await readJsonDir("pipeline_tasks");
const pipelineRuns = await readJsonDir("pipeline_runs");
const ruleOutputs = await readJsonDir("rule_outputs");
const observationRuns = await readJsonDir("observation_runs");
const schedulerRuns = await readJsonDir("scheduler_runs");
const pipelineMap = await readJsonFile(path.join(DATA_DIR, "pipelines", "pipeline_map.json"));
const serenityDatasetMap = await readJsonFile(path.join(DATA_DIR, "serenity_bridge", "dataset_map.json"));
const schedulerConfig = await readJsonFile(path.join(DATA_DIR, "scheduler", "sources.json"));
const schedulerState = await readJsonFile(path.join(DATA_DIR, "scheduler", "state.json"));

const fetchRunIds = new Set();
const rawArtifactIds = new Set();
const claimIds = new Set();
const evidenceIds = new Set();
const milestoneIds = new Set();
const stateTransitionIds = new Set();
const pipelineTaskIds = new Set();
const pipelineRunIds = new Set();
const ruleOutputIds = new Set();
const observationRunIds = new Set();
const schedulerRunIds = new Set();

for (const { file, data } of fetchRuns) registerId(data, file, "id", fetchRunIds, "fetch run");
for (const { file, data } of rawArtifacts) registerId(data, file, "id", rawArtifactIds, "raw artifact");
for (const { file, data } of claims) registerId(data, file, "id", claimIds, "claim");
for (const { file, data } of evidence) registerId(data, file, "id", evidenceIds, "evidence");
for (const { file, data } of milestones) registerId(data, file, "id", milestoneIds, "milestone");
for (const { file, data } of stateTransitions) {
  registerId(data, file, "id", stateTransitionIds, "state transition");
}
for (const { file, data } of pipelineTasks) registerId(data, file, "id", pipelineTaskIds, "pipeline task");
for (const { file, data } of pipelineRuns) registerId(data, file, "id", pipelineRunIds, "pipeline run");
for (const { file, data } of ruleOutputs) registerId(data, file, "id", ruleOutputIds, "rule output");
for (const { file, data } of observationRuns) registerId(data, file, "id", observationRunIds, "observation run");
for (const { file, data } of schedulerRuns) registerId(data, file, "id", schedulerRunIds, "scheduler run");

const configuredPipelineByType = new Map();
if (!Array.isArray(pipelineMap.routes) || pipelineMap.routes.length === 0) {
  fail("data/pipelines/pipeline_map.json", "routes must be a non-empty array");
} else {
  for (const route of pipelineMap.routes) {
    if (!allowedRouteTypes.has(route.type)) {
      fail("data/pipelines/pipeline_map.json", `invalid route type "${route.type}"`);
    }
    if (!allowedPipelineNames.has(route.pipeline)) {
      fail("data/pipelines/pipeline_map.json", `invalid pipeline "${route.pipeline}"`);
    }
    configuredPipelineByType.set(route.type, route.pipeline);
  }
}

const allowedSerenityModes = new Set(["stock_snapshot", "filing_claims", "financial_claim", "source_health", "data_gap"]);
if (!serenityDatasetMap || typeof serenityDatasetMap !== "object") {
  fail("data/serenity_bridge/dataset_map.json", "dataset map must be an object");
} else {
  if (!serenityDatasetMap.datasets || typeof serenityDatasetMap.datasets !== "object") {
    fail("data/serenity_bridge/dataset_map.json", "datasets must be an object");
  } else {
    for (const [dataset, config] of Object.entries(serenityDatasetMap.datasets)) {
      if (!allowedSerenityModes.has(config.mode)) {
        fail("data/serenity_bridge/dataset_map.json", `invalid mode "${config.mode}" for ${dataset}`);
      }
      if (!allowedArtifactTypes.has(config.artifactType)) {
        fail("data/serenity_bridge/dataset_map.json", `invalid artifactType "${config.artifactType}" for ${dataset}`);
      }
      if (!allowedIngestionSourceTypes.has(config.sourceType)) {
        fail("data/serenity_bridge/dataset_map.json", `invalid sourceType "${config.sourceType}" for ${dataset}`);
      }
      if (typeof config.route !== "boolean" || typeof config.enqueuePipeline !== "boolean") {
        fail("data/serenity_bridge/dataset_map.json", `${dataset} must declare boolean route/enqueuePipeline`);
      }
    }
  }
  const blocked = new Set(serenityDatasetMap.blockedDatasets || []);
  for (const dataset of ["valuation_inputs", "rating", "portfolio", "buy_point"]) {
    if (!blocked.has(dataset)) {
      fail("data/serenity_bridge/dataset_map.json", `blockedDatasets must include ${dataset}`);
    }
  }
}

const schedulerCadenceIds = new Set();
if (!Array.isArray(schedulerConfig.cadences) || schedulerConfig.cadences.length === 0) {
  fail("data/scheduler/sources.json", "cadences must be a non-empty array");
} else {
  for (const cadence of schedulerConfig.cadences) {
    requireString(cadence, "data/scheduler/sources.json", "id");
    requireString(cadence, "data/scheduler/sources.json", "label");
    if (!allowedSchedulerCadenceKeys.has(cadence.id)) {
      fail("data/scheduler/sources.json", `invalid cadence id "${cadence.id}"`);
    }
    if (!Number.isInteger(cadence.seconds) || cadence.seconds <= 0) {
      fail("data/scheduler/sources.json", `cadence "${cadence.id}" seconds must be positive`);
    }
    if (schedulerCadenceIds.has(cadence.id)) {
      fail("data/scheduler/sources.json", `duplicate cadence id "${cadence.id}"`);
    }
    schedulerCadenceIds.add(cadence.id);
  }
}

const schedulerSourceIds = new Set();
if (!Array.isArray(schedulerConfig.sources)) {
  fail("data/scheduler/sources.json", "sources must be an array");
} else {
  for (const source of schedulerConfig.sources) {
    requireString(source, "data/scheduler/sources.json", "id");
    requireString(source, "data/scheduler/sources.json", "cadenceKey");
    requireString(source, "data/scheduler/sources.json", "inputType");
    requireString(source, "data/scheduler/sources.json", "title");
    requireString(source, "data/scheduler/sources.json", "publisher");
    requireString(source, "data/scheduler/sources.json", "url");
    if (schedulerSourceIds.has(source.id)) {
      fail("data/scheduler/sources.json", `duplicate scheduler source id "${source.id}"`);
    }
    schedulerSourceIds.add(source.id);
    if (!schedulerCadenceIds.has(source.cadenceKey)) {
      fail("data/scheduler/sources.json", `unknown cadenceKey "${source.cadenceKey}"`);
    }
    if (!allowedInputTypes.has(source.inputType)) {
      fail("data/scheduler/sources.json", `invalid inputType "${source.inputType}"`);
    }
    if (!String(source.url || "").startsWith("http")) {
      fail("data/scheduler/sources.json", "source url must be clickable http(s)");
    }
    if (!allowedArtifactTypes.has(source.artifactType)) {
      fail("data/scheduler/sources.json", `invalid artifactType "${source.artifactType}"`);
    }
    if (!allowedIngestionSourceTypes.has(source.sourceType)) {
      fail("data/scheduler/sources.json", `invalid sourceType "${source.sourceType}"`);
    }
    if (!allowedEvidence.has(source.sourceLevel)) {
      fail("data/scheduler/sources.json", "sourceLevel must be A/B/C/D");
    }
    requireKnownIds(source, "data/scheduler/sources.json", "entityIds", entityIds, "entityId", { required: true });
  }
}

for (const { file, data } of fetchRuns) {
  requireString(data, file, "fetcher");
  requireString(data, file, "sourceName");
  requireString(data, file, "startedAt");
  requireString(data, file, "finishedAt");
  if (!allowedFetchSourceTypes.has(data.sourceType)) fail(file, `invalid sourceType "${data.sourceType}"`);
  if (!allowedFetchStatus.has(data.status)) fail(file, `invalid fetch status "${data.status}"`);
  requireKnownIds(data, file, "artifactIds", rawArtifactIds, "rawArtifactId");
  requireKnownIds(data, file, "claimIds", claimIds, "claimId");
  if (!Array.isArray(data.attemptLedger) || data.attemptLedger.length === 0) {
    fail(file, "attemptLedger must be a non-empty array");
  }
}

for (const { file, data } of rawArtifacts) {
  requireString(data, file, "title");
  requireString(data, file, "publisher");
  requireString(data, file, "url");
  if (!String(data.url || "").startsWith("http")) fail(file, "url must be clickable http(s)");
  if (!allowedArtifactTypes.has(data.artifactType)) fail(file, `invalid artifactType "${data.artifactType}"`);
  if (!sourceIds.has(data.sourceId)) fail(file, `unknown sourceId "${data.sourceId}"`);
  if (!fetchRunIds.has(data.fetchRunId)) fail(file, `unknown fetchRunId "${data.fetchRunId}"`);
  requireString(data, file, "firstSeenAt");
  requireString(data, file, "capturedAt");
  requireString(data, file, "contentHash");
  await validateRawPayload(data, file);
  requireKnownIds(data, file, "entityIds", entityIds, "entityId");
  requireKnownIds(data, file, "claimIds", claimIds, "claimId");
}

for (const { file, data } of claims) {
  requireString(data, file, "text");
  if (!allowedClaimTypes.has(data.claimType)) fail(file, `invalid claimType "${data.claimType}"`);
  if (!allowedClaimStatus.has(data.status)) fail(file, `invalid claim status "${data.status}"`);
  if (!allowedReviewStatus.has(data.reviewStatus)) fail(file, `invalid reviewStatus "${data.reviewStatus}"`);
  if (!allowedClaimConfidence.has(data.confidence)) fail(file, `invalid confidence "${data.confidence}"`);
  requireKnownIds(data, file, "entityIds", entityIds, "entityId", { required: true });
  requireKnownIds(data, file, "artifactIds", rawArtifactIds, "rawArtifactId", { required: true });
  requireKnownIds(data, file, "promotedEventIds", eventIds, "eventId");
  requireKnownIds(data, file, "promotedFollowupIds", followupIds, "followupId");
  requireKnownIds(data, file, "ruleOutputIds", ruleOutputIds, "ruleOutputId");
  requireString(data, file, "firstSeenAt");
  requireString(data, file, "capturedAt");
  requireString(data, file, "processedAt");
  if ("sourceLevel" in data) {
    fail(file, "sourceLevel belongs on evidence, not claim");
  }
}

for (const { file, data } of evidence) {
  requireString(data, file, "claimId");
  requireString(data, file, "rawArtifactId");
  requireString(data, file, "sourceId");
  if (!claimIds.has(data.claimId)) fail(file, `unknown claimId "${data.claimId}"`);
  if (!rawArtifactIds.has(data.rawArtifactId)) fail(file, `unknown rawArtifactId "${data.rawArtifactId}"`);
  if (!sourceIds.has(data.sourceId)) fail(file, `unknown sourceId "${data.sourceId}"`);
  if (data.ruleOutputId && !ruleOutputIds.has(data.ruleOutputId)) fail(file, `unknown ruleOutputId "${data.ruleOutputId}"`);
  if (!allowedEvidenceRelation.has(data.relation)) fail(file, `invalid evidence relation "${data.relation}"`);
  if (!allowedEvidence.has(data.sourceLevel)) fail(file, "sourceLevel must be A/B/C/D");
  if (!allowedEvidenceStrength.has(data.strength)) fail(file, `invalid evidence strength "${data.strength}"`);
  requireString(data, file, "capturedAt");
  requireString(data, file, "assessedAt");
}

for (const { file, data } of ruleOutputs) {
  requireString(data, file, "contractVersion");
  requireString(data, file, "ruleId");
  requireString(data, file, "pipeline");
  requireString(data, file, "rawArtifactId");
  requireString(data, file, "sourceId");
  requireString(data, file, "generatedAt");
  if (data.contractVersion !== "skill_rule_contract_v0") {
    fail(file, `unsupported contractVersion "${data.contractVersion}"`);
  }
  if (!allowedPipelineNames.has(data.pipeline)) fail(file, `invalid pipeline "${data.pipeline}"`);
  if (!rawArtifactIds.has(data.rawArtifactId)) fail(file, `unknown rawArtifactId "${data.rawArtifactId}"`);
  if (!sourceIds.has(data.sourceId)) fail(file, `unknown sourceId "${data.sourceId}"`);
  if (data.routeDecisionId && !routeDecisions.some((row) => row.data.id === data.routeDecisionId)) {
    fail(file, `unknown routeDecisionId "${data.routeDecisionId}"`);
  }
  if (!Array.isArray(data.claimCandidates) || data.claimCandidates.length === 0) {
    fail(file, "claimCandidates must be a non-empty array");
  } else {
    for (const candidate of data.claimCandidates) {
      if (!allowedClaimTypes.has(candidate.claimType)) fail(file, `invalid claimType "${candidate.claimType}"`);
      requireString(candidate, file, "text");
      if (!allowedClaimConfidence.has(candidate.confidence)) fail(file, `invalid confidence "${candidate.confidence}"`);
    }
  }
  if (!Array.isArray(data.evidenceCandidates) || data.evidenceCandidates.length === 0) {
    fail(file, "evidenceCandidates must be a non-empty array");
  } else {
    for (const candidate of data.evidenceCandidates) {
      if (!allowedEvidenceRelation.has(candidate.relation)) fail(file, `invalid evidence relation "${candidate.relation}"`);
      if (!allowedEvidence.has(candidate.sourceLevel)) fail(file, "evidence candidate sourceLevel must be A/B/C/D");
      if (!allowedEvidenceStrength.has(candidate.strength)) fail(file, `invalid evidence strength "${candidate.strength}"`);
    }
  }
  if (!Array.isArray(data.unknowns)) fail(file, "unknowns must be an array");
  if (!Array.isArray(data.followupHints)) fail(file, "followupHints must be an array");
  if (!Array.isArray(data.dataGaps)) fail(file, "dataGaps must be an array");
  if (!Array.isArray(data.reviewRequirements)) fail(file, "reviewRequirements must be an array");
  if (!data.timeFields || typeof data.timeFields !== "object") fail(file, "timeFields must be an object");
}

for (const { file, data } of milestones) {
  requireString(data, file, "title");
  requireString(data, file, "dueAt");
  if (!allowedMilestonePrecision.has(data.dueAtPrecision)) {
    fail(file, `invalid dueAtPrecision "${data.dueAtPrecision}"`);
  }
  if (!allowedMilestoneStatus.has(data.status)) fail(file, `invalid milestone status "${data.status}"`);
  requireKnownIds(data, file, "entityIds", entityIds, "entityId", { required: true });
  requireKnownIds(data, file, "claimIds", claimIds, "claimId");
  requireKnownIds(data, file, "followupIds", followupIds, "followupId");
  requireSourceIds(data, file, sourceIds);
}

for (const { file, data } of stateTransitions) {
  if (!allowedTransitionSubjectTypes.has(data.subjectType)) {
    fail(file, `invalid subjectType "${data.subjectType}"`);
  }
  if (data.subjectType === "claim" && !claimIds.has(data.subjectId)) fail(file, `unknown claim subjectId "${data.subjectId}"`);
  if (data.subjectType === "followup" && !followupIds.has(data.subjectId)) {
    fail(file, `unknown followup subjectId "${data.subjectId}"`);
  }
  if (data.subjectType === "event" && !eventIds.has(data.subjectId)) fail(file, `unknown event subjectId "${data.subjectId}"`);
  if (data.subjectType === "milestone" && !milestoneIds.has(data.subjectId)) {
    fail(file, `unknown milestone subjectId "${data.subjectId}"`);
  }
  if (data.subjectType === "source" && !sourceIds.has(data.subjectId)) fail(file, `unknown source subjectId "${data.subjectId}"`);
  requireString(data, file, "fromStatus");
  requireString(data, file, "toStatus");
  requireString(data, file, "occurredAt");
  requireString(data, file, "reason");
  requireKnownIds(data, file, "evidenceIds", evidenceIds, "evidenceId");
  requireKnownIds(data, file, "sourceIds", sourceIds, "sourceId");
}

const routeDecisionIds = new Set();
for (const { file, data } of routeDecisions) {
  registerId(data, file, "id", routeDecisionIds, "route decision");
  requireString(data, file, "rawArtifactId");
  requireString(data, file, "entity");
  requireString(data, file, "entityId");
  requireString(data, file, "pipeline");
  requireString(data, file, "reason");
  requireString(data, file, "createdAt");
  requireString(data, file, "nextAction");
  if (!rawArtifactIds.has(data.rawArtifactId)) fail(file, `unknown rawArtifactId "${data.rawArtifactId}"`);
  if (!allowedRouteTypes.has(data.type)) fail(file, `invalid route type "${data.type}"`);
  if (!entityIds.has(data.entityId)) fail(file, `unknown entityId "${data.entityId}"`);
  requireKnownIds(data, file, "entityIds", entityIds, "entityId", { required: true });
  if (!allowedPipelineNames.has(data.pipeline)) fail(file, `invalid pipeline "${data.pipeline}"`);
  if (configuredPipelineByType.get(data.type) !== data.pipeline) {
    fail(file, `pipeline "${data.pipeline}" does not match configured type "${data.type}"`);
  }
  if (!allowedRouteConfidence.has(data.confidence)) fail(file, `invalid confidence "${data.confidence}"`);
  if (!allowedRouteSourceKind.has(data.sourceKind)) fail(file, `invalid sourceKind "${data.sourceKind}"`);
  if (!allowedRouteStatus.has(data.status)) fail(file, `invalid route status "${data.status}"`);
  if (!Array.isArray(data.matchedSignals)) fail(file, "matchedSignals must be an array");
}

for (const { file, data } of pipelineTasks) {
  requireString(data, file, "rawArtifactId");
  requireString(data, file, "routeDecisionId");
  requireString(data, file, "pipeline");
  requireString(data, file, "type");
  requireString(data, file, "entityId");
  requireString(data, file, "inputType");
  requireString(data, file, "sourceKind");
  requireString(data, file, "status");
  requireString(data, file, "createdAt");
  requireString(data, file, "updatedAt");
  requireString(data, file, "nextAction");
  if (!rawArtifactIds.has(data.rawArtifactId)) fail(file, `unknown rawArtifactId "${data.rawArtifactId}"`);
  if (!routeDecisionIds.has(data.routeDecisionId)) fail(file, `unknown routeDecisionId "${data.routeDecisionId}"`);
  if (!allowedPipelineNames.has(data.pipeline)) fail(file, `invalid pipeline "${data.pipeline}"`);
  if (!allowedRouteTypes.has(data.type)) fail(file, `invalid route type "${data.type}"`);
  if (!entityIds.has(data.entityId)) fail(file, `unknown entityId "${data.entityId}"`);
  requireKnownIds(data, file, "entityIds", entityIds, "entityId", { required: true });
  if (!allowedInputTypes.has(data.inputType)) fail(file, `invalid inputType "${data.inputType}"`);
  if (!allowedRouteSourceKind.has(data.sourceKind)) fail(file, `invalid sourceKind "${data.sourceKind}"`);
  if (!allowedPipelineTaskStatus.has(data.status)) fail(file, `invalid pipeline task status "${data.status}"`);
  requireKnownIds(data, file, "claimIds", claimIds, "claimId");
  requireKnownIds(data, file, "evidenceIds", evidenceIds, "evidenceId");
  requireKnownIds(data, file, "ruleOutputIds", ruleOutputIds, "ruleOutputId");
  requireKnownIds(data, file, "pipelineRunIds", pipelineRunIds, "pipelineRunId");
  const route = routeDecisions.find((row) => row.data.id === data.routeDecisionId)?.data;
  if (route) {
    if (route.rawArtifactId !== data.rawArtifactId) fail(file, "rawArtifactId does not match route decision");
    if (route.pipeline !== data.pipeline) fail(file, "pipeline does not match route decision");
    if (route.type !== data.type) fail(file, "type does not match route decision");
  }
}

for (const { file, data } of pipelineRuns) {
  requireString(data, file, "pipelineTaskId");
  requireString(data, file, "rawArtifactId");
  requireString(data, file, "routeDecisionId");
  requireString(data, file, "pipeline");
  requireString(data, file, "status");
  requireString(data, file, "startedAt");
  if (!pipelineTaskIds.has(data.pipelineTaskId)) fail(file, `unknown pipelineTaskId "${data.pipelineTaskId}"`);
  if (!rawArtifactIds.has(data.rawArtifactId)) fail(file, `unknown rawArtifactId "${data.rawArtifactId}"`);
  if (!routeDecisionIds.has(data.routeDecisionId)) fail(file, `unknown routeDecisionId "${data.routeDecisionId}"`);
  if (!allowedPipelineNames.has(data.pipeline)) fail(file, `invalid pipeline "${data.pipeline}"`);
  if (!allowedPipelineRunStatus.has(data.status)) fail(file, `invalid pipeline run status "${data.status}"`);
  requireKnownIds(data, file, "claimIds", claimIds, "claimId");
  requireKnownIds(data, file, "evidenceIds", evidenceIds, "evidenceId");
  requireKnownIds(data, file, "ruleOutputIds", ruleOutputIds, "ruleOutputId");
  const task = pipelineTasks.find((row) => row.data.id === data.pipelineTaskId)?.data;
  if (task) {
    if (task.rawArtifactId !== data.rawArtifactId) fail(file, "rawArtifactId does not match pipeline task");
    if (task.routeDecisionId !== data.routeDecisionId) fail(file, "routeDecisionId does not match pipeline task");
    if (task.pipeline !== data.pipeline) fail(file, "pipeline does not match pipeline task");
  }
}

for (const { file, data } of observationRuns) {
  requireString(data, file, "targetDate");
  requireString(data, file, "generatedAt");
  requireString(data, file, "sourceDashboardGeneratedAt");
  requireString(data, file, "status");
  requireString(data, file, "projectionPolicy");
  if (!allowedObservationRunStatus.has(data.status)) fail(file, `invalid observation run status "${data.status}"`);
  if (!Array.isArray(data.rows)) {
    fail(file, "rows must be an array");
  } else {
    for (const row of data.rows) {
      requireString(row, file, "observationId");
      requireString(row, file, "eventId");
      requireString(row, file, "gate");
      requireString(row, file, "status");
      if (!eventIds.has(row.eventId)) fail(file, `unknown eventId "${row.eventId}"`);
      requireKnownIds(row, file, "claimIds", claimIds, "claimId");
      requireKnownIds(row, file, "evidenceIds", evidenceIds, "evidenceId");
      requireKnownIds(row, file, "stateTransitionIds", stateTransitionIds, "stateTransitionId");
      if (row.status === "projected") {
        if (!Array.isArray(row.claimIds) || row.claimIds.length === 0) {
          fail(file, `projected observation "${row.observationId}" must include promoted claimIds`);
        }
        if (!Array.isArray(row.evidenceIds) || row.evidenceIds.length === 0) {
          fail(file, `projected observation "${row.observationId}" must include evidenceIds`);
        }
      }
      for (const claimId of row.claimIds || []) {
        const claim = claims.find((item) => item.data.id === claimId)?.data;
        if (claim && (claim.reviewStatus !== "promoted" || !claim.promotedEventIds?.includes(row.eventId))) {
          fail(file, `observation row includes unpromoted claim "${claimId}"`);
        }
      }
    }
  }
  if (!Array.isArray(data.excludedClaims)) {
    fail(file, "excludedClaims must be an array");
  } else {
    for (const excluded of data.excludedClaims) {
      requireString(excluded, file, "claimId");
      if (!claimIds.has(excluded.claimId)) fail(file, `unknown excluded claimId "${excluded.claimId}"`);
    }
  }
  if (Number(data.violationCount || 0) > 0 && data.status !== "failed") {
    fail(file, "observation run with violations must be failed");
  }
}

for (const { file, data } of schedulerRuns) {
  requireString(data, file, "mode");
  requireString(data, file, "status");
  requireString(data, file, "startedAt");
  if (!allowedSchedulerRunStatus.has(data.status)) fail(file, `invalid scheduler status "${data.status}"`);
  if (!Array.isArray(data.cadenceKeys)) fail(file, "cadenceKeys must be an array");
  for (const cadenceKey of data.cadenceKeys || []) {
    if (!schedulerCadenceIds.has(cadenceKey)) fail(file, `unknown cadenceKey "${cadenceKey}"`);
  }
  if (!Array.isArray(data.results)) {
    fail(file, "results must be an array");
    continue;
  }
  for (const result of data.results) {
    requireString(result, file, "sourceId");
    requireString(result, file, "cadenceKey");
    requireString(result, file, "inputType");
    requireString(result, file, "url");
    requireString(result, file, "status");
    requireString(result, file, "reason");
    if (!schedulerSourceIds.has(result.sourceId)) fail(file, `unknown scheduler sourceId "${result.sourceId}"`);
    if (!schedulerCadenceIds.has(result.cadenceKey)) fail(file, `unknown cadenceKey "${result.cadenceKey}"`);
    if (!allowedInputTypes.has(result.inputType)) fail(file, `invalid inputType "${result.inputType}"`);
    if (!allowedSchedulerResultStatus.has(result.status)) fail(file, `invalid result status "${result.status}"`);
    if (result.rawArtifactId && !rawArtifactIds.has(result.rawArtifactId)) {
      fail(file, `unknown rawArtifactId "${result.rawArtifactId}"`);
    }
    if (result.routeDecisionId && !routeDecisionIds.has(result.routeDecisionId)) {
      fail(file, `unknown routeDecisionId "${result.routeDecisionId}"`);
    }
    if (result.pipelineTaskId && !pipelineTaskIds.has(result.pipelineTaskId)) {
      fail(file, `unknown pipelineTaskId "${result.pipelineTaskId}"`);
    }
    if (result.pipeline && !allowedPipelineNames.has(result.pipeline)) fail(file, `invalid pipeline "${result.pipeline}"`);
  }
}

if (!schedulerState || typeof schedulerState !== "object") {
  fail("data/scheduler/state.json", "state must be an object");
} else {
  requireString(schedulerState, "data/scheduler/state.json", "updatedAt");
  const stateSources = schedulerState.sources || {};
  for (const [sourceId, sourceState] of Object.entries(stateSources)) {
    if (!schedulerSourceIds.has(sourceId)) fail("data/scheduler/state.json", `unknown state source "${sourceId}"`);
    requireString(sourceState, "data/scheduler/state.json", "lastCheckedAt");
    requireString(sourceState, "data/scheduler/state.json", "lastRunAt");
    requireString(sourceState, "data/scheduler/state.json", "lastSchedulerRunId");
    requireString(sourceState, "data/scheduler/state.json", "lastStatus");
    if (!allowedSchedulerResultStatus.has(sourceState.lastStatus)) {
      fail("data/scheduler/state.json", `invalid lastStatus "${sourceState.lastStatus}"`);
    }
    if (schedulerRunIds.size > 0 && !schedulerRunIds.has(sourceState.lastSchedulerRunId)) {
      fail("data/scheduler/state.json", `unknown lastSchedulerRunId "${sourceState.lastSchedulerRunId}"`);
    }
    if (sourceState.lastRawArtifactId && !rawArtifactIds.has(sourceState.lastRawArtifactId)) {
      fail("data/scheduler/state.json", `unknown lastRawArtifactId "${sourceState.lastRawArtifactId}"`);
    }
    if (sourceState.lastRouteDecisionId && !routeDecisionIds.has(sourceState.lastRouteDecisionId)) {
      fail("data/scheduler/state.json", `unknown lastRouteDecisionId "${sourceState.lastRouteDecisionId}"`);
    }
    if (sourceState.lastPipelineTaskId && !pipelineTaskIds.has(sourceState.lastPipelineTaskId)) {
      fail("data/scheduler/state.json", `unknown lastPipelineTaskId "${sourceState.lastPipelineTaskId}"`);
    }
  }
}

async function validateRawPayload(rawArtifact, file) {
  requireString(rawArtifact, file, "storagePath");
  if (typeof rawArtifact.storagePath !== "string" || rawArtifact.storagePath.trim() === "") return;
  const payloadPath = path.join(DATA_DIR, rawArtifact.storagePath);
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(payloadPath, "utf8"));
  } catch {
    fail(file, `storagePath does not point to a readable raw payload: ${rawArtifact.storagePath}`);
    return;
  }
  if (!payload.content || typeof payload.content !== "object") {
    fail(file, "raw payload must contain a content object");
    return;
  }
  const expected = `sha256:${crypto.createHash("sha256").update(stableStringify(payload.content)).digest("hex")}`;
  if (rawArtifact.contentHash !== expected) {
    fail(file, `contentHash does not match raw payload content hash ${expected}`);
  }
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

if (errors.length > 0) {
  console.error("Data validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(
  `Data validation passed. Sources: ${sourceIds.size}, entities: ${entityIds.size}, pipeline tasks: ${pipelineTaskIds.size}, pipeline runs: ${pipelineRunIds.size}, rule outputs: ${ruleOutputIds.size}, observation runs: ${observationRunIds.size}, scheduler runs: ${schedulerRunIds.size}.`
);
