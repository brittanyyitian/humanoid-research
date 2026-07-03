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

const marketByEntityId = new Map(marketRows.map((row) => [row.entityId, row]));
const watchlistMarketContext = marketRows
  .slice()
  .sort((a, b) => Math.abs(Number(b.changePct) || 0) - Math.abs(Number(a.changePct) || 0))
  .slice(0, 5);

function enrichedEntity(entityId) {
  const entity = entityById.get(entityId);
  if (!entity) {
    return {
      id: entityId,
      name: entityId,
      kind: "unknown",
      segment: null,
      listed: false,
      stockCode: null,
      market: null,
    };
  }

  return {
    id: entity.id,
    name: entity.name,
    kind: entity.kind,
    segment: entity.segment || null,
    listed: Boolean(entity.listed),
    stockCode: entity.stockCode || null,
    market: entity.market || null,
  };
}

function eventDashboardRow(event) {
  const involvedEntities = event.entityIds.map(enrichedEntity);
  const directMarketRows = event.entityIds
    .map((entityId) => marketByEntityId.get(entityId))
    .filter(Boolean);
  const relatedFollowups = followups
    .filter((item) => ensureArray(item.entityIds).some((entityId) => event.entityIds.includes(entityId)))
    .map((item) => ({
      id: item.id,
      subject: item.subject,
      status: item.status,
      entityNames: entityNames(item.entityIds),
      sourceIds: item.sourceIds,
      sources: enrichSources(item.sourceIds),
    }));

  return {
    id: event.id,
    date: event.date,
    title: event.title,
    fact: event.fact,
    eventType: event.eventType,
    module: event.module,
    importance: event.importance || 1,
    entityIds: event.entityIds,
    entityNames: entityNames(event.entityIds),
    entities: involvedEntities,
    directMarketRows,
    watchlistMarketContext,
    followups: relatedFollowups,
    evidenceLevel: event.evidenceLevel,
    sourceIds: event.sourceIds,
    sources: enrichSources(event.sourceIds),
    tags: event.tags || [],
  };
}

const importantEvents = todayEvents
  .slice()
  .sort((a, b) => (b.importance || 0) - (a.importance || 0))
  .slice(0, 5)
  .map(eventDashboardRow);

const allEventRows = events
  .slice()
  .sort((a, b) => b.date.localeCompare(a.date) || (b.importance || 0) - (a.importance || 0))
  .map(eventDashboardRow);

const latestEventRows = allEventRows.slice(0, 8);

const evidenceRank = { A: 4, B: 3, C: 2, D: 1 };

function observationSort(a, b) {
  return (
    (evidenceRank[b.evidenceLevel] || 0) - (evidenceRank[a.evidenceLevel] || 0) ||
    (b.importance || 0) - (a.importance || 0) ||
    (b.entityIds?.length || 0) - (a.entityIds?.length || 0) ||
    String(b.date || "").localeCompare(String(a.date || ""))
  );
}

function relatedObservationScore(event, candidate) {
  if (event.id === candidate.id) return -1;
  let score = 0;
  if (event.eventType === candidate.eventType) score += 4;
  if (event.module === candidate.module) score += 3;
  const eventTags = new Set(event.tags || []);
  for (const tag of candidate.tags || []) {
    if (eventTags.has(tag)) score += 1;
  }
  return score;
}

