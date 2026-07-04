import path from "node:path";
import {
  DATA_DIR,
  readJsonDir,
  readJsonFile,
  todayInShanghai,
  writeJsonFile,
} from "../data-utils.mjs";
import {
  dateFrom,
  hash,
  loadRouterContext,
  nowShanghai,
  readExistingRoutes,
  routeArtifact,
  writeRouteDecision,
} from "./router-service.mjs";

const INPUT_TYPES = new Set(["url", "rss", "api", "manual"]);
const SOURCE_TYPES = new Set(["webpage", "pdf", "video", "filing", "wechat", "news", "exchange", "government"]);
const ARTIFACT_TYPES = new Set([
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
const SOURCE_LEVELS = new Set(["A", "B", "C", "D"]);

export async function ingestInput(options = {}) {
  const capturedAt = options.capturedAt || nowShanghai();
  const inputType = options.inputType || "url";
  if (!INPUT_TYPES.has(inputType)) {
    throw new Error(`inputType must be one of: ${Array.from(INPUT_TYPES).join(", ")}`);
  }
  if (!options.url) {
    throw new Error("Missing required option: url");
  }

  const routerContext = await loadRouterContext();
  const title = options.title || titleFromUrl(options.url);
  const publisher = options.publisher || publisherFromUrl(options.url);
  const sourceType = normalizeSourceType(options.sourceType || inferSourceType(options.url, title, publisher));
  const artifactType = normalizeArtifactType(options.artifactType || inferArtifactType(options.url, title, publisher));
  const sourceLevel = normalizeSourceLevel(options.sourceLevel || evidenceLevelForInput(inputType, sourceType));
  const entityIds = normalizeEntityIds(options.entityIds, routerContext.entities, [title, publisher, options.url]);

  if (entityIds.length === 0) {
    throw new Error("Unable to infer entityIds. Pass --entity-ids so Router can create a route_decision.");
  }

  const date = dateFrom(options.publishedAt || capturedAt);
  const hostToken = hostSlug(options.url);
  const digest = hash(`${inputType}|${options.url}|${title}|${options.publishedAt || ""}`, 10);
  const baseToken = `${hostToken}_${digest}`;
  const sourceId = options.sourceId || `src_${baseToken}`;
  const artifactId = options.artifactId || `raw_${date.replaceAll("-", "_")}_${baseToken}`;
  const fetchRunId = options.fetchRunId || `fetch_${date.replaceAll("-", "_")}_${baseToken}`;
  const sourcePath = path.join(DATA_DIR, "sources", `${sourceId}.json`);
  const artifactPath = path.join(DATA_DIR, "raw_artifacts", `${artifactId}.json`);
  const fetchRunPath = path.join(DATA_DIR, "fetch_runs", `${fetchRunId}.json`);
  const inboxPath = path.join(DATA_DIR, "inbox", "artifact_candidates.json");
  const existingRawArtifact = await readOrDefault(artifactPath, null);

  const source = {
    id: sourceId,
    title,
    publisher,
    sourceType,
    url: options.url,
    publishedAt: options.publishedAt || null,
    capturedAt,
    evidenceLevel: sourceLevel,
    status: "active",
    notes: options.notes || `Captured by ingestion entry layer from ${inputType}.`,
  };

  const rawArtifact = {
    id: artifactId,
    artifactType,
    title,
    publisher,
    url: options.url,
    sourceId,
    fetchRunId,
    publishedAt: options.publishedAt || null,
    firstSeenAt: existingRawArtifact?.firstSeenAt || capturedAt,
    capturedAt,
    contentHash: `sha256:${hash(`${inputType}|${options.url}|${title}|${options.publishedAt || ""}`, 64)}`,
    storagePath: null,
    entityIds,
    claimIds: [],
    status: "active",
    notes: options.notes || "Ingested entry awaiting routed pipeline processing.",
  };

  const fetchRun = {
    id: fetchRunId,
    fetcher: "ingestion_entry_v1",
    sourceName: publisher,
    sourceType: "ingestion",
    startedAt: capturedAt,
    finishedAt: capturedAt,
    status: inputType === "manual" ? "manual" : "success",
    artifactIds: [artifactId],
    claimIds: [],
    error: null,
    gaps: [],
  };

  const inbox = await readOrDefault(inboxPath, {
    date: todayInShanghai(),
    capturedAt,
    reviewStatus: "pending_manual_review",
    policy: "Ingestion entries become raw artifacts first, then Router decides the pipeline.",
    candidates: [],
  });

  const candidate = {
    id: `artifact_candidate_${digest}`,
    rawArtifactId: artifactId,
    sourceId,
    fetchRunId,
    title,
    publisher,
    sourceUrl: options.url,
    entityIds,
    inputType,
    reviewStatus: "pending",
    capturedAt,
  };

  inbox.date = capturedAt.slice(0, 10);
  inbox.capturedAt = capturedAt;
  inbox.policy = "Ingestion entries become raw artifacts first, then Router decides the pipeline.";
  inbox.candidates = upsertById(inbox.candidates || [], candidate);

  const payloads = {
    source: { file: sourcePath, data: source },
    raw_artifact: { file: artifactPath, data: rawArtifact },
    fetch_run: { file: fetchRunPath, data: fetchRun },
    inbox: { file: inboxPath, data: inbox },
  };

  if (options.autoRoute !== false) {
    const routeByArtifactId = await readExistingRoutesSafe();
    let routeDecision = routeByArtifactId.get(rawArtifact.id);
    if (!routeDecision || options.forceRoute) {
      routeDecision = routeArtifact(rawArtifact, routerContext, { createdAt: capturedAt });
    }
    payloads.route_decision = {
      file: path.join(DATA_DIR, "route_decisions", `${routeDecision.id}.json`),
      data: routeDecision,
    };

    if (options.enqueuePipeline !== false) {
      const existingTask = await findPipelineTaskByRoute(routeDecision.id);
      const pipelineTask =
        existingTask && !options.forceTask
          ? existingTask
          : buildPipelineTask({
              routeDecision,
              rawArtifact,
              inputType,
              sourceKind: routeDecision.sourceKind,
              createdAt: capturedAt,
            });
      payloads.pipeline_task = {
        file: path.join(DATA_DIR, "pipeline_tasks", `${pipelineTask.id}.json`),
        data: pipelineTask,
      };
    }
  }

  if (options.dryRun) {
    return payloads;
  }

  await writeIfMissing(sourcePath, source);
  await writeJsonFile(artifactPath, rawArtifact);
  await writeJsonFile(fetchRunPath, fetchRun);
  await writeJsonFile(inboxPath, inbox);
  if (payloads.route_decision) {
    await writeRouteDecision(payloads.route_decision.data);
  }
  if (payloads.pipeline_task) {
    await writeJsonFile(payloads.pipeline_task.file, payloads.pipeline_task.data);
  }

  return payloads;
}

function buildPipelineTask({ routeDecision, rawArtifact, inputType, sourceKind, createdAt }) {
  const date = dateFrom(createdAt);
  const id = `ptask_${date.replaceAll("-", "_")}_${hash(
    `${routeDecision.id}|${routeDecision.pipeline}|${rawArtifact.id}`,
    12
  )}`;
  return {
    id,
    rawArtifactId: rawArtifact.id,
    routeDecisionId: routeDecision.id,
    pipeline: routeDecision.pipeline,
    type: routeDecision.type,
    entityId: routeDecision.entityId,
    entityIds: routeDecision.entityIds,
    inputType,
    sourceKind,
    status: routeDecision.status === "routed" ? "queued" : "needs_review",
    createdAt,
    updatedAt: createdAt,
    nextAction: routeDecision.status === "routed" ? `run ${routeDecision.pipeline}` : "manual route review",
    notes: "Queued by ingestion entry layer. Pipeline execution is a separate step.",
  };
}

function normalizeEntityIds(value, entities, textParts) {
  const explicit = splitList(value);
  if (explicit.length) return explicit;
  const haystack = textParts.filter(Boolean).join(" ").toLowerCase();
  return entities
    .filter((entity) => {
      const tokens = [entity.id, entity.name, entity.stockCode, ...(entity.tags || [])]
        .filter(Boolean)
        .map((item) => String(item).toLowerCase());
      return tokens.some((token) => token && haystack.includes(token));
    })
    .map((entity) => entity.id);
}

function inferSourceType(url, title, publisher) {
  const text = `${url} ${title} ${publisher}`.toLowerCase();
  if (text.includes("wechat") || text.includes("公众号")) return "wechat";
  if (text.includes(".pdf")) return "pdf";
  if (text.includes("cninfo") || text.includes("sse.com") || text.includes("szse.cn") || text.includes("hkex")) {
    return "exchange";
  }
  if (text.includes(".gov.cn") || text.includes("政府") || text.includes("工信")) return "government";
  if (text.includes("news") || text.includes("新闻") || text.includes("动态")) return "news";
  return "webpage";
}

function inferArtifactType(url, title, publisher) {
  const text = `${url} ${title} ${publisher}`.toLowerCase();
  if (text.includes(".pdf")) return "pdf";
  if (text.includes("wechat") || text.includes("公众号")) return "wechat";
  if (text.includes("cninfo") || text.includes("sse.com") || text.includes("szse.cn") || text.includes("hkex")) {
    return "filing";
  }
  if (hasAny(text, ["product", "产品", "发布", "参数", "spec", "h2", "g1", "g2"])) return "product_page";
  if (hasAny(text, ["news", "新闻", "动态"])) return "news_page";
  return "webpage";
}

function evidenceLevelForInput(inputType, sourceType) {
  if (sourceType === "exchange" || sourceType === "government") return "A";
  if (inputType === "api" || inputType === "rss") return "B";
  return "A";
}

function normalizeSourceType(value) {
  if (!SOURCE_TYPES.has(value)) {
    throw new Error(`sourceType must be one of: ${Array.from(SOURCE_TYPES).join(", ")}`);
  }
  return value;
}

function normalizeArtifactType(value) {
  if (!ARTIFACT_TYPES.has(value)) {
    throw new Error(`artifactType must be one of: ${Array.from(ARTIFACT_TYPES).join(", ")}`);
  }
  return value;
}

function normalizeSourceLevel(value) {
  if (!SOURCE_LEVELS.has(value)) {
    throw new Error("sourceLevel must be A, B, C, or D");
  }
  return value;
}

function titleFromUrl(value) {
  try {
    const url = new URL(value);
    const pathTitle = url.pathname
      .split("/")
      .filter(Boolean)
      .at(-1);
    return pathTitle ? decodeURIComponent(pathTitle).replace(/[-_]+/g, " ") : url.hostname.replace(/^www\./, "");
  } catch {
    return "Untitled input";
  }
}

function publisherFromUrl(value) {
  try {
    return new URL(value).hostname.replace(/^www\./, "");
  } catch {
    return "unknown";
  }
}

function hostSlug(value) {
  try {
    return slug(new URL(value).hostname.replace(/^www\./, ""));
  } catch {
    return "manual";
  }
}

function slug(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40);
  return normalized || "item";
}

function splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item).trim()).filter(Boolean);
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function hasAny(value, needles) {
  return needles.some((needle) => String(value || "").includes(needle));
}

