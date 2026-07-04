import crypto from "node:crypto";
import path from "node:path";
import { DATA_DIR, readJsonFile, todayInShanghai, writeJsonFile } from "./data-utils.mjs";

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/capture_artifact.mjs --url <url> --title <title> --publisher <publisher> --entity-ids <id,id>

Options:
  --artifact-type <type>   Default: webpage
  --source-type <type>     Default: webpage
  --source-id <id>         Reuse or set a source id
  --source-level <A-D>     Default: A
  --published-at <time>    Source publish time
  --captured-at <time>     Default: current Shanghai time
  --notes <text>
  --dry-run                Print payloads without writing files
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

const required = ["url", "title", "publisher", "entityIds"];
const missing = required.filter((key) => !args[key]);
if (missing.length) {
  console.error(`Missing required option(s): ${missing.join(", ")}`);
  console.error(usage());
  process.exit(1);
}

const capturedAt = args.capturedAt || nowShanghai();
const date = dateFrom(args.publishedAt || capturedAt);
const hostToken = hostSlug(args.url);
const digest = hash(`${args.url}|${args.title}|${args.publishedAt || ""}`, 10);
const baseToken = `${hostToken}_${digest}`;
const sourceId = args.sourceId || `src_${baseToken}`;
const artifactId = `raw_${date.replaceAll("-", "_")}_${baseToken}`;
const fetchRunId = `fetch_${date.replaceAll("-", "_")}_${baseToken}`;
const sourcePath = path.join(DATA_DIR, "sources", `${sourceId}.json`);
const artifactPath = path.join(DATA_DIR, "raw_artifacts", `${artifactId}.json`);
const fetchRunPath = path.join(DATA_DIR, "fetch_runs", `${fetchRunId}.json`);
const inboxPath = path.join(DATA_DIR, "inbox", "artifact_candidates.json");

const source = {
  id: sourceId,
  title: args.title,
  publisher: args.publisher,
  sourceType: args.sourceType || "webpage",
  url: args.url,
  publishedAt: args.publishedAt || null,
  capturedAt,
  evidenceLevel: args.sourceLevel || "A",
  status: "active",
  notes: args.notes || "Captured by manual artifact intake.",
};

const rawArtifact = {
  id: artifactId,
  artifactType: args.artifactType || "webpage",
  title: args.title,
  publisher: args.publisher,
  url: args.url,
  sourceId,
  fetchRunId,
  publishedAt: args.publishedAt || null,
  firstSeenAt: capturedAt,
  capturedAt,
  contentHash: `sha256:${hash(`${args.url}|${args.title}|${args.publishedAt || ""}`, 64)}`,
  storagePath: null,
  entityIds: splitList(args.entityIds),
  claimIds: [],
  status: "active",
  notes: args.notes || "Manual official/product link capture.",
};

const fetchRun = {
  id: fetchRunId,
  fetcher: "capture_artifact_v1",
  sourceName: args.publisher,
  sourceType: "manual_link",
  startedAt: capturedAt,
  finishedAt: capturedAt,
  status: "manual",
  artifactIds: [artifactId],
  claimIds: [],
  error: null,
  gaps: [],
};

const inbox = await readOrDefault(inboxPath, {
  date: todayInShanghai(),
  capturedAt,
  reviewStatus: "pending_manual_review",
  policy: "Manual artifact captures enter inbox first. Claims must be reviewed before promotion.",
  candidates: [],
});

const candidate = {
  id: `artifact_candidate_${digest}`,
  rawArtifactId: artifactId,
  sourceId,
  fetchRunId,
  title: args.title,
  publisher: args.publisher,
  sourceUrl: args.url,
  entityIds: splitList(args.entityIds),
  reviewStatus: "pending",
  capturedAt,
};

inbox.date = capturedAt.slice(0, 10);
inbox.capturedAt = capturedAt;
inbox.candidates = upsertById(inbox.candidates || [], candidate);

const payloads = [
  ["source", sourcePath, source],
  ["raw_artifact", artifactPath, rawArtifact],
  ["fetch_run", fetchRunPath, fetchRun],
  ["inbox", inboxPath, inbox],
];

if (args.dryRun) {
  console.log(JSON.stringify(Object.fromEntries(payloads.map(([key, file, data]) => [key, { file, data }])), null, 2));
  process.exit(0);
}

await writeIfMissing(sourcePath, source);
await writeJsonFile(artifactPath, rawArtifact);
await writeJsonFile(fetchRunPath, fetchRun);
await writeJsonFile(inboxPath, inbox);

console.log(`Captured artifact ${artifactId}`);
console.log(`Source: ${sourceId}`);
console.log(`Fetch run: ${fetchRunId}`);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      result.help = true;
    } else if (item === "--dry-run") {
      result.dryRun = true;
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

function hash(value, length) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, length);
}

function splitList(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
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
