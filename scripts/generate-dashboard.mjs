import path from "node:path";
import {
  DATA_DIR,
  ensureArray,
  readJsonDir,
  readJsonFile,
  severityForCount,
  todayInShanghai,
  writeJsonFile,
} from "./data-utils.mjs";

const targetDate = process.env.RESEARCH_DATE || todayInShanghai();

const entitiesIndex = await readJsonFile(path.join(DATA_DIR, "entities", "index.json"));
const entities = entitiesIndex.entities || [];
const entityById = new Map(entities.map((entity) => [entity.id, entity]));
const sourceRows = await readJsonDir("sources");
const sources = sourceRows.map((row) => row.data);
const sourceById = new Map(sources.map((source) => [source.id, source]));
const events = (await readJsonDir("events")).map((row) => row.data);
const relations = (await readJsonDir("relations")).map((row) => row.data);
const followups = (await readJsonDir("followups")).map((row) => row.data);
const stockRows = (await readJsonDir("stocks")).flatMap((row) => ensureArray(row.data));

function enrichSources(sourceIds = []) {
  return sourceIds.map((sourceId) => sourceById.get(sourceId)).filter(Boolean);
}

function entityNames(entityIds = []) {
  return entityIds.map((entityId) => entityById.get(entityId)?.name || entityId);
}

const todayEvents = events.filter((event) => event.date === targetDate);
const todayStocks = stockRows.filter((stock) => stock.date === targetDate);
const todayRelations = relations.filter((relation) => relation.date === targetDate);

const eventTypeCounts = todayEvents.reduce((acc, event) => {
  acc[event.eventType] = (acc[event.eventType] || 0) + 1;
  return acc;
}, {});

const moduleCounts = todayEvents.reduce((acc, event) => {
  acc[event.module] = (acc[event.module] || 0) + 1;
  return acc;
}, {});

const followupStatusCounts = followups.reduce((acc, item) => {
  acc[item.status] = (acc[item.status] || 0) + 1;
  return acc;
}, {});

const marketRows = todayStocks.map((stock) => ({
  id: stock.id,
  entityId: stock.entityId,
  company: entityById.get(stock.entityId)?.name || stock.entityId,
  stockCode: stock.stockCode,
  market: stock.market,
  snapshotType: stock.snapshotType,
  isFinal: stock.isFinal,
  price: stock.price ?? stock.close ?? null,
  changePct: stock.changePct ?? null,
  turnoverAmount: stock.turnoverAmount ?? null,
  turnoverRate: stock.turnoverRate ?? null,
  mainNetInflow: stock.mainNetInflow ?? null,
  sourceIds: stock.sourceIds,
  sources: enrichSources(stock.sourceIds),
  capturedAt: stock.capturedAt,
}));

const importantEvents = todayEvents
  .slice()
  .sort((a, b) => (b.importance || 0) - (a.importance || 0))
  .slice(0, 5)
  .map((event) => ({
    id: event.id,
    title: event.title,
    fact: event.fact,
    eventType: event.eventType,
    module: event.module,
    importance: event.importance || 1,
    entityNames: entityNames(event.entityIds),
    evidenceLevel: event.evidenceLevel,
    sourceIds: event.sourceIds,
    sources: enrichSources(event.sourceIds),
  }));

const today = {
  date: targetDate,
  generatedAt: new Date().toISOString(),
  status: todayEvents.length || todayStocks.length ? "ready" : "empty",
  signals: {
    changes: severityForCount(todayEvents.length + todayRelations.length),
    market: severityForCount(todayStocks.length),
    followup: severityForCount(followups.filter((item) => item.status === "pending").length),
  },
  totals: {
    changes: todayEvents.length + todayRelations.length,
    events: todayEvents.length,
    relations: todayRelations.length,
    stocks: todayStocks.length,
    sources: sources.length,
  },
  eventTypeCounts,
  moduleCounts,
  importantEvents,
  marketRows,
  noVerifiedData: todayEvents.length === 0 && todayStocks.length === 0,
};

const market = {
  date: targetDate,
  generatedAt: today.generatedAt,
  rows: marketRows,
  summary: {
    tracked: marketRows.length,
    up: marketRows.filter((row) => Number(row.changePct) > 0).length,
    down: marketRows.filter((row) => Number(row.changePct) < 0).length,
    flat: marketRows.filter((row) => Number(row.changePct) === 0).length,
  },
};

const heat = {
  date: targetDate,
  generatedAt: today.generatedAt,
  score: Math.min(100, todayEvents.reduce((sum, event) => sum + (event.importance || 1), 0) * 10),
  modules: Object.entries(moduleCounts).map(([name, count]) => ({ name, count })),
  eventTypes: Object.entries(eventTypeCounts).map(([name, count]) => ({ name, count })),
};

const timeline = {
  date: targetDate,
  generatedAt: today.generatedAt,
  nodes: todayEvents
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((event) => ({
      id: event.id,
      date: event.date,
      title: event.title,
      eventType: event.eventType,
      entityNames: entityNames(event.entityIds),
      evidenceLevel: event.evidenceLevel,
      sourceIds: event.sourceIds,
      sources: enrichSources(event.sourceIds),
    })),
};

const followup = {
  date: targetDate,
  generatedAt: today.generatedAt,
  statusCounts: followupStatusCounts,
  rows: followups.map((item) => ({
    id: item.id,
    subject: item.subject,
    status: item.status,
    entityNames: entityNames(item.entityIds),
    sourceIds: item.sourceIds,
    sources: enrichSources(item.sourceIds),
  })),
};

const watchlist = {
  date: targetDate,
  generatedAt: today.generatedAt,
  rows: entities
    .filter((entity) => entity.tags?.includes("Watchlist"))
    .map((entity) => ({
      id: entity.id,
      name: entity.name,
      kind: entity.kind,
      segment: entity.segment || null,
      listed: Boolean(entity.listed),
      stockCode: entity.stockCode || null,
      market: entity.market || null,
    })),
};

const stats = {
  date: targetDate,
  generatedAt: today.generatedAt,
  entities: entities.length,
  events: events.length,
  relations: relations.length,
  followups: followups.length,
  stockSnapshots: stockRows.length,
  sources: sources.length,
  evidenceLevels: sources.reduce((acc, source) => {
    acc[source.evidenceLevel] = (acc[source.evidenceLevel] || 0) + 1;
    return acc;
  }, {}),
};

const sourceRegistry = {
  date: targetDate,
  generatedAt: today.generatedAt,
  rows: sources.map((source) => ({
    id: source.id,
    title: source.title,
    publisher: source.publisher,
    sourceType: source.sourceType,
    url: source.url,
    evidenceLevel: source.evidenceLevel,
    status: source.status,
  })),
};

await writeJsonFile(path.join(DATA_DIR, "dashboard", "today.json"), today);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "market.json"), market);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "heat.json"), heat);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "timeline.json"), timeline);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "followup.json"), followup);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "watchlist.json"), watchlist);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "stats.json"), stats);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "sources.json"), sourceRegistry);

console.log(`Dashboard cache generated for ${targetDate}.`);
