import { readJsonDir, readJsonFile, DATA_DIR } from "./data-utils.mjs";
import path from "node:path";

const allowedEvidence = new Set(["A", "B", "C", "D"]);
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

if (errors.length > 0) {
  console.error("Data validation failed:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Data validation passed. Sources: ${sourceIds.size}, entities: ${entityIds.size}.`);

