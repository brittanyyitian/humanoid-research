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
const rawArtifacts = (await readJsonDir("raw_artifacts")).map((row) => row.data);
const claims = (await readJsonDir("claims")).map((row) => row.data);
const evidenceRows = (await readJsonDir("evidence")).map((row) => row.data);
const fetchRuns = (await readJsonDir("fetch_runs")).map((row) => row.data);
const milestones = (await readJsonDir("milestones")).map((row) => row.data);
const stateTransitions = (await readJsonDir("state_transitions")).map((row) => row.data);
const inboxRows = (await readJsonDir("inbox")).map((row) => row.data);
const routeDecisions = (await readJsonDir("route_decisions")).map((row) => row.data);
const pipelineTasks = (await readJsonDir("pipeline_tasks")).map((row) => row.data);
const pipelineMap = await readJsonFile(path.join(DATA_DIR, "pipelines", "pipeline_map.json"));
const schedulerConfig = await readJsonFile(path.join(DATA_DIR, "scheduler", "sources.json"));
const schedulerState = await readJsonFile(path.join(DATA_DIR, "scheduler", "state.json"));
const schedulerRuns = (await readJsonDir("scheduler_runs")).map((row) => row.data);

const rawArtifactById = new Map(rawArtifacts.map((artifact) => [artifact.id, artifact]));
const routeDecisionById = new Map(routeDecisions.map((route) => [route.id, route]));
const schedulerCadenceById = new Map((schedulerConfig.cadences || []).map((cadence) => [cadence.id, cadence]));
const evidenceByClaimId = new Map();
const claimsByEventId = new Map();
const transitionsBySubject = new Map();

function pushMap(map, key, value) {
  if (!key) return;
  const rows = map.get(key) || [];
  rows.push(value);
  map.set(key, rows);
}

for (const item of evidenceRows) pushMap(evidenceByClaimId, item.claimId, item);
for (const claim of claims) {
  for (const eventId of claim.promotedEventIds || []) pushMap(claimsByEventId, eventId, claim);
}
for (const transition of stateTransitions) {
  pushMap(transitionsBySubject, `${transition.subjectType}:${transition.subjectId}`, transition);
}

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

function dateKey(value) {
  if (!value) return null;
  return String(value).slice(0, 10);
}

function dateTime(value) {
  if (!value) return null;
  const time = new Date(String(value).length === 10 ? `${value}T00:00:00+08:00` : value).getTime();
  return Number.isFinite(time) ? time : null;
}

function latestTime(values) {
  return values
    .filter(Boolean)
    .map(String)
    .sort()
    .at(-1);
}

