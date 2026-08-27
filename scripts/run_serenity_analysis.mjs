import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./data-utils.mjs";
import { hash, nowShanghai } from "./services/router-service.mjs";

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/run_serenity_analysis.mjs --all
  node scripts/run_serenity_analysis.mjs --entity-id <entity_id>

Options:
  --limit <n>          Limit selected rows
  --include-needs      Include rows that still need body/material work
  --force-local        Overwrite existing external Serenity outputs with local briefs
  --dry-run            Print summary without writing files
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

try {
  const result = await runSerenityAnalysis({
    all: Boolean(args.all),
    entityId: args.entityId,
    limit: Number.parseInt(args.limit || "", 10),
    includeNeeds: Boolean(args.includeNeeds),
    forceLocal: Boolean(args.forceLocal),
    dryRun: Boolean(args.dryRun),
  });

  if (args.dryRun) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(
      `Serenity analysis complete. selected=${result.selectedCount}, written=${result.writtenCount}, skipped=${result.skippedCount}`
    );
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function runSerenityAnalysis(options) {
  if (!options.all && !options.entityId) {
    throw new Error(`Missing --all or --entity-id\n${usage()}`);
  }

  const generatedAt = nowShanghai();
  const dashboard = await readJsonFile(path.join(DATA_DIR, "dashboard", "serenity_analysis.json"));
  const rows = selectRows(dashboard.rows || [], options);
  const rowsToRun = [];
  let preservedExternalCount = 0;
  for (const row of rows) {
    const existing = await readExistingOutput(row.entityId);
    if (!options.forceLocal && existing?.provider?.externalCall) {
      preservedExternalCount += 1;
      continue;
    }
    rowsToRun.push(row);
  }
  const outputs = rowsToRun.map((row) => compileAnalysisOutput(row, { generatedAt, dashboard }));

  if (!options.dryRun) {
    for (const output of outputs) {
      await writeJsonFile(path.join(DATA_DIR, "analysis", "serenity_outputs", `${output.entityId}.json`), output);
    }
  }

  return {
    generatedAt,
    selectedCount: rows.length,
    writtenCount: options.dryRun ? 0 : outputs.length,
    preservedExternalCount,
    skippedCount: (dashboard.rows || []).length - rows.length,
    entityIds: outputs.map((output) => output.entityId),
  };
}

async function readExistingOutput(entityId) {
  try {
    return await readJsonFile(path.join(DATA_DIR, "analysis", "serenity_outputs", `${entityId}.json`));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function selectRows(rows, options) {
  let selected = rows.slice();
  if (options.entityId) selected = selected.filter((row) => row.entityId === options.entityId);
  if (!options.includeNeeds) {
    selected = selected.filter((row) => row.analysisStatus?.key === "ready_for_serenity");
  }
  selected = selected.sort(
    (a, b) =>
      (b.inputPack?.materialCounts?.readable || 0) - (a.inputPack?.materialCounts?.readable || 0) ||
      (b.inputPack?.materialCounts?.pendingClaims || 0) - (a.inputPack?.materialCounts?.pendingClaims || 0) ||
      String(a.name).localeCompare(String(b.name), "zh-Hans-CN")
  );
  if (Number.isFinite(options.limit) && options.limit > 0) selected = selected.slice(0, options.limit);
  return selected;
}

function compileAnalysisOutput(row, context) {
  const inputPack = row.inputPack || {};
  const factInputs = inputPack.factInputs || {};
  const topMaterialRefs = inputPack.topMaterialRefs || [];
  const claimIds = inputPack.candidateLayer?.claimIds || [];
  const sourceIds = collectSourceIds(factInputs);
  const evidenceIds = collectEvidenceIds(factInputs, topMaterialRefs);
  const materialIds = topMaterialRefs.map((material) => material.rawArtifactId).filter(Boolean);
  const seed = `${row.entityId}|${context.dashboard.generatedAt}|${materialIds.join(",")}|${claimIds.join(",")}`;

  return {
    id: `saout_${row.entityId}_${hash(seed, 12)}`,
    entityId: row.entityId,
    name: row.name,
    generatedAt: context.generatedAt,
    contractType: "serenity_analysis_output_v0",
    status: "research_brief",
    provider: {
      name: "research_brief_compiler_v0",
      type: "local_compiler",
      externalCall: false,
      note: "本地编译器根据 inputPack 生成研究重点；不是外部 Serenity/LLM 的分析结论。",
    },
    sourceInputPack: {
      dashboardGeneratedAt: context.dashboard.generatedAt,
      contractType: row.contractType,
      analysisStatus: row.analysisStatus,
    },
    inputRefs: {
      materialRawArtifactIds: materialIds,
      claimIds,
      evidenceIds,
      sourceIds,
      dashboardRefs: ["dashboard/serenity_analysis.json", "dashboard/serenity_materials.json", "dashboard/research_reading.json"],
    },
    display: displaySummary(row, topMaterialRefs),
    layers: {
      factNotes: buildFactNotes(row),
      candidateSignals: buildCandidateSignals(row),
      analysisNotes: buildAnalysisNotes(row),
      evidenceGaps: buildEvidenceGaps(row),
      nextVerificationQuestions: buildNextQuestions(row),
      marketContext: buildMarketContextNote(row),
      forecastCandidates: buildForecastCandidates(row),
    },
    calibration: {
      status: "not_started",
      note: "后续如用户采纳某个 forecastCandidate，应创建独立 forecast ledger，并设置复盘日期和判定标准。",
    },
    guardrails: [
      "分析层不写入事实层。",
      "候选 Claim 不等于已验证事实。",
      "不输出买卖建议。",
      "不输出受益判断。",
      "不把市场涨跌解释为事件影响。",
      "所有分析句子必须能回溯到 material、claim、evidence、source 和时间。",
    ],
  };
}

function displaySummary(row, materials) {
  const counts = row.inputPack?.materialCounts || {};
  const currentFocus = currentFocusLine(row);
  const toVerify = toVerifyItems(row);
  const view = systemViewLine(row, materials);
  const followup = followupLine(row);
  return {
    mode: "research_brief",
    label: "研究重点",
    title: `${row.name} 研究重点`,
    summary: currentFocus,
    currentFocus,
    toVerify,
    viewLabel: "系统整理",
    view,
    followup,
    materialLine: topMaterialLine(materials),
    statusLabel: row.analysisStatus?.label || "未标注",
    inputState: `${counts.readable || 0} 条可读材料`,
  };
}

function currentFocusLine(row) {
  const summary = row.inputPack?.factInputs?.researchSummary?.summary || row.analysisDraft?.text || "";
  const firstSentence = String(summary).split(/[。；;]/u).find(Boolean)?.trim();
  if (firstSentence) return firstSentence.endsWith("。") ? firstSentence : `${firstSentence}。`;
  const role = row.inputPack?.factInputs?.profile?.role || "当前对象";
  return `${role}已进入研究观察，证据仍需补齐。`;
}

function toVerifyItems(row) {
  const items = [];
  for (const question of row.nextQuestions || []) {
    const item = shortVerificationItem(question);
    if (item && !items.includes(item)) items.push(item);
    if (items.length >= 3) break;
  }
  for (const gap of row.missingEvidence || []) {
    const item = shortVerificationItem(gap);
    if (item && !items.includes(item)) items.push(item);
    if (items.length >= 3) break;
  }
  return items.length ? items : ["等待新的公开材料"];
}

function shortVerificationItem(value) {
  const text = String(value || "")
    .replace(/^查/u, "")
    .replace(/^确认/u, "")
    .replace(/^等待/u, "")
    .replace(/^复查/u, "")
    .replace(/是否/u, "")
    .replace(/出现/u, "")
    .replace(/公开材料|公告原文|调研纪要|原文|材料/u, "")
    .replace(/正式/u, "")
    .replace(/验证/u, "")
    .replace(/[。；;]/gu, "")
    .trim();
  if (/订单/u.test(text)) return "正式订单";
  if (/客户/u.test(text)) return "客户名称";
  if (/交付/u.test(text)) return "交付记录";
  if (/收入|财务|财报|兑现/u.test(text)) return "收入或财务兑现";
  if (/供应|合作/u.test(text)) return "供应关系";
  if (/正文|PDF/u.test(text)) return "材料正文";
  return text.slice(0, 18);
}

function systemViewLine(row, materials) {
  const types = countBy(materials, (material) => material.materialType).map(([type]) => type);
  const typeText = types.length ? types.slice(0, 2).join("和") : "现有公开材料";
  const missing = row.missingEvidence || [];
  if (missing.some((item) => /订单|客户|交付|财务|收入|兑现/u.test(item))) {
    return `目前主要依据${typeText}，只能支持跟踪和复核，不能支持兑现判断。`;
  }
  return `目前主要依据${typeText}，先看事实变化，再等后续材料验证。`;
}

function followupLine(row) {
  const questions = row.nextQuestions || [];
  if (questions.some((question) => /财报|收入|财务|兑现/u.test(question))) {
    return "下一期财报或公告是否补充收入、客户或业务线信息。";
  }
  if (questions.some((question) => /订单|客户|交付/u.test(question))) {
    return "未来 60-90 天是否出现订单、客户或交付披露。";
  }
  return "未来 60 天是否出现新的官方材料或公告。";
}

function topMaterialLine(materials) {
  const types = countBy(materials, (material) => material.materialType).slice(0, 3);
  if (!types.length) return "暂无可引用材料。";
  return `主要材料：${types.map(([type, count]) => `${type} ${count}`).join(" / ")}`;
}

function buildFactNotes(row) {
  const factInputs = row.inputPack?.factInputs || {};
  const profile = factInputs.profile || {};
  const summary = factInputs.researchSummary || {};
  const notes = [
    {
      label: "对象画像",
      text: `${row.name} 的产业角色为 ${profile.role || "未标注"}，上市状态为 ${profile.listedStatus || "未标注"}。`,
      refs: { dashboardRefs: ["research_reading.profile"] },
    },
  ];

  if (summary.verifiedEvidence?.length) {
    notes.push({
      label: "已覆盖证据",
      text: `已覆盖证据：${summary.verifiedEvidence.slice(0, 5).join("、")}。`,
      refs: { dashboardRefs: ["research_reading.researchSummary.verifiedEvidence"] },
    });
  }

  for (const item of (factInputs.timelineRefs || []).filter((ref) => ref.verificationState === "verified").slice(0, 4)) {
    notes.push({
      label: "已验证变化",
      text: `${item.date || "--"}：${item.title}`,
      refs: {
        changeIds: [item.id],
        sourceIds: item.sourceIds || [],
        evidenceIds: item.evidenceIds || [],
      },
    });
  }

  return notes;
}

function buildCandidateSignals(row) {
  const candidate = row.inputPack?.candidateLayer || {};
  const materialRefs = row.inputPack?.topMaterialRefs || [];
  const signals = [];
  if (candidate.pendingClaimCount) {
    signals.push({
      label: "候选 Claim",
      text: `候选层有 ${candidate.pendingClaimCount} 条 Claim 待审；人工复核前不进入事实层。`,
      refs: { claimIds: (candidate.claimIds || []).slice(0, 10) },
    });
  }

  const materialWithGaps = materialRefs.filter((material) => material.dataGaps?.length).slice(0, 4);
  for (const material of materialWithGaps) {
    signals.push({
      label: "材料缺口",
      text: `${material.title}：${material.dataGaps.slice(0, 2).join("；")}`,
      refs: { materialRawArtifactIds: [material.rawArtifactId], claimIds: material.claimIds || [] },
    });
  }

  if (!signals.length) {
    signals.push({
      label: "候选状态",
      text: "当前未看到明显候选堆积，等待新材料或人工复核结果。",
      refs: { dashboardRefs: ["serenity_analysis.inputPack.candidateLayer"] },
    });
  }
  return signals;
}

function buildAnalysisNotes(row) {
  const materials = row.inputPack?.topMaterialRefs || [];
  const materialTypes = countBy(materials, (material) => material.materialType).slice(0, 3);
  const missing = row.missingEvidence || [];
  const notes = [];

  if (materialTypes.length) {
    notes.push({
      label: "材料结构",
      text: `当前材料主要集中在 ${materialTypes.map(([type]) => type).join("、")}；阅读时应先核对原文，再判断候选 Claim 是否可提升。`,
      basis: "material_distribution",
      refs: { materialRawArtifactIds: materials.slice(0, 6).map((material) => material.rawArtifactId) },
    });
  }

  if (missing.length) {
    notes.push({
      label: "研究缺口",
      text: `当前最需要补齐的是：${missing.slice(0, 5).join("、")}。这些缺口决定下一轮材料抓取和人工复核顺序。`,
      basis: "missing_evidence",
      refs: { dashboardRefs: ["serenity_analysis.missingEvidence"] },
    });
  }

  const readable = row.inputPack?.materialCounts?.readable || 0;
  const metadataOnly = row.inputPack?.materialCounts?.metadataOnly || 0;
  if (metadataOnly > readable) {
    notes.push({
      label: "正文优先级",
      text: `仅标题/元数据材料多于可读正文，下一轮应优先补正文，而不是扩大结论范围。`,
      basis: "material_readability",
      refs: { dashboardRefs: ["serenity_analysis.inputPack.materialCounts"] },
    });
  }

  return notes;
}

function buildEvidenceGaps(row) {
  return (row.missingEvidence || []).slice(0, 8).map((gap) => ({
    text: gap,
    status: "open",
    refs: { dashboardRefs: ["serenity_analysis.missingEvidence"] },
  }));
}

function buildNextQuestions(row) {
  return (row.nextQuestions || []).slice(0, 6).map((question) => ({
    question,
    status: "open",
    refs: { dashboardRefs: ["serenity_analysis.nextQuestions"] },
  }));
}

function buildMarketContextNote(row) {
  const market = row.inputPack?.factInputs?.marketContext || {};
  return {
    mode: market.mode || null,
    label: market.modeLabel || null,
    note: market.disclaimer || "仅作为市场事实，不解释原因。",
    refs: { dashboardRefs: ["research_reading.marketContext"] },
  };
}

function buildForecastCandidates(row) {
  const questions = row.nextQuestions || [];
  return questions.slice(0, 3).map((question, index) => ({
    id: `fc_${row.entityId}_${index + 1}`,
    question: forecastQuestion(question),
    status: "candidate_not_activated",
    probability: null,
    horizon: horizonForQuestion(question),
    resolutionCriteria: resolutionCriteriaForQuestion(question),
    refs: { dashboardRefs: ["serenity_analysis.nextQuestions"], materialRawArtifactIds: inputMaterialIds(row).slice(0, 5) },
  }));
}

function forecastQuestion(question) {
  const text = String(question || "").replace(/^查|^确认|^等待|^复查/u, "").trim();
  return `后续公开材料是否会明确${text || "补齐当前研究缺口"}？`;
}

function horizonForQuestion(question) {
  if (/财报|收入|财务|兑现/u.test(question)) return "next_reporting_period";
  if (/交付|订单|客户/u.test(question)) return "next_90_days";
  return "next_60_days";
}

function resolutionCriteriaForQuestion(question) {
  if (/财报|收入|财务|兑现/u.test(question)) {
    return ["财报或公告中出现可引用字段", "字段能对应到当前研究对象或业务线", "保留原文链接和发布日期"];
  }
  if (/交付|订单|客户/u.test(question)) {
    return ["公开材料披露客户名称、订单信息或交付记录", "来源为官方公告、客户披露或可回溯材料", "记录披露时间和实体归属"];
  }
  return ["出现新的官方材料或公告", "材料可回溯到 source 和发布时间", "人工复核后决定是否进入事实层"];
}

function inputMaterialIds(row) {
  return (row.inputPack?.topMaterialRefs || []).map((material) => material.rawArtifactId).filter(Boolean);
}

function collectSourceIds(factInputs) {
  return Array.from(
    new Set((factInputs.timelineRefs || []).flatMap((item) => item.sourceIds || []).filter(Boolean))
  ).slice(0, 40);
}

function collectEvidenceIds(factInputs, materials) {
  return Array.from(
    new Set([
      ...(factInputs.timelineRefs || []).flatMap((item) => item.evidenceIds || []),
      ...materials.flatMap((material) => material.evidenceIds || []),
    ].filter(Boolean))
  ).slice(0, 40);
}

function countBy(rows, keyFn) {
  const map = new Map();
  for (const row of rows) {
    const key = keyFn(row);
    if (!key) continue;
    map.set(key, (map.get(key) || 0) + 1);
  }
  return Array.from(map.entries()).sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]), "zh-Hans-CN"));
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
    } else if (item === "--include-needs") {
      result.includeNeeds = true;
    } else if (item === "--force-local") {
      result.forceLocal = true;
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
