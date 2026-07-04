import { readJsonDir, readJsonFile, DATA_DIR } from "./data-utils.mjs";
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
const pipelineMap = await readJsonFile(path.join(DATA_DIR, "pipelines", "pipeline_map.json"));

const fetchRunIds = new Set();
const rawArtifactIds = new Set();
const claimIds = new Set();
const evidenceIds = new Set();
const milestoneIds = new Set();
const stateTransitionIds = new Set();

for (const { file, data } of fetchRuns) registerId(data, file, "id", fetchRunIds, "fetch run");
for (const { file, data } of rawArtifacts) registerId(data, file, "id", rawArtifactIds, "raw artifact");
for (const { file, data } of claims) registerId(data, file, "id", claimIds, "claim");
for (const { file, data } of evidence) registerId(data, file, "id", evidenceIds, "evidence");
for (const { file, data } of milestones) registerId(data, file, "id", milestoneIds, "milestone");
for (const { file, data } of stateTransitions) {
  registerId(data, file, "id", stateTransitionIds, "state transition");
}

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

for (const { file, data } of fetchRuns) {
  requireString(data, file, "fetcher");
  requireString(data, file, "sourceName");
  requireString(data, file, "startedAt");
  requireString(data, file, "finishedAt");
  if (!allowedFetchSourceTypes.has(data.sourceType)) fail(file, `invalid sourceType "${data.sourceType}"`);
  if (!allowedFetchStatus.has(data.status)) fail(file, `invalid fetch status "${data.status}"`);
  requireKnownIds(data, file, "artifactIds", rawArtifactIds, "rawArtifactId");
  requireKnownIds(data, file, "claimIds", claimIds, "claimId");
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
  if (!allowedEvidenceRelation.has(data.relation)) fail(file, `invalid evidence relation "${data.relation}"`);
  if (!allowedEvidence.has(data.sourceLevel)) fail(file, "sourceLevel must be A/B/C/D");
  if (!allowedEvidenceStrength.has(data.strength)) fail(file, `invalid evidence strength "${data.strength}"`);
  requireString(data, file, "capturedAt");
  requireString(data, file, "assessedAt");
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

if (errors.length > 0) {
  console.error("Data validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Data validation passed. Sources: ${sourceIds.size}, entities: ${entityIds.size}.`);