function addSeconds(value, seconds) {
  const time = dateTime(value);
  if (!time || !seconds) return null;
  return shanghaiDateTime(time + seconds * 1000);
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

function dueStatus(lastRunAt, seconds) {
  if (!lastRunAt) return "never_run";
  const nextDue = addSeconds(lastRunAt, seconds);
  if (!nextDue) return "unknown";
  return Date.parse(nextDue) <= Date.now() ? "due" : "waiting";
}

function freshnessStatus(lastSeenAt, maxAgeHours) {
  const time = dateTime(lastSeenAt);
  if (!time) return "missing";
  const ageHours = (Date.now() - time) / (60 * 60 * 1000);
  if (ageHours <= maxAgeHours) return "fresh";
  if (ageHours <= maxAgeHours * 3) return "aging";
  return "stale";
}

function countBy(rows, keyFn) {
  return rows.reduce((acc, row) => {
    const key = keyFn(row);
    if (key) acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function pendingInboxCount() {
  return inboxRows.reduce((total, inbox) => {
    const candidates = [...ensureArray(inbox.candidates), ...ensureArray(inbox.claimCandidates)];
    const pendingCandidates = candidates.filter((item) => {
      return !item.reviewStatus || String(item.reviewStatus).includes("pending") || item.reviewStatus === "inbox";
    });
    return total + pendingCandidates.length;
  }, 0);
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

function claimsForEvent(eventId) {
  return (claimsByEventId.get(eventId) || []).slice().sort((a, b) => {
    return (
      String(a.processedAt || "").localeCompare(String(b.processedAt || "")) ||
      String(a.id).localeCompare(String(b.id))
    );
  });
}

function transitionsForClaim(claimId) {
  return transitionsBySubject.get(`claim:${claimId}`) || [];
}

function evidenceForClaim(claimId) {
  return evidenceByClaimId.get(claimId) || [];
}

function artifactRowsForClaim(claim) {
  return (claim.artifactIds || []).map((artifactId) => rawArtifactById.get(artifactId)).filter(Boolean);
}

function summarizeEvidence(claimRows) {
  const rows = claimRows.flatMap((claim) => evidenceForClaim(claim.id));
  const sourceLevelCounts = countBy(rows, (row) => row.sourceLevel);
  const relationCounts = countBy(rows, (row) => row.relation);
  const strongestSourceLevel = rows
    .slice()
    .sort((a, b) => (evidenceRank[b.sourceLevel] || 0) - (evidenceRank[a.sourceLevel] || 0))[0]?.sourceLevel;

  return {
    claimCount: claimRows.length,
    evidenceCount: rows.length,
    strongestSourceLevel: strongestSourceLevel || null,
    sourceLevelCounts,
    relationCounts,
  };
}

function sourceTimesForClaims(claimRows, event) {
  const artifacts = claimRows.flatMap(artifactRowsForClaim);
  return {
    occurredAt: latestTime([event.date, ...claimRows.map((claim) => claim.occurredAt)]),
    publishedAt: latestTime([
      ...claimRows.map((claim) => claim.publishedAt),
      ...artifacts.map((artifact) => artifact.publishedAt),
    ]),
    firstSeenAt: latestTime([
      ...claimRows.map((claim) => claim.firstSeenAt),
      ...artifacts.map((artifact) => artifact.firstSeenAt),
    ]),
    capturedAt: latestTime([
      ...claimRows.map((claim) => claim.capturedAt),
      ...artifacts.map((artifact) => artifact.capturedAt),
    ]),
    processedAt: latestTime(claimRows.map((claim) => claim.processedAt)),
    dueAt: latestTime(claimRows.map((claim) => claim.dueAt)),
    resolvedAt: latestTime(claimRows.map((claim) => claim.resolvedAt)),
  };
}

function whyNowForObservation(event, claimRows, transitionRows) {
  if (event.date === targetDate) return "今日新增正式事件";
  if (claimRows.some((claim) => dateKey(claim.firstSeenAt) === targetDate)) return "今日新发现资料";
  if (claimRows.some((claim) => dateKey(claim.processedAt) === targetDate)) return "今日完成事实审核";
  if (transitionRows.some((transition) => dateKey(transition.occurredAt) === targetDate)) return "今日证据状态变化";
  if (claimRows.some((claim) => claim.dueAt && dateTime(claim.dueAt) >= targetTime)) return "存在后续验证节点";
  return "按证据等级和重要性进入研究队列";
}

function claimProjection(claim) {
  const rows = evidenceForClaim(claim.id);
  return {
    id: claim.id,
    claimType: claim.claimType,
    text: claim.text,
    normalizedFact: claim.normalizedFact || claim.text,
    status: claim.status,
    reviewStatus: claim.reviewStatus,
    confidence: claim.confidence,
    occurredAt: claim.occurredAt || null,
    publishedAt: claim.publishedAt || null,
    firstSeenAt: claim.firstSeenAt,
    capturedAt: claim.capturedAt,
    processedAt: claim.processedAt,
    dueAt: claim.dueAt || null,
    evidence: rows.map((row) => ({
      id: row.id,
      relation: row.relation,
      sourceLevel: row.sourceLevel,
      strength: row.strength,
      source: sourceById.get(row.sourceId) || null,
      rawArtifact: rawArtifactById.get(row.rawArtifactId) || null,
    })),
  };
}

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
  const claimRows = claimsForEvent(event.id);
  const transitionRows = claimRows.flatMap((claim) => transitionsForClaim(claim.id));
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
    claimIds: claimRows.map((claim) => claim.id),
    claims: claimRows.map(claimProjection),
    evidenceSummary: summarizeEvidence(claimRows),
    sourceTimes: sourceTimesForClaims(claimRows, event),
    stateTransitions: transitionRows.map((transition) => ({
      id: transition.id,
      subjectType: transition.subjectType,
      subjectId: transition.subjectId,
      fromStatus: transition.fromStatus,
      toStatus: transition.toStatus,
      occurredAt: transition.occurredAt,
      reason: transition.reason,
      evidenceIds: transition.evidenceIds || [],
      sourceIds: transition.sourceIds || [],
    })),
    whyNow: whyNowForObservation(event, claimRows, transitionRows),
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
  projectionPolicy: "Observation 是从 event/followup/claim/evidence 派生的展示层，不是事实源。",
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

const pendingClaims = claims.filter((claim) => claim.reviewStatus === "inbox" || claim.status === "candidate");
const fetchFailures = fetchRuns.filter((run) => run.status === "failed" || run.status === "partial");
const schedulerFailures = schedulerRuns.filter((run) => run.status === "failed" || run.status === "partial");
const latestSchedulerFinishedAt = latestTime(schedulerRuns.map((run) => run.finishedAt));
const freshnessRows = [
  {
    id: "market",
    label: "Watchlist 行情",
    lastSeenAt: latestTime(marketRows.map((row) => row.capturedAt || row.quoteTime)),
    status: freshnessStatus(latestTime(marketRows.map((row) => row.capturedAt || row.quoteTime)), 24),
    count: marketRows.length,
    maxAgeHours: 24,
  },
  {
    id: "official_artifacts",
    label: "产业原始材料",
    lastSeenAt: latestTime(rawArtifacts.map((artifact) => artifact.capturedAt)),
    status: freshnessStatus(latestTime(rawArtifacts.map((artifact) => artifact.capturedAt)), 72),
    count: rawArtifacts.length,
    maxAgeHours: 72,
  },
  {
    id: "claim_review",
    label: "Claim 审核",
    lastSeenAt: latestTime(claims.map((claim) => claim.processedAt || claim.capturedAt)),
    status: pendingClaims.length ? "needs_review" : "clear",
    count: claims.length,
    pendingCount: pendingClaims.length,
  },
  {
    id: "fetch_runs",
    label: "抓取运行",
    lastSeenAt: latestTime(fetchRuns.map((run) => run.finishedAt)),
    status: fetchFailures.length ? "has_failures" : freshnessStatus(latestTime(fetchRuns.map((run) => run.finishedAt)), 72),
    count: fetchRuns.length,
    failedCount: fetchFailures.length,
  },
  {
    id: "scheduler",
    label: "Scheduler 心跳",
    lastSeenAt: latestSchedulerFinishedAt,
    status: schedulerFailures.length ? "has_failures" : freshnessStatus(latestSchedulerFinishedAt, 6),
    count: schedulerRuns.length,
    failedCount: schedulerFailures.length,
  },
];

const freshness = {
  date: targetDate,
  generatedAt: today.generatedAt,
  policy: "Freshness describes whether data was checked recently. It does not mean the underlying event happened today.",
  rows: freshnessRows,
  failedSources: fetchFailures.map((run) => ({
    id: run.id,
    sourceName: run.sourceName,
    status: run.status,
    finishedAt: run.finishedAt,
    error: run.error || null,
  })),
  totals: {
    pendingInbox: pendingInboxCount(),
    pendingClaims: pendingClaims.length,
    fetchRuns: fetchRuns.length,
    fetchFailures: fetchFailures.length,
    schedulerRuns: schedulerRuns.length,
    schedulerFailures: schedulerFailures.length,
  },
};

const router = {
  date: targetDate,
  generatedAt: today.generatedAt,
  policy: "Router decides which pipeline should process each raw artifact. It does not promote facts.",
  pipelineMap,
  rows: routeDecisions
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id)))
    .map((route) => {
      const artifact = rawArtifactById.get(route.rawArtifactId);
      return {
        ...route,
        rawArtifact: artifact
          ? {
              id: artifact.id,
              title: artifact.title,
              artifactType: artifact.artifactType,
              publisher: artifact.publisher,
              url: artifact.url,
              capturedAt: artifact.capturedAt,
            }
          : null,
      };
    }),
  totals: {
    all: routeDecisions.length,
    routed: routeDecisions.filter((route) => route.status === "routed").length,
    needsReview: routeDecisions.filter((route) => route.status === "needs_review").length,
    byType: countBy(routeDecisions, (route) => route.type),
    byPipeline: countBy(routeDecisions, (route) => route.pipeline),
  },
};

const ingestion = {
  date: targetDate,
  generatedAt: today.generatedAt,
  policy: "Ingestion turns URL/RSS/API/manual inputs into raw_artifacts, then routes and queues pipeline tasks.",
  rows: pipelineTasks
    .slice()
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(a.id).localeCompare(String(b.id)))
    .map((task) => {
      const artifact = rawArtifactById.get(task.rawArtifactId);
      const route = routeDecisionById.get(task.routeDecisionId);
      return {
        ...task,
        routeDecision: route || null,
        rawArtifact: artifact
          ? {
              id: artifact.id,
              title: artifact.title,
              artifactType: artifact.artifactType,
              publisher: artifact.publisher,
              url: artifact.url,
              publishedAt: artifact.publishedAt || null,
              firstSeenAt: artifact.firstSeenAt,
              capturedAt: artifact.capturedAt,
            }
          : null,
      };
    }),
  totals: {
    all: pipelineTasks.length,
    queued: pipelineTasks.filter((task) => task.status === "queued").length,
    needsReview: pipelineTasks.filter((task) => task.status === "needs_review").length,
    completed: pipelineTasks.filter((task) => task.status === "completed").length,
    failed: pipelineTasks.filter((task) => task.status === "failed").length,
    byInputType: countBy(pipelineTasks, (task) => task.inputType),
    byPipeline: countBy(pipelineTasks, (task) => task.pipeline),
    byStatus: countBy(pipelineTasks, (task) => task.status),
  },
};

const schedulerRows = (schedulerConfig.sources || []).map((source) => {
  const cadence = schedulerCadenceById.get(source.cadenceKey);
  const state = schedulerState.sources?.[source.id] || {};
  const nextDueAt = addSeconds(state.lastRunAt, cadence?.seconds);
  return {
    id: source.id,
    enabled: source.enabled !== false,
    cadenceKey: source.cadenceKey,
    cadenceSeconds: cadence?.seconds || null,
    inputType: source.inputType,
    title: source.title,
    publisher: source.publisher,
    url: source.url,
    entityIds: source.entityIds,
    artifactType: source.artifactType,
    sourceType: source.sourceType,
    sourceId: source.sourceId || null,
    lastRunAt: state.lastRunAt || null,
    lastSuccessAt: state.lastSuccessAt || null,
    lastStatus: state.lastStatus || "never_run",
    nextDueAt,
    dueStatus: dueStatus(state.lastRunAt, cadence?.seconds),
    lastSchedulerRunId: state.lastSchedulerRunId || null,
    lastRawArtifactId: state.lastRawArtifactId || null,
    lastRouteDecisionId: state.lastRouteDecisionId || null,
    lastPipelineTaskId: state.lastPipelineTaskId || null,
    consecutiveFailures: state.consecutiveFailures || 0,
  };
});

const scheduler = {
  date: targetDate,
  generatedAt: today.generatedAt,
  policy: schedulerConfig.policy,
  cadences: schedulerConfig.cadences || [],
  rows: schedulerRows,
  recentRuns: schedulerRuns
    .slice()
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)) || String(b.id).localeCompare(String(a.id)))
    .slice(0, 10),
  totals: {
    sources: schedulerRows.length,
    enabledSources: schedulerRows.filter((row) => row.enabled).length,
    dueSources: schedulerRows.filter((row) => row.enabled && row.dueStatus !== "waiting").length,
    runs: schedulerRuns.length,
    failedRuns: schedulerFailures.length,
    byCadence: countBy(schedulerRows, (row) => row.cadenceKey),
    byStatus: countBy(schedulerRows, (row) => row.lastStatus),
  },
};

