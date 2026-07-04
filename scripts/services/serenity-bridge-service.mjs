import fs from "node:fs/promises";
import path from "node:path";
import {
  DATA_DIR,
  readJsonDir,
  readJsonFile,
  writeJsonFile,
} from "../data-utils.mjs";
import {
  contentHashForPayload,
  rawPayloadFilePath,
  rawPayloadStoragePath,
} from "./artifact-payload-service.mjs";
import {
  dateFrom,
  hash,
  loadRouterContext,
  nowShanghai,
  routeArtifact,
  writeRouteDecision,
} from "./router-service.mjs";
import { runPipelineTasks } from "./pipeline-service.mjs";

const DATASET_MAP_PATH = path.join(DATA_DIR, "serenity_bridge", "dataset_map.json");

export async function runSerenityBridge(options = {}) {
  if (!options.manifestPath) {
    throw new Error("Missing required option: manifestPath");
  }

  const manifestPath = path.resolve(options.manifestPath);
  const manifestDir = path.dirname(manifestPath);
  const baseDir = options.baseDir ? path.resolve(options.baseDir) : manifestDir;
  const capturedAt = options.capturedAt || nowShanghai();
  const manifest = await readJsonFile(manifestPath);
  const datasetMap = await readJsonFile(DATASET_MAP_PATH);
  const entitiesIndex = await readJsonFile(path.join(DATA_DIR, "entities", "index.json"));
  const entity = resolveEntity(manifest, entitiesIndex.entities || [], options.entityId);
  const routerContext = await loadRouterContext();
  const existingTaskByRouteId = await readPipelineTaskByRouteId();
  const existingRawArtifactById = await readRawArtifactById();
  const retrievedAt = normalizeDateTime(manifest.retrieved_at) || capturedAt;
  const symbolInfo = manifest.symbol || {};
  const stockCode = stockCodeFromSymbol(symbolInfo.symbol || symbolInfo.input_value || entity.stockCode);
  const symbol = symbolInfo.symbol || stockCode;
  const blockedDatasets = new Set(datasetMap.blockedDatasets || []);
  const dataGaps = normalizeSerenityGaps(manifest.data_acquisition?.data_gaps || [], datasetMap);
  const artifacts = [];
  const fetchRuns = [];
  const sources = [];
  const rawPayloads = [];
  const routes = [];
  const pipelineTasks = [];
  const stockSnapshots = [];
  const skipped = [];

  for (const result of manifest.results || []) {
    const dataset = result.dataset;
    if (blockedDatasets.has(dataset)) {
      skipped.push({
        dataset,
        status: "blocked",
        reason: "Dataset belongs to Serenity decision/valuation layer and is excluded by Bridge policy.",
      });
      continue;
    }

    const datasetConfig = datasetMap.datasets?.[dataset];
    if (!datasetConfig) {
      skipped.push({
        dataset,
        status: "unsupported",
        reason: "Dataset is not mapped in data/serenity_bridge/dataset_map.json.",
      });
      continue;
    }

    const payload = result.data_path
      ? await readJsonFile(await resolveDataPath(result.data_path, { manifestDir, baseDir }))
      : null;
    const datasetGaps = dataGaps.filter((gap) => gap.dataset === dataset);
    const source = buildSource({
      dataset,
      datasetConfig,
      entity,
      result,
      manifest,
      stockCode,
      capturedAt,
      retrievedAt,
      datasetMap,
    });
    sources.push(source);

    if (datasetConfig.mode === "stock_snapshot") {
      const row = buildQuoteBundle({
        dataset,
        datasetConfig,
        entity,
        source,
        result,
        manifest,
        payload,
        stockCode,
        symbol,
        capturedAt,
        retrievedAt,
        datasetGaps,
        routerContext,
        existingRawArtifactById,
      });
      rawPayloads.push(row.rawPayload);
      artifacts.push(row.rawArtifact);
      fetchRuns.push(row.fetchRun);
      routes.push(row.routeDecision);
      stockSnapshots.push(row.stockSnapshot);
      continue;
    }

    if (datasetConfig.mode === "filing_claims") {
      const rows = buildAnnouncementBundles({
        dataset,
        datasetConfig,
        entity,
        source,
        result,
        manifest,
        payload,
        stockCode,
        capturedAt,
        retrievedAt,
        datasetGaps,
        routerContext,
        existingTaskByRouteId,
        existingRawArtifactById,
      });
      rawPayloads.push(...rows.rawPayloads);
      artifacts.push(...rows.rawArtifacts);
      fetchRuns.push(rows.fetchRun);
      routes.push(...rows.routeDecisions);
      pipelineTasks.push(...rows.pipelineTasks);
      continue;
    }

    if (datasetConfig.mode === "financial_claim") {
      const row = buildFinancialBundle({
        dataset,
        datasetConfig,
        entity,
        source,
        result,
        manifest,
        payload,
        stockCode,
        capturedAt,
        retrievedAt,
        datasetGaps,
        routerContext,
        existingTaskByRouteId,
        existingRawArtifactById,
      });
      rawPayloads.push(row.rawPayload);
      artifacts.push(row.rawArtifact);
      fetchRuns.push(row.fetchRun);
      routes.push(row.routeDecision);
      pipelineTasks.push(row.pipelineTask);
      continue;
    }

    skipped.push({
      dataset,
      status: "not_implemented",
      reason: `Dataset mode ${datasetConfig.mode} is declared but not implemented in Bridge v0.`,
    });
  }

  const payload = {
    manifestPath,
    baseDir,
    capturedAt,
    retrievedAt,
    entityId: entity.id,
    symbol,
    sources,
    rawPayloads,
    rawArtifacts: artifacts,
    fetchRuns,
    routeDecisions: routes,
    pipelineTasks,
    stockSnapshots,
    dataGaps,
    skipped,
  };

  if (options.dryRun) {
    return {
      ...payload,
      pipelineResult: null,
      summary: bridgeSummary(payload, null),
    };
  }

  for (const source of sources) {
    await writeJsonFile(path.join(DATA_DIR, "sources", `${source.id}.json`), source);
  }
  for (const row of rawPayloads) {
    await writeJsonFile(rawPayloadFilePath(row.id), row);
  }
  for (const artifact of artifacts) {
    await writeJsonFile(path.join(DATA_DIR, "raw_artifacts", `${artifact.id}.json`), artifact);
  }
  for (const run of fetchRuns) {
    const existing = await readOrDefault(path.join(DATA_DIR, "fetch_runs", `${run.id}.json`), null);
    await writeJsonFile(path.join(DATA_DIR, "fetch_runs", `${run.id}.json`), {
      ...run,
      claimIds: existing?.claimIds || run.claimIds,
    });
  }
  for (const routeDecision of routes) {
    await writeRouteDecision(routeDecision);
  }
  for (const task of pipelineTasks.filter(Boolean)) {
    await writeJsonFile(path.join(DATA_DIR, "pipeline_tasks", `${task.id}.json`), task);
  }
  for (const snapshot of stockSnapshots) {
    await writeJsonFile(path.join(DATA_DIR, "stocks", `${snapshot.id}.json`), snapshot);
  }

  let pipelineResult = null;
  if (options.runPipeline) {
    const results = [];
    for (const task of pipelineTasks.filter((row) => row && row.status === "queued")) {
      results.push(
        await runPipelineTasks({
          taskId: task.id,
          now: options.pipelineAt || capturedAt,
          force: Boolean(options.forcePipeline),
        })
      );
    }
    pipelineResult = {
      runs: results,
      completed: results.reduce((total, row) => total + row.successCount, 0),
      skipped: results.reduce((total, row) => total + row.skippedCount, 0),
      failed: results.reduce((total, row) => total + row.failureCount, 0),
    };
  }

  return {
    ...payload,
    pipelineResult,
    summary: bridgeSummary(payload, pipelineResult),
  };
}