async function readOrDefault(file, fallback) {
  try {
    return await readJsonFile(file);
  } catch {
    return fallback;
  }
}

function upsertById(rows, row) {
  const without = rows.filter((item) => item.id !== row.id);
  return [...without, row];
}

async function writeIfMissing(file, payload) {
  try {
    await readJsonFile(file);
  } catch {
    await writeJsonFile(file, payload);
  }
}

async function readExistingRoutesSafe() {
  try {
    return await readExistingRoutes();
  } catch {
    return new Map();
  }
}

async function findPipelineTaskByRoute(routeDecisionId) {
  let rows = [];
  try {
    rows = await readJsonDir("pipeline_tasks");
  } catch {
    return null;
  }
  return rows.map((row) => row.data).find((task) => task.routeDecisionId === routeDecisionId) || null;
}

export function payloadSummary(payloads) {
  return {
    rawArtifactId: payloads.raw_artifact?.data.id || null,
    routeDecisionId: payloads.route_decision?.data.id || null,
    pipelineTaskId: payloads.pipeline_task?.data.id || null,
    pipeline: payloads.pipeline_task?.data.pipeline || payloads.route_decision?.data.pipeline || null,
    status: payloads.pipeline_task?.data.status || payloads.route_decision?.data.status || null,
  };
}
