import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./data-utils.mjs";
import { hash, nowShanghai } from "./services/router-service.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERENITY_HOME = path.join(ROOT, "vendor", "serenity-chan");
const PYTHON = "/Users/edy/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";

const DATASET_LABELS = {
  current_quote: "当前行情",
  price_history_adjusted: "复权K线",
  valuation_inputs: "估值输入",
  financials: "财务报表",
  filings_announcements: "公告材料",
  customer_order_capacity_evidence: "订单/客户/产能证据",
};

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/run_serenity_ai_outcomes.mjs --all
  node scripts/run_serenity_ai_outcomes.mjs --entity-id <entity_id>

Options:
  --force    Rewrite existing serenity_ai_review_outcome outputs.
  --replace-templated-reviews
             Withdraw deterministic template reviews and replace them with a
             validated insufficient-research outcome.
  --dry-run  Print selected rows without writing.
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

try {
  const result = await runAiOutcomes({
    all: Boolean(args.all),
    entityId: args.entityId,
    force: Boolean(args.force),
    replaceTemplatedReviews: Boolean(args.replaceTemplatedReviews),
    dryRun: Boolean(args.dryRun),
  });
  if (args.dryRun) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `Serenity AI outcomes complete. selected=${result.selectedCount}, written=${result.writtenCount}, skipped=${result.skippedCount}, failed=${result.failedCount}`
    );
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function runAiOutcomes(options) {
  if (!options.all && !options.entityId) throw new Error(`Missing --all or --entity-id\n${usage()}`);
  const dashboard = await readJsonFile(path.join(DATA_DIR, "dashboard", "serenity_analysis.json"));
  const rows = selectRows(dashboard.rows || [], options);
  if (options.dryRun) {
    return {
      selectedCount: rows.length,
      rows: rows.map((row) => ({ entityId: row.entityId, name: row.name, ticker: tickerForRow(row) })),
    };
  }

  let writtenCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const row of rows) {
    const outputPath = path.join(DATA_DIR, "analysis", "serenity_outputs", `${row.entityId}.json`);
    const existing = await readOptionalJson(outputPath);
    const templatedReview = isDeterministicTemplateReview(existing);
    if (
      existing?.status === "serenity_ai_review" &&
      !(options.replaceTemplatedReviews && templatedReview)
    ) {
      skippedCount += 1;
      continue;
    }
    if (existing?.status === "serenity_ai_review_outcome" && !options.force) {
      skippedCount += 1;
      continue;
    }

    try {
      const output = await buildOutcomeOutput(row, existing, {
        withdrewTemplatedReview: templatedReview,
      });
      await writeJsonFile(outputPath, output);
      writtenCount += 1;
    } catch (error) {
      failedCount += 1;
      console.error(`${row.entityId}: ${error.message}`);
    }
  }

  return { selectedCount: rows.length, writtenCount, skippedCount, failedCount };
}

function selectRows(rows, options) {
  let selected = rows.filter((row) => tickerForRow(row));
  if (options.entityId) selected = selected.filter((row) => row.entityId === options.entityId);
  return selected.sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-Hans-CN"));
}