function buildQuoteBundle({
  dataset,
  datasetConfig,
  entity,
  source,
  result,
  manifest,
  payload,
  stockCode,
  symbol,
  capturedAt,
  retrievedAt,
  datasetGaps,
  routerContext,
  existingRawArtifactById,
}) {
  const sourceUrl = quoteUrl(symbol, stockCode);
  const title = `${entity.name} ${stockCode} Serenity 行情快照`;
  const artifactId = rawId(retrievedAt, `serenity_${stockCode}_${dataset}`);
  const fetchRunId = fetchId(retrievedAt, `serenity_${stockCode}_${dataset}`);
  const rawPayload = buildSerenityRawPayload({
    artifactId,
    dataset,
    mode: datasetConfig.mode,
    title,
    publisher: source.publisher,
    url: sourceUrl,
    sourceType: source.sourceType,
    artifactType: datasetConfig.artifactType,
    entityIds: [entity.id],
    entityName: entity.name,
    publishedAt: retrievedAt,
    capturedAt,
    retrievedAt,
    result,
    manifest,
    payload,
  });
  const contentHash = contentHashForPayload(rawPayload);
  const existingArtifact = existingRawArtifactById.get(artifactId);
  const rawArtifact = {
    id: artifactId,
    artifactType: datasetConfig.artifactType,
    title,
    publisher: source.publisher,
    url: sourceUrl,
    sourceId: source.id,
    fetchRunId,
    publishedAt: retrievedAt,
    firstSeenAt: existingArtifact?.firstSeenAt || capturedAt,
    capturedAt,
    contentHash,
    storagePath: rawPayloadStoragePath(artifactId),
    entityIds: [entity.id],
    claimIds: existingArtifact?.claimIds || [],
    status: "active",
    notes: "Serenity Bridge v0 market quote artifact. It feeds stock snapshot only, not claim promotion.",
  };
  const routeDecision = routeArtifact(rawArtifact, routerContext, { createdAt: capturedAt });
  const fetchRun = buildFetchRun({
    id: fetchRunId,
    dataset,
    source,
    result,
    artifactIds: [artifactId],
    capturedAt,
    retrievedAt,
    status: statusForResult(result, datasetGaps, payload),
    gaps: datasetGaps,
    url: sourceUrl,
    contentHash,
    storagePath: rawPayloadStoragePath(artifactId),
  });
  const stockSnapshot = buildStockSnapshot({
    entity,
    source,
    payload,
    stockCode,
    symbol,
    capturedAt,
    retrievedAt,
  });
  return { rawPayload, rawArtifact, fetchRun, routeDecision, stockSnapshot };
}

