import path from "node:path";
import { DATA_DIR, readJsonDir, readJsonFile, writeJsonFile } from "../data-utils.mjs";
import { dateFrom, hash, nowShanghai } from "./router-service.mjs";
import { applySkillRule, claimDraftFromRuleOutput, ruleOutputPath } from "./rule-engine-service.mjs";

export async function runPipelineTasks(options = {}) {
  const startedAt = options.now || nowShanghai();
  const taskRows = await readJsonDir("pipeline_tasks");
  const tasks = taskRows.map((row) => row.data);
  const selectedTasks = selectTasks(tasks, options);
  const results = [];

  for (const task of selectedTasks) {
    results.push(await runOneTask(task, { ...options, startedAt }));
  }

  return {
    startedAt,
    finishedAt: nowShanghai(),
    dryRun: Boolean(options.dryRun),
    selectedCount: selectedTasks.length,
    successCount: results.filter((result) => result.status === "completed").length,
    skippedCount: results.filter((result) => result.status === "skipped").length,
    failureCount: results.filter((result) => result.status === "failed").length,
    results,
  };
}

async function runOneTask(task, options) {
  if (!options.force && !["queued", "failed"].includes(task.status)) {
    return {
      taskId: task.id,
      pipeline: task.pipeline,
      status: "skipped",
      reason: `task status is ${task.status}`,
      claimIds: task.claimIds || [],
      evidenceIds: task.evidenceIds || [],
      pipelineRunId: null,
      error: null,
    };
  }

  const artifact = await readJsonFile(path.join(DATA_DIR, "raw_artifacts", `${task.rawArtifactId}.json`));
  const source = await readJsonFile(path.join(DATA_DIR, "sources", `${artifact.sourceId}.json`));
  const fetchRun = await readJsonFile(path.join(DATA_DIR, "fetch_runs", `${artifact.fetchRunId}.json`));
  const routeDecision = await readJsonFile(path.join(DATA_DIR, "route_decisions", `${task.routeDecisionId}.json`));
  const rawPayload = await readRawPayload(artifact);
  const processedAt = options.startedAt;
  const ruleOutput = applySkillRule({ task, artifact, source, fetchRun, routeDecision, rawPayload, processedAt });
  const claimDraft = claimDraftFromRuleOutput(ruleOutput);
  const { claim, evidence, paths } = buildClaimEvidence({
    task,
    artifact,
    source,
    claimDraft,
    ruleOutput,
    processedAt,
  });
  const pipelineRun = buildPipelineRun({ task, claim, evidence, ruleOutput, processedAt });
  const updatedArtifact = {
    ...artifact,
    claimIds: unique([...(artifact.claimIds || []), claim.id]),
  };
  const updatedFetchRun = {
    ...fetchRun,
    claimIds: unique([...(fetchRun.claimIds || []), claim.id]),
  };
  const updatedTask = {
    ...task,
    status: "completed",
    updatedAt: processedAt,
    startedAt: task.startedAt || processedAt,
    finishedAt: processedAt,
    nextAction: "review generated claim candidates",
    error: null,
    claimIds: unique([...(task.claimIds || []), claim.id]),
    evidenceIds: unique([...(task.evidenceIds || []), evidence.id]),
    ruleOutputIds: unique([...(task.ruleOutputIds || []), ruleOutput.id]),
    pipelineRunIds: unique([...(task.pipelineRunIds || []), pipelineRun.id]),
    notes: "Pipeline generated claim/evidence candidates. Review is still required before promotion.",
  };
  const inbox = await buildClaimInbox({ claim, evidence, ruleOutput, artifact, source, processedAt });

  if (!options.dryRun) {
    await writeJsonFile(ruleOutputPath(ruleOutput.id), ruleOutput);
    await writeJsonFile(paths.claim, claim);
    await writeJsonFile(paths.evidence, evidence);
    await writeJsonFile(path.join(DATA_DIR, "raw_artifacts", `${artifact.id}.json`), updatedArtifact);
    await writeJsonFile(path.join(DATA_DIR, "fetch_runs", `${fetchRun.id}.json`), updatedFetchRun);
    await writeJsonFile(path.join(DATA_DIR, "pipeline_tasks", `${task.id}.json`), updatedTask);
    await writeJsonFile(path.join(DATA_DIR, "pipeline_runs", `${pipelineRun.id}.json`), pipelineRun);
    await writeJsonFile(path.join(DATA_DIR, "inbox", "claim_candidates.json"), inbox);
  }

  return {
    taskId: task.id,
    pipeline: task.pipeline,
    status: "completed",
    reason: "generated claim/evidence candidate",
    claimIds: [claim.id],
    evidenceIds: [evidence.id],
    ruleOutputIds: [ruleOutput.id],
    pipelineRunId: pipelineRun.id,
    error: null,
  };
}

