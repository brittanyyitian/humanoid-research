import path from "node:path";
import { DATA_DIR, readJsonDir, readJsonFile, writeJsonFile } from "../data-utils.mjs";
import { hash, nowShanghai } from "./router-service.mjs";

const PROJECTION_POLICY =
  "Observations are projected only from formal events with promoted claims and supporting evidence. Pipeline candidates stay in inbox.";

export async function projectObservations(options = {}) {
  const generatedAt = options.generatedAt || nowShanghai();
  const context = await loadObservationContext();
  const dashboard = await readJsonFile(path.join(DATA_DIR, "dashboard", "observations.json"));
  const rows = dashboard.rows || [];
  const projectedRows = rows.map((row) => projectRow(row, context));
  const excludedClaims = buildExcludedClaims(context.claims);
  const violations = projectedRows.flatMap((row) => row.violations);
  const run = {
    id: `obsrun_${String(dashboard.date || generatedAt.slice(0, 10)).replaceAll("-", "_")}_${hash(
      `${dashboard.generatedAt}|${generatedAt}|${rows.length}|${excludedClaims.length}`,
      12
    )}`,
    targetDate: dashboard.date,
    generatedAt,
    sourceDashboardGeneratedAt: dashboard.generatedAt,
    status: violations.length ? "failed" : "completed",
    projectionPolicy: PROJECTION_POLICY,
    observationCount: rows.length,
    projectedCount: projectedRows.filter((row) => row.status === "projected").length,
    excludedClaimCount: excludedClaims.length,
    violationCount: violations.length,
    rows: projectedRows,
    excludedClaims,
    violations,
  };
  const dashboardProjection = {
    date: dashboard.date,
    generatedAt,
    policy: PROJECTION_POLICY,
    latestRunId: run.id,
    status: run.status,
    totals: {
      observations: run.observationCount,
      projected: run.projectedCount,
      excludedClaims: run.excludedClaimCount,
      violations: run.violationCount,
    },
    rows: projectedRows,
    excludedClaims,
    violations,
  };

  if (!options.dryRun) {
    await writeJsonFile(path.join(DATA_DIR, "observation_runs", `${run.id}.json`), run);
    await writeJsonFile(path.join(DATA_DIR, "dashboard", "observation_projection.json"), dashboardProjection);
  }

  return { run, dashboardProjection };
}

async function loadObservationContext() {
  const events = (await readJsonDir("events")).map((row) => row.data);
  const claims = (await readJsonDir("claims")).map((row) => row.data);
  const evidenceRows = (await readJsonDir("evidence")).map((row) => row.data);
  const stateTransitions = (await readJsonDir("state_transitions")).map((row) => row.data);
  const eventById = new Map(events.map((event) => [event.id, event]));
  const claimById = new Map(claims.map((claim) => [claim.id, claim]));
  const evidenceByClaimId = new Map();
  const stateTransitionsByClaimId = new Map();

  for (const evidence of evidenceRows) pushMap(evidenceByClaimId, evidence.claimId, evidence);
  for (const transition of stateTransitions) {
    if (transition.subjectType === "claim") pushMap(stateTransitionsByClaimId, transition.subjectId, transition);
  }

  return { claims, eventById, claimById, evidenceByClaimId, stateTransitionsByClaimId };
}

function projectRow(row, context) {
  const event = context.eventById.get(row.eventId);
  const claimIds = row.claimIds || [];
  const claimRows = claimIds.map((claimId) => context.claimById.get(claimId)).filter(Boolean);
  const evidenceIds = claimRows.flatMap((claim) => {
    return supportingEvidence(context.evidenceByClaimId.get(claim.id) || []).map((evidence) => evidence.id);
  });
  const stateTransitionIds = claimRows.flatMap((claim) => {
    return (context.stateTransitionsByClaimId.get(claim.id) || []).map((transition) => transition.id);
  });
  const violations = [];

  if (!event) {
    violations.push({
      kind: "missing_event",
      observationId: row.id,
      eventId: row.eventId,
      reason: "Observation row must point to a formal event.",
    });
  }

  if (claimIds.length === 0) {
    violations.push({
      kind: "missing_promoted_claim",
      observationId: row.id,
      eventId: row.eventId,
      reason: "Observation must include at least one promoted claim.",
    });
  }

  if (evidenceIds.length === 0) {
    violations.push({
      kind: "missing_supporting_evidence",
      observationId: row.id,
      eventId: row.eventId,
      reason: "Observation must include supporting evidence from promoted claims.",
    });
  }

  for (const claimId of claimIds) {
    const claim = context.claimById.get(claimId);
    if (!claim) {
      violations.push({
        kind: "missing_claim",
        observationId: row.id,
        claimId,
        reason: "Observation references an unknown claim.",
      });
      continue;
    }
    if (claim.reviewStatus !== "promoted" || !claim.promotedEventIds?.includes(row.eventId)) {
      violations.push({
        kind: "unpromoted_claim",
        observationId: row.id,
        claimId,
        reason: "Observation may include only claims promoted to its formal event.",
      });
    }
    if (supportingEvidence(context.evidenceByClaimId.get(claimId) || []).length === 0) {
      violations.push({
        kind: "claim_without_supporting_evidence",
        observationId: row.id,
        claimId,
        reason: "Promoted claims in an observation must carry supporting evidence.",
      });
    }
  }

  return {
    observationId: row.id,
    eventId: row.eventId,
    gate: "formal_event_and_promoted_claims",
    status: violations.length ? "blocked" : "projected",
    title: row.title,
    date: row.date,
    claimIds,
    evidenceIds,
    stateTransitionIds,
    violations,
  };
}

function supportingEvidence(rows) {
  return rows.filter((row) => ["supports", "updates", "mentions"].includes(row.relation));
}

function buildExcludedClaims(claims) {
  return claims
    .filter((claim) => claim.reviewStatus !== "promoted" || !claim.promotedEventIds?.length)
    .map((claim) => ({
      claimId: claim.id,
      status: claim.status,
      reviewStatus: claim.reviewStatus,
      reason:
        claim.reviewStatus === "promoted"
          ? "claim_has_no_promoted_event"
          : "claim_not_promoted",
    }))
    .sort((a, b) => a.claimId.localeCompare(b.claimId));
}

function pushMap(map, key, value) {
  if (!key) return;
  const rows = map.get(key) || [];
  rows.push(value);
  map.set(key, rows);
}