function buildAnnouncementBundles({
  dataset,
  datasetConfig,
  entity,
  source,
  result,
  manifest,
  payload,
  stockCode,
  capturedAt,
  retrievedAt,
  datasetGaps,
  routerContext,
  existingTaskByRouteId,
  existingRawArtifactById,
}) {
  const announcements = Array.isArray(payload?.recent_announcements) ? payload.recent_announcements : [];
  const fetchRunId = fetchId(retrievedAt, `serenity_${stockCode}_${dataset}`);
  const rawPayloads = [];
  const rawArtifacts = [];
  const routeDecisions = [];
  const pipelineTasks = [];

  for (const item of announcements) {
    const publishedAt = item.announcement_date || retrievedAt;
    const itemToken = `serenity_${stockCode}_filing_${slug(item.title).slice(0, 28)}_${hash(item.pdf_url || item.title, 8)}`;
    const artifactId = rawId(publishedAt, itemToken);
    const title = item.title || `${entity.name} 公告`;
    const url = item.pdf_url || filingSearchUrl(stockCode);
    const rawPayload = buildSerenityRawPayload({
      artifactId,
      dataset,
      mode: datasetConfig.mode,
      title,
      publisher: source.publisher,
      url,
      sourceType: source.sourceType,
      artifactType: datasetConfig.artifactType,
      entityIds: [entity.id],
      entityName: entity.name,
      publishedAt,
      capturedAt,
      retrievedAt,
      result,
      manifest,
      payload: item,
    });
    const contentHash = contentHashForPayload(rawPayload);
    const existingArtifact = existingRawArtifactById.get(artifactId);
    const rawArtifact = {
      id: artifactId,
      artifactType: datasetConfig.artifactType,
      title,
      publisher: source.publisher,
      url,
      sourceId: source.id,
      fetchRunId,
      publishedAt,
      firstSeenAt: existingArtifact?.firstSeenAt || capturedAt,
      capturedAt,
      contentHash,
      storagePath: rawPayloadStoragePath(artifactId),
      entityIds: [entity.id],
      claimIds: existingArtifact?.claimIds || [],
      status: "active",
      notes: "Serenity Bridge v0 CNINFO announcement artifact. Candidate claim must stay in inbox until review.",
    };
    const routeDecision = routeArtifact(rawArtifact, routerContext, { createdAt: capturedAt });
    rawPayloads.push(rawPayload);
    rawArtifacts.push(rawArtifact);
    routeDecisions.push(routeDecision);
    if (datasetConfig.enqueuePipeline && routeDecision.status === "routed") {
      pipelineTasks.push(existingTaskByRouteId.get(routeDecision.id) || buildPipelineTask(routeDecision, rawArtifact, capturedAt));
    }
  }

  const fetchRun = buildFetchRun({
    id: fetchRunId,
    dataset,
    source,
    result,
    artifactIds: rawArtifacts.map((row) => row.id),
    capturedAt,
    retrievedAt,
    status: statusForResult(result, datasetGaps, payload),
    gaps: datasetGaps,
    url: filingSearchUrl(stockCode),
    contentHash: hash(JSON.stringify(payload || {}), 16),
    storagePath: `serenity:${dataset}`,
  });

  return { rawPayloads, rawArtifacts, fetchRun, routeDecisions, pipelineTasks };
}