async function buildOutcomeOutput(row, existing, options = {}) {
  const symbol = tickerForRow(row);
  const generatedAt = nowShanghai();
  const runDir = await latestFormalRunDir(row.entityId);
  if (!runDir) throw new Error(`${row.name} has no Serenity formal run.`);
  const manifestPath = await findManifestPath(runDir);
  if (!manifestPath) throw new Error(`${row.name} formal run has no manifest.json.`);
  const manifest = await readJsonFile(manifestPath);
  const outcome = buildReviewOutcome(row, symbol, generatedAt, manifest, options);
  const reviewDir = path.join(runDir, "ai_research", symbol);
  const outcomePath = path.join(reviewDir, "ai_review_outcome.json");
  await writeJsonFile(outcomePath, outcome);
  validateOutcome(outcomePath);

  const previousRadar = existing?.display?.stockRadar || {};
  const stockRadar = {
    source: "serenity",
    symbol,
    name: row.name,
    generatedAt,
    quote: previousRadar.quote || {},
    review: {
      status: outcome.ai_review_status,
      reason: outcome.reason,
      requiredEvidence: outcome.required_evidence || [],
      researchQuestions: outcome.research_questions || [],
      outcomePath,
    },
    ai: {
      reviewStatus: outcome.ai_review_status,
    },
    movement: {
      confirmed: [],
      possible: [],
      unexplained: [],
    },
    sentiment: null,
    trend: null,
    risk: [],
    triggers: {},
    nextEvidence: outcome.required_evidence || [],
    evidence: previousRadar.evidence || {},
  };

  return {
    id: `saout_${row.entityId}_${hash(`${symbol}|${generatedAt}|ai_review_outcome`, 12)}`,
    entityId: row.entityId,
    name: row.name,
    generatedAt,
    contractType: "serenity_analysis_output_v0",
    status: "serenity_ai_review_outcome",
    provider: {
      name: "serenity_chan_ai_review_outcome_v0",
      type: "vendored_validator",
      mode: "validated_insufficient_evidence_outcome",
      externalCall: false,
      note: "使用 Serenity ai_review_outcome schema 和 validator；证据不足时不生成 overlay、不展示买点或风险判断。",
    },
    sourceInputPack: {
      contractType: row.contractType,
      analysisStatus: row.analysisStatus,
      ticker: symbol,
      symbol,
    },
    inputRefs: {
      providerRunDir: runDir,
      manifestPath,
      outcomePath,
      dashboardRefs: ["dashboard/serenity_analysis.json"],
    },
    display: {
      mode: "serenity_ai_review_outcome",
      label: "Serenity Review Outcome",
      title: `${row.name} Serenity Review Outcome`,
      summary: outcome.reason,
      currentFocus: outcome.reason,
      toVerify: outcome.required_evidence || [],
      viewLabel: "Review 结果",
      view: "证据不足，不生成买点、因素或风险判断。",
      followup: (outcome.research_questions || [])[0] || "补齐 Serenity 要求的证据后重新运行 AI Review。",
      materialLine: `${symbol} · ${outcome.ai_review_status}`,
      inputState: "AI Review 已校验：证据不足",
      stockRadar,
      aiReviewOutcome: outcome,
    },
    layers: {
      factNotes: [],
      candidateSignals: [],
      analysisNotes: [{ label: "Serenity outcome", text: outcome.reason }],
      evidenceGaps: (outcome.required_evidence || []).map((text) => ({ text, status: "open" })),
      nextVerificationQuestions: (outcome.research_questions || []).map((question) => ({ question, status: "open" })),
      marketContext: {},
      forecastCandidates: [],
    },
    rawArtifacts: {
      aiReviewOutcome: outcome,
    },
    calibration: {
      status: "not_started",
      note: "Insufficient-evidence outcome has no forecast calibration yet.",
    },
    guardrails: [
      "证据不足时不展示完整 AI 分析。",
      "不把行情、低质量门控分或模板风险包装成买卖判断。",
    ],
  };
}

