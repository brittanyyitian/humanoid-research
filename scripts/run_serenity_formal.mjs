import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./data-utils.mjs";
import { hash, nowShanghai } from "./services/router-service.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_SERENITY_HOME = path.join(ROOT, "vendor", "serenity-chan");
const DEFAULT_PYTHON =
  "/Users/edy/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";

const args = parseArgs(process.argv.slice(2));
let localMarketIndexPromise = null;

function usage() {
  return `Usage:
  node scripts/run_serenity_formal.mjs --entity-id <entity_id>
  node scripts/run_serenity_formal.mjs --entity-ids <id_a,id_b> --scorecard-only
  node scripts/run_serenity_formal.mjs --all --scorecard-only

Options:
  --dry-run         Print selected row without calling Serenity
  --scorecard-only  Rebuild scorecard from the latest existing Serenity formal run
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

try {
  const result = await runFormal({
    entityId: args.entityId,
    entityIds: args.entityIds,
    all: Boolean(args.all),
    scorecardOnly: Boolean(args.scorecardOnly),
    dryRun: Boolean(args.dryRun),
  });
  console.log(
    `Serenity formal complete. selected=${result.selectedCount}, written=${result.writtenCount}, failed=${result.failedCount}`
  );
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function runFormal(options) {
  const dashboard = await readJsonFile(path.join(DATA_DIR, "dashboard", "serenity_analysis.json"));
  if (!options.all && !options.entityId && !options.entityIds) throw new Error(`Missing --entity-id, --entity-ids or --all\n${usage()}`);
  const selectedEntityIds = new Set(String(options.entityIds || "").split(",").map((value) => value.trim()).filter(Boolean));
  const rows = (dashboard.rows || [])
    .filter((row) => tickerForRow(row))
    .filter((row) => (options.entityId ? row.entityId === options.entityId : true))
    .filter((row) => (!selectedEntityIds.size ? true : selectedEntityIds.has(row.entityId)));
  if (options.entityId && !rows.length) throw new Error(`Unknown entityId: ${options.entityId}`);
  if (options.dryRun) {
    console.log(JSON.stringify(rows.map((row) => ({ entityId: row.entityId, name: row.name, ticker: tickerForRow(row) })), null, 2));
    return { selectedCount: rows.length, writtenCount: 0, failedCount: 0 };
  }
  let writtenCount = 0;
  let failedCount = 0;
  for (const row of rows) {
    const ticker = tickerForRow(row);
    try {
      const result = options.scorecardOnly
        ? await refreshScorecardOnly(row, ticker)
        : await runOne(row, ticker);
      if (result.status === "written") writtenCount += 1;
      else failedCount += 1;
    } catch (error) {
      failedCount += 1;
      console.error(`${row.entityId}: ${error.message}`);
    }
  }
  return { selectedCount: rows.length, writtenCount, failedCount };
}

async function runOne(row, ticker) {
  const generatedAt = nowShanghai();
  const symbol = symbolForSerenity(ticker);
  const runDir = path.join(DATA_DIR, "serenity_provider", "formal_runs", `${dateSlug(generatedAt)}_${row.entityId}`);
  const command = [
    "scripts/serenity.py",
    "ask",
    `${row.name} 正式研究`,
    "--formal",
    "--symbols",
    symbol,
    "--out-dir",
    runDir,
  ];
  const provider = providerInfo({ command, runDir, mode: "formal_single" });

  try {
    const execution = await execCommand(command, { allowedExitCodes: [0, 10] });
    const manifestPath = await findManifestPath(runDir, symbol);
    if (!manifestPath) throw new Error("Serenity formal run did not produce manifest.json");
    const manifest = await readJsonFile(manifestPath);
    const scorecardInput = await buildScorecardInput(row, manifest, ticker, generatedAt, {
      dataDir: path.dirname(manifestPath),
    });
    const scorecardInputPath = path.join(runDir, "scorecard_filled.json");
    await writeJsonFile(scorecardInputPath, scorecardInput);
    const scoreJsonRun = await execCommand(["scripts/serenity_chan_scorecard.py", scorecardInputPath, "--format", "json"], {
      allowedExitCodes: [0],
    });
    const scoreMdRun = await execCommand(["scripts/serenity_chan_scorecard.py", scorecardInputPath, "--format", "md"], {
      allowedExitCodes: [0],
    });
    const scoreResult = JSON.parse(scoreJsonRun.stdout);
    const scoreResultPath = path.join(runDir, "scorecard_result.json");
    const scoreMarkdownPath = path.join(runDir, "scorecard.md");
    await writeJsonFile(scoreResultPath, scoreResult);
    await fs.writeFile(scoreMarkdownPath, scoreMdRun.stdout, "utf8");

    const dataAuditPath = path.join(runDir, "data_audit.md");
    const output = buildFormalOutput(row, {
      generatedAt,
      ticker,
      symbol,
      runDir,
      provider: {
        ...provider,
        exitCode: execution.exitCode,
        stdoutTail: tail(execution.stdout),
        stderrTail: tail(execution.stderr),
      },
      manifestPath,
      scorecardInputPath,
      scoreResultPath,
      scoreMarkdownPath,
      dataAuditPath,
      manifest,
      scoreResult,
      scoreMarkdown: scoreMdRun.stdout,
    });
    await writeJsonFile(path.join(DATA_DIR, "analysis", "serenity_workspaces", `${row.entityId}.json`), output);
    return { status: "written", output };
  } catch (error) {
    const output = buildFailedOutput(row, {
      generatedAt,
      ticker,
      symbol,
      runDir,
      provider: {
        ...provider,
        exitCode: error.exitCode ?? 1,
        stdoutTail: tail(error.stdout || ""),
        stderrTail: tail(error.stderr || error.message || ""),
      },
      error,
    });
    await writeJsonFile(path.join(DATA_DIR, "analysis", "serenity_workspaces", `${row.entityId}.json`), output);
    return { status: "failed", output };
  }
}

async function refreshScorecardOnly(row, ticker) {
  const generatedAt = nowShanghai();
  const symbol = symbolForSerenity(ticker);
  const runDir = await latestFormalRunDir(row.entityId);
  if (!runDir) throw new Error(`${row.name} has no existing Serenity formal run.`);
  const manifestPath = await findManifestPath(runDir, symbol);
  if (!manifestPath) throw new Error(`${row.name} formal run did not produce manifest.json`);
  const manifest = await readJsonFile(manifestPath);
  const scorecardInput = await buildScorecardInput(row, manifest, ticker, generatedAt, {
    dataDir: path.dirname(manifestPath),
  });
  const scorecardInputPath = path.join(runDir, "scorecard_filled.json");
  await writeJsonFile(scorecardInputPath, scorecardInput);
  const scoreJsonRun = await execCommand(["scripts/serenity_chan_scorecard.py", scorecardInputPath, "--format", "json"], {
    allowedExitCodes: [0],
  });
  const scoreMdRun = await execCommand(["scripts/serenity_chan_scorecard.py", scorecardInputPath, "--format", "md"], {
    allowedExitCodes: [0],
  });
  const scoreResult = JSON.parse(scoreJsonRun.stdout);
  const scoreResultPath = path.join(runDir, "scorecard_result.json");
  const scoreMarkdownPath = path.join(runDir, "scorecard.md");
  await writeJsonFile(scoreResultPath, scoreResult);
  await fs.writeFile(scoreMarkdownPath, scoreMdRun.stdout, "utf8");

  const provider = providerInfo({
    command: ["scripts/serenity_chan_scorecard.py", scorecardInputPath, "--format", "json"],
    runDir,
    mode: "scorecard_only_refresh",
  });
  const output = buildFormalOutput(row, {
    generatedAt,
    ticker,
    symbol,
    runDir,
    provider: {
      ...provider,
      exitCode: 0,
      stdoutTail: tail(scoreJsonRun.stdout),
      stderrTail: tail(scoreJsonRun.stderr),
    },
    manifestPath,
    scorecardInputPath,
    scoreResultPath,
    scoreMarkdownPath,
    dataAuditPath: path.join(runDir, "data_audit.md"),
    manifest,
    scoreResult,
    scoreMarkdown: scoreMdRun.stdout,
  });
  await writeJsonFile(path.join(DATA_DIR, "analysis", "serenity_workspaces", `${row.entityId}.json`), output);
  return { status: "written", output };
}

async function buildScorecardInput(row, manifest, ticker, generatedAt, context = {}) {
  const dataAcquisition = manifest.data_acquisition || {};
  const manifestSymbol = manifest.symbol?.symbol || ticker;
  const artifacts = await readFormalArtifacts(context.dataDir, manifestSymbol);
  const localMarket = await localMarketContext(row.entityId);
  const materialRefs = row.inputPack?.topMaterialRefs || [];
  const readableMaterials = materialRefs.filter((item) => item.bodyStatus === "full_text");
  const financialMaterialCount = readableMaterials.filter((item) =>
    /年度报告|年报|半年度报告|季度报告|一季度|三季度|业绩/u.test(item.title || "")
  ).length;
  const hasLocalFinancials = readableMaterials.some((item) =>
    /年度报告|年报|半年度报告|季度报告|一季度|三季度|业绩/u.test(item.title || "")
  );
  const localCurrentQuote = localMarket.current
    ? {
        regular_market_price: numeric(localMarket.current.price),
        regular_market_turnover: parseCnMoney(localMarket.current.turnoverAmount),
        previous_close: previousCloseFromChange(localMarket.current.price, localMarket.current.changePct),
        currency: localMarket.current.market === "HKEX" ? "HKD" : "CNY",
      }
    : null;
  const localValuationInputs = localMarket.current
    ? {
        regular_market_price: numeric(localMarket.current.price),
        total_market_cap: parseCnMoney(localMarket.current.totalMarketCap),
        float_market_cap: parseCnMoney(localMarket.current.floatMarketCap),
        currency: localMarket.current.market === "HKEX" ? "HKD" : "CNY",
        as_of_date: localMarket.current.date || String(generatedAt).slice(0, 10),
      }
    : null;
  artifacts.currentQuote ||= localCurrentQuote;
  artifacts.valuationInputs ||= localValuationInputs;
  if ((artifacts.priceRows || []).length < 20 && localMarket.history.length >= 20) {
    artifacts.priceRows = localMarket.history;
  }
  const providerStatus = dataAcquisition.status_by_dataset || {};
  const localDatasetStatus = {
    current_quote:
      providerStatus.current_quote !== "OK" && artifacts.currentQuote?.regular_market_price != null
        ? "OK"
        : null,
    price_history_adjusted:
      providerStatus.price_history_adjusted !== "OK" && artifacts.priceRows.length >= 250
        ? "OK"
        : providerStatus.price_history_adjusted !== "OK" && artifacts.priceRows.length >= 20
          ? "PARTIAL"
          : null,
    valuation_inputs:
      providerStatus.valuation_inputs !== "OK" &&
      (artifacts.valuationInputs?.total_market_cap != null || artifacts.valuationInputs?.float_market_cap != null)
        ? "PARTIAL"
        : null,
    financials:
      providerStatus.financials !== "OK" && hasLocalFinancials
        ? "PARTIAL"
        : null,
    filings_announcements:
      providerStatus.filings_announcements !== "OK" && readableMaterials.length
        ? "OK"
        : null,
  };
  const statusByDataset = {
    ...(dataAcquisition.status_by_dataset || {}),
    ...Object.fromEntries(Object.entries(localDatasetStatus).filter(([, status]) => status)),
  };
  const resolvedDatasets = new Set(
    Object.entries(statusByDataset)
      .filter(([, status]) => status === "OK")
      .map(([dataset]) => dataset)
  );
  const technicalTiming = technicalTimingFromPriceHistory(artifacts.priceRows, artifacts.currentQuote);
  const customerEvidenceSummary = artifacts.customerEvidence?.summary || {};
  const customerEvidenceScore = numeric(customerEvidenceSummary.score);
  const directEvidenceCount = numeric(customerEvidenceSummary.direct_evidence_count) || 0;
  const leadEvidenceCount = numeric(customerEvidenceSummary.lead_evidence_count) || 0;
  const hasDirectCustomerEvidence = directEvidenceCount > 0 || customerEvidenceSummary.evidence_status === "DIRECT_EVIDENCE_FOUND";
  const summary = row.inputPack?.factInputs?.researchSummary || {};
  const sector = row.inputPack?.factInputs?.profile?.sector || "robotics";
  const hasOfficial = readableMaterials.some((item) => item.sourceLevel === "A") ||
    (summary.verifiedEvidence || []).includes("官方来源");
  const hasFinancials = statusByDataset.financials === "OK";
  const hasPartialFinancials = statusByDataset.financials === "PARTIAL";
  const hasFilings = statusByDataset.filings_announcements === "OK";
  const missing = [...new Set([...(summary.missingEvidence || []), ...(row.missingEvidence || [])])];
  const customerOrderUnverified = ["robotics", "semiconductor", "drone"].includes(sector) &&
    missing.some((item) => /订单|客户|交付|份额|供应/u.test(item)) &&
    !hasDirectCustomerEvidence;
  const blockers = [];
  if (customerOrderUnverified) {
    blockers.push({
      name: "customer_order_delivery_unverified",
      severity: "major",
      effect: "rating_cap_b",
    });
  }
  const marketPayoff = marketPayoffFromArtifacts({
    valuationInputs: artifacts.valuationInputs,
    currentQuote: artifacts.currentQuote,
    technicalTiming,
    customerEvidenceScore,
  });
  const evidenceConfidence = evidenceConfidenceFromArtifacts({
    hasOfficial,
    hasFinancials,
    hasPartialFinancials,
    hasFilings,
    directEvidenceCount,
    leadEvidenceCount,
    pendingClaimCount: row.inputPack?.candidateLayer?.pendingClaimCount || 0,
  });

  return {
    ticker,
    company: row.name,
    market: manifest.symbol?.market || marketFromTicker(ticker),
    as_of_date: String(generatedAt).slice(0, 10),
    layer: {
      value_chain_bottleneck: 3,
      scarcity_and_entry_barrier: 2.5,
      demand_inflection_capture: 3,
      industry_positioning: 3,
    },
    company_thesis: {
      bottleneck_ownership: 2.5,
      revenue_translation: hasDirectCustomerEvidence ? 3.2 : customerOrderUnverified ? 2 : 2.7,
      financial_quality: hasFinancials ? 3.4 : hasPartialFinancials ? 2.8 : 2,
      management_execution: 2.5,
      durability: 2.5,
    },
    evidence_confidence: evidenceConfidence,
    market_payoff: marketPayoff,
    technical_timing: {
      monthly_trend: technicalTiming.monthlyTrend,
      weekly_structure: technicalTiming.weeklyStructure,
      daily_buy_point: technicalTiming.dailyBuyPoint,
      gf_dma_alignment: technicalTiming.gfDmaAlignment,
      drawdown_position: technicalTiming.drawdownPosition,
    },
    risk_controls: {
      falsification_clarity: 3,
      governance_accounting_risk_control: 3,
      balance_sheet_dilution_control: 3,
      cycle_policy_risk_control: 3,
      liquidity_event_risk_control: 3,
    },
    data_acquisition: {
      status_by_dataset: {
        current_quote: statusByDataset.current_quote || "NOT_REQUESTED",
        price_history_adjusted: statusByDataset.price_history_adjusted || "NOT_REQUESTED",
        valuation_inputs: statusByDataset.valuation_inputs || "NOT_REQUESTED",
        financials: statusByDataset.financials || "NOT_REQUESTED",
        filings_announcements: statusByDataset.filings_announcements || "NOT_REQUESTED",
      },
      data_gaps: ensureArray(dataAcquisition.data_gaps).filter((item) => !resolvedDatasets.has(item.dataset)),
      research_debt: ensureArray(dataAcquisition.research_debt).filter((item) => !resolvedDatasets.has(item.dataset)),
      manual_retrieval_tasks: ensureArray(dataAcquisition.manual_retrieval_tasks),
    },
    blockers,
    evidence_notes: [
      {
        claim: summary.summary || `${row.name} 当前处于研究跟踪状态。`,
        source: "research_reading + Serenity formal artifacts",
        source_level: hasOfficial ? "A/L0-L2" : "mixed",
        supports: [
          `已读取 ${readableMaterials.length} 份正式公告，其中 ${financialMaterialCount} 份财报或业绩材料`,
          `近20日涨跌 ${formatPct(technicalTiming.change20d)}，近60日涨跌 ${formatPct(technicalTiming.change60d)}`,
          ["robotics", "semiconductor", "drone"].includes(sector)
            ? `客户或订单证据 ${directEvidenceCount} 条直接、${leadEvidenceCount} 条线索`
            : "",
        ].filter(Boolean).join("；") + "。",
        missing_proof: missing.slice(0, 4).join(" / ") || "暂无明显阻断项。",
        confidence: customerOrderUnverified ? "Medium" : "Strong",
      },
    ],
    falsification_points: falsificationPointsForRow(row),
  };
}

function buildFormalOutput(row, context) {
  const score = context.scoreResult;
  const blockers = score.decision_blockers || [];
  const readinessLabel = formatReadiness(score.action_readiness);
  const bucketLabel = formatReadiness(score.watchlist_bucket);
  const currentFocus = `Serenity 已生成正式评分卡：评级上限 ${score.rating_cap}，当前状态：${readinessLabel}。`;
  const toVerify = blockers.length
    ? blockers.map(formatBlocker).filter(Boolean).slice(0, 3)
    : ["人工复核正式研究备忘录", "跟踪订单、客户和交付证据", "复查财报兑现字段"];
  return {
    id: `saout_${row.entityId}_${hash(`${context.symbol}|${context.generatedAt}|formal|${score.candidate_priority_score}`, 12)}`,
    entityId: row.entityId,
    name: row.name,
    generatedAt: context.generatedAt,
    contractType: "serenity_analysis_output_v0",
    status: "serenity_formal_scorecard",
    provider: context.provider,
    sourceInputPack: {
      contractType: row.contractType,
      analysisStatus: row.analysisStatus,
      ticker: context.ticker,
      symbol: context.symbol,
    },
    inputRefs: {
      materialRawArtifactIds: (row.inputPack?.topMaterialRefs || []).map((material) => material.rawArtifactId).filter(Boolean),
      claimIds: row.inputPack?.candidateLayer?.claimIds || [],
      providerRunDir: context.runDir,
      manifestPath: context.manifestPath,
      dataAuditPath: context.dataAuditPath,
      scorecardInputPath: context.scorecardInputPath,
      scoreResultPath: context.scoreResultPath,
      scoreMarkdownPath: context.scoreMarkdownPath,
      dashboardRefs: ["dashboard/serenity_analysis.json"],
    },
    display: {
      mode: "serenity_formal_scorecard",
      label: "Serenity 正式评分卡",
      title: `${row.name} Serenity 正式评分卡`,
      summary: currentFocus,
      currentFocus,
      toVerify,
      viewLabel: "Serenity 看法",
      view: score.verdict,
      followup: "下一步需要人工复核正式备忘录，并持续验证订单、客户、交付和财务兑现。",
      materialLine: `候选优先级 ${score.candidate_priority_score}/100`,
      inputState: `${bucketLabel} · 证据等级 ${score.evidence_confidence_rating}`,
    },
    layers: {
      factNotes: [
        {
          label: "数据准备",
          text: `Serenity data readiness: ${score.data_readiness_score}/100。`,
          refs: { manifestPath: context.manifestPath },
        },
      ],
      candidateSignals: [],
      analysisNotes: [
        {
          label: "Scorecard verdict",
          text: score.verdict,
          refs: { scoreResultPath: context.scoreResultPath },
        },
      ],
      evidenceGaps: blockers.map((item) => ({
        text: formatBlocker(item) || "存在待复核阻断项",
        status: "open",
      })),
      nextVerificationQuestions: toVerify.map((question) => ({ question, status: "open" })),
      marketContext: {},
      forecastCandidates: [],
    },
    rawArtifacts: {
      scorecardMarkdownExcerpt: context.scoreMarkdown.slice(0, 4000),
    },
    calibration: {
      status: "not_started",
      note: "Formal scorecard does not create a forecast ledger until the user activates specific claims.",
    },
    guardrails: [
      "Serenity 正式评分卡属于分析层输出，不进入事实层晋级。",
      "不输出买卖建议。",
      "行动状态来自评分卡，不代表用户应执行交易。",
    ],
  };
}

function buildFailedOutput(row, context) {
  return {
    id: `saout_${row.entityId}_${hash(`${context.symbol}|${context.generatedAt}|formal_failed`, 12)}`,
    entityId: row.entityId,
    name: row.name,
    generatedAt: context.generatedAt,
    contractType: "serenity_analysis_output_v0",
    status: "serenity_formal_failed",
    provider: context.provider,
    sourceInputPack: {
      ticker: context.ticker,
      symbol: context.symbol,
    },
    inputRefs: {
      providerRunDir: context.runDir,
      dashboardRefs: ["dashboard/serenity_analysis.json"],
    },
    display: {
      mode: "serenity_formal_failed",
      label: "Serenity 正式流程失败",
      title: `${row.name} Serenity 正式流程失败`,
      summary: "Serenity 正式流程未完成。",
      currentFocus: "Serenity 正式流程未完成。",
      toVerify: ["检查 Serenity 报错", "确认数据源可用", "重新运行正式流程"],
      viewLabel: "失败原因",
      view: context.provider.stderrTail || context.provider.stdoutTail || context.error?.message || "未知错误",
      followup: "修复后重新运行 Serenity 正式流程。",
      materialLine: "正式流程失败",
      inputState: "失败",
    },
    layers: {
      factNotes: [],
      candidateSignals: [],
      analysisNotes: [],
      evidenceGaps: [{ text: context.provider.stderrTail || "正式流程失败", status: "open" }],
      nextVerificationQuestions: [{ question: "检查 Serenity 报错", status: "open" }],
      marketContext: {},
      forecastCandidates: [],
    },
    calibration: { status: "not_started" },
    guardrails: ["失败输出不构成研究结论。"],
  };
}

async function readFormalArtifacts(dataDir, manifestSymbol) {
  const symbol = String(manifestSymbol || "").trim();
  const code = symbol.split(".")[0];
  const currentQuote =
    (await readOptionalJson(path.join(dataDir, `${symbol}_current_quote.json`))) ||
    (await readOptionalJson(path.join(dataDir, `${code}_current_quote.json`)));
  const valuationInputs =
    (await readOptionalJson(path.join(dataDir, `${symbol}_valuation_inputs.json`))) ||
    (await readOptionalJson(path.join(dataDir, `${code}_valuation_inputs.json`)));
  const customerEvidence =
    (await readOptionalJson(path.join(dataDir, `${symbol}_customer_order_capacity_evidence.json`))) ||
    (await readOptionalJson(path.join(dataDir, `${code}_customer_order_capacity_evidence.json`)));
  const priceCsv =
    (await readOptionalText(path.join(dataDir, `${symbol}_price_history_adjusted.csv`))) ||
    (await readOptionalText(path.join(dataDir, `${code}_price_history_adjusted.csv`))) ||
    "";

  return {
    currentQuote,
    valuationInputs,
    customerEvidence,
    priceRows: parsePriceCsv(priceCsv),
  };
}

async function localMarketContext(entityId) {
  if (!localMarketIndexPromise) localMarketIndexPromise = buildLocalMarketIndex();
  const index = await localMarketIndexPromise;
  return {
    current: index.current.get(entityId) || null,
    history: index.history.get(entityId) || [],
  };
}

async function buildLocalMarketIndex() {
  const currentDashboard = await readOptionalJson(path.join(DATA_DIR, "dashboard", "market.json"));
  const current = new Map((currentDashboard?.rows || []).map((row) => [row.entityId, row]));
  const history = new Map();
  const stocksDir = path.join(DATA_DIR, "stocks");
  const entries = await fs.readdir(stocksDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /^market_\d{4}_\d{2}_\d{2}\.json$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const fileName of files) {
    const rows = await readOptionalJson(path.join(stocksDir, fileName));
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row.entityId || !Number.isFinite(numeric(row.price))) continue;
      const entityRows = history.get(row.entityId) || [];
      entityRows.push({
        date: row.date || fileName.slice(7, 17).replaceAll("_", "-"),
        open: numeric(row.open),
        high: numeric(row.high),
        low: numeric(row.low),
        close: numeric(row.price),
        volume: numeric(row.volume),
      });
      history.set(row.entityId, entityRows);
    }
  }
  for (const rows of history.values()) rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return { current, history };
}

function parseCnMoney(value) {
  if (typeof value === "number") return value;
  const text = String(value || "").replaceAll(",", "").trim();
  const amount = Number.parseFloat(text);
  if (!Number.isFinite(amount)) return null;
  if (text.includes("万亿")) return amount * 1_000_000_000_000;
  if (text.includes("亿")) return amount * 100_000_000;
  if (text.includes("万")) return amount * 10_000;
  return amount;
}

function previousCloseFromChange(price, changePct) {
  const current = numeric(price);
  const change = numeric(changePct);
  if (current == null || change == null || change === -100) return null;
  return current / (1 + change / 100);
}

function falsificationPointsForRow(row) {
  const sector = row.inputPack?.factInputs?.profile?.sector || "robotics";
  const bySector = {
    semiconductor: [
      "后续财报仍看不到核心产品收入、客户验证或份额提升。",
      "研发和扩产投入增加，但订单、收入与现金流没有同步改善。",
      "行业景气回落，价格或库存变化削弱原来的增长判断。",
    ],
    drone: [
      "产品或项目进展没有转成批量订单和实际交付。",
      "无人机相关收入增长弱于公司整体，无法证明业务在兑现。",
      "应收、库存或现金流恶化，说明订单质量低于预期。",
    ],
    oil: [
      "产量或销量没有增长，成本却持续上升。",
      "油价变化没有转成利润和现金流改善。",
      "资本开支增加，但储量、产量或项目回报没有兑现。",
    ],
    power: [
      "发电量或利用小时下降，电价和成本又没有改善。",
      "利润增长没有转成经营现金流，负债压力继续上升。",
      "水情、煤价或新增装机变化削弱原来的盈利判断。",
    ],
    innovative_drug: [
      "关键临床、审批或商业化进度晚于原计划。",
      "研发投入继续增加，但获批产品销售没有形成增长。",
      "核心产品出现安全性、竞争或医保价格压力。",
    ],
    precious_metals: [
      "金属价格上涨，但产量、成本或利润没有同步改善。",
      "扩产项目延期，资源量没有转成可销售产量。",
      "现金流弱于利润，资本开支和负债压力上升。",
    ],
    robotics: [
      "后续公告或财报持续无法披露订单、客户或交付证据。",
      "机器人相关收入或业务线无法在财报中找到可追溯兑现。",
      "供应链或合作披露不能被官方材料交叉验证。",
    ],
  };
  return bySector[sector] || bySector.robotics;
}

function technicalTimingFromPriceHistory(rows, currentQuote) {
  const cleanRows = rows.filter((row) => Number.isFinite(row.close) && row.close > 0);
  const last = cleanRows.at(-1) || {};
  const lastClose = numeric(currentQuote?.regular_market_price) || last.close || null;
  const change5d = changeFromLookback(cleanRows, 5, lastClose);
  const change20d = changeFromLookback(cleanRows, 20, lastClose);
  const change60d = changeFromLookback(cleanRows, 60, lastClose);
  const ma10 = movingAverage(cleanRows, 10);
  const ma20 = movingAverage(cleanRows, 20);
  const ma60 = movingAverage(cleanRows, 60);
  const high60 = maxOf(cleanRows.slice(-60), "high");
  const low60 = minOf(cleanRows.slice(-60), "low");
  const drawdownFrom60dHigh = high60 && lastClose ? lastClose / high60 - 1 : null;
  const position60d = high60 && low60 && high60 > low60 && lastClose ? (lastClose - low60) / (high60 - low60) : null;
  const dailyRange = Number.isFinite(last.high - last.low) && last.high > last.low ? (lastClose - last.low) / (last.high - last.low) : null;
  const avgVolume20 = average(cleanRows.slice(-21, -1).map((row) => row.volume).filter(Number.isFinite));
  const volumeRatio20 = avgVolume20 && last.volume ? last.volume / avgVolume20 : null;

  const aboveMa10 = lastClose && ma10 ? lastClose > ma10 : false;
  const aboveMa20 = lastClose && ma20 ? lastClose > ma20 : false;
  const aboveMa60 = lastClose && ma60 ? lastClose > ma60 : false;
  const alignedMa = Boolean(ma10 && ma20 && ma60 && ma10 > ma20 && ma20 > ma60);
  const overheated = (change20d ?? 0) > 0.55 || (change5d ?? 0) > 0.25 || (volumeRatio20 ?? 1) > 2.8;
  const broken = (drawdownFrom60dHigh ?? 0) < -0.32 || (!aboveMa20 && (change20d ?? 0) < -0.12);

  const monthlyTrend = clampRating(
    2.5 +
      scoreSlope(change60d, [
        [-0.25, -1.4],
        [-0.1, -0.7],
        [0.08, 0.4],
        [0.22, 1.0],
        [0.45, 1.6],
      ]) +
      (aboveMa20 ? 0.35 : -0.25) +
      (aboveMa60 ? 0.45 : -0.35)
  );
  const weeklyStructure = clampRating(
    2.5 +
      scoreSlope(change20d, [
        [-0.18, -1.3],
        [-0.05, -0.5],
        [0.05, 0.35],
        [0.16, 0.9],
        [0.35, 1.2],
      ]) +
      (aboveMa10 ? 0.25 : -0.15) +
      (aboveMa20 ? 0.35 : -0.25) -
      (overheated ? 0.45 : 0)
  );
  const dailyBuyPoint = clampRating(
    2.4 +
      scoreSlope(change5d, [
        [-0.12, -0.9],
        [-0.02, -0.25],
        [0.04, 0.45],
        [0.12, 0.75],
        [0.22, -0.1],
      ]) +
      (dailyRange != null ? (dailyRange > 0.58 ? 0.35 : dailyRange < 0.25 ? -0.35 : 0) : 0) +
      (volumeRatio20 != null ? (volumeRatio20 >= 1.05 && volumeRatio20 <= 2.2 ? 0.25 : volumeRatio20 > 2.8 ? -0.45 : 0) : 0) -
      (broken ? 0.6 : 0) -
      (overheated ? 0.35 : 0)
  );
  const gfDmaAlignment = clampRating(
    2.2 +
      (aboveMa10 ? 0.45 : -0.2) +
      (aboveMa20 ? 0.55 : -0.35) +
      (aboveMa60 ? 0.65 : -0.45) +
      (alignedMa ? 0.75 : 0)
  );
  const drawdownPosition = clampRating(
    2.5 +
      (position60d != null ? (position60d > 0.75 ? 0.35 : position60d > 0.45 ? 0.65 : position60d < 0.2 ? -0.8 : 0) : 0) +
      (drawdownFrom60dHigh != null
        ? drawdownFrom60dHigh > -0.08
          ? 0.4
          : drawdownFrom60dHigh > -0.2
            ? 0.15
            : -0.7
        : 0) -
      ((change20d ?? 0) > 0.6 ? 0.55 : 0)
  );

  return {
    monthlyTrend,
    weeklyStructure,
    dailyBuyPoint,
    gfDmaAlignment,
    drawdownPosition,
    lastClose,
    change5d,
    change20d,
    change60d,
    volumeRatio20,
    drawdownFrom60dHigh,
    position60d,
  };
}

function marketPayoffFromArtifacts({ valuationInputs, currentQuote, technicalTiming, customerEvidenceScore }) {
  const marketCap = numeric(valuationInputs?.total_market_cap) || numeric(valuationInputs?.float_market_cap);
  const turnover = numeric(currentQuote?.regular_market_turnover);
  const liquidityCapacity = clampRating(
    turnover == null
      ? 2.5
      : turnover >= 800000
        ? 4.3
        : turnover >= 250000
          ? 3.6
          : turnover >= 70000
            ? 3.0
            : 2.2
  );
  const valuationDiscount = clampRating(
    marketCap == null
      ? 2.5
      : marketCap <= 12000000000
        ? 3.4
        : marketCap <= 35000000000
          ? 3.0
          : marketCap <= 85000000000
            ? 2.5
            : 2.1
  );
  const evidenceFactor = customerEvidenceScore == null ? 2.4 : 1.8 + (customerEvidenceScore / 100) * 2.2;
  const upsideDownside = clampRating(
    2.4 +
      ((technicalTiming.change60d ?? 0) > 0.18 ? 0.55 : (technicalTiming.change60d ?? 0) < -0.12 ? -0.45 : 0) +
      ((technicalTiming.drawdownFrom60dHigh ?? 0) > -0.18 ? 0.25 : -0.35) -
      ((technicalTiming.change20d ?? 0) > 0.6 ? 0.6 : 0)
  );
  const crowdingControl = clampRating(
    3.1 -
      ((technicalTiming.change20d ?? 0) > 0.45 ? 0.7 : 0) -
      ((technicalTiming.volumeRatio20 ?? 1) > 2.5 ? 0.55 : 0) +
      ((technicalTiming.drawdownFrom60dHigh ?? 0) < -0.18 ? 0.25 : 0)
  );
  return {
    valuation_discount: valuationDiscount,
    implied_growth_vs_evidence: clampRating(evidenceFactor),
    upside_downside: upsideDownside,
    liquidity_capacity: liquidityCapacity,
    crowding_control: crowdingControl,
  };
}

function evidenceConfidenceFromArtifacts({
  hasOfficial,
  hasFinancials,
  hasPartialFinancials,
  hasFilings,
  directEvidenceCount,
  leadEvidenceCount,
  pendingClaimCount,
}) {
  return {
    primary_source_coverage: clampRating(hasOfficial || hasFilings ? 4 : 2),
    financial_statement_verification: clampRating(hasFinancials ? 4 : hasPartialFinancials ? 3 : 2),
    claim_traceability: clampRating(directEvidenceCount > 0 ? 3.8 : leadEvidenceCount > 0 ? 3 : pendingClaimCount ? 2.4 : 3.1),
    cross_source_consistency: clampRating(directEvidenceCount > 1 ? 3.5 : leadEvidenceCount > 2 ? 3 : 2.6),
    freshness: 4,
  };
}

function parsePriceCsv(text) {
  const lines = String(text || "").trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => {
    const [date, open, high, low, close, volume, adjClose, rawClose] = line.split(",");
    return {
      date,
      open: numeric(open),
      high: numeric(high),
      low: numeric(low),
      close: numeric(adjClose) || numeric(close) || numeric(rawClose),
      volume: numeric(volume),
    };
  });
}

function changeFromLookback(rows, lookback, lastClose) {
  if (!lastClose || rows.length <= lookback) return null;
  const base = rows.at(-(lookback + 1))?.close;
  if (!base) return null;
  return lastClose / base - 1;
}

function movingAverage(rows, length) {
  const values = rows.slice(-length).map((row) => row.close).filter(Number.isFinite);
  if (!values.length) return null;
  return average(values);
}

function average(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function maxOf(rows, key) {
  const values = rows.map((row) => row[key]).filter(Number.isFinite);
  return values.length ? Math.max(...values) : null;
}

function minOf(rows, key) {
  const values = rows.map((row) => row[key]).filter(Number.isFinite);
  return values.length ? Math.min(...values) : null;
}

function scoreSlope(value, bands) {
  if (value == null) return 0;
  let result = 0;
  for (const [threshold, score] of bands) {
    if (value >= threshold) result = score;
  }
  return result;
}

function clampRating(value) {
  if (!Number.isFinite(value)) return 2.5;
  return Math.max(0, Math.min(5, Number(value.toFixed(2))));
}

function numeric(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(number) ? number : null;
}

function formatPct(value) {
  if (value == null) return "--";
  return `${(value * 100).toFixed(1)}%`;
}

async function readOptionalJson(file) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function readOptionalText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

function execCommand(command, { allowedExitCodes }) {
  const serenityHome = process.env.SERENITY_HOME || DEFAULT_SERENITY_HOME;
  const python = process.env.SERENITY_PYTHON || DEFAULT_PYTHON;
  const env = {
    ...process.env,
    SERENITY_DATA_DIR: process.env.SERENITY_DATA_DIR || path.join(DATA_DIR, "serenity_provider"),
  };
  return new Promise((resolve, reject) => {
    const child = spawn(python, command, {
      cwd: serenityHome,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => {
      reject(Object.assign(error, { stdout, stderr }));
    });
    child.on("close", (exitCode) => {
      if (allowedExitCodes.includes(exitCode)) resolve({ exitCode, stdout, stderr });
      else reject(Object.assign(new Error(`Command exited with ${exitCode}`), { exitCode, stdout, stderr }));
    });
  });
}

function providerInfo({ command, runDir, mode }) {
  return {
    name: "serenity_chan_cli_v0",
    type: "vendored_cli",
    mode,
    externalCall: true,
    serenityHome: process.env.SERENITY_HOME || DEFAULT_SERENITY_HOME,
    python: process.env.SERENITY_PYTHON || DEFAULT_PYTHON,
    command,
    runDir,
    note: "调用 vendored Serenity Chan formal single workflow，并通过 Serenity scorecard validator 渲染评分卡。",
  };
}

async function findManifestPath(runDir, symbol) {
  const code = String(symbol || "").split(".")[0];
  const direct = path.join(runDir, "data", code, "manifest.json");
  if (await exists(direct)) return direct;
  const dataDir = path.join(runDir, "data");
  try {
    const entries = await fs.readdir(dataDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(dataDir, entry.name, "manifest.json");
      if (await exists(candidate)) return candidate;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  return null;
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

function tickerForRow(row) {
  const ticker = row.profile?.ticker || row.inputPack?.factInputs?.profile?.ticker;
  if (!ticker || ticker === "--" || ticker === "未上市") return null;
  return ticker;
}

function symbolForSerenity(ticker) {
  const text = String(ticker || "").trim();
  if (/^\d{6}\.(SH|SZ)$/i.test(text)) return text.slice(0, 6);
  if (/^\d{5}\.HK$/i.test(text)) return text;
  return text;
}

function marketFromTicker(ticker) {
  if (/\.HK$/i.test(ticker)) return "HK";
  if (/\.SH$|\.SZ$/i.test(ticker)) return "CN_A";
  return "UNKNOWN";
}

function formatReadiness(value) {
  const text = String(value || "").trim();
  const labels = {
    ACTION_READY: "可进入人工决策复核",
    DATA_GATED: "数据仍未满足",
    RESEARCH_GATED: "研究仍未完成",
    WATCHLIST: "观察池跟踪",
    NOT_READY: "暂不满足",
  };
  return labels[text] || text || "待复核";
}

function formatBlocker(item) {
  const key = item?.name || item?.dataset || item?.gap_type || "";
  const labels = {
    customer_order_delivery_unverified: "订单、客户和交付仍缺正式验证",
    formal_memo_not_human_reviewed: "正式研究备忘录仍需人工复核",
    current_quote: "当前行情数据待补齐",
    price_history_adjusted: "复权历史行情待补齐",
    valuation_inputs: "估值输入待补齐",
    financials: "财务数据待补齐",
    filings_announcements: "公告材料待补齐",
  };
  return labels[key] || key;
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

function ensureArray(value) {
  return Array.isArray(value) ? value : [];
}

function tail(text, length = 2000) {
  return String(text || "").slice(-length);
}

function dateSlug(value) {
  return String(value || nowShanghai()).slice(0, 19).replace(/[-:T]/g, "_");
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") {
      result.help = true;
    } else if (item === "--dry-run" || item === "--all" || item === "--scorecard-only") {
      result[item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = true;
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
