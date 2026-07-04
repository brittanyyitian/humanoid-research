import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR } from "./data-utils.mjs";
import { applySkillRule } from "./services/rule-engine-service.mjs";

const suitePath = path.join(DATA_DIR, "rule_contract", "stress_cases.json");
const suite = JSON.parse(await fs.readFile(suitePath, "utf8"));
const failures = [];
const results = [];

for (const testCase of suite.cases || []) {
  const output = applySkillRule(testCase.input);
  const replay = applySkillRule(testCase.input);
  const caseFailures = [];

  assert(sameJson(stableOutput(output), stableOutput(replay)), "rule output is not deterministic", caseFailures);
  assertContractSurface(output, caseFailures);
  assertExpectations(output, testCase.expect || {}, caseFailures);
  assertNoInvestmentConclusion(output, suite.forbiddenInvestmentClaimTerms || [], caseFailures);

  results.push({
    id: testCase.id,
    status: caseFailures.length ? "failed" : "passed",
    ruleOutputId: output.id,
    ruleId: output.ruleId,
    failures: caseFailures,
  });
  for (const failure of caseFailures) failures.push(`${testCase.id}: ${failure}`);
}

if (failures.length > 0) {
  console.error("Rule Contract stress test failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(`Rule Contract stress test passed. cases=${results.length}`);
for (const result of results) {
  console.log(`PASS ${result.id} ${result.ruleId} ${result.ruleOutputId}`);
}

function assertContractSurface(output, failuresForCase) {
  assert(output.contractVersion === "skill_rule_contract_v0", "contractVersion must be skill_rule_contract_v0", failuresForCase);
  assert(output.id && output.id.startsWith("rout_"), "id must be a rule output id", failuresForCase);
  assert(output.ruleId, "ruleId is required", failuresForCase);
  assert(output.pipeline, "pipeline is required", failuresForCase);
  assert(output.rawArtifactId, "rawArtifactId is required", failuresForCase);
  assert(output.sourceId, "sourceId is required", failuresForCase);
  assert(Array.isArray(output.claimCandidates) && output.claimCandidates.length > 0, "claimCandidates must be non-empty", failuresForCase);
  assert(
    Array.isArray(output.evidenceCandidates) && output.evidenceCandidates.length > 0,
    "evidenceCandidates must be non-empty",
    failuresForCase
  );
  assert(Array.isArray(output.unknowns), "unknowns must be an array", failuresForCase);
  assert(Array.isArray(output.followupHints), "followupHints must be an array", failuresForCase);
  assert(Array.isArray(output.dataGaps), "dataGaps must be an array", failuresForCase);
  assert(Array.isArray(output.extractedFields), "extractedFields must be an array", failuresForCase);
  assert(Array.isArray(output.reviewRequirements) && output.reviewRequirements.length > 0, "reviewRequirements required", failuresForCase);
  assert(output.timeFields?.capturedAt, "timeFields.capturedAt is required", failuresForCase);
  assert(output.timeFields?.processedAt, "timeFields.processedAt is required", failuresForCase);
}

function assertExpectations(output, expect, failuresForCase) {
  if (expect.ruleId) assert(output.ruleId === expect.ruleId, `expected ruleId ${expect.ruleId}, got ${output.ruleId}`, failuresForCase);

  const claimText = output.claimCandidates.map((row) => `${row.claimType} ${row.text} ${row.normalizedFact || ""}`).join("\n");
  const evidenceText = output.evidenceCandidates.map((row) => `${row.relation} ${row.quote} ${row.notes || ""}`).join("\n");
  const unknownFields = new Set(output.unknowns.map((row) => row.field));
  const followupKinds = new Set(output.followupHints.map((row) => row.kind));
  const dataGapKinds = new Set(output.dataGaps.map((row) => row.kind));
  const reviewRequirementKinds = new Set(output.reviewRequirements.map((row) => row.kind));
  const extractedFields = new Set(output.extractedFields.map((row) => row.field));
  const evidenceRelations = new Set(output.evidenceCandidates.map((row) => row.relation));
  const claimTypes = new Set(output.claimCandidates.map((row) => row.claimType));

  for (const expected of expect.claimTypes || []) {
    assert(claimTypes.has(expected), `missing claim type ${expected}`, failuresForCase);
  }
  for (const expected of expect.claimIncludes || []) {
    assert(claimText.includes(expected), `claim text does not include "${expected}"`, failuresForCase);
  }
  for (const expected of expect.evidenceIncludes || []) {
    assert(evidenceText.includes(expected), `evidence text does not include "${expected}"`, failuresForCase);
  }
  for (const expected of expect.evidenceRelations || []) {
    assert(evidenceRelations.has(expected), `missing evidence relation ${expected}`, failuresForCase);
  }
  for (const expected of expect.unknownFields || []) {
    assert(unknownFields.has(expected), `missing unknown field ${expected}`, failuresForCase);
  }
  for (const expected of expect.followupKinds || []) {
    assert(followupKinds.has(expected), `missing followup kind ${expected}`, failuresForCase);
  }
  for (const expected of expect.dataGapKinds || []) {
    assert(dataGapKinds.has(expected), `missing data gap kind ${expected}`, failuresForCase);
  }
  for (const expected of expect.reviewRequirementKinds || []) {
    assert(reviewRequirementKinds.has(expected), `missing review requirement ${expected}`, failuresForCase);
  }
  for (const expected of expect.extractedFields || []) {
    assert(extractedFields.has(expected), `missing extracted field ${expected}`, failuresForCase);
  }
  for (const [field, expected] of Object.entries(expect.timeFields || {})) {
    assert(output.timeFields?.[field] === expected, `expected timeFields.${field}=${expected}, got ${output.timeFields?.[field]}`, failuresForCase);
  }
}

function assertNoInvestmentConclusion(output, forbiddenTerms, failuresForCase) {
  const claimSurface = output.claimCandidates
    .map((row) => `${row.text} ${row.normalizedFact || ""} ${row.whyNow || ""} ${row.notes || ""}`)
    .join("\n");
  const evidenceSurface = output.evidenceCandidates.map((row) => `${row.quote} ${row.notes || ""}`).join("\n");
  const surface = `${claimSurface}\n${evidenceSurface}`;
  for (const term of forbiddenTerms) {
    assert(!surface.includes(term), `claim/evidence surface contains forbidden investment term "${term}"`, failuresForCase);
  }
}

function stableOutput(output) {
  return {
    id: output.id,
    contractVersion: output.contractVersion,
    ruleId: output.ruleId,
    pipeline: output.pipeline,
    rawArtifactId: output.rawArtifactId,
    sourceId: output.sourceId,
    routeDecisionId: output.routeDecisionId,
    payloadStatus: output.payloadStatus,
    claimCandidates: output.claimCandidates,
    evidenceCandidates: output.evidenceCandidates,
    unknowns: output.unknowns,
    followupHints: output.followupHints,
    dataGaps: output.dataGaps,
    extractedFields: output.extractedFields,
    timeFields: output.timeFields,
    reviewRequirements: output.reviewRequirements,
  };
}

function assert(condition, message, failuresForCase) {
  if (!condition) failuresForCase.push(message);
}

function sameJson(left, right) {
  return stableStringify(left) === stableStringify(right);
}

function stableStringify(value) {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}