function buildFinancialBundle({
  dataset,
  datasetConfig,
  entity,
  source,
  result,
  manifest,
  payload,
  stockCode,
  capturedAt,
  retrievedAt,
  datasetGaps,
  routerContext,
  existingTaskByRouteId,
  existingRawArtifactById,
}) {
  const latestPeriod = latestFinancialPeriod(payload?.periods || []);
  if (!latestPeriod) {
    throw new Error(`Serenity financials payload for ${stockCode} has no periods`);
  }
  const publishedAt = latestPeriod.period || retrievedAt;
  const title = `${entity.name} ${latestPeriod.period} ${latestPeriod.report_type || "财报"}结构化财务数据`;
  const artifactId = rawId(publishedAt, `serenity_${stockCode}_financials_${latestPeriod.period || "latest"}`);
  const fetchRunId = fetchId(retrievedAt, `serenity_${stockCode}_${dataset}`);
  const url = financialsUrl(stockCode, entity.market);
  const rawPayload = buildSerenityRawPayload({
    artifactId,
    dataset,
    mode: datasetConfig.mode,
    title,
    publisher: source.publisher,
    url,
    sourceType: source.sourceType,
    artifactType: datasetConfig.artifactType,
    entityIds: [entity.id],
    entityName: entity.name,
    publishedAt,
    capturedAt,
    retrievedAt,
    result,
    manifest,
    payload: {
      ...payload,
      latestPeriod,
    },
  });
  const contentHash = contentHashForPayload(rawPayload);
  const existingArtifact = existingRawArtifactById.get(artifactId);
  const rawArtifact = {
    id: artifactId,
    artifactType: datasetConfig.artifactType,
    title,
    publisher: source.publisher,
    url,
    sourceId: source.id,
    fetchRunId,
    publishedAt,
    firstSeenAt: existingArtifact?.firstSeenAt || capturedAt,
    capturedAt,
    contentHash,
    storagePath: rawPayloadStoragePath(artifactId),
    entityIds: [entity.id],
    claimIds: existingArtifact?.claimIds || [],
    status: "active",
    notes: "Serenity Bridge v0 structured financial artifact. L3 financial data remains a candidate until L0/L1 review.",
  };
  const routeDecision = routeArtifact(rawArtifact, routerContext, { createdAt: capturedAt });
  const pipelineTask =
    datasetConfig.enqueuePipeline && routeDecision.status === "routed"
      ? existingTaskByRouteId.get(routeDecision.id) || buildPipelineTask(routeDecision, rawArtifact, capturedAt)
      : null;
  const fetchRun = buildFetchRun({
    id: fetchRunId,
    dataset,
    source,
    result,
    artifactIds: [artifactId],
    capturedAt,
    retrievedAt,
    status: statusForResult(result, datasetGaps, payload),
    gaps: datasetGaps,
    url,
    contentHash,
    storagePath: rawPayloadStoragePath(artifactId),
  });
  return { rawPayload, rawArtifact, fetchRun, routeDecision, pipelineTask };
}

