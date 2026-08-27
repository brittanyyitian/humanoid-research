import path from "node:path";
import fs from "node:fs/promises";
import {
  DATA_DIR,
  ensureArray,
  readJsonDir,
  readJsonFile,
  severityForCount,
  todayInShanghai,
  writeJsonFile,
} from "./data-utils.mjs";
import {
  assertSerenityQuoteProjection,
  projectSerenityQuotes,
} from "./dashboard/serenity-quote-projection.mjs";
import {
  projectSerenityOutputIndex,
  serenityDetailFileName,
} from "./dashboard/serenity-output-projection.mjs";
import {
  projectSerenityJudgmentIndex,
  serenityJudgmentDetailFileName,
} from "./dashboard/serenity-judgment-projection.mjs";

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
const rawPayloads = (await readJsonDir("raw_artifacts/payloads")).map((row) => row.data);
const claims = (await readJsonDir("claims")).map((row) => row.data);
const evidenceRows = (await readJsonDir("evidence")).map((row) => row.data);
const fetchRuns = (await readJsonDir("fetch_runs")).map((row) => row.data);
const milestones = (await readJsonDir("milestones")).map((row) => row.data);
const stateTransitions = (await readJsonDir("state_transitions")).map((row) => row.data);
const inboxRows = (await readJsonDir("inbox")).map((row) => row.data);
const routeDecisions = (await readJsonDir("route_decisions")).map((row) => row.data);
const pipelineTasks = (await readJsonDir("pipeline_tasks")).map((row) => row.data);
const pipelineRuns = (await readJsonDir("pipeline_runs")).map((row) => row.data);
const ruleOutputs = (await readJsonDir("rule_outputs")).map((row) => row.data);
const observationRuns = (await readJsonDir("observation_runs")).map((row) => row.data);
const USER_FACING_SERENITY_OUTPUT_STATUSES = new Set([
  "serenity_ai_review",
  "serenity_ai_review_outcome",
  "serenity_stock_radar",
  "serenity_stock_radar_failed",
  "generated_draft",
  "research_brief",
]);
const serenityAnalysisOutputRows = (await readOptionalJsonDir("analysis/serenity_outputs"))
  .map((row) => ({
    ...row.data,
    storagePath: path.relative(DATA_DIR, row.file),
  }))
  .filter((row) => USER_FACING_SERENITY_OUTPUT_STATUSES.has(row.status));
const serenityJudgmentHistories = (await readOptionalJsonDir("analysis/serenity_judgments")).map(
  (row) => row.data
);
const pipelineMap = await readJsonFile(path.join(DATA_DIR, "pipelines", "pipeline_map.json"));
const serenityDatasetMap = await readJsonFile(path.join(DATA_DIR, "serenity_bridge", "dataset_map.json"));
const schedulerConfig = await readJsonFile(path.join(DATA_DIR, "scheduler", "sources.json"));
const schedulerState = await readJsonFile(path.join(DATA_DIR, "scheduler", "state.json"));
const schedulerRuns = (await readJsonDir("scheduler_runs")).map((row) => row.data);

const rawArtifactById = new Map(rawArtifacts.map((artifact) => [artifact.id, artifact]));
const rawPayloadById = new Map(rawPayloads.map((payload) => [payload.id, payload]));
const routeDecisionById = new Map(routeDecisions.map((route) => [route.id, route]));
const routeDecisionByRawArtifactId = new Map(routeDecisions.map((route) => [route.rawArtifactId, route]));
const claimById = new Map(claims.map((claim) => [claim.id, claim]));
const evidenceById = new Map(evidenceRows.map((row) => [row.id, row]));
const ruleOutputById = new Map(ruleOutputs.map((row) => [row.id, row]));
const schedulerCadenceById = new Map((schedulerConfig.cadences || []).map((cadence) => [cadence.id, cadence]));
const evidenceByClaimId = new Map();
const claimsByEventId = new Map();
const claimsByRawArtifactId = new Map();
const evidenceByRawArtifactId = new Map();
const pipelineTasksByRawArtifactId = new Map();
const transitionsBySubject = new Map();

function pushMap(map, key, value) {
  if (!key) return;
  const rows = map.get(key) || [];
  rows.push(value);
  map.set(key, rows);
}

for (const item of evidenceRows) pushMap(evidenceByClaimId, item.claimId, item);
for (const item of evidenceRows) pushMap(evidenceByRawArtifactId, item.rawArtifactId, item);
for (const claim of claims) {
  for (const eventId of claim.promotedEventIds || []) pushMap(claimsByEventId, eventId, claim);
  for (const artifactId of claim.artifactIds || []) pushMap(claimsByRawArtifactId, artifactId, claim);
}
for (const task of pipelineTasks) pushMap(pipelineTasksByRawArtifactId, task.rawArtifactId, task);
for (const transition of stateTransitions) {
  pushMap(transitionsBySubject, `${transition.subjectType}:${transition.subjectId}`, transition);
}

