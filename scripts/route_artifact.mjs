import crypto from "node:crypto";
import path from "node:path";
import { DATA_DIR, readJsonDir, readJsonFile, writeJsonFile } from "./data-utils.mjs";

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/route_artifact.mjs --artifact-id <raw_id>
  node scripts/route_artifact.mjs --all

Options:
  --dry-run    Print route decision(s) without writing files
  --force      Rewrite an existing route decision
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

if (!args.artifactId && !args.all) {
  console.error("Missing --artifact-id or --all");
  console.error(usage());
  process.exit(1);
}

const entitiesIndex = await readJsonFile(path.join(DATA_DIR, "entities", "index.json"));
const entities = entitiesIndex.entities || [];
const entityById = new Map(entities.map((entity) => [entity.id, entity]));
const pipelineMap = await readJsonFile(path.join(DATA_DIR, "pipelines", "pipeline_map.json"));
const pipelineByType = new Map((pipelineMap.routes || []).map((route) => [route.type, route.pipeline]));
const artifacts = args.all
  ? (await readJsonDir("raw_artifacts")).map((row) => row.data)
  : [await readJsonFile(path.join(DATA_DIR, "raw_artifacts", `${args.artifactId}.json`))];
const existingRoutes = await readJsonDir("route_decisions");
const routeByArtifactId = new Map(existingRoutes.map((row) => [row.data.rawArtifactId, row.data]));

const decisions = [];
for (const artifact of artifacts) {
  const existing = routeByArtifactId.get(artifact.id);
  if (existing && !args.force) {
    decisions.push(existing);
    continue;
  }
  decisions.push(routeArtifact(artifact));
}

if (args.dryRun) {
  console.log(JSON.stringify(decisions, null, 2));
  process.exit(0);
}

for (const decision of decisions) {
  await writeJsonFile(path.join(DATA_DIR, "route_decisions", `${decision.id}.json`), decision);
}

console.log(`Routed ${decisions.length} artifact(s).`);

function routeArtifact(artifact) {
  const text = [
    artifact.title,
    artifact.publisher,
    artifact.url,
    artifact.artifactType,
    artifact.notes,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  const entityRows = (artifact.entityIds || []).map((entityId) => entityById.get(entityId)).filter(Boolean);
  const primaryEntity = entityRows[0] || { id: "unknown", name: "unknown", kind: "unknown" };
  const signals = [];

  function add(field, value, reason) {
    signals.push({ field, value: String(value), reason });
  }

  let type = "event";
  let confidence = "low";
  let reason = "Default route for general event-like official material.";

  if (artifact.artifactType === "filing" || hasAny(text, ["cninfo", "sse.com", "szse.cn", "hkex", "sec.gov", "公告", "财报"])) {
    type = "filing";
    confidence = "high";
    reason = "Artifact looks like a formal filing or exchange announcement.";
    add("artifact", artifact.artifactType, "filing artifact or disclosure keyword");
  } else if (isPolicy(text, artifact.publisher)) {
    type = "policy";
    confidence = "high";
    reason = "Publisher or title matches government policy material.";
    add("publisher/title", artifact.publisher, "government or policy signal");
  } else if (artifact.artifactType === "product_page" || hasAny(text, ["产品", "product", "发布", "release", "参数", "spec", "h2", "g1", "g2"])) {
    type = "product";
    confidence = artifact.artifactType === "product_page" ? "high" : "medium";
    reason = "Artifact contains product page or launch/specification signals.";
    add("artifact/title", `${artifact.artifactType} ${artifact.title}`, "product release/spec signal");
  } else if (entityRows.some((entity) => entity.kind === "supply_chain") || hasAny(text, ["供应链", "传感器", "减速器", "丝杠", "执行器", "灵巧手"])) {
    type = "supply_chain";
    confidence = entityRows.some((entity) => entity.kind === "supply_chain") ? "high" : "medium";
    reason = "Artifact is tied to a supply-chain entity or component keyword.";
    add("entity/title", primaryEntity.name, "supply-chain signal");
  } else if (hasAny(text, ["新闻", "动态", "公司", "融资", "生态", "合作"])) {
    type = "company";
    confidence = "medium";
    reason = "Artifact looks like company official news or corporate update.";
    add("title", artifact.title, "company update signal");
  } else {
    add("fallback", artifact.artifactType, "no stronger route matched");
  }

  if (hasAny(text, ["下线", "交付", "大会", "展会", "发布会", "里程碑", "部署"])) {
    type = type === "product" ? "product" : "event";
    confidence = confidence === "low" ? "medium" : confidence;
    reason = type === "product" ? reason : "Artifact contains event, delivery or milestone signals.";
    add("title", artifact.title, "event/milestone signal");
  }

  const pipeline = pipelineByType.get(type);
  const date = dateFrom(artifact.publishedAt || artifact.capturedAt || artifact.firstSeenAt);
  const id = `route_${date.replaceAll("-", "_")}_${hash(`${artifact.id}|${type}|${pipeline}`, 12)}`;

  return {
    id,
    rawArtifactId: artifact.id,
    type,
    entity: primaryEntity.name,
    entityId: primaryEntity.id,
    entityIds: artifact.entityIds || [],
    pipeline,
    confidence,
    reason,
    matchedSignals: signals,
    sourceKind: sourceKindFor(artifact, text),
    status: pipeline ? "routed" : "needs_review",
    createdAt: nowShanghai(),
    nextAction: pipeline ? `run ${pipeline}` : "manual route review",
    notes: "Generated by route_artifact v1 rules.",
  };
}

function isPolicy(text, publisher) {
  const publisherText = String(publisher || "").toLowerCase();
  return (
    hasAny(text, ["政策", "通知", "意见", "方案", "办法", "申报", "补贴"]) ||
    hasAny(publisherText, ["政府", "工信", "发改", "科技部", "miit", "ndrc"]) ||
    text.includes(".gov.cn")
  );
}

function sourceKindFor(artifact, text) {
  if (artifact.artifactType === "filing" || hasAny(text, ["cninfo", "sse.com", "szse.cn", "hkex", "sec.gov"])) return "filing";
  if (artifact.artifactType === "market_quote") return "market";
  if (isPolicy(text, artifact.publisher)) return "official";
  if (hasAny(String(artifact.publisher || "").toLowerCase(), ["公司", "科技", "robot", "robotics", "inc", "ltd"])) {
    return "official";
  }
  if (hasAny(text, ["wechat", "公众号"])) return "social";
  if (hasAny(text, ["media", "news", "新闻"])) return "media";
  if (artifact.fetchRunId?.includes("manual") || artifact.url?.startsWith("http")) return "official";
  return "unknown";
}

function hasAny(value, needles) {
  return needles.some((needle) => String(value || "").includes(needle));
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      result.help = true;
    } else if (item === "--dry-run") {
      result.dryRun = true;
    } else if (item === "--all") {
      result.all = true;
    } else if (item === "--force") {
      result.force = true;
    } else if (item.startsWith("--")) {
      const key = item
        .slice(2)
        .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      result[key] = argv[index + 1];
      index += 1;
    }
  }
  return result;
}

function nowShanghai() {
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date());
  return `${parts.replace(" ", "T")}+08:00`;
}

function dateFrom(value) {
  return String(value || nowShanghai()).slice(0, 10);
}

function hash(value, length) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, length);
}
