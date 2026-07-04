import crypto from "node:crypto";
import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./data-utils.mjs";

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/promote_claim.mjs --claim-id <id> --event-type <type> --module <name> --title <title>

Options:
  --fact <text>              Default: claim.normalizedFact
  --importance <1-5>         Default: 3
  --followup-subject <text>  Create a pending follow-up
  --followup-due-at <date>
  --tags <tag,tag>
  --allow-repromote          Allow promoting a claim that is already promoted
  --dry-run
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

const required = ["claimId", "eventType", "module", "title"];
const missing = required.filter((key) => !args[key]);
if (missing.length) {
  console.error(`Missing required option(s): ${missing.join(", ")}`);
  console.error(usage());
  process.exit(1);
}

const claimPath = path.join(DATA_DIR, "claims", `${args.claimId}.json`);
const claim = await readJsonFile(claimPath);
const evidenceRows = await readEvidenceForClaim(args.claimId);
if (claim.reviewStatus === "promoted" && !args.allowRepromote) {
  console.error(`Claim ${claim.id} is already promoted. Pass --allow-repromote to override.`);
  process.exit(1);
}
if (evidenceRows.length === 0) {
  console.error(`Claim ${claim.id} has no evidence records.`);
  process.exit(1);
}
const sourceIds = unique(evidenceRows.map((row) => row.sourceId));
const evidenceLevel = strongestLevel(evidenceRows.map((row) => row.sourceLevel));
const now = nowShanghai();
const eventDate = dateFrom(claim.occurredAt || claim.publishedAt || claim.firstSeenAt || now);
const token = `${slug(args.eventType)}_${hash(`${args.claimId}|${args.title}`, 10)}`;
const eventId = `evt_${eventDate.replaceAll("-", "_")}_${token}`;
const eventPath = path.join(DATA_DIR, "events", `${eventId}.json`);
const followupId = args.followupSubject
  ? `fu_${eventDate.replaceAll("-", "_")}_${hash(`${args.claimId}|${args.followupSubject}`, 12)}`
  : null;
const followupPath = followupId ? path.join(DATA_DIR, "followups", `${followupId}.json`) : null;
const transitionId = `st_${now.slice(0, 10).replaceAll("-", "_")}_${hash(`${args.claimId}|promoted|${now}`, 12)}`;
const transitionPath = path.join(DATA_DIR, "state_transitions", `${transitionId}.json`);

const event = {
  id: eventId,
  date: eventDate,
  eventType: args.eventType,
  module: args.module,
  entityIds: claim.entityIds,
  title: args.title,
  fact: args.fact || claim.normalizedFact || claim.text,
  importance: Number(args.importance || 3),
  sourceIds,
  evidenceLevel,
  createdAt: now,
  tags: splitList(args.tags),
};

const followup = followupId
  ? {
      id: followupId,
      subject: args.followupSubject,
      entityIds: claim.entityIds,
      originEventId: eventId,
      status: "pending",
      openedAt: now.slice(0, 10),
      closedAt: null,
      sourceIds,
      history: [
        {
          date: now.slice(0, 10),
          status: "pending",
          sourceIds,
          note: args.followupDueAt
            ? `Promoted from claim; due window ${args.followupDueAt}.`
            : "Promoted from claim; waiting for follow-up evidence.",
        },
      ],
    }
  : null;

const updatedClaim = {
  ...claim,
  status: "verified",
  reviewStatus: "promoted",
  processedAt: now,
  resolvedAt: now,
  dueAt: args.followupDueAt || claim.dueAt || null,
  promotedEventIds: unique([...(claim.promotedEventIds || []), eventId]),
  promotedFollowupIds: followupId ? unique([...(claim.promotedFollowupIds || []), followupId]) : claim.promotedFollowupIds || [],
};

const transition = {
  id: transitionId,
  subjectType: "claim",
  subjectId: claim.id,
  fromStatus: claim.status,
  toStatus: "verified",
  occurredAt: now,
  reason: "Manual review promoted claim into formal event layer.",
  evidenceIds: evidenceRows.map((row) => row.id),
  sourceIds,
  actor: "promote_claim_v1",
};

const inboxPath = path.join(DATA_DIR, "inbox", "claim_candidates.json");
const inbox = await readOrDefault(inboxPath, null);
const updatedInbox = inbox
  ? {
      ...inbox,
      candidates: (inbox.candidates || []).map((candidate) =>
        candidate.claimId === claim.id
          ? {
              ...candidate,
              reviewStatus: "promoted",
              promotedEventId: eventId,
              promotedFollowupId: followupId,
              reviewedAt: now,
            }
          : candidate
      ),
    }
  : null;

const payloads = [
  ["event", eventPath, event],
  ["claim", claimPath, updatedClaim],
  ["state_transition", transitionPath, transition],
];
if (followup) payloads.push(["followup", followupPath, followup]);
if (updatedInbox) payloads.push(["inbox", inboxPath, updatedInbox]);

if (args.dryRun) {
  console.log(JSON.stringify(Object.fromEntries(payloads.map(([key, file, data]) => [key, { file, data }])), null, 2));
  process.exit(0);
}

await writeJsonFile(eventPath, event);
if (followup) await writeJsonFile(followupPath, followup);
await writeJsonFile(claimPath, updatedClaim);
await writeJsonFile(transitionPath, transition);
if (updatedInbox) await writeJsonFile(inboxPath, updatedInbox);

console.log(`Promoted claim ${claim.id}`);
console.log(`Event: ${eventId}`);
if (followupId) console.log(`Follow-up: ${followupId}`);

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      result.help = true;
    } else if (item === "--dry-run") {
      result.dryRun = true;
    } else if (item === "--allow-repromote") {
      result.allowRepromote = true;
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

async function readEvidenceForClaim(claimId) {
  const evidenceDir = path.join(DATA_DIR, "evidence");
  const { readdir } = await import("node:fs/promises");
  const files = await readdir(evidenceDir);
  const rows = [];
  for (const file of files.filter((item) => item.endsWith(".json"))) {
    const row = await readJsonFile(path.join(evidenceDir, file));
    if (row.claimId === claimId) rows.push(row);
  }
  return rows;
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
  return normalized || "event";
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

function strongestLevel(levels) {
  const rank = { A: 4, B: 3, C: 2, D: 1 };
  return levels.slice().sort((a, b) => (rank[b] || 0) - (rank[a] || 0))[0] || "D";
}

async function readOrDefault(file, fallback) {
  try {
    return await readJsonFile(file);
  } catch {
    return fallback;
  }
}