function buildSerenityRawPayload({
  artifactId,
  dataset,
  mode,
  title,
  publisher,
  url,
  sourceType,
  artifactType,
  entityIds,
  entityName,
  publishedAt,
  capturedAt,
  retrievedAt,
  result,
  manifest,
  payload,
}) {
  return {
    id: artifactId,
    capturedAt,
    retrievalStatus: "captured_payload",
    content: {
      inputType: "api",
      url,
      title,
      publisher,
      publishedAt: publishedAt || null,
      sourceType,
      artifactType,
      entityIds,
      serenityBridge: {
        version: 0,
        dataset,
        mode,
        entityName,
        retrievedAt,
        symbol: manifest.symbol || null,
        result: {
          dataset: result.dataset,
          status: result.status,
          source: result.source,
          source_level: result.source_level,
          data_path: result.data_path || null,
        },
        payload,
      },
    },
  };
}

function buildSource({ dataset, datasetConfig, entity, result, manifest, stockCode, capturedAt, retrievedAt, datasetMap }) {
  const sourceId = `src_serenity_${stockCode}_${slug(dataset)}_${slug(result.source)}`;
  return {
    id: sourceId,
    title: `${entity.name} ${datasetLabel(dataset)} · Serenity Bridge`,
    publisher: result.source || "Serenity",
    sourceType: datasetConfig.sourceType,
    url: datasetSourceUrl(dataset, manifest, stockCode, entity),
    publishedAt: retrievedAt,
    capturedAt,
    evidenceLevel: evidenceLevelForSerenity(result.source_level, datasetMap),
    status: "active",
    notes: `Imported from Serenity ${dataset} dataset. Bridge excludes valuation, rating and portfolio outputs.`,
  };
}

function buildFetchRun({ id, dataset, source, result, artifactIds, capturedAt, retrievedAt, status, gaps, url, contentHash, storagePath }) {
  return {
    id,
    fetcher: "serenity_bridge_v0",
    sourceName: `Serenity ${dataset} · ${source.publisher}`,
    sourceType: "serenity_bridge",
    startedAt: capturedAt,
    finishedAt: capturedAt,
    status,
    artifactIds,
    claimIds: [],
    error: result.status === "OK" ? null : `Serenity dataset status: ${result.status}`,
    gaps,
    attemptLedger: [
      {
        kind: "serenity_dataset_import",
        inputType: "api",
        url,
        status: result.status || "UNKNOWN",
        startedAt: retrievedAt,
        finishedAt: capturedAt,
        contentHash: String(contentHash || ""),
        storagePath,
      },
    ],
  };
}

function buildPipelineTask(routeDecision, rawArtifact, createdAt) {
  const date = dateFrom(createdAt);
  return {
    id: `ptask_${date.replaceAll("-", "_")}_${hash(
      `${routeDecision.id}|${routeDecision.pipeline}|${rawArtifact.id}`,
      12
    )}`,
    rawArtifactId: rawArtifact.id,
    routeDecisionId: routeDecision.id,
    pipeline: routeDecision.pipeline,
    type: routeDecision.type,
    entityId: routeDecision.entityId,
    entityIds: routeDecision.entityIds,
    inputType: "api",
    sourceKind: routeDecision.sourceKind,
    status: "queued",
    createdAt,
    updatedAt: createdAt,
    nextAction: `run ${routeDecision.pipeline}`,
    notes: "Queued by Serenity Bridge v0. Pipeline creates inbox candidates only.",
  };
}

