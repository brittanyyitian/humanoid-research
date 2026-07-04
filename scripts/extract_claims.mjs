import crypto from "node:crypto";
import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./data-utils.mjs";

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/extract_claims.mjs --artifact-id <raw_id> --claim <text> --claim-type <type> --entity-ids <id,id>

Options:
  --normalized-fact <text>
  --confidence <high|medium|low|unknown>  Default: medium
  --relation <supports|mentions|refutes|updates>  Default: supports
  --source-level <A-D>                    Default: source evidence level
  --strength <strong|medium|weak>         Default: medium
  --occurred-at <date>
  --published-at <time>                   Default: artifact publishedAt
  --due-at <date>
  --product-ids <id,id>
  --quote <text>
  --why-now <text>
  --notes <text>
  --dry-run
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

const required = ["artifactId", "claim", "claimType", "entityIds"];
const missing = required.filter((key) => !args[key]);
if (missing.length) {
  console.error(`Missing required option(s): ${missing.join(", ")}`);
  console.error(usage());
  process.exit(1);
}

const artifactPath = path.join(DATA_DIR, "raw_artifacts", `${args.artifactId}.json`);
const artifact = await readJsonFile(artifactPath);
const source = await readJsonFile(path.join(DATA_DIR, "sources", `${artifact.sourceId}.json`));
const capturedAt = artifact.capturedAt;
const processedAt = nowShanghai();
const date = dateFrom(args.occurredAt || args.publishedAt || artifact.publishedAt || artifact.firstSeenAt || capturedAt);
const digest = hash(`${args.artifactId}|${args.claim}`, 10);
const token = `${slug(args.claimType)}_${digest}`;
const claimId = `claim_${date.replaceAll("-", "_")}_${token}`;
const evidenceId = `evd_${date.replaceAll("-", "_")}_${token}`;
const claimPath = path.join(DATA_DIR, "claims", `${claimId}.json`);
const evidencePath = path.join(DATA_DIR, "evidence", `${evidenceId}.json`);
const inboxPath = path.join(DATA_DIR, "inbox", "claim_candidates.json");
const fetchRunPath = path.join(DATA_DIR, "fetch_runs", `${artifact.fetchRunId}.json`);
const fetchRun = await readJsonFile(fetchRunPath);

const claim = {
  id: claimId,
  claimType: args.claimType,
  text: args.claim,
  normalizedFact: args.normalizedFact || args.claim,
  entityIds: splitList(args.entityIds),
  productIds: splitList(args.productIds),
  artifactIds: [artifact.id],
  status: "candidate",
  reviewStatus: "inbox",
  confidence: args.confidence || "medium",
  occurredAt: args.occurredAt || null,
  publishedAt: args.publishedAt || artifact.publishedAt || null,
  firstSeenAt: artifact.firstSeenAt,
  capturedAt,
  processedAt,
  dueAt: args.dueAt || null,
  resolvedAt: null,
  promotedEventIds: [],
  promotedFollowupIds: [],
  whyNow: args.whyNow || "新录入的事实候选，等待人工审核。",
  notes: args.notes || "Manual claim extraction candidate.",
};

const evidence = {
  id: evidenceId,
  claimId,
  rawArtifactId: artifact.id,
  sourceId: artifact.sourceId,
  relation: args.relation || "supports",
  sourceLevel: args.sourceLevel || source.evidenceLevel || "A",
  strength: args.strength || "medium",
  quote: args.quote || args.claim,
  capturedAt,
  assessedAt: processedAt,
  notes: args.notes || "Manual evidence link created from captured artifact.",
};

const updatedArtifact = {
  ...artifact,
  claimIds: unique([...(artifact.claimIds || []), claimId]),
};
const updatedFetchRun = {
  ...fetchRun,
  claimIds: unique([...(fetchRun.claimIds || []), claimId]),
};
const inbox = await readOrDefault(inboxPath, {
  date: processedAt.slice(0, 10),
  capturedAt: processedAt,
  reviewStatus: "pending_manual_review",
  policy: "Claim candidates are not formal truth until promoted by review.",
  candidates: [],
});
const candidate = {
  id: `claim_candidate_${digest}`,
  claimId,
  rawArtifactId: artifact.id,
  evidenceId,
  text: claim.text,
  normalizedFact: claim.normalizedFact,
  claimType: claim.claimType,
  entityIds: claim.entityIds,
  sourceId: artifact.sourceId,
  sourceLevel: evidence.sourceLevel,
  confidence: claim.confidence,
  reviewStatus: "pending",
  processedAt,
};
inbox.date = processedAt.slice(0, 10);
inbox.capturedAt = processedAt;
inbox.candidates = upsertById(inbox.candidates || [], candidate);

const payloads = [
  ["claim", claimPath, claim],
  ["evidence", evidencePath, evidence],
  ["raw_artifact", artifactPath, updatedArtifact],
  ["fetch_run", fetchRunPath, updatedFetchRun],
  ["inbox", inboxPath, inbox],
];

if (args.dryRun) {
  console.log(JSON.stringify(Object.fromEntries(payloads.map(([key, file, data]) => [key, { file, data }])), null, 2));
  process.exit(0);
}

await writeJsonFile(claimPath, claim);
await writeJsonFile(evidencePath, evidence);
await writeJsonFile(artifactPath, updatedArtifact);
await writeJsonFile(fetchRunPath, updatedFetchRun);
await writeJsonFile(inboxPath, inbox);

console.log(`Extracted claim ${claimId}`);
console.log(`Evidence: ${evidenceId}`);

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

function slug(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  return normalized || "claim";
}

function hash(value, length) {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, length);
}

function splitList(value) {
  if (!value) return [];
  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function unique(rows) {
  return Array.from(new Set(rows.filter(Boolean)));
}

async function readOrDefault(file, fallback) {
  try {
    return await readJsonFile(file);
  } catch {
    return fallback;
  }
}

function upsertById(rows, row) {
  return [...rows.filter((item) => item.id !== row.id), row];
}
