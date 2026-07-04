import path from "node:path";
import { DATA_DIR, readJsonDir, readJsonFile, writeJsonFile } from "../data-utils.mjs";
import { dateFrom, hash, nowShanghai } from "./router-service.mjs";

const PIPELINE_HANDLERS = {
  company_pipeline: companyClaim,
  product_pipeline: productClaim,
  filing_pipeline: filingClaim,
  event_pipeline: eventClaim,
  policy_pipeline: policyClaim,
  supply_chain_pipeline: supplyChainClaim,
};

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
  const handler = PIPELINE_HANDLERS[task.pipeline] || genericClaim;
  const processedAt = options.startedAt;
  const claimDraft = handler({ task, artifact, source, routeDecision, processedAt });
  const { claim, evidence, paths } = buildClaimEvidence({
    task,
    artifact,
    source,
    claimDraft,
    processedAt,
  });
  const pipelineRun = buildPipelineRun({ task, claim, evidence, processedAt });
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
    pipelineRunIds: unique([...(task.pipelineRunIds || []), pipelineRun.id]),
    notes: "Pipeline generated claim/evidence candidates. Review is still required before promotion.",
  };
  const inbox = await buildClaimInbox({ claim, evidence, artifact, source, processedAt });

  if (!options.dryRun) {
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
    pipelineRunId: pipelineRun.id,
    error: null,
  };
}

function buildClaimEvidence({ task, artifact, source, claimDraft, processedAt }) {
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
    whyNow: claimDraft.whyNow,
    notes: claimDraft.notes,
  };

  const evidence = {
    id: evidenceId,
    claimId,
    rawArtifactId: artifact.id,
    sourceId: artifact.sourceId,
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

function buildPipelineRun({ task, claim, evidence, processedAt }) {
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
    error: null,
    notes: "Pipeline execution created inbox claim/evidence candidates only.",
  };
}

async function buildClaimInbox({ claim, evidence, artifact, source, processedAt }) {
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
    text: claim.text,
    normalizedFact: claim.normalizedFact,
    claimType: claim.claimType,
    entityIds: claim.entityIds,
    sourceId: artifact.sourceId,
    sourceLevel: evidence.sourceLevel,
    confidence: claim.confidence,
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

function productClaim({ artifact, routeDecision, processedAt }) {
  return {
    claimType: "product_release",
    text: `${artifact.publisher}存在官方产品材料《${artifact.title}》。`,
    normalizedFact: `${artifact.publisher} has official product material for "${artifact.title}".`,
    confidence: routeDecision.confidence === "high" ? "medium" : "low",
    relation: "supports",
    strength: "medium",
    quote: artifact.title,
    whyNow: "Router 将原始材料分配至 product_pipeline，pipeline 生成待审核产品事实候选。",
    notes: `Generated by product_pipeline at ${processedAt}. This candidate is not promoted truth.`,
    evidenceNotes: "Official product material supports the existence of a product-related candidate.",
  };
}

function filingClaim({ artifact, processedAt }) {
  return {
    claimType: "filing",
    text: `${artifact.publisher}存在待审核公告/披露材料《${artifact.title}》。`,
    normalizedFact: `${artifact.publisher} has filing/disclosure material: "${artifact.title}".`,
    confidence: "medium",
    relation: "mentions",
    strength: "medium",
    quote: artifact.title,
    whyNow: "Router 将原始材料分配至 filing_pipeline，pipeline 生成待审核披露事实候选。",
    notes: `Generated by filing_pipeline at ${processedAt}. Review required.`,
  };
}

function policyClaim({ artifact, processedAt }) {
  return {
    claimType: "other",
    text: `${artifact.publisher}存在待审核政策相关材料《${artifact.title}》。`,
    normalizedFact: `${artifact.publisher} has policy-related material: "${artifact.title}".`,
    confidence: "medium",
    relation: "mentions",
    strength: "medium",
    quote: artifact.title,
    whyNow: "Router 将原始材料分配至 policy_pipeline，pipeline 生成待审核政策事实候选。",
    notes: `Generated by policy_pipeline at ${processedAt}. Review required.`,
  };
}

function companyClaim({ artifact, processedAt }) {
  return {
    claimType: "other",
    text: `${artifact.publisher}存在待审核公司动态材料《${artifact.title}》。`,
    normalizedFact: `${artifact.publisher} has company update material: "${artifact.title}".`,
    confidence: "medium",
    relation: "mentions",
    strength: "medium",
    quote: artifact.title,
    whyNow: "Router 将原始材料分配至 company_pipeline，pipeline 生成待审核公司事实候选。",
    notes: `Generated by company_pipeline at ${processedAt}. Review required.`,
  };
}

function eventClaim({ artifact, processedAt }) {
  return {
    claimType: "other",
    text: `${artifact.publisher}存在待审核事件材料《${artifact.title}》。`,
    normalizedFact: `${artifact.publisher} has event-like material: "${artifact.title}".`,
    confidence: "medium",
    relation: "mentions",
    strength: "medium",
    quote: artifact.title,
    whyNow: "Router 将原始材料分配至 event_pipeline，pipeline 生成待审核事件事实候选。",
    notes: `Generated by event_pipeline at ${processedAt}. Review required.`,
  };
}

function supplyChainClaim({ artifact, processedAt }) {
  return {
    claimType: "other",
    text: `${artifact.publisher}存在待审核供应链相关材料《${artifact.title}》。`,
    normalizedFact: `${artifact.publisher} has supply-chain-related material: "${artifact.title}".`,
    confidence: "medium",
    relation: "mentions",
    strength: "medium",
    quote: artifact.title,
    whyNow: "Router 将原始材料分配至 supply_chain_pipeline，pipeline 生成待审核供应链事实候选。",
    notes: `Generated by supply_chain_pipeline at ${processedAt}. Review required.`,
  };
}

function genericClaim({ artifact, processedAt }) {
  return {
    claimType: "other",
    text: `${artifact.publisher}存在待审核材料《${artifact.title}》。`,
    normalizedFact: `${artifact.publisher} has review material: "${artifact.title}".`,
    confidence: "low",
    relation: "mentions",
    strength: "weak",
    quote: artifact.title,
    whyNow: "Pipeline 生成待审核事实候选。",
    notes: `Generated by generic pipeline at ${processedAt}. Review required.`,
  };
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

function upsertById(rows, row) {
  return [...rows.filter((item) => item.id !== row.id), row];
}