function buildClaimEvidence({ task, artifact, source, claimDraft, ruleOutput, processedAt }) {
  const date = dateFrom(claimDraft.occurredAt || claimDraft.publishedAt || artifact.publishedAt || artifact.firstSeenAt);
  const digest = hash(`${task.id}|${artifact.id}|${claimDraft.text}`, 10);
  const token = `${slug(claimDraft.claimType)}_${digest}`;
  const claimId = `claim_${date.replaceAll("-", "_")}_${token}`;
  const evidenceId = `evd_${date.replaceAll("-", "_")}_${token}`;

  const claim = {
    id: claimId,
    claimType: claimDraft.claimType,
    text: claimDraft.text,
    normalizedFact: claimDraft.normalizedFact || claimDraft.text,
    entityIds: task.entityIds,
    productIds: claimDraft.productIds || [],
    artifactIds: [artifact.id],
    status: "candidate",
    reviewStatus: "inbox",
    confidence: claimDraft.confidence || "medium",
    occurredAt: claimDraft.occurredAt || null,
    publishedAt: claimDraft.publishedAt || artifact.publishedAt || null,
    firstSeenAt: artifact.firstSeenAt,
    capturedAt: artifact.capturedAt,
    processedAt,
    dueAt: claimDraft.dueAt || null,
    resolvedAt: null,
    promotedEventIds: [],
    promotedFollowupIds: [],
    ruleOutputIds: [ruleOutput.id],
    unknowns: claimDraft.unknowns || [],
    followupHints: claimDraft.followupHints || [],
    dataGaps: claimDraft.dataGaps || [],
    reviewRequirements: claimDraft.reviewRequirements || [],
    whyNow: claimDraft.whyNow,
    notes: claimDraft.notes,
  };

  const evidence = {
    id: evidenceId,
    claimId,
    rawArtifactId: artifact.id,
    sourceId: artifact.sourceId,
    ruleOutputId: ruleOutput.id,
    relation: claimDraft.relation || "mentions",
    sourceLevel: claimDraft.sourceLevel || source.evidenceLevel || "A",
    strength: claimDraft.strength || "medium",
    quote: claimDraft.quote || artifact.title,
    capturedAt: artifact.capturedAt,
    assessedAt: processedAt,
    notes: claimDraft.evidenceNotes || "Pipeline-generated evidence link. Review required.",
  };

  return {
    claim,
    evidence,
    paths: {
      claim: path.join(DATA_DIR, "claims", `${claimId}.json`),
      evidence: path.join(DATA_DIR, "evidence", `${evidenceId}.json`),
    },
  };
}

function buildPipelineRun({ task, claim, evidence, ruleOutput, processedAt }) {
  const date = dateFrom(processedAt);
  return {
    id: `prun_${date.replaceAll("-", "_")}_${hash(`${task.id}|${claim.id}|${processedAt}`, 12)}`,
    pipelineTaskId: task.id,
    rawArtifactId: task.rawArtifactId,
    routeDecisionId: task.routeDecisionId,
    pipeline: task.pipeline,
    status: "completed",
    startedAt: processedAt,
    finishedAt: processedAt,
    claimIds: [claim.id],
    evidenceIds: [evidence.id],
    ruleOutputIds: [ruleOutput.id],
    error: null,
    notes: "Pipeline execution created rule_output plus inbox claim/evidence candidates only.",
  };
}

async function buildClaimInbox({ claim, evidence, ruleOutput, artifact, source, processedAt }) {
  const inboxPath = path.join(DATA_DIR, "inbox", "claim_candidates.json");
  const inbox = await readOrDefault(inboxPath, {
    date: processedAt.slice(0, 10),
    capturedAt: processedAt,
    reviewStatus: "pending_manual_review",
    policy: "Claim candidates are not formal truth until promoted by review.",
    candidates: [],
  });
  const candidate = {
    id: `claim_candidate_${hash(`${claim.id}|${evidence.id}`, 10)}`,
    claimId: claim.id,
    rawArtifactId: artifact.id,
    evidenceId: evidence.id,
    ruleOutputId: ruleOutput.id,
    text: claim.text,
    normalizedFact: claim.normalizedFact,
    claimType: claim.claimType,
    entityIds: claim.entityIds,
    sourceId: artifact.sourceId,
    sourceLevel: evidence.sourceLevel,
    confidence: claim.confidence,
    unknowns: claim.unknowns || [],
    followupHints: claim.followupHints || [],
    dataGaps: claim.dataGaps || [],
    reviewRequirements: claim.reviewRequirements || [],
    reviewStatus: "pending",
    processedAt,
    sourceTitle: source.title,
  };
  inbox.date = processedAt.slice(0, 10);
  inbox.capturedAt = processedAt;
  inbox.policy = "Claim candidates are not formal truth until promoted by review.";
  inbox.candidates = upsertById(inbox.candidates || [], candidate);
  return inbox;
}

function selectTasks(tasks, options) {
  return tasks.filter((task) => {
    if (options.taskId && task.id !== options.taskId) return false;
    if (options.pipeline && task.pipeline !== options.pipeline) return false;
    if (!options.all && !options.taskId && !options.pipeline) return false;
    if (options.force) return true;
    return task.status === "queued";
  });
}

function slug(value) {
  const normalized = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 36);
  return normalized || "claim";
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

async function readRawPayload(artifact) {
  if (!artifact.storagePath) return null;
  try {
    return await readJsonFile(path.join(DATA_DIR, artifact.storagePath));
  } catch {
    return null;
  }
}

function upsertById(rows, row) {
  return [...rows.filter((item) => item.id !== row.id), row];
}