const dayMs = 24 * 60 * 60 * 1000;

function withinPastWindow(value, days) {
  if (!value) return false;
  if (days === 0) return dateKey(value) === targetDate;
  const time = dateTime(dateKey(value));
  return time !== null && time >= targetTime - (days - 1) * dayMs && time <= targetTime;
}

function withinFutureWindow(value, days) {
  if (!value) return false;
  const time = dateTime(dateKey(value));
  return time !== null && time >= targetTime && time <= targetTime + days * dayMs;
}

function claimWindowDate(claim) {
  return claim.firstSeenAt || claim.processedAt || claim.occurredAt || claim.publishedAt;
}

const pastWindows = [
  { id: "today", label: "今日", days: 0 },
  { id: "last_7_days", label: "近7天", days: 7 },
  { id: "last_30_days", label: "近30天", days: 30 },
  { id: "last_90_days", label: "近90天", days: 90 },
  { id: "last_180_days", label: "近180天", days: 180 },
];
const futureWindows = [
  { id: "future_30_days", label: "未来30天", days: 30 },
  { id: "future_90_days", label: "未来90天", days: 90 },
];

const windowSummary = {
  date: targetDate,
  generatedAt: today.generatedAt,
  policy: "Past windows count happened/published/discovered evidence. Future windows count public verification milestones only.",
  windows: [
    ...pastWindows.map((window) => ({
      ...window,
      direction: "past",
      events: events.filter((event) => withinPastWindow(event.date, window.days)).length,
      claims: claims.filter((claim) => withinPastWindow(claimWindowDate(claim), window.days)).length,
      evidence: evidenceRows.filter((row) => withinPastWindow(row.assessedAt || row.capturedAt, window.days)).length,
      stateTransitions: stateTransitions.filter((transition) => withinPastWindow(transition.occurredAt, window.days))
        .length,
      observations: allObservationRows.filter((row) => withinPastWindow(row.date, window.days)).length,
    })),
    ...futureWindows.map((window) => ({
      ...window,
      direction: "future",
      milestones: milestones.filter((milestone) => withinFutureWindow(milestone.dueAt, window.days)).length,
      pendingFollowups: followups.filter((item) => item.status === "pending").length,
    })),
  ],
};