function observationRow(event, index, sortedRows) {
  const relatedObservations = sortedRows
    .map((candidate) => ({ candidate, score: relatedObservationScore(event, candidate) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score || observationSort(a.candidate, b.candidate))
    .slice(0, 3)
    .map(({ candidate }) => ({
      id: `obs_${candidate.id}`,
      eventId: candidate.id,
      date: candidate.date,
      title: candidate.title,
      fact: candidate.fact,
      module: candidate.module,
      eventType: candidate.eventType,
      evidenceLevel: candidate.evidenceLevel,
      entityNames: candidate.entityNames,
      sources: candidate.sources,
    }));

  return {
    id: `obs_${event.id}`,
    number: `#${String(index + 1).padStart(3, "0")}`,
    eventId: event.id,
    date: event.date,
    title: event.title,
    fact: event.fact,
    eventType: event.eventType,
    module: event.module,
    importance: event.importance || 1,
    evidenceLevel: event.evidenceLevel,
    entityIds: event.entityIds,
    entityNames: event.entityNames,
    entities: event.entities,
    sameDayWatchlistRows: event.watchlistMarketContext,
    followups: event.followups,
    sourceIds: event.sourceIds,
    sources: event.sources,
    relatedObservations,
    tags: event.tags || [],
  };
}

const sortedObservationEvents = allEventRows.slice().sort(observationSort);
const allObservationRows = sortedObservationEvents.map((event, index) =>
  observationRow(event, index, sortedObservationEvents)
);
const todayObservationRows = allObservationRows.filter((row) => row.date === targetDate);
const researchObservationRows = (todayObservationRows.length ? todayObservationRows : allObservationRows).slice(0, 5);

const companyRows = entities
  .filter((entity) => entity.tags?.includes("Watchlist"))
  .map((entity) => {
    const companyEvents = allEventRows.filter((event) => event.entityIds.includes(entity.id));
    const companyFollowups = followups
      .filter((item) => ensureArray(item.entityIds).includes(entity.id))
      .map((item) => ({
        id: item.id,
        subject: item.subject,
        status: item.status,
        entityNames: entityNames(item.entityIds),
        sourceIds: item.sourceIds,
        sources: enrichSources(item.sourceIds),
      }));
    const stock = marketByEntityId.get(entity.id) || null;
    const sourceMap = new Map();
    for (const source of stock?.sources || []) sourceMap.set(source.id || source.url, source);
    for (const event of companyEvents) {
      for (const source of event.sources || []) sourceMap.set(source.id || source.url, source);
    }
    for (const item of companyFollowups) {
      for (const source of item.sources || []) sourceMap.set(source.id || source.url, source);
    }

    return {
      ...enrichedEntity(entity.id),
      tags: entity.tags || [],
      stock,
      events: companyEvents.slice(0, 8),
      followups: companyFollowups,
      sources: Array.from(sourceMap.values()),
      todayEventCount: companyEvents.filter((event) => event.date === targetDate).length,
    };
  });

const dataGaps = companyRows
  .map((company) => {
    const gaps = [];
    if (!company.events.length) gaps.push("缺正式事件");
    if (!company.followups.length) gaps.push("缺Follow-up");
    if (company.listed && !company.stock) gaps.push("缺股票快照");
    if (!company.sources.length) gaps.push("缺来源引用");
    return {
      entityId: company.id,
      name: company.name,
      segment: company.segment,
      listed: company.listed,
      stockCode: company.stockCode,
      market: company.market,
      gapCount: gaps.length,
      gaps,
    };
  })
  .filter((row) => row.gaps.length)
  .sort((a, b) => b.gapCount - a.gapCount || a.name.localeCompare(b.name, "zh-Hans-CN"));

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
  latestEvents: latestEventRows.slice(0, 5),
  marketRows,
  noVerifiedData: todayEvents.length === 0 && todayStocks.length === 0,
};

const eventDashboard = {
  date: targetDate,
  generatedAt: today.generatedAt,
  todayEvents: importantEvents,
  recentEvents: latestEventRows,
  rows: allEventRows,
  totals: {
    today: todayEvents.length,
    all: allEventRows.length,
    involvedCompaniesToday: new Set(todayEvents.flatMap((event) => event.entityIds)).size,
    directStocksToday: new Set(
      todayEvents.flatMap((event) => event.entityIds).filter((entityId) => marketByEntityId.has(entityId))
    ).size,
  },
};

const observationsDashboard = {
  date: targetDate,
  generatedAt: today.generatedAt,
  sortPolicy: "证据等级 > 事件重要性 > 涉及公司数量 > 日期",
  sourcePolicy: "股票只展示同日 Watchlist 行情事实，不表达因果判断。",
  todayRows: todayObservationRows,
  researchRows: researchObservationRows,
  rows: allObservationRows,
  whatsNew: {
    previousTotal: allObservationRows.filter((row) => row.date < targetDate).length,
    currentTotal: allObservationRows.length,
    addedToday: todayObservationRows.length,
  },
  totals: {
    today: todayObservationRows.length,
    all: allObservationRows.length,
    research: researchObservationRows.length,
  },
};

const companiesDashboard = {
  date: targetDate,
  generatedAt: today.generatedAt,
  rows: companyRows,
};

const gapsDashboard = {
  date: targetDate,
  generatedAt: today.generatedAt,
  policy: "只标记缺口，不自动补正式事件；正式库仍要求事实、日期、来源链接和证据等级。",
  rows: dataGaps,
  totals: {
    companiesWithGaps: dataGaps.length,
    missingEvents: dataGaps.filter((row) => row.gaps.includes("缺正式事件")).length,
    missingFollowups: dataGaps.filter((row) => row.gaps.includes("缺Follow-up")).length,
    missingStocks: dataGaps.filter((row) => row.gaps.includes("缺股票快照")).length,
    missingSources: dataGaps.filter((row) => row.gaps.includes("缺来源引用")).length,
  },
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
  observations: allObservationRows.length,
  dataGaps: dataGaps.length,
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
await writeJsonFile(path.join(DATA_DIR, "dashboard", "events.json"), eventDashboard);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "observations.json"), observationsDashboard);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "companies.json"), companiesDashboard);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "gaps.json"), gapsDashboard);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "market.json"), market);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "heat.json"), heat);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "timeline.json"), timeline);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "followup.json"), followup);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "watchlist.json"), watchlist);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "stats.json"), stats);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "relations.json"), relationDashboard);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "sources.json"), sourceRegistry);

console.log(`Dashboard cache generated for ${targetDate}.`);