async function readOptionalJsonDir(relativeDir) {
  try {
    return await readJsonDir(relativeDir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
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

function addDays(value, days) {
  const time = dateTime(value);
  if (!time || !Number.isFinite(days)) return null;
  return dateKey(shanghaiDateTime(time + days * 24 * 60 * 60 * 1000));
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

function tickerText(row = {}) {
  if (!row.stockCode) return null;
  const suffixByMarket = {
    SSE: "SH",
    SZSE: "SZ",
    HKEX: "HK",
  };
  const suffix = suffixByMarket[row.market] || row.market;
  return suffix ? `${row.stockCode}.${suffix}` : row.stockCode;
}

function listingLabel(entity = {}) {
  if (!entity.listed && !entity.stockCode) return "非上市";
  if (entity.market === "SSE" || entity.market === "SZSE") return "A股";
  if (entity.market === "HKEX") return "港股";
  return entity.market || "上市";
}

function entityType(entity = {}) {
  if (entity.listed) return "listed_company";
  if (entity.kind === "robot_oem") return "private_company";
  if (entity.kind === "customer") return "customer";
  if (entity.kind === "policy") return "policy_subject";
  return entity.kind || "industry_entity";
}

function industryRole(entity = {}) {
  if (entity.segment) return entity.segment;
  const tags = entity.tags || [];
  if (tags.includes("整机厂")) return "整机厂";
  return tags.find((tag) => !["Watchlist", "A股", "港股"].includes(tag)) || "观察对象";
}

function sectorOf(entity = {}) {
  if (entity.sector) return entity.sector;
  if (entity.tags?.includes("半导体")) return "semiconductor";
  return "robotics";
}

function sectorLabelOf(entity = {}) {
  if (entity.sectorLabel) return entity.sectorLabel;
  return {
    robotics: "机器人",
    semiconductor: "半导体",
    drone: "无人机",
    oil: "石油",
    power: "电力",
    innovative_drug: "创新药",
    precious_metals: "贵金属",
  }[sectorOf(entity)] || "其他";
}

function roboticsRole(entity = {}) {
  if (sectorOf(entity) !== "robotics") return null;
  const role = industryRole(entity);
  if (entity.kind === "robot_oem") return "人形机器人整机厂观察对象";
  if (entity.kind === "customer") return `${role}部署场景`;
  if (entity.kind === "supply_chain") return `机器人${role}链观察标的`;
  return `机器人产业${role}观察对象`;
}

function sectorRole(entity = {}) {
  const role = industryRole(entity);
  const sector = sectorOf(entity);
  if (sector === "robotics") return roboticsRole(entity);
  if (sector === "semiconductor") return `半导体${role}环节观察公司`;
  return `${sectorLabelOf(entity)} · ${role}`;
}

function sourceIdsForRows(rows = []) {
  return Array.from(
    new Set(
      rows
        .flatMap((row) => [...ensureArray(row.sourceIds), ...ensureArray(row.sources).map((source) => source?.id)])
        .filter(Boolean)
    )
  );
}

function profileEvidenceState({ entityEvents = [], entityClaims = [], entityFollowups = [], stock = null, sourceIds = [] }) {
  if (entityEvents.length || sourceIds.length) return "has_verified_sources";
  if (entityClaims.some((claim) => claim.reviewStatus === "inbox" || claim.status === "candidate")) return "has_pending_review";
  if (entityFollowups.length) return "has_followups";
  if (stock) return "market_only";
  return "profile_only";
}

function watchReasonForEntity(entity, { entityEvents = [], entityClaims = [], stock = null }) {
  const role = industryRole(entity);
  if (entity.tags?.includes("Watchlist")) {
    const parts = [`进入${sectorLabelOf(entity)}观察池`, `用于跟踪${role}环节`];
    if (entity.listed || stock) parts.push("有上市公司行情/公告入口");
    if (entityEvents.length || entityClaims.length) parts.push("已有公开材料进入证据链");
    return parts.join("；");
  }
  return "在事件、关系或候选事实中出现，作为关联对象跟踪";
}

function enrichedEntity(entityId) {
  const entity = entityById.get(entityId);
  if (!entity) {
    return {
      id: entityId,
      name: entityId,
      kind: "unknown",
      sector: "robotics",
      sectorLabel: "机器人",
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
    sector: sectorOf(entity),
    sectorLabel: sectorLabelOf(entity),
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
  return (claimsByEventId.get(eventId) || [])
    .filter((claim) => {
      return claim.status === "verified" && claim.reviewStatus === "promoted" && claim.promotedEventIds?.includes(eventId);
    })
    .slice()
    .sort((a, b) => {
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

function supportingEvidenceForClaim(claimId) {
  return evidenceForClaim(claimId).filter((row) => ["supports", "updates", "mentions"].includes(row.relation));
}

function artifactRowsForClaim(claim) {
  return (claim.artifactIds || []).map((artifactId) => rawArtifactById.get(artifactId)).filter(Boolean);
}

function summarizeEvidence(claimRows) {
  const rows = claimRows.flatMap((claim) => supportingEvidenceForClaim(claim.id));
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
  const rows = supportingEvidenceForClaim(claim.id);
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
const eligibleObservationEvents = sortedObservationEvents.filter((event) => {
  const claimRows = claimsForEvent(event.id);
  return claimRows.length > 0 && claimRows.some((claim) => supportingEvidenceForClaim(claim.id).length > 0);
});
const allObservationRows = eligibleObservationEvents.map((event, index) =>
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

const dashboardGeneratedAt = new Date().toISOString();
const entityProfiles = {
  date: targetDate,
  generatedAt: dashboardGeneratedAt,
  policy: "Entity profiles are generated from entity seeds plus verified events, relations, followups, sources and market snapshots. They are descriptive context, not AI investment analysis.",
  rows: entities
    .map((entity) => {
      const entityEvents = allEventRows.filter((event) => event.entityIds.includes(entity.id));
      const entityRelations = relations.filter((relation) => relation.entityAId === entity.id || relation.entityBId === entity.id);
      const entityFollowups = followups.filter((item) => ensureArray(item.entityIds).includes(entity.id));
      const entityClaims = claims.filter((claim) => ensureArray(claim.entityIds).includes(entity.id));
      const stock = marketByEntityId.get(entity.id) || null;
      const profileSourceIds = sourceIdsForRows([stock, ...entityEvents, ...entityRelations, ...entityFollowups].filter(Boolean));
      const currentGaps = [];
      if (entity.tags?.includes("Watchlist") && !entityEvents.length) currentGaps.push("缺正式事件");
      if (entity.tags?.includes("Watchlist") && !entityFollowups.length) currentGaps.push("缺Follow-up");
      if (entity.listed && !stock) currentGaps.push("缺股票快照");
      if (!profileSourceIds.length) currentGaps.push("缺来源引用");

      const role = industryRole(entity);
      const listing = listingLabel(entity);
      return {
        id: entity.id,
        entityId: entity.id,
        name: entity.name,
        entityType: entityType(entity),
        ticker: tickerText(entity),
        listed: Boolean(entity.listed),
        stockCode: entity.stockCode || null,
        market: entity.market || null,
        sector: sectorOf(entity),
        sectorLabel: sectorLabelOf(entity),
        industryRole: role,
        roboticsRole: roboticsRole(entity),
        sectorRole: sectorRole(entity),
        userFocus: Boolean(entity.userFocus),
        curatorPick: Boolean(entity.curatorPick),
        selectionReason: entity.selectionReason || null,
        watchReason: watchReasonForEntity(entity, { entityEvents, entityClaims, stock }),
        evidenceState: profileEvidenceState({
          entityEvents,
          entityClaims,
          entityFollowups,
          stock,
          sourceIds: profileSourceIds,
        }),
        currentGaps,
        sourceIds: profileSourceIds,
        tags: entity.tags || [],
        updatedAt: dashboardGeneratedAt,
        role,
        listing,
        line: `${role} / ${listing}`,
        reason: entity.tags?.includes("Watchlist") ? "Watchlist观察池" : "关联对象",
        gap: currentGaps[0] || (entity.tags?.includes("部署场景") ? "部署场景" : "证据可追溯"),
      };
    })
    .sort((a, b) => {
      const watchA = a.tags.includes("Watchlist") ? 1 : 0;
      const watchB = b.tags.includes("Watchlist") ? 1 : 0;
      return watchB - watchA || String(a.name).localeCompare(String(b.name), "zh-Hans-CN");
    }),
};

const entityProfileById = new Map(entityProfiles.rows.map((profile) => [profile.entityId, profile]));

const today = {
  date: targetDate,
  generatedAt: dashboardGeneratedAt,
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

const laneMeta = {
  product: { label: "产品/技术", description: "产品发布、参数、交付和技术进展" },
  company: { label: "公司动态", description: "公司事件、公告、合作和经营动作" },
  supply_chain: { label: "产业链/供应链", description: "供应链、客户、部件和产线线索" },
  policy: { label: "政策/行业", description: "政策、会议、行业节点和公开计划" },
  market: { label: "股票市场", description: "股票涨跌、成交和行情事实" },
};

function laneForEvent(event) {
  if (event.eventType === "policy" || event.eventType === "conference") return "policy";
  if (event.eventType === "product" || event.eventType === "delivery" || event.eventType === "demo") return "product";
  if (event.eventType === "partnership" || event.eventType === "order" || event.module?.includes("供应链")) {
    return "supply_chain";
  }
  return "company";
}

function laneForClaim(claim) {
  if (["product_release", "product_spec", "delivery"].includes(claim.claimType)) return "product";
  if (["order", "partnership"].includes(claim.claimType)) return "supply_chain";
  if (claim.claimType === "milestone" || claim.claimType === "data_gap") return "policy";
  return "company";
}

function shortMarketMove(row) {
  const pct = typeof row.changePct === "number" ? `${row.changePct > 0 ? "+" : ""}${row.changePct.toFixed(2)}%` : "--";
  const turnover = row.turnoverAmount ? `，成交额 ${row.turnoverAmount}` : "";
  return `${row.company} ${pct}${turnover}`;
}

function compactSources(sourceIds = []) {
  return enrichSources(sourceIds).slice(0, 3).map(compactSource);
}

function compactSource(source) {
  if (!source) return null;
  return {
    id: source.id,
    title: source.title,
    publisher: source.publisher,
    sourceType: source.sourceType,
    url: source.url,
    evidenceLevel: source.evidenceLevel,
  };
}

function compactMarketRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    entityId: row.entityId,
    company: row.company,
    stockCode: row.stockCode,
    market: row.market,
    price: row.price ?? null,
    changePct: row.changePct ?? null,
    turnoverAmount: row.turnoverAmount ?? null,
    turnoverRate: row.turnoverRate ?? null,
    fiveDayChangePct: row.fiveDayChangePct ?? null,
    twentyDayChangePct: row.twentyDayChangePct ?? null,
    capturedAt: row.capturedAt || null,
    sources: (row.sources || []).slice(0, 2).map(compactSource).filter(Boolean),
  };
}

function changeEvidenceForClaim(claim) {
  return (evidenceByClaimId.get(claim.id) || [])
    .slice()
    .sort((a, b) => (evidenceRank[b.sourceLevel] || 0) - (evidenceRank[a.sourceLevel] || 0))
    .map((row) => ({
      id: row.id,
      relation: row.relation,
      sourceLevel: row.sourceLevel,
      strength: row.strength,
      source: compactSource(sourceById.get(row.sourceId)),
    }));
}

function strongestLevelFromEvidence(rows = []) {
  return rows
    .slice()
    .sort((a, b) => (evidenceRank[b.sourceLevel] || 0) - (evidenceRank[a.sourceLevel] || 0))[0]?.sourceLevel;
}

function objectName(entityId) {
  return entityById.get(entityId)?.name || entityId;
}

const sourceTypeLabels = {
  webpage: "官方网页",
  news: "新闻/文章",
  exchange: "交易所公告",
  filing: "公告/财报",
  market_data: "行情数据",
};

function sourceTypeLabel(sourceType) {
  return sourceTypeLabels[sourceType] || sourceType || "公开来源";
}

function changeReadingType(block) {
  const text = `${block.title || ""} ${block.change || ""}`;
  if (block.lane === "market") return { changeType: "market_fact", changeLabel: "市场 / 行情事实" };
  if (block.lane === "product") {
    if (/量产|下线|产线|里程碑/.test(text)) {
      return { changeType: "product_milestone", changeLabel: "产品 / 量产进展" };
    }
    if (/交付|客户|订单/.test(text)) {
      return { changeType: "product_delivery_signal", changeLabel: "产品 / 交付线索" };
    }
    if (/发布|上市|新品|材料/.test(text)) {
      return { changeType: "product_release", changeLabel: "产品 / 发布进展" };
    }
    return { changeType: "product_technical_update", changeLabel: "产品 / 技术进展" };
  }
  if (block.lane === "company") {
    if (/公告|报告书|财报|定增|发行|披露/.test(text)) {
      return { changeType: "company_disclosure", changeLabel: "公司 / 公告材料" };
    }
    if (/合作|生态|计划|业务|进展/.test(text)) {
      return { changeType: "company_operation", changeLabel: "公司 / 经营动作" };
    }
    return { changeType: "company_public_update", changeLabel: "公司 / 公开动态" };
  }
  if (block.lane === "supply_chain") {
    return { changeType: "supply_chain_signal", changeLabel: "产业链 / 供应链线索" };
  }
  if (block.lane === "policy") {
    return { changeType: "policy_industry_node", changeLabel: "政策 / 行业节点" };
  }
  return { changeType: block.lane || "other_change", changeLabel: laneMeta[block.lane]?.label || "变化" };
}

function verificationStateForBlock(block) {
  if (block.lane === "market") return block.status === "final" ? "final_market_fact" : "market_fact";
  if (block.status === "verified") return block.verificationItems?.length ? "verified_with_followup" : "verified";
  if (block.status === "pending_review" || block.status === "candidate") return "pending_review";
  return block.status || "unknown";
}

function verificationLabelForState(state) {
  const labels = {
    verified: "已验证",
    verified_with_followup: "已验证 · 待跟踪",
    pending_review: "待审核",
    market_fact: "行情事实",
    final_market_fact: "收盘事实",
  };
  return labels[state] || state || "--";
}

function evidenceSummaryForBlock(block) {
  const sources = block.sources || [];
  const sourceLabels = Array.from(new Set(sources.map((source) => sourceTypeLabel(source.sourceType)).filter(Boolean)));
  const strongestSourceLevel = sources
    .slice()
    .sort((a, b) => (evidenceRank[b.evidenceLevel] || 0) - (evidenceRank[a.evidenceLevel] || 0))[0]?.evidenceLevel;
  return {
    level: block.evidenceLevel || strongestSourceLevel || "--",
    sourceType: sources[0]?.sourceType || (block.lane === "market" ? "market_data" : "unknown"),
    sourceLabel: sourceLabels.slice(0, 2).join(" / ") || (block.lane === "market" ? "行情数据" : "公开来源"),
    sourceCount: sources.length,
    claimCount: block.sourceType === "claim" ? 1 : 0,
    evidenceCount: block.evidence?.length || 0,
    strongestSourceLevel: strongestSourceLevel || block.evidenceLevel || "--",
    hasOfficialSource: sources.some((source) => ["webpage", "exchange", "filing"].includes(source.sourceType)),
  };
}

function nextQuestionForBlock(block, readingType) {
  if (block.lane === "market") return "仅作为行情事实；不表示与当前事件存在因果关系。";
  const verificationSubjects = (block.verificationItems || []).map((item) => item.subject).filter(Boolean);
  if (verificationSubjects.length) return `待验证：${verificationSubjects.slice(0, 2).join(" / ")}`;
  if (block.status === "pending_review" || block.status === "candidate") return "需要人工审核事实、来源和实体归属。";
  if (["product_milestone", "product_delivery_signal", "product_release"].includes(readingType.changeType)) {
    return "后续验证交付、客户、订单或收入披露。";
  }
  if (readingType.changeType === "company_disclosure") return "后续核对公告条款、时间节点和进展更新。";
  if (readingType.changeType === "supply_chain_signal") return "后续确认供应关系、客户/订单和公开来源。";
  if (readingType.changeType === "policy_industry_node") return "后续跟踪落地时间、责任主体和公开材料。";
  return "继续跟踪后续公开材料。";
}

function withResearchReadingSemantics(block) {
  const readingType = changeReadingType(block);
  const verificationState = verificationStateForBlock(block);
  return {
    ...block,
    ...readingType,
    verificationState,
    verificationLabel: verificationLabelForState(verificationState),
    evidenceSummary: evidenceSummaryForBlock(block),
    nextQuestion: nextQuestionForBlock(block, readingType),
  };
}

const eventChangeBlocks = allEventRows.map((event) => {
  const claimRows = claimsForEvent(event.id);
  const evidenceRowsForEvent = claimRows.flatMap((claim) => changeEvidenceForClaim(claim));
  return {
    id: `chg_${event.id}`,
    sourceType: "event",
    lane: laneForEvent(event),
    date: event.date,
    time: event.date,
    objectId: event.entityIds[0] || event.id,
    objectName: event.entityNames?.[0] || event.title,
    title: event.title,
    change: event.fact,
    status: "verified",
    evidenceLevel: event.evidenceLevel,
    confidence: "verified",
    entityIds: event.entityIds,
    entityNames: event.entityNames,
    sources: (event.sources || []).map(compactSource).filter(Boolean),
    evidence: evidenceRowsForEvent,
    verificationItems: (event.followups || []).map((item) => ({
      id: item.id,
      subject: item.subject,
      status: item.status,
    })),
    marketContext: event.directMarketRows?.length ? event.directMarketRows.map(compactMarketRow).filter(Boolean) : [],
    noCausalityPolicy: "market context is displayed alongside the event without causal interpretation",
  };
});

const candidateChangeBlocks = claims
  .filter((claim) => claim.status === "candidate" || claim.reviewStatus === "inbox")
  .map((claim) => {
    const evidence = changeEvidenceForClaim(claim);
    const artifact = (claim.artifactIds || []).map((artifactId) => rawArtifactById.get(artifactId)).filter(Boolean)[0];
    return {
      id: `chg_${claim.id}`,
      sourceType: "claim",
      lane: laneForClaim(claim),
      date: dateKey(claim.occurredAt || claim.publishedAt || claim.firstSeenAt || claim.processedAt),
      time: claim.occurredAt || claim.publishedAt || claim.firstSeenAt || claim.processedAt,
      objectId: claim.entityIds?.[0] || claim.id,
      objectName: objectName(claim.entityIds?.[0]) || artifact?.publisher || "候选事实",
      title: claim.text,
      change: claim.normalizedFact || claim.text,
      status: claim.reviewStatus === "inbox" ? "pending_review" : claim.status,
      evidenceLevel: strongestLevelFromEvidence(evidence) || "D",
      confidence: claim.confidence,
      entityIds: claim.entityIds || [],
      entityNames: entityNames(claim.entityIds || []),
      sources: evidence.map((row) => row.source).filter(Boolean),
      evidence,
      verificationItems: (claim.reviewRequirements || []).map((item) => ({
        id: item.kind,
        subject: item.description,
        status: item.required ? "required" : "optional",
      })),
      marketContext: (claim.entityIds || []).map((entityId) => compactMarketRow(marketByEntityId.get(entityId))).filter(Boolean),
      noCausalityPolicy: "candidate claims are not facts until review",
    };
  });

const relationChangeBlocks = relations.map((relation) => ({
  id: `chg_${relation.id}`,
  sourceType: "relation",
  lane: "supply_chain",
  date: relation.date || targetDate,
  time: relation.date || targetDate,
  objectId: relation.entityAId,
  objectName: objectName(relation.entityAId),
  title: `${objectName(relation.entityAId)} / ${objectName(relation.entityBId)}`,
  change: relation.fact || relation.relationType,
  status: "verified",
  evidenceLevel: relation.evidenceLevel,
  confidence: "verified",
  entityIds: [relation.entityAId, relation.entityBId],
  entityNames: [objectName(relation.entityAId), objectName(relation.entityBId)],
  sources: compactSources(relation.sourceIds),
  evidence: [],
  verificationItems: [],
  marketContext: [marketByEntityId.get(relation.entityAId), marketByEntityId.get(relation.entityBId)]
    .map(compactMarketRow)
    .filter(Boolean),
  noCausalityPolicy: "relationship facts are displayed as source-backed changes, not causal interpretation",
}));

const marketChangeBlocks = marketRows
  .slice()
  .sort((a, b) => Math.abs(Number(b.changePct) || 0) - Math.abs(Number(a.changePct) || 0))
  .slice(0, 12)
  .map((row) => ({
    id: `chg_market_${row.id || row.entityId}`,
    sourceType: "market",
    lane: "market",
    date: dateKey(row.capturedAt || market.date),
    time: row.capturedAt || row.quoteTime || market.date,
    objectId: row.entityId,
    objectName: row.company,
    title: shortMarketMove(row),
    change: `价格 ${row.price ?? "--"}，涨跌幅 ${
      typeof row.changePct === "number" ? `${row.changePct > 0 ? "+" : ""}${row.changePct.toFixed(2)}%` : "--"
    }，成交额 ${row.turnoverAmount || "--"}。`,
    status: row.isFinal ? "final" : "market_snapshot",
    evidenceLevel: row.sources?.[0]?.evidenceLevel || "B",
    confidence: "market_fact",
    entityIds: [row.entityId],
    entityNames: [row.company],
    sources: (row.sources || []).slice(0, 2).map(compactSource).filter(Boolean),
    evidence: [],
    verificationItems: [],
    marketContext: [compactMarketRow(row)].filter(Boolean),
    noCausalityPolicy: "market changes are shown as facts only; no event causality is implied",
  }));

const allChangeBlocks = [
  ...eventChangeBlocks,
  ...candidateChangeBlocks,
  ...relationChangeBlocks,
  ...marketChangeBlocks,
]
  .filter((row) => row.date)
  .map(withResearchReadingSemantics);

function changeSort(a, b) {
  return String(b.time || b.date).localeCompare(String(a.time || a.date)) || String(a.id).localeCompare(String(b.id));
}

function compactChangePreview(block) {
  return {
    id: block.id,
    lane: block.lane,
    date: block.date,
    time: block.time,
    objectId: block.objectId,
    objectName: block.objectName,
    title: block.title,
    status: block.status,
    changeType: block.changeType,
    changeLabel: block.changeLabel,
    verificationState: block.verificationState,
    verificationLabel: block.verificationLabel,
    evidenceSummary: block.evidenceSummary,
    nextQuestion: block.nextQuestion,
    evidenceLevel: block.evidenceLevel,
    entityIds: block.entityIds || [],
  };
}

const recentChangeBlocks = allChangeBlocks.slice().sort(changeSort);

function marketContextItem(row, { evidenceLinked = false, linkChange = null } = {}) {
  const profile = entityProfileById.get(row.entityId);
  const originalId = linkChange?.id?.replace(/^chg_/, "") || null;
  const firstSource = linkChange?.sources?.[0] || null;
  return {
    entityId: row.entityId,
    name: row.company,
    ticker: profile?.ticker || tickerText(row),
    sector: profile?.sector || "robotics",
    sectorLabel: profile?.sectorLabel || "机器人",
    industryRole: profile?.industryRole || "Watchlist",
    roboticsRole: profile?.roboticsRole || null,
    sectorRole: profile?.sectorRole || profile?.roboticsRole || null,
    changePct: row.changePct ?? null,
    price: row.price ?? null,
    turnoverAmount: row.turnoverAmount ?? null,
    turnoverRate: row.turnoverRate ?? null,
    capturedAt: row.capturedAt || null,
    evidenceLinked,
    linkChangeId: linkChange?.id || null,
    eventId: linkChange?.sourceType === "event" ? originalId : null,
    relationId: linkChange?.sourceType === "relation" ? originalId : null,
    claimId: linkChange?.sourceType === "claim" ? originalId : null,
    linkEvidenceIds: (linkChange?.evidence || []).map((item) => item.id).filter(Boolean),
    linkSourceIds: (linkChange?.sources || []).map((source) => source.id).filter(Boolean),
    linkReason: linkChange
      ? `依据：${firstSource?.publisher || firstSource?.sourceType || "公开材料"} / ${laneMeta[linkChange.lane]?.label || linkChange.lane}`
      : null,
    sources: (row.sources || []).slice(0, 2).map(compactSource).filter(Boolean),
  };
}

const watchlistSnapshotItems = marketRows
  .slice()
  .sort((a, b) => (Number(b.changePct) || 0) - (Number(a.changePct) || 0))
  .slice(0, 5)
  .map((row) => marketContextItem(row));

function evidenceLinkedMarketItems(entityId) {
  const rows = new Map();
  for (const block of recentChangeBlocks) {
    if (block.lane === "market" || !ensureArray(block.entityIds).includes(entityId)) continue;
    for (const otherEntityId of ensureArray(block.entityIds)) {
      if (otherEntityId === entityId) continue;
      const row = marketByEntityId.get(otherEntityId);
      if (!row) continue;
      rows.set(row.id || row.entityId, marketContextItem(row, { evidenceLinked: true, linkChange: block }));
    }
  }
  return Array.from(rows.values())
    .sort((a, b) => (Number(b.changePct) || 0) - (Number(a.changePct) || 0))
    .slice(0, 5);
}

const marketContextEntityIds = Array.from(
  new Set([...entities.map((entity) => entity.id), ...recentChangeBlocks.flatMap((block) => ensureArray(block.entityIds))].filter(Boolean))
);

const marketContexts = {
  date: targetDate,
  generatedAt: today.generatedAt,
  policy: "Market context modes are generated data projections. watchlist_snapshot is not causal; evidence_linked_market requires event/relation/claim evidence; entity_market is the selected entity's own market snapshot.",
  rows: marketContextEntityIds.map((entityId) => {
    const entityMarketRow = marketByEntityId.get(entityId);
    if (entityMarketRow) {
      return {
        entityId,
        mode: "entity_market",
        title: "当前对象行情",
        relatedToSelectedEntity: true,
        sortBy: "selectedEntity",
        disclaimer: null,
        items: [marketContextItem(entityMarketRow)],
      };
    }

    const linkedItems = evidenceLinkedMarketItems(entityId);
    if (linkedItems.length) {
      return {
        entityId,
        mode: "evidence_linked_market",
        title: "有证据连接的市场对象",
        relatedToSelectedEntity: true,
        sortBy: "latestChangePctDesc",
        disclaimer: "以下对象存在公开材料或关系证据连接，不表示因果或投资判断。",
        linkEvidenceIds: Array.from(new Set(linkedItems.flatMap((item) => item.linkEvidenceIds || []))),
        items: linkedItems,
      };
    }

    return {
      entityId,
      mode: "watchlist_snapshot",
      title: "观察池市场快照",
      relatedToSelectedEntity: false,
      sortBy: "latestChangePctDesc",
      disclaimer: "按最新涨跌幅排序，不表示与当前对象或当前事件存在因果关系。",
      items: watchlistSnapshotItems,
    };
  }),
};

const acquisitionStatusLabels = {
  OK: "已取得",
  PARTIAL: "部分",
  PENDING: "待处理",
  FAILED: "失败",
  NOT_REQUESTED: "未接入",
  NOT_APPLICABLE: "不适用",
};

const researchGateLabels = {
  READY_FOR_REVIEW: "可进入研究复核",
  EVIDENCE_GATED: "证据门禁",
  DATA_GATED: "数据门禁",
  WATCH_ONLY: "仅观察",
};

const layerDefinitions = [
  {
    id: "robot_oem",
    label: "整机厂",
    match: /整机厂|人形机器人/,
    bottleneckRank: 3,
    scarcityReason: "验证终端需求和量产节奏，但不直接等同于上游瓶颈。",
  },
  {
    id: "force_sensor",
    label: "力传感器",
    match: /力传感器|六维力传感/,
    bottleneckRank: 8,
    scarcityReason: "量产一致性、客户验证和工艺积累会影响放量速度。",
  },
  {
    id: "lead_screw",
    label: "丝杠",
    match: /丝杠|滚柱丝杠/,
    bottleneckRank: 8,
    scarcityReason: "精密加工、寿命验证和扩产周期较长。",
  },
  {
    id: "reducer",
    label: "减速器",
    match: /减速器|谐波/,
    bottleneckRank: 7,
    scarcityReason: "精密传动件受良率、寿命和客户认证约束。",
  },
  {
    id: "vision_sensor",
    label: "视觉传感器",
    match: /视觉|3D视觉|机器视觉/,
    bottleneckRank: 6,
    scarcityReason: "感知链条需要产品参数、客户导入和收入拆分验证。",
  },
  {
    id: "controller_drive",
    label: "控制器 / 驱动",
    match: /控制器|驱动|运动控制|伺服/,
    bottleneckRank: 6,
    scarcityReason: "控制和驱动环节需要机器人业务纯度与客户量产验证。",
  },
  {
    id: "actuator",
    label: "执行器",
    match: /执行器|灵巧手|电机/,
    bottleneckRank: 7,
    scarcityReason: "执行器受 BOM 关键性、寿命和成本下降路径影响。",
  },
  {
    id: "manufacturing",
    label: "代工 / 制造链",
    match: /3C制造|代工|制造链/,
    bottleneckRank: 4,
    scarcityReason: "部署场景能验证需求，但需订单和利润率进一步确认。",
  },
  {
    id: "other_robotics",
    label: "机器人链其他",
    match: /.*/,
    bottleneckRank: 2,
    scarcityReason: "需要进一步定位产业链角色和证据来源。",
  },
];

function entityChangeRows(entityId) {
  return recentChangeBlocks.filter((block) => ensureArray(block.entityIds).includes(entityId) || block.objectId === entityId);
}

function entityClaimRows(entityId) {
  return claims.filter((claim) => ensureArray(claim.entityIds).includes(entityId));
}

function entityEvidenceRows(entityId) {
  return entityClaimRows(entityId).flatMap((claim) => evidenceByClaimId.get(claim.id) || []);
}

function entitySourceRows(entityId) {
  const sourceMap = new Map();
  const addSource = (source) => {
    if (source?.id) sourceMap.set(source.id, source);
  };
  for (const block of entityChangeRows(entityId)) {
    (block.sources || []).forEach(addSource);
  }
  for (const evidence of entityEvidenceRows(entityId)) {
    addSource(sourceById.get(evidence.sourceId));
  }
  (marketByEntityId.get(entityId)?.sources || []).forEach(addSource);
  return Array.from(sourceMap.values());
}

function entityFollowupRows(entityId) {
  const entity = entityById.get(entityId);
  return followups.filter((item) => {
    if (ensureArray(item.entityIds).includes(entityId)) return true;
    return entity?.name && ensureArray(item.entityNames).includes(entity.name);
  });
}

function entityRelationRows(entityId) {
  return relations.filter((relation) => relation.entityAId === entityId || relation.entityBId === entityId);
}

function sourceHasType(sources, types) {
  return sources.some((source) => types.includes(source.sourceType));
}

function acquisitionItem(id, label, status, evidenceRefs = [], gap = "") {
  return {
    id,
    label,
    status,
    statusLabel: acquisitionStatusLabels[status] || status,
    evidenceRefs: evidenceRefs.filter(Boolean).slice(0, 5),
    gap,
  };
}

function entityAcquisitionRow(entity) {
  const entityId = entity.id;
  const sourcesForEntity = entitySourceRows(entityId);
  const claimsForEntity = entityClaimRows(entityId);
  const changesForEntity = entityChangeRows(entityId);
  const followupsForEntity = entityFollowupRows(entityId);
  const relationsForEntity = entityRelationRows(entityId);
  const stock = marketByEntityId.get(entityId);
  const officialSources = sourcesForEntity.filter((source) => ["webpage", "news"].includes(source.sourceType));
  const filingSources = sourcesForEntity.filter((source) => ["exchange", "filing"].includes(source.sourceType));
  const customerSignals = [...claimsForEntity, ...changesForEntity, ...followupsForEntity].filter((row) =>
    /客户|订单|交付|产线|量产|产能|backlog|capacity/i.test(`${row.title || ""} ${row.text || ""} ${row.change || ""} ${row.subject || ""}`)
  );
  const supplySignals = [...relationsForEntity, ...changesForEntity].filter((row) =>
    row.lane === "supply_chain" || /供应|客户|合作|产线|代工/.test(`${row.title || ""} ${row.fact || ""} ${row.change || ""}`)
  );

  const datasets = [
    acquisitionItem(
      "official_news",
      "官网/新闻",
      officialSources.length ? "OK" : sourcesForEntity.length ? "PARTIAL" : "PENDING",
      officialSources.map((source) => source.id),
      officialSources.length ? "" : "缺官方新闻或产品页"
    ),
    acquisitionItem(
      "filings_announcements",
      "公告/财报",
      !entity.listed ? "NOT_APPLICABLE" : filingSources.length ? "OK" : "NOT_REQUESTED",
      filingSources.map((source) => source.id),
      !entity.listed ? "非上市对象" : filingSources.length ? "" : "尚未接入公告/财报源"
    ),
    acquisitionItem(
      "market_snapshot",
      "行情快照",
      !entity.listed ? "NOT_APPLICABLE" : stock ? "OK" : "FAILED",
      stock?.sources?.map((source) => source.id) || [],
      !entity.listed ? "非上市对象" : stock ? "" : "缺股票行情快照"
    ),
    acquisitionItem(
      "customer_order_capacity",
      "客户/订单/产能",
      customerSignals.length ? "PARTIAL" : "NOT_REQUESTED",
      sourceIdsForRows(customerSignals),
      customerSignals.length ? "已有线索，仍需原始披露确认" : "尚未形成客户/订单/产能验证任务"
    ),
    acquisitionItem(
      "supply_relationship",
      "供应关系",
      relationsForEntity.length ? "OK" : supplySignals.length ? "PARTIAL" : "NOT_REQUESTED",
      sourceIdsForRows(supplySignals),
      relationsForEntity.length ? "" : supplySignals.length ? "已有供应链线索，待正式关系验证" : "尚未形成供应关系验证"
    ),
  ];
  const statusCounts = countBy(datasets, (item) => item.status);
  const blockingStatuses = datasets.filter((item) => ["FAILED", "PENDING"].includes(item.status));
  return {
    entityId,
    name: entity.name,
    industryRole: entityProfileById.get(entityId)?.industryRole || industryRole(entity),
    datasets,
    statusCounts,
    acquisitionState: blockingStatuses.length ? "has_blockers" : datasets.some((item) => item.status === "PARTIAL") ? "partial" : "ready",
    blockers: blockingStatuses.map((item) => item.gap || item.label).filter(Boolean),
  };
}

const dataAcquisitionMatrix = {
  date: targetDate,
  generatedAt: today.generatedAt,
  policy: "Data acquisition matrix describes whether public research inputs exist for each entity. It is a research-readiness view, not an investment rating.",
  rows: entities.map(entityAcquisitionRow),
};

const acquisitionByEntityId = new Map(dataAcquisitionMatrix.rows.map((row) => [row.entityId, row]));

function layerForProfile(profile) {
  const text = `${profile?.industryRole || ""} ${profile?.roboticsRole || ""} ${profile?.tags?.join(" ") || ""}`;
  return layerDefinitions.find((layer) => layer.match.test(text)) || layerDefinitions.at(-1);
}

function researchGateForEntity(entity) {
  const entityId = entity.id;
  const changesForEntity = entityChangeRows(entityId);
  const nonMarketChanges = changesForEntity.filter((change) => change.lane !== "market");
  const profile = entityProfileById.get(entityId);
  const acquisition = acquisitionByEntityId.get(entityId);
  const evidenceForEntity = entityEvidenceRows(entityId);
  const hasStrongEvidence = evidenceForEntity.some((row) => ["A", "B"].includes(row.sourceLevel)) || sourceHasType(entitySourceRows(entityId), ["webpage", "exchange", "filing"]);
  const pendingClaims = entityClaimRows(entityId).filter((claim) => claim.status === "candidate" || claim.reviewStatus === "inbox");
  const hasVerifiedNonMarket = nonMarketChanges.some((change) => ["verified", "verified_with_followup"].includes(change.status || change.verificationState));
  const blockers = [];

  if (acquisition?.blockers?.length) blockers.push(...acquisition.blockers);
  if (!hasStrongEvidence) blockers.push("缺 A/B 级来源或官方材料");
  if (pendingClaims.length && !hasVerifiedNonMarket) blockers.push("存在待审核候选事实");
  if (!nonMarketChanges.length) blockers.push("缺非行情正式变化");

  let gate = "READY_FOR_REVIEW";
  if (!nonMarketChanges.length && changesForEntity.length) gate = "WATCH_ONLY";
  if (!changesForEntity.length) gate = "WATCH_ONLY";
  if (!hasStrongEvidence || (pendingClaims.length && !hasVerifiedNonMarket)) gate = "EVIDENCE_GATED";
  if (acquisition?.datasets?.some((item) => item.status === "FAILED" || item.status === "PENDING")) gate = "DATA_GATED";
  if (!nonMarketChanges.length && entity.listed && marketByEntityId.has(entityId)) gate = "WATCH_ONLY";

  const nextEvidence = blockers[0] || entityFollowupRows(entityId)[0]?.subject || "继续跟踪后续公开材料";
  return {
    entityId,
    name: entity.name,
    gate,
    gateLabel: researchGateLabels[gate],
    gateClass: gate === "READY_FOR_REVIEW" ? "RESEARCH_VALIDATION" : gate === "DATA_GATED" ? "DATA_ACQUISITION" : gate === "EVIDENCE_GATED" ? "EVIDENCE_VALIDATION" : "WATCHLIST",
    blockers: Array.from(new Set(blockers)).slice(0, 5),
    nextEvidence,
    evidenceLevel: profile?.evidenceState || "unknown",
    nonMarketChangeCount: nonMarketChanges.length,
    acquisitionState: acquisition?.acquisitionState || "unknown",
  };
}

const researchGates = {
  date: targetDate,
  generatedAt: today.generatedAt,
  policy: "Research gates constrain whether an entity can move from observation to review. They are not ratings and do not imply investment action.",
  rows: entities.map(researchGateForEntity),
};

const gateByEntityId = new Map(researchGates.rows.map((row) => [row.entityId, row]));

function candidatePriorityScore(entity) {
  const entityId = entity.id;
  const changesForEntity = entityChangeRows(entityId);
  const gate = gateByEntityId.get(entityId);
  const acquisition = acquisitionByEntityId.get(entityId);
  const profile = entityProfileById.get(entityId);
  const layer = layerForProfile(profile);
  const sourceCount = entitySourceRows(entityId).length;
  const followupCount = entityFollowupRows(entityId).length;
  const gateBonus = {
    READY_FOR_REVIEW: 24,
    EVIDENCE_GATED: 12,
    DATA_GATED: 6,
    WATCH_ONLY: 0,
  }[gate?.gate] || 0;
  const acquisitionPenalty = acquisition?.acquisitionState === "has_blockers" ? 10 : acquisition?.acquisitionState === "partial" ? 4 : 0;
  return Math.max(
    0,
    Math.round(layer.bottleneckRank * 6 + changesForEntity.filter((row) => row.lane !== "market").length * 8 + sourceCount * 2 + followupCount * 3 + gateBonus - acquisitionPenalty)
  );
}

const candidateRows = entities.map((entity) => {
  const profile = entityProfileById.get(entity.id);
  const layer = layerForProfile(profile);
  const gate = gateByEntityId.get(entity.id);
  const acquisition = acquisitionByEntityId.get(entity.id);
  const priorityScore = candidatePriorityScore(entity);
  return {
    entityId: entity.id,
    name: entity.name,
    ticker: profile?.ticker || tickerText(entity),
    layerId: layer.id,
    layerLabel: layer.label,
    listed: Boolean(entity.listed),
    gate: gate?.gate || "WATCH_ONLY",
    gateLabel: gate?.gateLabel || researchGateLabels.WATCH_ONLY,
    priorityScore,
    stage:
      gate?.gate === "READY_FOR_REVIEW"
        ? "shortlist_candidate"
        : gate?.gate === "EVIDENCE_GATED"
          ? "evidence_repair"
          : gate?.gate === "DATA_GATED"
            ? "data_repair"
            : "watch_only",
    reason: profile?.watchReason || `${layer.label}观察对象`,
    nextEvidence: gate?.nextEvidence || acquisition?.blockers?.[0] || "继续跟踪后续公开材料",
  };
});

const layerRows = layerDefinitions.map((layer) => {
  const rows = candidateRows.filter((row) => row.layerId === layer.id).sort((a, b) => b.priorityScore - a.priorityScore);
  return {
    layerId: layer.id,
    label: layer.label,
    bottleneckRank: layer.bottleneckRank,
    scarcityReason: layer.scarcityReason,
    entityCount: rows.length,
    readyCount: rows.filter((row) => row.gate === "READY_FOR_REVIEW").length,
    gatedCount: rows.filter((row) => row.gate !== "READY_FOR_REVIEW").length,
    entities: rows.slice(0, 8),
  };
});

const candidateFunnel = {
  date: targetDate,
  generatedAt: today.generatedAt,
  contractType: "humanoid_research_candidate_funnel_v0",
  policy: "Layer-first candidate funnel ranks research priority from public evidence readiness, layer role, and data gaps. It is not a buy/sell recommendation.",
  theme: "人形机器人产业链",
  layerRows: layerRows.filter((row) => row.entityCount > 0).sort((a, b) => b.bottleneckRank - a.bottleneckRank || b.readyCount - a.readyCount),
  candidateRows: candidateRows.sort((a, b) => b.priorityScore - a.priorityScore || a.name.localeCompare(b.name, "zh-Hans-CN")),
  shortlist: candidateRows
    .filter((row) => row.gate !== "WATCH_ONLY")
    .sort((a, b) => b.priorityScore - a.priorityScore)
    .slice(0, 8),
  excludedDirections: layerRows
    .filter((row) => row.entityCount > 0 && row.readyCount === 0)
    .map((row) => ({
      layerId: row.layerId,
      label: row.label,
      reason: "当前层级缺少可进入研究复核的对象，先补数据或证据。",
    })),
  nextStep: "先修复 DATA_GATED/EVIDENCE_GATED 对象，再把 READY_FOR_REVIEW 对象推进到人工研究复核。",
};

function reviewItemFromFollowup(item) {
  const entityIds = ensureArray(item.entityIds).length
    ? ensureArray(item.entityIds)
    : entities.filter((entity) => ensureArray(item.entityNames).includes(entity.name)).map((entity) => entity.id);
  return {
    id: item.id,
    sourceType: "followup",
    subject: item.subject,
    entityIds,
    entityNames: ensureArray(item.entityNames),
    status: item.status || "pending",
    cadenceDays: 30,
    dueAt: targetDate,
    probeType: /行情|价格|涨跌/.test(item.subject || "") ? "market_snapshot" : "public_material",
    sourceIds: ensureArray(item.sourceIds),
  };
}

function reviewItemFromChange(change) {
  const cadenceDays = change.verificationState === "pending_review" ? 30 : change.lane === "market" ? 30 : 90;
  return {
    id: `${change.id}_review`,
    sourceType: "change_next_question",
    subject: change.nextQuestion,
    entityIds: ensureArray(change.entityIds),
    entityNames: ensureArray(change.entityNames),
    status: change.verificationState === "pending_review" ? "required" : "pending",
    cadenceDays,
    dueAt: addDays(change.date || targetDate, cadenceDays) || targetDate,
    probeType: change.lane === "market" ? "market_snapshot" : change.changeType?.includes("company") ? "filing_or_news" : "public_material",
    sourceChangeId: change.id,
  };
}

const reviewCycleRows = [
  ...followups.filter((item) => item.status === "pending").map(reviewItemFromFollowup),
  ...recentChangeBlocks
    .filter((change) => change.nextQuestion && change.lane !== "market")
    .map(reviewItemFromChange),
]
  .filter((item, index, rows) => rows.findIndex((row) => row.id === item.id) === index)
  .sort((a, b) => String(a.dueAt).localeCompare(String(b.dueAt)) || String(a.subject).localeCompare(String(b.subject), "zh-Hans-CN"));

const reviewCycle = {
  date: targetDate,
  generatedAt: today.generatedAt,
  contractType: "humanoid_research_review_cycle_v0",
  policy: "Review cycle turns next-evidence questions into dated public-material checks. It does not resolve claims automatically yet.",
  dueBefore: targetDate,
  rows: reviewCycleRows,
  summary: {
    total: reviewCycleRows.length,
    due: reviewCycleRows.filter((item) => String(item.dueAt) <= targetDate).length,
    byProbeType: countBy(reviewCycleRows, (item) => item.probeType),
  },
};

const timelineDates = Array.from(new Set(recentChangeBlocks.map((row) => row.date)))
  .slice(0, 8)
  .map((date) => ({
    date,
    lanes: Object.fromEntries(
      Object.keys(laneMeta).map((lane) => [
        lane,
        recentChangeBlocks
          .filter((row) => row.date === date && row.lane === lane)
          .slice(0, 3)
          .map(compactChangePreview),
      ])
    ),
    total: recentChangeBlocks.filter((row) => row.date === date).length,
  }));

const objectCards = Array.from(
  recentChangeBlocks.reduce((map, block) => {
    const key = block.objectId || block.objectName || block.id;
    const existing = map.get(key) || {
      id: key,
      name: block.objectName,
      entityId: block.entityIds?.[0] || null,
      entityNames: [],
      lanes: Object.fromEntries(Object.keys(laneMeta).map((lane) => [lane, []])),
      changes: [],
      verificationItems: [],
      marketContext: [],
      evidenceLevels: [],
    };
    existing.name = existing.name || block.objectName;
    existing.entityNames = Array.from(new Set([...existing.entityNames, ...(block.entityNames || [])].filter(Boolean)));
    existing.lanes[block.lane] = [...(existing.lanes[block.lane] || []), compactChangePreview(block)].slice(0, 3);
    existing.changes.push(block);
    existing.verificationItems.push(...(block.verificationItems || []));
    existing.marketContext.push(...(block.marketContext || []));
    if (block.evidenceLevel) existing.evidenceLevels.push(block.evidenceLevel);
    map.set(key, existing);
    return map;
  }, new Map()).values()
)
  .map((card) => ({
    ...card,
    changes: card.changes.slice().sort(changeSort).slice(0, 8).map(compactChangePreview),
    verificationItems: card.verificationItems.slice(0, 5),
    marketContext: Array.from(new Map(card.marketContext.map((row) => [row.id || row.entityId, row])).values()).slice(0, 4),
    strongestEvidenceLevel: card.evidenceLevels
      .slice()
      .sort((a, b) => (evidenceRank[b] || 0) - (evidenceRank[a] || 0))[0] || null,
    lastChangedAt: latestTime(card.changes.map((row) => row.time || row.date)),
  }))
  .sort((a, b) => {
    return (
      String(b.lastChangedAt || "").localeCompare(String(a.lastChangedAt || "")) ||
      b.changes.length - a.changes.length ||
      String(a.name || "").localeCompare(String(b.name || ""), "zh-Hans-CN")
    );
  })
  .slice(0, 8);

const verificationQueue = [
  ...followups
    .filter((item) => item.status === "pending")
    .map((item) => ({
      id: item.id,
      subject: item.subject,
      status: item.status,
      entityNames: entityNames(item.entityIds),
      sourceIds: item.sourceIds,
      sources: enrichSources(item.sourceIds),
    })),
  ...candidateChangeBlocks.flatMap((block) =>
    (block.verificationItems || []).map((item) => ({
      ...item,
      id: `${block.id}_${item.id}`,
      subject: item.subject,
      status: item.status,
      entityNames: block.entityNames,
      sources: block.sources,
    }))
  ),
].slice(0, 12);

const changeWall = {
  date: targetDate,
  generatedAt: today.generatedAt,
  title: "Change Wall",
  policy: "Change Wall only places product, company, supply-chain, policy and market changes side by side. It does not infer causality or make recommendations.",
  lanes: Object.entries(laneMeta).map(([id, meta]) => ({
    id,
    ...meta,
    count: recentChangeBlocks.filter((row) => row.lane === id).length,
  })),
  rows: recentChangeBlocks.slice(0, 80),
  timelineDates,
  objectCards,
  marketChanges: marketChangeBlocks.slice(0, 10),
  verificationQueue,
  summary: {
    totalChanges: recentChangeBlocks.length,
    objectCards: objectCards.length,
    marketChanges: marketChangeBlocks.length,
    pendingVerification: verificationQueue.length,
    byLane: countBy(recentChangeBlocks, (row) => row.lane),
  },
};

const marketContextByEntityId = new Map(marketContexts.rows.map((row) => [row.entityId, row]));

const coverageDatasetIds = {
  officialSource: "official_news",
  financials: "filings_announcements",
  marketSnapshot: "market_snapshot",
  customerOrder: "customer_order_capacity",
  supplyChain: "supply_relationship",
};

function isWithinLastDays(value, days) {
  if (!value) return false;
  const time = dateTime(dateKey(value));
  return time !== null && time >= targetTime - (days - 1) * 24 * 60 * 60 * 1000 && time <= targetTime;
}

function coverageStatusFromAcquisition(item, { missingWhenNotApplicable = false } = {}) {
  if (!item) return "missing";
  if (item.status === "OK") return "ok";
  if (item.status === "PARTIAL") return "partial";
  if (item.status === "NOT_APPLICABLE") return missingWhenNotApplicable ? "missing" : "not_applicable";
  return "missing";
}

function coverageForEntity(entity, changesForEntity, acquisition) {
  const datasetById = new Map((acquisition?.datasets || []).map((item) => [item.id, item]));
  const hasProductMaterial = changesForEntity.some((change) => change.lane === "product");
  return {
    product: hasProductMaterial
      ? "ok"
      : coverageStatusFromAcquisition(datasetById.get(coverageDatasetIds.officialSource)) === "ok"
        ? "partial"
        : "missing",
    officialSource: coverageStatusFromAcquisition(datasetById.get(coverageDatasetIds.officialSource)),
    supplyChain: coverageStatusFromAcquisition(datasetById.get(coverageDatasetIds.supplyChain)),
    customerOrder: coverageStatusFromAcquisition(datasetById.get(coverageDatasetIds.customerOrder)),
    financials: coverageStatusFromAcquisition(datasetById.get(coverageDatasetIds.financials), {
      missingWhenNotApplicable: true,
    }),
    marketSnapshot: entity.listed
      ? coverageStatusFromAcquisition(datasetById.get(coverageDatasetIds.marketSnapshot))
      : "not_listed",
  };
}

function addUnique(list, value) {
  if (value && !list.includes(value)) list.push(value);
}

function factLabelForChange(change) {
  if (change.changeType === "product_milestone") return "量产节点";
  if (change.changeType === "product_delivery_signal") return "交付线索";
  if (change.changeType === "product_release") return "产品材料";
  if (change.changeType === "company_operation") return "生态/合作材料";
  if (change.changeType === "company_disclosure") return "公告/财报材料";
  if (change.changeType === "supply_chain_signal") return "供应链线索";
  if (change.lane === "market") return "市场快照";
  if (change.lane === "company") return "公司动态";
  return change.changeLabel || laneMeta[change.lane]?.label || "公开材料";
}

function knownEvidenceForEntity(changesForEntity, coverage) {
  const known = [];
  if (coverage.product === "ok") addUnique(known, "产品材料");
  if (coverage.officialSource === "ok") addUnique(known, "官方来源");
  if (coverage.supplyChain === "ok") addUnique(known, "供应关系");
  if (coverage.supplyChain === "partial") addUnique(known, "供应链线索");
  if (coverage.customerOrder === "partial") addUnique(known, "客户/订单线索");
  if (coverage.financials === "ok") addUnique(known, "财务/公告材料");
  if (coverage.marketSnapshot === "ok") addUnique(known, "市场快照");
  if (!known.length && changesForEntity.length) addUnique(known, "公开材料");
  return known;
}

function verifiedEvidenceForCoverage(coverage) {
  const verified = [];
  if (coverage.product === "ok") addUnique(verified, "产品材料");
  if (coverage.officialSource === "ok") addUnique(verified, "官方来源");
  if (coverage.supplyChain === "ok") addUnique(verified, "供应关系");
  if (coverage.financials === "ok") addUnique(verified, "财务/公告材料");
  if (coverage.marketSnapshot === "ok") addUnique(verified, "市场快照");
  return verified;
}

function signalEvidenceForCoverage(coverage) {
  const signals = [];
  if (coverage.customerOrder === "partial") addUnique(signals, "客户/订单仍为线索");
  if (coverage.supplyChain === "partial") addUnique(signals, "供应链线索");
  if (coverage.product === "partial") addUnique(signals, "产品材料部分覆盖");
  if (coverage.officialSource === "partial") addUnique(signals, "官方来源部分覆盖");
  if (coverage.financials === "partial") addUnique(signals, "财务/公告材料待复核");
  return signals;
}

function missingEvidenceForCoverage(coverage, sector = "robotics") {
  const missing = [];
  const sectorEvidence = {
    semiconductor: ["核心产品收入", "客户验证", "份额提升"],
    drone: ["批量订单", "实际交付", "无人机业务收入"],
    oil: ["产量和销量", "成本变化", "现金流兑现"],
    power: ["发电量", "电价和成本", "现金流兑现"],
    innovative_drug: ["临床和审批进度", "产品销售", "研发兑现"],
    precious_metals: ["产量变化", "成本变化", "项目投产"],
    robotics: ["正式订单", "客户名称", "交付验证"],
  };
  if (coverage.customerOrder !== "ok") {
    for (const item of sectorEvidence[sector] || sectorEvidence.robotics) addUnique(missing, item);
  }
  if (coverage.financials !== "ok") addUnique(missing, "财务兑现");
  if (coverage.supplyChain === "missing" && ["robotics", "semiconductor", "drone"].includes(sector)) {
    addUnique(missing, "供应关系");
  }
  if (coverage.officialSource === "missing") addUnique(missing, "官方来源");
  return missing;
}

function coverageDetailLabel(field, status) {
  const labels = {
    product: {
      ok: ["已覆盖", "有产品或量产材料"],
      partial: ["部分覆盖", "产品细节待补"],
      missing: ["缺失", "暂无产品材料"],
    },
    officialSource: {
      ok: ["已覆盖", "有官方来源"],
      partial: ["部分覆盖", "来源待复核"],
      missing: ["缺失", "缺官方来源"],
    },
    supplyChain: {
      ok: ["已覆盖", "有供应关系证据"],
      partial: ["线索未验证", "待公告或合作方确认"],
      missing: ["缺失", "缺供应关系证据"],
    },
    customerOrder: {
      ok: ["已验证", "有客户/订单证据"],
      partial: ["仅线索，未验证", "缺正式订单/客户/交付"],
      missing: ["缺正式披露", "缺订单、客户、交付"],
    },
    financials: {
      ok: ["公告已覆盖", "兑现仍需拆分验证"],
      partial: ["部分覆盖", "财务材料待复核"],
      missing: ["缺失", "缺财务兑现材料"],
    },
    marketSnapshot: {
      ok: ["已覆盖", "仅市场事实"],
      partial: ["部分覆盖", "行情数据待补"],
      missing: ["缺失", "无行情快照"],
      not_listed: ["非上市", "不展示对象行情"],
      not_applicable: ["不适用", "无行情要求"],
    },
  };
  const [label, note] = labels[field]?.[status] || [status || "缺失", ""];
  return { label, note };
}

function evidenceCoverageDetailsForCoverage(coverage) {
  return Object.fromEntries(
    Object.entries(coverage).map(([field, status]) => [field, coverageDetailLabel(field, status)])
  );
}

function joinChineseList(values = [], limit = 4) {
  const visible = values.filter(Boolean).slice(0, limit);
  if (!visible.length) return "";
  if (visible.length === 1) return visible[0];
  if (visible.length === 2) return visible.join("和");
  return `${visible.slice(0, -1).join("、")}和${visible.at(-1)}`;
}

function researchPhaseForFacts(newFacts = [], changesForEntity = [], marketContext = null) {
  const hasNonMarketChange = changesForEntity.some((change) => change.lane !== "market");
  if (!hasNonMarketChange && marketContext?.mode === "entity_market") return "行情快照观察";
  if (!hasNonMarketChange) return "观察池待材料";
  const text = `${newFacts.join(" ")} ${changesForEntity.map((change) => change.changeType || change.changeLabel || "").join(" ")}`;
  if (/量产节点|product_milestone|量产/.test(text)) return "量产进展跟踪";
  if (/交付线索|product_delivery_signal|交付/.test(text)) return "交付线索跟踪";
  if (/供应链线索|supply_chain_signal|供应链/.test(text)) return "供应链线索跟踪";
  if (/生态\/合作材料|company_operation|合作/.test(text)) return "生态/合作材料跟踪";
  if (/公告\/财报材料|company_disclosure/.test(text)) return "公告材料跟踪";
  if (changesForEntity.some((change) => change.lane === "market") && !changesForEntity.some((change) => change.lane !== "market")) {
    return "行情事实观察";
  }
  return "公开材料观察";
}

function summaryTextForEntity({
  role,
  phase,
  verifiedEvidence,
  signalEvidence,
  missingEvidence,
  hasResearchMaterial,
}) {
  if (!hasResearchMaterial && verifiedEvidence.includes("市场快照")) {
    return `${role || "该对象"}为观察池对象。当前仅有市场快照，暂无研究材料进入证据链。`;
  }
  if (!hasResearchMaterial) {
    return `${role || "该对象"}为观察池对象。暂无研究材料进入证据链。`;
  }
  const nonMarketVerified = verifiedEvidence.filter((item) => item !== "市场快照");
  const verified = joinChineseList(nonMarketVerified, 3) || "公开材料";
  const signals = signalEvidence.length ? `；${joinChineseList(signalEvidence, 2)}` : "";
  const missing = joinChineseList(missingEvidence, 4);
  const missingPart = missing ? `；缺${missing}。` : "；暂无关键证据缺口。";
  return `${role || "该对象"}处于${phase}阶段。已有${verified}${signals}${missingPart}`;
}

function stripVerificationPrefix(value = "") {
  return String(value)
    .replace(/^待验证[:：]\s*/u, "")
    .replace(/^后续/u, "")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeVerificationSubject(value = "") {
  const text = stripVerificationPrefix(value);
  if (/人工确认事实字段|promotion|标题、页面正文|标准产品名|事实、来源和实体归属|打开公告 PDF|交易所页面/.test(text)) {
    return "查原文是否明确事实、来源和实体归属";
  }
  if (/兑现|财务|收入|财报|生态伙伴名单|投入进展/.test(text)) {
    return "查财报/公告是否披露机器人相关收入、订单或兑现进展";
  }
  if (/交付|客户|订单|累计交付|常态化运行/.test(text)) {
    return "查公告、调研纪要或客户披露是否出现正式订单、客户名称和交付记录";
  }
  if (/供应关系|供应链|合作方|公开来源/.test(text)) {
    return "查供应链公告或合作方披露是否确认供货关系";
  }
  return text || "继续跟踪后续公开材料";
}

function verificationPriority(subject = "") {
  if (/正式订单|客户名称|交付/.test(subject)) return 1;
  if (/财报|收入|兑现/.test(subject)) return 2;
  if (/供应链|合作方|供货关系/.test(subject)) return 3;
  if (/产品型号|应用场景|时间节点/.test(subject)) return 4;
  if (/原文|实体归属/.test(subject)) return 5;
  return 5;
}

function whyWatchForEntity(entity, profile, changesForEntity, nextVerifications, marketContext) {
  const reasons = [];
  const nonMarketChanges = changesForEntity.filter((change) => change.lane !== "market");
  if (!nonMarketChanges.length) return reasons;
  const recentProduct = nonMarketChanges.some((change) => change.lane === "product" && isWithinLastDays(change.date, 30));
  const recentCompany = nonMarketChanges.some((change) => change.lane === "company" && isWithinLastDays(change.date, 30));
  const hasSupply = nonMarketChanges.some((change) => change.lane === "supply_chain");

  if (recentProduct) addUnique(reasons, "新增量产或产品公开材料");
  if (hasSupply) addUnique(reasons, "存在供应链/生态线索");
  if (nextVerifications.length) addUnique(reasons, "订单、客户、交付仍缺验证");
  if (recentCompany) addUnique(reasons, "新增公司公开动态或公告材料");
  return reasons.slice(0, 3);
}

function researchStateForEntity(gate) {
  const stageByGate = {
    READY_FOR_REVIEW: "Researching",
    EVIDENCE_GATED: "EvidenceGated",
    DATA_GATED: "DataGated",
    WATCH_ONLY: "Watching",
  };
  const labelByGate = {
    READY_FOR_REVIEW: "研究中",
    EVIDENCE_GATED: "证据待补",
    DATA_GATED: "数据待补",
    WATCH_ONLY: "观察中",
  };
  return {
    stage: stageByGate[gate?.gate] || "Watching",
    label: labelByGate[gate?.gate] || gate?.gateLabel || "观察中",
    nextStageRequirement: gate?.nextEvidence || "继续跟踪后续公开材料",
    gate: gate?.gate || "WATCH_ONLY",
  };
}

function coverageVerificationRows(entityId, coverage, changesForEntity) {
  if (!changesForEntity.some((change) => change.lane !== "market")) return [];
  const baseDate = changesForEntity.find((change) => change.lane !== "market")?.date || targetDate;
  const rows = [];

  if (coverage.customerOrder !== "ok") {
    rows.push({
      id: `${entityId}_coverage_customer_order`,
      sourceType: "coverage_gap",
      subject: "查公告、调研纪要或客户披露是否出现正式订单、客户名称和交付记录",
      entityIds: [entityId],
      status: coverage.customerOrder === "partial" ? "pending" : "required",
      dueAt: addDays(baseDate, 30) || targetDate,
      probeType: "customer_order",
    });
  }
  if (coverage.financials !== "ok") {
    rows.push({
      id: `${entityId}_coverage_financials`,
      sourceType: "coverage_gap",
      subject: "查财报/公告是否披露机器人相关收入、订单或兑现进展",
      entityIds: [entityId],
      status: "required",
      dueAt: addDays(baseDate, 60) || targetDate,
      probeType: "financials",
    });
  } else if (coverage.customerOrder !== "ok") {
    rows.push({
      id: `${entityId}_coverage_financials_split`,
      sourceType: "coverage_gap",
      subject: "查财报是否拆出机器人相关收入或客户订单",
      entityIds: [entityId],
      status: "pending",
      dueAt: addDays(baseDate, 90) || targetDate,
      probeType: "financials",
    });
  }
  if (coverage.supplyChain === "partial") {
    rows.push({
      id: `${entityId}_coverage_supply_chain`,
      sourceType: "coverage_gap",
      subject: "查合作方公告是否确认供应关系和应用场景",
      entityIds: [entityId],
      status: "pending",
      dueAt: addDays(baseDate, 60) || targetDate,
      probeType: "supply_chain",
    });
  } else if (coverage.supplyChain === "missing") {
    rows.push({
      id: `${entityId}_coverage_supply_chain_missing`,
      sourceType: "coverage_gap",
      subject: "查公开公告是否出现供应关系或合作方披露",
      entityIds: [entityId],
      status: "pending",
      dueAt: addDays(baseDate, 90) || targetDate,
      probeType: "supply_chain",
    });
  }
  if (coverage.product !== "ok") {
    rows.push({
      id: `${entityId}_coverage_product`,
      sourceType: "coverage_gap",
      subject: "查官方材料是否明确产品型号、应用场景和时间节点",
      entityIds: [entityId],
      status: coverage.product === "partial" ? "pending" : "required",
      dueAt: addDays(baseDate, 60) || targetDate,
      probeType: "product",
    });
  }

  return rows;
}

function nextVerificationsForEntity(entityId, changesForEntity, coverage) {
  const rows = [
    ...reviewCycleRows.filter((row) => ensureArray(row.entityIds).includes(entityId)),
    ...coverageVerificationRows(entityId, coverage, changesForEntity),
    ...changesForEntity
      .filter((change) => change.nextQuestion && change.lane !== "market")
      .map((change) => ({
        id: `${change.id}_next_verification`,
        sourceType: "change_next_question",
        subject: change.nextQuestion,
        entityIds: ensureArray(change.entityIds),
        entityNames: ensureArray(change.entityNames),
        status: change.verificationState === "pending_review" ? "required" : "pending",
        dueAt: addDays(change.date || targetDate, change.verificationState === "pending_review" ? 30 : 90) || targetDate,
        sourceChangeId: change.id,
      })),
  ];

  const seen = new Set();
  return rows
    .map((row) => ({
      ...row,
      subject: normalizeVerificationSubject(row.subject),
    }))
    .filter((row) => {
      const key = row.subject;
      if (!row.subject || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      return (
        verificationPriority(a.subject) - verificationPriority(b.subject) ||
        String(a.dueAt || "").localeCompare(String(b.dueAt || "")) ||
        String(a.subject).localeCompare(String(b.subject), "zh-Hans-CN")
      );
    })
    .map((row) => ({
      id: row.id,
      subject: row.subject,
      status: row.status,
      dueAt: row.dueAt || null,
      probeType: row.probeType || "public_material",
      sourceChangeId: row.sourceChangeId || null,
      entityNames: row.entityNames || entityNames(row.entityIds),
    }));
}

function marketModeLabel(mode) {
  const labels = {
    entity_market: "当前对象行情",
    evidence_linked_market: "有证据连接的市场对象",
    watchlist_snapshot: "观察池市场快照",
  };
  return labels[mode] || "市场背景";
}

function marketModeDescription(mode) {
  const descriptions = {
    entity_market: "当前对象行情，仅显示市场变化，不解释原因。",
    evidence_linked_market: "有公开材料或关系证据连接，仅作市场背景，不解释原因。",
    watchlist_snapshot: "按最新涨跌幅排序，不表示与当前对象或当前事件存在因果关系。",
  };
  return descriptions[mode] || "仅展示市场事实，不表示因果关系或投资判断。";
}

function marketModeTone(mode) {
  const tones = {
    entity_market: "entity",
    evidence_linked_market: "linked",
    watchlist_snapshot: "snapshot",
  };
  return tones[mode] || "snapshot";
}

function observedCompaniesForContext(marketContext) {
  const mode = marketContext?.mode || "watchlist_snapshot";
  return ensureArray(marketContext?.items).map((item) => {
    const reason = mode === "entity_market"
      ? "当前对象自己的行情"
      : item.evidenceLinked
        ? item.linkReason || "公告 / relation / evidence 连接"
        : "同研究主题观察池";
    return {
      entityId: item.entityId,
      name: item.name,
      ticker: item.ticker || null,
      role: item.industryRole || item.roboticsRole || "观察对象",
      reason,
      marketChangePct: item.changePct ?? null,
      price: item.price ?? null,
      turnoverAmount: item.turnoverAmount ?? null,
      capturedAt: item.capturedAt || null,
      evidenceLinked: Boolean(item.evidenceLinked),
      marketContext: "仅为市场事实，不表示因果关系或投资判断。",
      sources: item.sources || [],
    };
  });
}

function timelineNextLine(change) {
  if (change.lane === "market") return "仅作为市场事实，不表示事件影响。";
  return normalizeVerificationSubject(change.nextQuestion || "继续跟踪后续公开材料");
}

function compactReadingTitle(title = "") {
  return String(title)
    .replace(/股份有限公司/g, "")
    .replace(/有限责任公司/g, "")
    .replace(/.*存在待审核材料《(.+?)》。?/u, "$1")
    .replace(/.*存在公告材料《(.+?)》。?/u, "$1")
    .replace(/.*存在公开材料《(.+?)》。?/u, "$1")
    .replace(/存在官方产品材料《(.+?)》。?/u, "$1")
    .replace(/存在官方产品材料/u, "产品材料")
    .replace(/\s+/g, " ")
    .trim();
}

function timelineItemForResearch(change) {
  const nextLine = timelineNextLine(change);
  return {
    id: change.id,
    sourceType: change.sourceType,
    lane: change.lane,
    date: change.date,
    time: change.time,
    objectId: change.objectId,
    objectName: change.objectName,
    title: change.title,
    change: change.change,
    changeType: change.changeType,
    changeLabel: change.changeLabel,
    verificationState: change.verificationState,
    verificationLabel: change.verificationLabel,
    evidenceSummary: change.evidenceSummary,
    nextQuestion: change.nextQuestion,
    entityIds: change.entityIds || [],
    entityNames: change.entityNames || [],
    sources: change.sources || [],
    evidence: change.evidence || [],
    marketContext: change.marketContext || [],
    readingCard: {
      meta: `${change.changeLabel || laneMeta[change.lane]?.label || "变化"} · ${change.evidenceSummary?.level || "--"}级 · ${change.verificationLabel || "--"}`,
      title: compactReadingTitle(change.title),
      next: `下一步：${nextLine}`,
    },
  };
}

function researchReadingRow(entity) {
  const profile = entityProfileById.get(entity.id) || null;
  const acquisition = acquisitionByEntityId.get(entity.id) || null;
  const gate = gateByEntityId.get(entity.id) || null;
  const marketContext = marketContextByEntityId.get(entity.id) || {
    entityId: entity.id,
    mode: "watchlist_snapshot",
    title: "观察池市场快照",
    relatedToSelectedEntity: false,
    sortBy: "latestChangePctDesc",
    disclaimer: "按最新涨跌幅排序，不表示与当前对象或当前事件存在因果关系。",
    items: watchlistSnapshotItems,
  };
  const changesForEntity = entityChangeRows(entity.id).slice().sort(changeSort);
  const recentNonMarketChanges = changesForEntity.filter((change) => change.lane !== "market" && isWithinLastDays(change.date, 30));
  const coverage = coverageForEntity(entity, changesForEntity, acquisition);
  const newFacts = [];
  for (const change of recentNonMarketChanges.length ? recentNonMarketChanges : changesForEntity.filter((row) => row.lane !== "market")) {
    addUnique(newFacts, factLabelForChange(change));
    if (newFacts.length >= 4) break;
  }
  const knownEvidence = knownEvidenceForEntity(changesForEntity, coverage);
  const verifiedEvidence = verifiedEvidenceForCoverage(coverage);
  const signalEvidence = signalEvidenceForCoverage(coverage);
  const missingEvidence = missingEvidenceForCoverage(coverage, profile?.sector || sectorOf(entity));
  const nextVerifications = nextVerificationsForEntity(entity.id, changesForEntity, coverage);
  const observedCompanies = observedCompaniesForContext(marketContext);
  const hasResearchMaterial = changesForEntity.some((change) => change.lane !== "market");
  const phase = researchPhaseForFacts(newFacts, changesForEntity, marketContext);
  const role = profile?.industryRole || industryRole(entity);

  return {
    entityId: entity.id,
    name: entity.name,
    profile: {
      role,
      sector: profile?.sector || sectorOf(entity),
      sectorLabel: profile?.sectorLabel || sectorLabelOf(entity),
      sectorRole: profile?.sectorRole || sectorRole(entity),
      userFocus: Boolean(profile?.userFocus || entity.userFocus),
      curatorPick: Boolean(profile?.curatorPick || entity.curatorPick),
      selectionReason: profile?.selectionReason || entity.selectionReason || null,
      listedStatus: profile?.listing || listingLabel(entity),
      entityType: profile?.entityType || entityType(entity),
      ticker: profile?.ticker || tickerText(entity),
      watchReason: profile?.watchReason || watchReasonForEntity(entity, {
        entityEvents: allEventRows.filter((event) => event.entityIds.includes(entity.id)),
        entityClaims: entityClaimRows(entity.id),
        stock: marketByEntityId.get(entity.id) || null,
      }),
    },
    researchSummary: {
      summary: summaryTextForEntity({
        role,
        phase,
        verifiedEvidence,
        signalEvidence,
        missingEvidence,
        hasResearchMaterial,
      }),
      phase,
      newFacts,
      knownEvidence,
      verifiedEvidence,
      signalEvidence,
      missingEvidence,
    },
    whyWatch: whyWatchForEntity(entity, profile, changesForEntity, nextVerifications, marketContext),
    evidenceCoverage: coverage,
    evidenceCoverageDetails: evidenceCoverageDetailsForCoverage(coverage),
    researchState: researchStateForEntity(gate),
    nextVerifications,
    nextVerificationPreview: nextVerifications.slice(0, 3),
    timeline: changesForEntity.slice(0, 80).map(timelineItemForResearch),
    marketContext: {
      mode: marketContext.mode,
      modeLabel: marketModeLabel(marketContext.mode),
      modeDescription: marketModeDescription(marketContext.mode),
      tone: marketModeTone(marketContext.mode),
      title: "市场背景",
      subtitle: marketContext.title || marketModeLabel(marketContext.mode),
      relatedToSelectedEntity: Boolean(marketContext.relatedToSelectedEntity),
      disclaimer: marketContext.disclaimer || "仅为市场事实，不表示因果关系或投资判断。",
      observedCompanies,
    },
    counts: {
      changeCount: changesForEntity.length,
      nonMarketChangeCount: changesForEntity.filter((change) => change.lane !== "market").length,
      recent30DayChangeCount: changesForEntity.filter((change) => isWithinLastDays(change.date, 30)).length,
      timelineDateCount: new Set(changesForEntity.map((change) => change.date).filter(Boolean)).size,
    },
    sort: {
      priorityScore: candidateRows.find((row) => row.entityId === entity.id)?.priorityScore || 0,
      latestChangeTime: latestTime(changesForEntity.map((change) => change.time || change.date)),
    },
  };
}

const researchReadingRows = entities
  .map(researchReadingRow)
  .filter((row) => row.counts.changeCount > 0 || entityById.get(row.entityId)?.tags?.includes("Watchlist"))
  .sort((a, b) => {
    const gateWeight = {
      READY_FOR_REVIEW: 4,
      EVIDENCE_GATED: 3,
      DATA_GATED: 2,
      WATCH_ONLY: 1,
    };
    return (
      (gateWeight[b.researchState.gate] || 0) - (gateWeight[a.researchState.gate] || 0) ||
      b.counts.nonMarketChangeCount - a.counts.nonMarketChangeCount ||
      b.counts.changeCount - a.counts.changeCount ||
      b.sort.priorityScore - a.sort.priorityScore ||
      String(b.sort.latestChangeTime || "").localeCompare(String(a.sort.latestChangeTime || "")) ||
      String(a.name).localeCompare(String(b.name), "zh-Hans-CN")
    );
  });

const readingBannedConclusionPattern = /买卖|买点|卖点|评级|概率|受益|利好|利空|投资建议|商业化概率|该不该买/u;

function readingQaRow(row, index) {
  const warnings = [];
  const nextPreview = row.nextVerificationPreview || row.nextVerifications?.slice(0, 3) || [];
  const checkedText = [
    row.researchSummary?.summary,
    ...(row.whyWatch || []),
    ...nextPreview.map((item) => item.subject),
    row.marketContext?.modeLabel,
    row.marketContext?.modeDescription,
    row.marketContext?.disclaimer,
  ]
    .filter(Boolean)
    .join(" ");

  if (!row.profile?.role || row.profile.role === "观察对象") warnings.push("profile_role_is_generic");
  if (String(row.researchSummary?.summary || "").length > 90) warnings.push("summary_too_long");
  if ((row.whyWatch || []).length > 3) warnings.push("why_watch_over_3");
  if (nextPreview.length > 3) warnings.push("next_verification_preview_over_3");
  if (!row.marketContext?.mode || !row.marketContext?.modeDescription) warnings.push("market_mode_missing");
  if (readingBannedConclusionPattern.test(checkedText)) warnings.push("contains_conclusion_language");

  return {
    rank: index + 1,
    entityId: row.entityId,
    name: row.name,
    status: warnings.length ? "warning" : "pass",
    summaryLength: String(row.researchSummary?.summary || "").length,
    whyWatchCount: row.whyWatch?.length || 0,
    nextVerificationPreviewCount: nextPreview.length,
    marketMode: row.marketContext?.mode || null,
    warnings,
  };
}

const readingQaRows = researchReadingRows.slice(0, 10).map(readingQaRow);

const researchReading = {
  date: targetDate,
  generatedAt: today.generatedAt,
  contractType: "research_reading_flow_v1_1",
  policy: "Research Reading Flow organizes facts, evidence coverage, missing evidence, next verification and market context. It does not produce conclusions, benefit judgments, confidence scores or investment advice.",
  principles: [
    "The system organizes facts, not conclusions.",
    "The system supports research, not investment decisions.",
    "系统组织事实，不组织观点。",
    "系统支持研究，不替代投资决策。",
  ],
  systemStatus: {
    health: fetchRuns.some((run) => run.status === "failed") || schedulerRuns.some((run) => run.status === "failed" || run.status === "partial")
      ? "needs_check"
      : "normal",
    healthLabel: fetchRuns.some((run) => run.status === "failed") || schedulerRuns.some((run) => run.status === "failed" || run.status === "partial")
      ? "需检查"
      : "正常",
    pendingReview: claims.filter((claim) => claim.reviewStatus === "inbox" || claim.status === "candidate").length,
    dueReviewTasks: reviewCycle.summary.due || 0,
    generatedAt: today.generatedAt,
  },
  readingQa: {
    scope: "top_10_entities",
    checkedAt: today.generatedAt,
    checkedCount: readingQaRows.length,
    warningCount: readingQaRows.filter((row) => row.status === "warning").length,
    rows: readingQaRows,
  },
  rows: researchReadingRows,
};

const pendingClaims = claims.filter((claim) => claim.reviewStatus === "inbox" || claim.status === "candidate");
const fetchFailures = fetchRuns.filter((run) => run.status === "failed");
const fetchPartials = fetchRuns.filter((run) => run.status === "partial");
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
    status: fetchFailures.length
      ? "has_failures"
      : fetchPartials.length
        ? "has_gaps"
        : freshnessStatus(latestTime(fetchRuns.map((run) => run.finishedAt)), 72),
    count: fetchRuns.length,
    failedCount: fetchFailures.length,
    gapCount: fetchPartials.length,
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
  failedSources: [...fetchFailures, ...fetchPartials].map((run) => ({
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

const pipelineRunsByTaskId = new Map();
for (const run of pipelineRuns) pushMap(pipelineRunsByTaskId, run.pipelineTaskId, run);

const pipelineRows = pipelineTasks
  .slice()
  .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.id).localeCompare(String(b.id)))
  .map((task) => {
    const artifact = rawArtifactById.get(task.rawArtifactId);
    const route = routeDecisionById.get(task.routeDecisionId);
    const runs = (pipelineRunsByTaskId.get(task.id) || [])
      .slice()
      .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
    return {
      ...task,
      rawArtifact: artifact
        ? {
            id: artifact.id,
            title: artifact.title,
            artifactType: artifact.artifactType,
            publisher: artifact.publisher,
            url: artifact.url,
            firstSeenAt: artifact.firstSeenAt,
            capturedAt: artifact.capturedAt,
          }
        : null,
      routeDecision: route || null,
      runs,
      claims: (task.claimIds || []).map((claimId) => claimById.get(claimId)).filter(Boolean),
      evidence: (task.evidenceIds || []).map((evidenceId) => evidenceById.get(evidenceId)).filter(Boolean),
      ruleOutputs: (task.ruleOutputIds || []).map((ruleOutputId) => ruleOutputById.get(ruleOutputId)).filter(Boolean),
    };
  });

const pipelines = {
  date: targetDate,
  generatedAt: today.generatedAt,
  policy: "Pipelines turn routed tasks into claim/evidence candidates only. Review and promotion remain separate.",
  rows: pipelineRows,
  recentRuns: pipelineRuns
    .slice()
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)) || String(b.id).localeCompare(String(a.id)))
    .slice(0, 10),
  totals: {
    tasks: pipelineTasks.length,
    runs: pipelineRuns.length,
    ruleOutputs: ruleOutputs.length,
    queued: pipelineTasks.filter((task) => task.status === "queued").length,
    completed: pipelineTasks.filter((task) => task.status === "completed").length,
    failed: pipelineTasks.filter((task) => task.status === "failed").length,
    byPipeline: countBy(pipelineTasks, (task) => task.pipeline),
    byStatus: countBy(pipelineTasks, (task) => task.status),
  },
};

function materialTypeFor(artifact, source) {
  const artifactType = artifact.artifactType || "";
  const sourceType = source?.sourceType || "";
  if (artifactType === "filing" || sourceType === "filing" || sourceType === "exchange") return "公告/披露";
  if (artifactType === "product_page") return "产品材料";
  if (artifactType === "news_page" || sourceType === "news") return "官方新闻";
  if (artifactType === "market_quote") return "行情快照";
  if (artifactType === "serenity_output") return "Serenity 输出";
  if (artifactType === "pdf") return "PDF材料";
  if (artifactType === "wechat") return "公众号材料";
  if (artifactType === "video_transcript") return "视频文本";
  return "网页材料";
}

function materialBodyState(payload, artifact) {
  const body = payload?.content?.body;
  if (typeof body === "string" && body.trim().length >= 120) {
    return { status: "full_text", label: "已抓正文", textLength: body.trim().length };
  }
  if (typeof body === "string" && body.trim().length > 0) {
    return { status: "partial_text", label: "正文较短", textLength: body.trim().length };
  }
  if (payload?.content?.serenityBridge?.payload || artifact.artifactType === "market_quote") {
    return { status: "structured_payload", label: "结构化数据", textLength: 0 };
  }
  if (!payload) {
    return { status: "missing_payload", label: "缺原始载荷", textLength: 0 };
  }
  return { status: "metadata_only", label: "仅标题/元数据", textLength: 0 };
}

function materialPriority(artifact, claimsForArtifact) {
  const text = `${artifact.title || ""} ${claimsForArtifact.map((claim) => claim.text || "").join(" ")}`;
  if (/订单|客户|交付|合作|量产|产线|机器人|人形|具身|财报|年度报告|半年度|收入|专利|定增|募投/u.test(text)) {
    return "high";
  }
  if (/质押|担保|减持|会议|股东|董事|监事|分红|权益/u.test(text)) return "low";
  return "medium";
}

function materialGapForState(bodyState, artifact) {
  if (bodyState.status === "metadata_only") {
    return artifact.artifactType === "filing" ? "需要抓取/解析公告 PDF 正文" : "需要抓取网页正文";
  }
  if (bodyState.status === "missing_payload") return "需要补原始载荷";
  if (bodyState.status === "partial_text") return "需要复核正文是否完整";
  return null;
}

function materialRow(artifact) {
  const source = sourceById.get(artifact.sourceId) || null;
  const payload = rawPayloadById.get(artifact.id) || null;
  const routeDecision = routeDecisionByRawArtifactId.get(artifact.id) || null;
  const tasks = pipelineTasksByRawArtifactId.get(artifact.id) || [];
  const claimsForArtifact = claimsByRawArtifactId.get(artifact.id) || [];
  const evidenceForArtifact = evidenceByRawArtifactId.get(artifact.id) || [];
  const bodyState = materialBodyState(payload, artifact);
  const gap = materialGapForState(bodyState, artifact);
  return {
    id: `material_${artifact.id}`,
    rawArtifactId: artifact.id,
    sourceId: artifact.sourceId,
    fetchRunId: artifact.fetchRunId,
    entityIds: artifact.entityIds || [],
    entityNames: entityNames(artifact.entityIds || []),
    title: artifact.title,
    url: artifact.url,
    publisher: artifact.publisher,
    materialType: materialTypeFor(artifact, source),
    artifactType: artifact.artifactType,
    sourceType: source?.sourceType || null,
    sourceLevel: source?.evidenceLevel || null,
    publishedAt: artifact.publishedAt || null,
    capturedAt: artifact.capturedAt,
    firstSeenAt: artifact.firstSeenAt || null,
    bodyStatus: bodyState.status,
    bodyStatusLabel: bodyState.label,
    textLength: bodyState.textLength,
    priority: materialPriority(artifact, claimsForArtifact),
    route: routeDecision
      ? {
          id: routeDecision.id,
          type: routeDecision.type,
          pipeline: routeDecision.pipeline,
          status: routeDecision.status,
        }
      : null,
    pipelineTaskIds: tasks.map((task) => task.id),
    pipelineStatuses: Array.from(new Set(tasks.map((task) => task.status).filter(Boolean))),
    claimIds: claimsForArtifact.map((claim) => claim.id),
    pendingClaimCount: claimsForArtifact.filter((claim) => claim.status === "candidate" || claim.reviewStatus === "inbox").length,
    promotedClaimCount: claimsForArtifact.filter((claim) => (claim.promotedEventIds || []).length || (claim.promotedFollowupIds || []).length).length,
    evidenceIds: evidenceForArtifact.map((row) => row.id),
    evidenceRelations: Array.from(new Set(evidenceForArtifact.map((row) => row.relation).filter(Boolean))),
    dataGaps: [
      gap,
      ...claimsForArtifact.flatMap((claim) => (claim.dataGaps || []).map((item) => item.description || item.kind)),
    ]
      .filter(Boolean)
      .filter((item, index, rows) => rows.indexOf(item) === index)
      .slice(0, 5),
    nextAction:
      bodyState.status === "metadata_only"
        ? artifact.artifactType === "filing"
          ? "抓取并解析 PDF 正文"
          : "抓取网页正文"
        : claimsForArtifact.some((claim) => claim.status === "candidate" || claim.reviewStatus === "inbox")
          ? "人工审核候选事实"
          : "可供 Serenity 分析引用",
  };
}

const materialRows = rawArtifacts
  .map(materialRow)
  .sort((a, b) => String(b.publishedAt || b.capturedAt).localeCompare(String(a.publishedAt || a.capturedAt)) || a.title.localeCompare(b.title, "zh-Hans-CN"));

function materialEntitySummary(entity) {
  const rows = materialRows.filter((row) => row.entityIds.includes(entity.id));
  const byType = countBy(rows, (row) => row.materialType);
  const byBodyStatus = countBy(rows, (row) => row.bodyStatus);
  const highPriorityRows = rows.filter((row) => row.priority === "high");
  return {
    entityId: entity.id,
    name: entity.name,
    role: industryRole(entity),
    total: rows.length,
    highPriority: highPriorityRows.length,
    fullText: rows.filter((row) => row.bodyStatus === "full_text" || row.bodyStatus === "structured_payload").length,
    metadataOnly: rows.filter((row) => row.bodyStatus === "metadata_only").length,
    pendingClaims: rows.reduce((sum, row) => sum + row.pendingClaimCount, 0),
    byType,
    byBodyStatus,
    latestMaterialAt: latestTime(rows.map((row) => row.publishedAt || row.capturedAt)),
    topGaps: rows.flatMap((row) => row.dataGaps || []).slice(0, 5),
  };
}

const serenityMaterials = {
  date: targetDate,
  generatedAt: today.generatedAt,
  contractType: "serenity_research_materials_v0",
  policy:
    "Serenity Research Agent reads this material pool as inputs. Materials and candidate claims are not formal facts until reviewed and promoted.",
  rows: materialRows,
  entitySummaries: entities.map(materialEntitySummary).filter((row) => row.total > 0 || entityById.get(row.entityId)?.tags?.includes("Watchlist")),
  totals: {
    materials: materialRows.length,
    entitiesWithMaterials: new Set(materialRows.flatMap((row) => row.entityIds)).size,
    fullText: materialRows.filter((row) => row.bodyStatus === "full_text").length,
    structuredPayload: materialRows.filter((row) => row.bodyStatus === "structured_payload").length,
    metadataOnly: materialRows.filter((row) => row.bodyStatus === "metadata_only").length,
    missingPayload: materialRows.filter((row) => row.bodyStatus === "missing_payload").length,
    pendingClaims: materialRows.reduce((sum, row) => sum + row.pendingClaimCount, 0),
    byType: countBy(materialRows, (row) => row.materialType),
    byBodyStatus: countBy(materialRows, (row) => row.bodyStatus),
  },
};

const materialRowsByEntityId = new Map();
for (const row of materialRows) {
  for (const entityId of row.entityIds || []) pushMap(materialRowsByEntityId, entityId, row);
}

function materialReadabilityCounts(rows) {
  return {
    total: rows.length,
    readable: rows.filter((row) => ["full_text", "partial_text", "structured_payload"].includes(row.bodyStatus)).length,
    fullText: rows.filter((row) => row.bodyStatus === "full_text").length,
    structuredPayload: rows.filter((row) => row.bodyStatus === "structured_payload").length,
    metadataOnly: rows.filter((row) => row.bodyStatus === "metadata_only").length,
    missingPayload: rows.filter((row) => row.bodyStatus === "missing_payload").length,
    pendingClaims: rows.reduce((sum, row) => sum + (row.pendingClaimCount || 0), 0),
    promotedClaims: rows.reduce((sum, row) => sum + (row.promotedClaimCount || 0), 0),
  };
}

function materialAnalysisScore(row) {
  const priorityScore = { high: 30, medium: 15, low: 0 }[row.priority] || 0;
  const bodyScore = {
    full_text: 30,
    structured_payload: 24,
    partial_text: 18,
    metadata_only: 2,
    missing_payload: 0,
  }[row.bodyStatus] || 0;
  const sourceScore = { A: 18, B: 12, C: 6, D: 2 }[row.sourceLevel] || 0;
  return priorityScore + bodyScore + sourceScore + (row.pendingClaimCount || 0);
}

function compactMaterialForAnalysis(row) {
  return {
    rawArtifactId: row.rawArtifactId,
    title: row.title,
    materialType: row.materialType,
    sourceLevel: row.sourceLevel || null,
    publisher: row.publisher || null,
    publishedAt: row.publishedAt,
    capturedAt: row.capturedAt,
    url: row.url,
    bodyStatus: row.bodyStatus,
    bodyStatusLabel: row.bodyStatusLabel,
    textLength: row.textLength,
    priority: row.priority,
    claimIds: (row.claimIds || []).slice(0, 5),
    evidenceIds: (row.evidenceIds || []).slice(0, 5),
    dataGaps: (row.dataGaps || []).slice(0, 3),
    nextAction: row.nextAction,
  };
}

function serenityAnalysisStatus(counts) {
  if (!counts.total) {
    return {
      key: "needs_materials",
      label: "缺研究材料",
      reason: "当前对象还没有进入 Serenity 材料池。",
    };
  }
  if (!counts.readable) {
    return {
      key: "needs_body_fetch",
      label: "需补正文",
      reason: "当前只有标题或元数据，需先抓取正文再进入分析。",
    };
  }
  return {
    key: "ready_for_serenity",
    label: "可进入分析",
    reason: "已有可读材料；Serenity 输出仍需单独生成并引用来源。",
  };
}

function analysisNextQuestions(readingRow, rows) {
  const questions = [];
  for (const item of readingRow.nextVerificationPreview || []) {
    addUnique(questions, item.subject || item.description || item.title);
  }
  for (const gap of rows.flatMap((row) => row.dataGaps || [])) {
    addUnique(questions, gap);
  }
  if (!questions.length && rows.some((row) => row.pendingClaimCount > 0)) {
    questions.push("复核候选事实的来源、时间和实体归属。");
  }
  if (!questions.length) questions.push("等待新的公开材料进入材料池。");
  return questions.filter(Boolean).slice(0, 5);
}

function materialStateSentence(counts) {
  if (!counts.total) return "当前没有可供 Serenity 阅读的材料。";
  return `材料池 ${counts.total} 条，其中 ${counts.readable} 条可读，${counts.pendingClaims} 条候选 Claim 待审。`;
}

const latestSerenityOutputByEntityId = new Map();
for (const output of serenityAnalysisOutputRows
  .slice()
  .sort((a, b) => String(b.generatedAt || "").localeCompare(String(a.generatedAt || "")))) {
  if (!output.entityId || latestSerenityOutputByEntityId.has(output.entityId)) continue;
  latestSerenityOutputByEntityId.set(output.entityId, output);
}

function serenityAnalysisRow(readingRow) {
  const rows = (materialRowsByEntityId.get(readingRow.entityId) || [])
    .slice()
    .sort(
      (a, b) =>
        materialAnalysisScore(b) - materialAnalysisScore(a) ||
        String(b.publishedAt || b.capturedAt).localeCompare(String(a.publishedAt || a.capturedAt))
    );
  const counts = materialReadabilityCounts(rows);
  const status = serenityAnalysisStatus(counts);
  const generatedOutput = latestSerenityOutputByEntityId.get(readingRow.entityId) || null;
  const topMaterialRefs = rows.slice(0, 8).map(compactMaterialForAnalysis);
  const timelineRefs = (readingRow.timeline || [])
    .filter((item) => item.lane !== "market")
    .slice(0, 6)
    .map((item) => ({
      id: item.id,
      date: item.date,
      lane: item.lane,
      title: item.title,
      changeType: item.changeType,
      verificationState: item.verificationState,
      evidenceLevel: item.evidenceSummary?.level || item.evidenceLevel || null,
      sourceIds: (item.sources || []).map((source) => source.id).filter(Boolean).slice(0, 4),
      evidenceIds: (item.evidence || []).map((evidence) => evidence.id).filter(Boolean).slice(0, 4),
    }));

  return {
    entityId: readingRow.entityId,
    name: readingRow.name,
    generatedAt: today.generatedAt,
    contractType: "serenity_analysis_input_v0",
    analysisStatus: status,
    inputPack: {
      materialCounts: counts,
      topMaterialRefs,
      factInputs: {
        profile: readingRow.profile,
        researchSummary: readingRow.researchSummary,
        whyWatch: readingRow.whyWatch || [],
        evidenceCoverageDetails: readingRow.evidenceCoverageDetails || [],
        timelineRefs,
        marketContext: {
          mode: readingRow.marketContext?.mode,
          modeLabel: readingRow.marketContext?.modeLabel,
          disclaimer: readingRow.marketContext?.disclaimer,
        },
      },
      candidateLayer: {
        pendingClaimCount: counts.pendingClaims,
        claimIds: Array.from(new Set(rows.flatMap((row) => row.claimIds || []))).slice(0, 20),
        note: "Candidate claims are not formal facts until review and promotion.",
      },
    },
    analysisDraft: {
      status: "projection_note",
      label: "投影说明",
      text: `${materialStateSentence(counts)}当前摘要、证据覆盖和缺口来自 Research Reading 投影；这不是 Serenity 本体结论。`,
      sourceLayer: ["research_reading", "serenity_materials"],
    },
    serenityOutput: {
      status: generatedOutput ? "generated" : "not_generated",
      outputId: generatedOutput?.id || null,
      generatedAt: generatedOutput?.generatedAt || null,
      provider: generatedOutput?.provider || null,
      storagePath: generatedOutput?.storagePath || null,
      summary: generatedOutput?.display?.summary || null,
      reason: generatedOutput ? null : "等待 Serenity 本体基于 inputPack 输出可引用分析。",
      requiredBeforeDisplay: ["引用输入材料", "标注事实/线索/推断", "不得输出买卖建议或受益判断"],
    },
    forecastLedger: {
      status: "not_generated",
      reason: "预测需要单独创建 forecast、resolution criteria 和复盘时间。",
    },
    missingEvidence: Array.from(
      new Set([...(readingRow.researchSummary?.missingEvidence || []), ...rows.flatMap((row) => row.dataGaps || [])])
    ).slice(0, 8),
    nextQuestions: analysisNextQuestions(readingRow, rows),
    guardrails: [
      "不输出买卖建议。",
      "不输出受益判断。",
      "不把市场涨跌解释成事件影响。",
      "不把候选线索当成已验证事实。",
      "每条分析必须能回溯到 material、claim、evidence、source 和时间。",
    ],
    sort: {
      materialScore: rows.reduce((sum, row) => sum + materialAnalysisScore(row), 0),
      readableMaterials: counts.readable,
      pendingClaims: counts.pendingClaims,
      latestMaterialAt: latestTime(rows.map((row) => row.publishedAt || row.capturedAt)),
    },
  };
}

const serenityAnalysisRows = researchReadingRows
  .map(serenityAnalysisRow)
  .sort(
    (a, b) =>
      b.sort.readableMaterials - a.sort.readableMaterials ||
      b.sort.pendingClaims - a.sort.pendingClaims ||
      b.sort.materialScore - a.sort.materialScore ||
      String(b.sort.latestMaterialAt || "").localeCompare(String(a.sort.latestMaterialAt || "")) ||
      String(a.name).localeCompare(String(b.name), "zh-Hans-CN")
  );

const serenityAnalysis = {
  date: targetDate,
  generatedAt: today.generatedAt,
  contractType: "serenity_analysis_layer_v0",
  policy:
    "Serenity Analysis Layer prepares source-linked input packs for the Research Agent. Projection notes are not Serenity conclusions, forecasts or investment advice.",
  rows: serenityAnalysisRows,
  totals: {
    rows: serenityAnalysisRows.length,
    readyForSerenity: serenityAnalysisRows.filter((row) => row.analysisStatus.key === "ready_for_serenity").length,
    needsBodyFetch: serenityAnalysisRows.filter((row) => row.analysisStatus.key === "needs_body_fetch").length,
    needsMaterials: serenityAnalysisRows.filter((row) => row.analysisStatus.key === "needs_materials").length,
    serenityOutputsGenerated: serenityAnalysisOutputRows.filter((row) => row.status === "serenity_ai_review").length,
    forecastLedgersGenerated: serenityAnalysisRows.filter((row) => row.forecastLedger.status === "generated").length,
    inputMaterials: serenityMaterials.totals.materials,
    readableMaterials: (serenityMaterials.totals.fullText || 0) + (serenityMaterials.totals.structuredPayload || 0),
    pendingClaims: serenityMaterials.totals.pendingClaims,
  },
};

const serenityOutputs = {
  date: targetDate,
  generatedAt: today.generatedAt,
  contractType: "serenity_analysis_outputs_index_v0",
  policy:
    "Serenity outputs are analysis-layer artifacts. They may cite facts, candidates and materials, but they do not create formal facts without review.",
  rows: serenityAnalysisOutputRows
    .slice()
    .sort(
      (a, b) =>
        Number(Boolean(b.provider?.externalCall)) - Number(Boolean(a.provider?.externalCall)) ||
        String(b.generatedAt || "").localeCompare(String(a.generatedAt || ""))
    )
    .map((output) => {
      const quoteProjection = projectSerenityQuotes(output, marketByEntityId.get(output.entityId), targetDate);
      return {
        id: output.id,
        entityId: output.entityId,
        name: output.name,
        generatedAt: output.generatedAt,
        status: output.status,
        provider: output.provider,
        storagePath: output.storagePath,
        display: output.display,
        ...quoteProjection,
        scorecardSummary: output.rawArtifacts?.scorecard
          ? {
              thesis_quality_score: output.rawArtifacts.scorecard.thesis_quality_score ?? null,
              evidence_confidence_score: output.rawArtifacts.scorecard.evidence_confidence_score ?? null,
              market_payoff_score: output.rawArtifacts.scorecard.market_payoff_score ?? null,
              technical_timing_score: output.rawArtifacts.scorecard.technical_timing_score ?? null,
              data_readiness_score: output.rawArtifacts.scorecard.data_readiness_score ?? null,
              action_readiness_score: output.rawArtifacts.scorecard.action_readiness_score ?? null,
              module_results: output.rawArtifacts.scorecard.module_results || null,
              evidence_notes: output.rawArtifacts.scorecard.evidence_notes || [],
              decision_blockers: output.rawArtifacts.scorecard.decision_blockers || [],
              falsification_points: output.rawArtifacts.scorecard.falsification_points || [],
            }
          : null,
        inputRefs: {
          materialCount: output.inputRefs?.materialRawArtifactIds?.length || 0,
          claimCount: output.inputRefs?.claimIds?.length || 0,
          evidenceCount: output.inputRefs?.evidenceIds?.length || 0,
          sourceCount: output.inputRefs?.sourceIds?.length || 0,
        },
        layerCounts: {
          factNotes: output.layers?.factNotes?.length || 0,
          candidateSignals: output.layers?.candidateSignals?.length || 0,
          analysisNotes: output.layers?.analysisNotes?.length || 0,
          evidenceGaps: output.layers?.evidenceGaps?.length || 0,
          nextVerificationQuestions: output.layers?.nextVerificationQuestions?.length || 0,
          forecastCandidates: output.layers?.forecastCandidates?.length || 0,
        },
        guardrails: output.guardrails || [],
      };
    }),
  totals: {
    outputs: serenityAnalysisOutputRows.length,
    entitiesWithOutputs: new Set(serenityAnalysisOutputRows.map((row) => row.entityId).filter(Boolean)).size,
    researchBriefs: serenityAnalysisOutputRows.filter((row) => row.status === "research_brief").length,
    generatedDraft: serenityAnalysisOutputRows.filter((row) => row.status === "generated_draft").length,
    externalProviderOutputs: serenityAnalysisOutputRows.filter(
      (row) => row.status === "serenity_ai_review" && row.provider?.externalCall
    ).length,
    forecastCandidates: serenityAnalysisOutputRows.reduce(
      (sum, row) => sum + (row.layers?.forecastCandidates?.length || 0),
      0
    ),
  },
};

for (const row of serenityOutputs.rows) {
  assertSerenityQuoteProjection(row, marketByEntityId.get(row.entityId));
}

const serenityJudgments = {
  date: targetDate,
  generatedAt: today.generatedAt,
  contractType: "serenity_judgment_history_index_v0",
  rows: serenityJudgmentHistories
    .map((history) => {
      const snapshots = (history.snapshots || []).slice().sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return {
        entityId: history.entityId,
        name: history.name,
        updatedAt: history.updatedAt,
        latest: snapshots.at(-1) || null,
        snapshots,
      };
    })
    .filter((row) => row.latest)
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-Hans-CN")),
};

const serenityFetchRuns = fetchRuns.filter((run) => run.fetcher === "serenity_bridge_v0");
const serenityArtifactIdSet = new Set(serenityFetchRuns.flatMap((run) => run.artifactIds || []));
const serenityRawArtifacts = rawArtifacts.filter((artifact) => serenityArtifactIdSet.has(artifact.id));
const serenityClaimRows = claims.filter((claim) =>
  (claim.artifactIds || []).some((artifactId) => serenityArtifactIdSet.has(artifactId))
);
const serenityStockRows = stockRows.filter((stock) =>
  (stock.sourceIds || []).some((sourceId) => String(sourceId).startsWith("src_serenity_"))
);
const serenityBridge = {
  date: targetDate,
  generatedAt: today.generatedAt,
  policy: "Serenity Bridge only imports evidence-bearing datasets. Rating, valuation, portfolio, buy-point and sizing outputs are excluded.",
  acceptedDatasets: Object.keys(serenityDatasetMap.datasets || {}),
  excludedDatasets: serenityDatasetMap.blockedDatasets || [],
  rows: serenityFetchRuns
    .slice()
    .sort((a, b) => String(b.finishedAt).localeCompare(String(a.finishedAt)) || String(a.id).localeCompare(String(b.id)))
    .map((run) => ({
      id: run.id,
      sourceName: run.sourceName,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      artifactIds: run.artifactIds || [],
      claimIds: run.claimIds || [],
      gaps: run.gaps || [],
      attempts: run.attemptLedger || [],
      rawArtifacts: (run.artifactIds || [])
        .map((artifactId) => rawArtifactById.get(artifactId))
        .filter(Boolean)
        .map((artifact) => ({
          id: artifact.id,
          title: artifact.title,
          artifactType: artifact.artifactType,
          publisher: artifact.publisher,
          url: artifact.url,
          publishedAt: artifact.publishedAt || null,
          capturedAt: artifact.capturedAt,
          routeDecision: routeDecisions.find((route) => route.rawArtifactId === artifact.id) || null,
        })),
    })),
  stockSnapshots: serenityStockRows.map((stock) => ({
    id: stock.id,
    date: stock.date,
    time: stock.time || null,
    entityId: stock.entityId,
    company: entityById.get(stock.entityId)?.name || stock.entityId,
    stockCode: stock.stockCode,
    market: stock.market,
    price: stock.price ?? stock.close ?? null,
    changePct: stock.changePct ?? null,
    capturedAt: stock.capturedAt,
    quoteTime: stock.quoteTime || null,
    sources: enrichSources(stock.sourceIds),
  })),
  claimCandidates: serenityClaimRows.map((claim) => ({
    id: claim.id,
    claimType: claim.claimType,
    text: claim.text,
    status: claim.status,
    reviewStatus: claim.reviewStatus,
    confidence: claim.confidence,
    artifactIds: claim.artifactIds,
    evidence: (evidenceByClaimId.get(claim.id) || []).map((row) => ({
      id: row.id,
      relation: row.relation,
      sourceLevel: row.sourceLevel,
      strength: row.strength,
      source: sourceById.get(row.sourceId) || null,
    })),
  })),
  dataGaps: serenityFetchRuns.flatMap((run) =>
    (run.gaps || []).map((gap) => ({
      fetchRunId: run.id,
      sourceName: run.sourceName,
      ...gap,
    }))
  ),
  totals: {
    fetchRuns: serenityFetchRuns.length,
    rawArtifacts: serenityRawArtifacts.length,
    stockSnapshots: serenityStockRows.length,
    claimCandidates: serenityClaimRows.length,
    dataGaps: serenityFetchRuns.reduce((total, run) => total + (run.gaps?.length || 0), 0),
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
      sector: sectorOf(entity),
      sectorLabel: sectorLabelOf(entity),
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
  pipelineRuns: pipelineRuns.length,
  ruleOutputs: ruleOutputs.length,
  observationRuns: observationRuns.length,
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

const serenityOutputIndex = projectSerenityOutputIndex(serenityOutputs);
const serenityOutputDetailsDir = path.join(
  DATA_DIR,
  "dashboard",
  "serenity_output_details"
);
const serenityJudgmentIndex = projectSerenityJudgmentIndex(serenityJudgments);
const serenityJudgmentDetailsDir = path.join(
  DATA_DIR,
  "dashboard",
  "serenity_judgment_details"
);

await fs.rm(serenityOutputDetailsDir, { recursive: true, force: true });
await fs.rm(serenityJudgmentDetailsDir, { recursive: true, force: true });
await writeJsonFile(path.join(DATA_DIR, "dashboard", "today.json"), today);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "events.json"), eventDashboard);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "observations.json"), observationsDashboard);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "change_wall.json"), changeWall);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "research_reading.json"), researchReading);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "entity_profiles.json"), entityProfiles);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "market_contexts.json"), marketContexts);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "data_acquisition_matrix.json"), dataAcquisitionMatrix);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "candidate_funnel.json"), candidateFunnel);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "research_gates.json"), researchGates);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "review_cycle.json"), reviewCycle);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "companies.json"), companiesDashboard);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "gaps.json"), gapsDashboard);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "freshness.json"), freshness);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "router.json"), router);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "ingestion.json"), ingestion);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "pipelines.json"), pipelines);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "serenity_materials.json"), serenityMaterials);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "serenity_analysis.json"), serenityAnalysis);
await writeJsonFile(path.join(DATA_DIR, "dashboard", "serenity_outputs.json"), serenityOutputs);
await writeJsonFile(
  path.join(DATA_DIR, "dashboard", "serenity_output_index.json"),
  serenityOutputIndex
);
for (const row of serenityOutputs.rows || []) {
  await writeJsonFile(
    path.join(serenityOutputDetailsDir, serenityDetailFileName(row.entityId)),
    row
  );
}
await writeJsonFile(path.join(DATA_DIR, "dashboard", "serenity_judgments.json"), serenityJudgments);
await writeJsonFile(
  path.join(DATA_DIR, "dashboard", "serenity_judgment_index.json"),
  serenityJudgmentIndex
);
for (const history of serenityJudgments.rows || []) {
  await writeJsonFile(
    path.join(
      serenityJudgmentDetailsDir,
      serenityJudgmentDetailFileName(history.entityId)
    ),
    history
  );
}
await writeJsonFile(path.join(DATA_DIR, "dashboard", "serenity_bridge.json"), serenityBridge);
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
