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
const HEAT_MODULES = ["整机", "力传感器", "丝杠", "减速器", "灵巧手", "电机", "AI", "政策", "会议", "资本/IPO"];

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

function enrichStockSources(stock) {
  const rows = enrichSources(stock.sourceIds);
  if (!stock.providerSourceUrl || rows.length === 0) return rows;
  const quoteSources = rows.map((source, index) =>
    index === 0
      ? {
          ...source,
          title: `${source.title} · ${stock.stockCode}`,
          url: stock.providerSourceUrl,
        }
      : source
  );
  if (!stock.klineSourceUrl) return quoteSources;
  return [
    ...quoteSources,
    {
      ...quoteSources[0],
      id: `${quoteSources[0].id}_kline_${stock.stockCode}`,
      title: `腾讯财经K线接口 · ${stock.stockCode}`,
      url: stock.klineSourceUrl,
    },
  ];
}

function entityNames(entityIds = []) {
  return entityIds.map((entityId) => entityById.get(entityId)?.name || entityId);
}

const todayEvents = events.filter((event) => event.date === targetDate);
const todayStocks = stockRows.filter((stock) => stock.date === targetDate);
const todayRelations = relations.filter((relation) => relation.date === targetDate);
const targetTime = new Date(`${targetDate}T00:00:00+08:00`).getTime();
const heatWindowDays = 30;
const heatStartTime = targetTime - (heatWindowDays - 1) * 24 * 60 * 60 * 1000;
const windowEvents = events.filter((event) => {
  const time = new Date(`${event.date}T00:00:00+08:00`).getTime();
  return time >= heatStartTime && time <= targetTime;
});

const eventTypeCounts = todayEvents.reduce((acc, event) => {
  acc[event.eventType] = (acc[event.eventType] || 0) + 1;
  return acc;
}, {});

const todayModuleCounts = todayEvents.reduce((acc, event) => {
  acc[event.module] = (acc[event.module] || 0) + 1;
  return acc;
}, {});

function heatModuleName(event) {
  if (event.eventType === "policy") return "政策";
  if (event.eventType === "conference") return "会议";
  if (event.eventType === "ipo" || event.eventType === "funding") return "资本/IPO";
  const moduleName = event.module || "";
  if (moduleName.includes("整机")) return "整机";
  if (moduleName.includes("力传感器")) return "力传感器";
  if (moduleName.includes("丝杠")) return "丝杠";
  if (moduleName.includes("减速器")) return "减速器";
  if (moduleName.includes("灵巧手")) return "灵巧手";
  if (moduleName.includes("电机") || moduleName.includes("控制")) return "电机";
  if (moduleName.includes("AI") || moduleName.includes("模型")) return "AI";
  return null;
}

const windowModuleCounts = windowEvents.reduce((acc, event) => {
  const moduleName = heatModuleName(event);
  if (moduleName) acc[moduleName] = (acc[moduleName] || 0) + 1;
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
  totalMarketCap: stock.totalMarketCap ?? null,
  floatMarketCap: stock.floatMarketCap ?? null,
  mainNetInflow: stock.mainNetInflow ?? null,
  fiveDayChangePct: stock.fiveDayChangePct ?? null,
  twentyDayChangePct: stock.twentyDayChangePct ?? null,
  sourceIds: stock.sourceIds,
  sources: enrichStockSources(stock),
  capturedAt: stock.capturedAt,
  providerSourceUrl: stock.providerSourceUrl ?? null,
  quoteUrl: stock.quoteUrl ?? null,
  klineSourceUrl: stock.klineSourceUrl ?? null,
  quoteTime: stock.quoteTime ?? null,
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
    importantEvents: importantEvents.length,
    pendingFollowups: followups.filter((item) => item.status === "pending").length,
  },
  eventTypeCounts,
  moduleCounts: todayModuleCounts,
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
  windowDays: heatWindowDays,
  modules: HEAT_MODULES.map((name) => ({ name, count: windowModuleCounts[name] || 0 })),
  eventTypes: Object.entries(
    windowEvents.reduce((acc, event) => {
      acc[event.eventType] = (acc[event.eventType] || 0) + 1;
      return acc;
    }, {})
  ).map(([name, count]) => ({ name, count })),
};

const timeline = {
  date: targetDate,
  generatedAt: today.generatedAt,
  nodes: events
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((event) => ({
      id: event.id,
      date: event.date,
      title: event.title,
      fact: event.fact,
      eventType: event.eventType,
      module: event.module,
      entityNames: entityNames(event.entityIds),
      evidenceLevel: event.evidenceLevel,
      sourceIds: event.sourceIds,
      sources: enrichSources(event.sourceIds),
    })),
  recentNodes: events
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .map((event) => ({
      id: event.id,
      date: event.date,
      title: event.title,
      fact: event.fact,
      eventType: event.eventType,
      module: event.module,
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

const relationDashboard = {
  date: targetDate,
  generatedAt: today.generatedAt,
  rows: relations.map((relation) => ({
    id: relation.id,
    date: relation.date || null,
    entityAId: relation.entityAId,
    entityBId: relation.entityBId,
    entityAName: entityById.get(relation.entityAId)?.name || relation.entityAId,
    entityBName: entityById.get(relation.entityBId)?.name || relation.entityBId,
    relationType: relation.relationType,
    fact: relation.fact || relation.relationType,
    evidenceLevel: relation.evidenceLevel,
    sourceIds: relation.sourceIds,
    sources: enrichSources(relation.sourceIds),
  })),
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
await writeJsonFile(path.join(DATA_DIR, "dashboard", "relations.json"), relationDashboard);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "sources.json"), sourceRegistry);

console.log(`Dashboard cache generated for ${targetDate}.`);