function buildStockSnapshot({ entity, source, payload, stockCode, symbol, capturedAt, retrievedAt }) {
  const price = numberOrNull(payload?.regular_market_price);
  const previousClose = numberOrNull(payload?.previous_close);
  const changePct = price !== null && previousClose ? round(((price - previousClose) / previousClose) * 100, 2) : null;
  const shanghai = shanghaiParts(retrievedAt);
  return {
    id: `stk_${shanghai.date.replaceAll("-", "_")}_${entity.id}_serenity_quote`,
    date: shanghai.date,
    time: shanghai.time,
    snapshotType: "intraday",
    isFinal: false,
    entityId: entity.id,
    stockCode,
    market: entity.market || marketFromSymbol(symbol),
    close: null,
    price,
    changePct,
    turnoverAmount: null,
    turnoverRate: null,
    mainNetInflow: null,
    changePct5d: null,
    changePct20d: null,
    sourceIds: [source.id],
    capturedAt,
    provider: "serenity",
    providerSourceUrl: quoteUrl(symbol, stockCode),
    quoteUrl: quoteUrl(symbol, stockCode),
    quoteTime: retrievedAt,
    notes: "Imported by Serenity Bridge v0 as market context only; not an investment signal.",
  };
}

function bridgeSummary(payload, pipelineResult) {
  return {
    capturedAt: payload.capturedAt,
    retrievedAt: payload.retrievedAt,
    entityId: payload.entityId,
    symbol: payload.symbol,
    sources: payload.sources.length,
    rawArtifacts: payload.rawArtifacts.length,
    fetchRuns: payload.fetchRuns.length,
    routeDecisions: payload.routeDecisions.length,
    pipelineTasks: payload.pipelineTasks.filter(Boolean).length,
    stockSnapshots: payload.stockSnapshots.length,
    dataGaps: payload.dataGaps.length,
    skipped: payload.skipped.length,
    pipelineCompleted: pipelineResult?.completed || 0,
    pipelineSkipped: pipelineResult?.skipped || 0,
    pipelineFailed: pipelineResult?.failed || 0,
  };
}

function resolveEntity(manifest, entities, explicitEntityId) {
  if (explicitEntityId) {
    const entity = entities.find((row) => row.id === explicitEntityId);
    if (!entity) throw new Error(`Unknown entityId: ${explicitEntityId}`);
    return entity;
  }
  const symbol = manifest.symbol || {};
  const code = stockCodeFromSymbol(symbol.symbol || symbol.input_value);
  const nameCandidates = new Set([
    String(symbol.name || "").trim(),
    ...(manifest.results || []).map((row) => row.name).filter(Boolean),
  ]);
  const byCode = entities.find((row) => stockCodeFromSymbol(row.stockCode) === code);
  if (byCode) return byCode;
  const byName = entities.find((row) => nameCandidates.has(row.name));
  if (byName) return byName;
  throw new Error(`Unable to map Serenity symbol ${symbol.symbol || symbol.input_value || "unknown"} to data/entities.`);
}

function normalizeSerenityGaps(gaps, datasetMap) {
  return gaps.map((gap) => ({
    dataset: gap.dataset,
    status: gap.status,
    gap_type: gap.gap_type,
    decision_impact: gap.decision_impact,
    next_action: gap.next_action,
    source_name: gap.source_name || null,
    source_level: gap.source_level || null,
    evidenceLevel: evidenceLevelForSerenity(gap.source_level, datasetMap),
    kind: `serenity_${slug(gap.gap_type || "data_gap")}`,
    description: `${gap.dataset}: ${gap.next_action || gap.gap_type || "Serenity data gap"}`,
    severity: severityForGap(gap),
  }));
}

function statusForResult(result, gaps, payload) {
  if (result.status === "OK" && payload && gaps.length === 0) return "success";
  if (result.status === "OK" && payload) return "partial";
  if (["PARTIAL", "STALE", "PENDING", "NOT_REQUESTED"].includes(result.status)) return "partial";
  return "failed";
}