function buildReviewOutcome(row, symbol, generatedAt, manifest, options = {}) {
  const statusByDataset = manifest.data_acquisition?.status_by_dataset || {};
  const missingDatasets = Object.entries(statusByDataset)
    .filter(([, status]) => status !== "OK")
    .map(([dataset, status]) => `${DATASET_LABELS[dataset] || dataset}：${status || "缺失"}`);
  const gaps = ensureTextList(manifest.data_acquisition?.data_gaps).slice(0, 6);
  const manualTasks = ensureTextList(manifest.data_acquisition?.manual_retrieval_tasks).slice(0, 4);
  const requiredEvidence = uniqueNonEmpty([
    ...missingDatasets.map((item) => `补齐 ${item}`),
    ...gaps,
    ...manualTasks,
    "补齐正式订单、客户名称、交付记录或财报收入兑现证据",
  ]).slice(0, 8);

  const withdrewTemplatedReview = Boolean(options.withdrewTemplatedReview);
  return {
    symbol,
    as_of_date: String(generatedAt).slice(0, 10),
    ai_review_status: "FAILED_INSUFFICIENT_EVIDENCE",
    reason: withdrewTemplatedReview
      ? `${row.name} 的批量模板判断已撤回：正式数据已经取到，但尚未完成逐份公告与财报正文的 Serenity 深研，因此不展示个股结论。`
      : `${row.name} 的 Serenity AI Review 已执行到结果校验：关键数据或直接证据不足，因此不生成完整 overlay，不展示买点、因素或风险判断。`,
    required_evidence: withdrewTemplatedReview
      ? [
          "逐份阅读与核心逻辑相关的公告和财报正文",
          "为每条个股事实绑定原文、日期和来源",
          "说明事实如何支持或削弱结论，并给出可验证的改判条件",
        ]
      : requiredEvidence.length
        ? requiredEvidence
        : ["补齐 Serenity manifest 中缺失的数据集后重新运行 AI Review。"],
    source_refs: uniqueNonEmpty(Object.keys(statusByDataset).map((key) => `manifest:${key}`)).slice(0, 8),
    research_questions: [
      `${row.name} 是否有正式披露的客户、订单、交付或收入兑现？`,
      `${row.name} 的机器人相关收入能否在财报或公告中被单独追溯？`,
      `${row.name} 当前行情变化是否有足够证据支撑，而不是只有市场波动？`,
    ],
  };
}

function isDeterministicTemplateReview(output) {
  const confirmed = output?.display?.stockRadar?.movement?.confirmed || [];
  const possible = output?.display?.stockRadar?.movement?.possible || [];
  return (
    confirmed.some((text) =>
      String(text).startsWith(
        "Serenity 正式数据包中的行情、长期复权走势、财务、公告、订单/客户/产能证据和估值输入均已取数"
      )
    ) ||
    possible.some((text) =>
      /当前的财务兑现状态为“(?:增长与现金流相互验证|财务质量偏弱|基本稳定、仍需验证)”/u.test(
        String(text)
      )
    )
  );
}

function validateOutcome(outcomePath) {
  const result = spawnSync(PYTHON, ["scripts/validate_ai_review_outcome.py", outcomePath, "--json"], {
    cwd: SERENITY_HOME,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(`Serenity outcome validation failed: ${result.stderr || result.stdout}`);
  }
}

async function latestFormalRunDir(entityId) {
  const root = path.join(DATA_DIR, "serenity_provider", "formal_runs");
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  const matches = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(`_${entityId}`))
    .map((entry) => path.join(root, entry.name))
    .sort((a, b) => String(b).localeCompare(String(a)));
  return matches[0] || null;
}

async function findManifestPath(runDir) {
  const dataDir = path.join(runDir, "data");
  const entries = await fs.readdir(dataDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(dataDir, entry.name, "manifest.json");
    if (await exists(candidate)) return candidate;
  }
  return null;
}

async function readOptionalJson(filePath) {
  try {
    return await readJsonFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function tickerForRow(row) {
  const ticker = row.profile?.ticker || row.inputPack?.factInputs?.profile?.ticker;
  if (!ticker || ticker === "--" || ticker === "未上市") return null;
  return ticker;
}

function ensureTextList(value) {
  if (!value) return [];
  const rows = Array.isArray(value) ? value : [value];
  return rows
    .map((item) => {
      if (typeof item === "string") return item;
      if (item.next_action) return item.next_action;
      if (item.reason) return item.reason;
      if (item.dataset) return `${DATASET_LABELS[item.dataset] || item.dataset}：${item.gap_type || item.status || "待补"}`;
      try {
        return JSON.stringify(item);
      } catch {
        return String(item);
      }
    })
    .filter(Boolean);
}

function uniqueNonEmpty(rows) {
  return Array.from(new Set(rows.map((row) => String(row || "").trim()).filter(Boolean)));
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") result.help = true;
    else if (
      item === "--all" ||
      item === "--force" ||
      item === "--dry-run" ||
      item === "--replace-templated-reviews"
    ) {
      result[item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
    } else if (item.startsWith("--")) {
      const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      result[key] = argv[index + 1];
      index += 1;
    }
  }
  return result;
}