const upcomingRows = milestones
  .filter((milestone) => ["upcoming", "due"].includes(milestone.status))
  .slice()
  .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)) || String(a.id).localeCompare(String(b.id)))
  .map((milestone) => ({
    id: milestone.id,
    title: milestone.title,
    dueAt: milestone.dueAt,
    dueAtPrecision: milestone.dueAtPrecision,
    status: milestone.status,
    entityIds: milestone.entityIds,
    entityNames: entityNames(milestone.entityIds),
    claimIds: milestone.claimIds || [],
    claims: (milestone.claimIds || []).map((claimId) => claims.find((claim) => claim.id === claimId)).filter(Boolean),
    followupIds: milestone.followupIds || [],
    followups: (milestone.followupIds || [])
      .map((followupId) => followups.find((item) => item.id === followupId))
      .filter(Boolean),
    sourceIds: milestone.sourceIds,
    sources: enrichSources(milestone.sourceIds),
    notes: milestone.notes || null,
  }));

const upcoming = {
  date: targetDate,
  generatedAt: today.generatedAt,
  policy: "Upcoming rows are public or review-derived verification nodes, not predictions.",
  rows: upcomingRows,
  totals: {
    all: upcomingRows.length,
    future30: upcomingRows.filter((row) => withinFutureWindow(row.dueAt, 30)).length,
    future90: upcomingRows.filter((row) => withinFutureWindow(row.dueAt, 90)).length,
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

const timelineItems = {
  date: targetDate,
  generatedAt: today.generatedAt,
  rows: [
    ...events.map((event) => ({
      id: event.id,
      itemType: "event",
      date: event.date,
      title: event.title,
      body: event.fact,
      entityNames: entityNames(event.entityIds),
      evidenceLevel: event.evidenceLevel,
      sourceIds: event.sourceIds,
      sources: enrichSources(event.sourceIds),
    })),
    ...stateTransitions.map((transition) => ({
      id: transition.id,
      itemType: "state_transition",
      date: dateKey(transition.occurredAt),
      title: `${transition.subjectType} ${transition.fromStatus} -> ${transition.toStatus}`,
      body: transition.reason,
      subjectType: transition.subjectType,
      subjectId: transition.subjectId,
      evidenceIds: transition.evidenceIds || [],
      sourceIds: transition.sourceIds || [],
      sources: enrichSources(transition.sourceIds),
    })),
    ...milestones.map((milestone) => ({
      id: milestone.id,
      itemType: "milestone",
      date: dateKey(milestone.dueAt),
      title: milestone.title,
      body: milestone.notes || "待验证节点",
      entityNames: entityNames(milestone.entityIds),
      status: milestone.status,
      sourceIds: milestone.sourceIds,
      sources: enrichSources(milestone.sourceIds),
    })),
  ].sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.id).localeCompare(String(b.id))),
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
  rawArtifacts: rawArtifacts.length,
  routeDecisions: routeDecisions.length,
  pipelineTasks: pipelineTasks.length,
  schedulerSources: schedulerRows.length,
  schedulerRuns: schedulerRuns.length,
  claims: claims.length,
  evidence: evidenceRows.length,
  fetchRuns: fetchRuns.length,
  milestones: milestones.length,
  stateTransitions: stateTransitions.length,
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
await writeJsonFile(path.join(DATA_DIR, "dashboard", "freshness.json"), freshness);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "router.json"), router);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "ingestion.json"), ingestion);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "scheduler.json"), scheduler);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "window_summary.json"), windowSummary);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "upcoming.json"), upcoming);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "market.json"), market);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "heat.json"), heat);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "timeline.json"), timeline);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "timeline_items.json"), timelineItems);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "followup.json"), followup);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "watchlist.json"), watchlist);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "stats.json"), stats);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "relations.json"), relationDashboard);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "sources.json"), sourceRegistry);

console.log(`Dashboard cache generated for ${targetDate}.`);