function severityForGap(gap) {
  if (["FAILED", "STALE"].includes(gap.status)) return "high";
  if (["PARTIAL", "PENDING"].includes(gap.status)) return "medium";
  return "low";
}

function evidenceLevelForSerenity(sourceLevel, datasetMap) {
  const match = String(sourceLevel || "").match(/L[0-5]/i)?.[0]?.toUpperCase();
  return datasetMap.sourceLevelMap?.[match] || "C";
}

async function readPipelineTaskByRouteId() {
  const rows = await readJsonDir("pipeline_tasks");
  return new Map(rows.map((row) => [row.data.routeDecisionId, row.data]));
}

async function readRawArtifactById() {
  const rows = await readJsonDir("raw_artifacts");
  return new Map(rows.map((row) => [row.data.id, row.data]));
}

async function readOrDefault(file, fallback) {
  try {
    return await readJsonFile(file);
  } catch {
    return fallback;
  }
}

async function resolveDataPath(dataPath, { manifestDir, baseDir }) {
  const candidates = [
    path.isAbsolute(dataPath) ? dataPath : null,
    path.join(manifestDir, dataPath),
    path.join(baseDir, dataPath),
    path.join(process.cwd(), dataPath),
    path.join(manifestDir, path.basename(dataPath)),
    path.join(baseDir, path.basename(dataPath)),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`Unable to resolve Serenity data_path: ${dataPath}`);
}

function latestFinancialPeriod(periods) {
  return periods
    .slice()
    .filter((row) => row.period)
    .sort((a, b) => String(b.period).localeCompare(String(a.period)))[0];
}

function rawId(value, token) {
  return `raw_${dateFrom(value).replaceAll("-", "_")}_${slug(token)}`;
}

function fetchId(value, token) {
  return `fetch_${dateFrom(value).replaceAll("-", "_")}_${slug(token)}`;
}

function slug(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return normalized || "item";
}

function stockCodeFromSymbol(value) {
  const text = String(value || "");
  return text.split(".")[0].replace(/[^0-9A-Za-z]/g, "");
}

function datasetLabel(dataset) {
  const labels = {
    current_quote: "行情",
    filings_announcements: "公告",
    financials: "财报",
    provider_health: "来源健康",
    data_gaps: "数据缺口",
  };
  return labels[dataset] || dataset;
}

function datasetSourceUrl(dataset, manifest, stockCode, entity) {
  if (dataset === "current_quote") return quoteUrl(manifest.symbol?.symbol, stockCode);
  if (dataset === "filings_announcements") return filingSearchUrl(stockCode);
  if (dataset === "financials") return financialsUrl(stockCode, entity.market);
  return "https://github.com/brittanyyitian/humanoid-research";
}

function quoteUrl(symbol, stockCode) {
  if (String(symbol || "").endsWith(".SS")) return `https://finance.yahoo.com/quote/${symbol}`;
  if (String(symbol || "").endsWith(".SZ")) return `https://finance.yahoo.com/quote/${symbol}`;
  return `https://quote.eastmoney.com/${stockCode}.html`;
}

function filingSearchUrl(stockCode) {
  return `https://www.cninfo.com.cn/new/disclosure/stock?stockCode=${stockCode}`;
}

function financialsUrl(stockCode, market) {
  const prefix = market === "SZSE" ? "SZ" : "SH";
  return `https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/Index?type=web&code=${prefix}${stockCode}`;
}

function marketFromSymbol(symbol) {
  if (String(symbol || "").endsWith(".SS") || String(symbol || "").endsWith(".SH")) return "SSE";
  if (String(symbol || "").endsWith(".SZ")) return "SZSE";
  return "UNKNOWN";
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits) {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function normalizeDateTime(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
  return `${parts.replace(" ", "T")}+08:00`;
}

function shanghaiParts(value) {
  const normalized = normalizeDateTime(value) || nowShanghai();
  return {
    date: normalized.slice(0, 10),
    time: normalized.slice(11, 16),
  };
}
