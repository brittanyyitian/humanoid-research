import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./data-utils.mjs";
import { hash, nowShanghai } from "./services/router-service.mjs";
import { alignEvidenceTestReasons } from "./services/serenity-evidence-card-service.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DEFAULT_SERENITY_HOME = path.join(ROOT, "vendor", "serenity-chan");
const DEFAULT_PYTHON =
  "/Users/edy/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/run_serenity_ai_review.mjs --entity-id <entity_id>

Options:
  --run-dir <path>  Reuse an existing Serenity formal run directory.
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

try {
  const result = await runAiReview({ entityId: args.entityId, runDir: args.runDir });
  console.log(`Serenity AI review projected. written=${result.writtenCount}`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function runAiReview(options) {
  if (!options.entityId) throw new Error(`Missing --entity-id\n${usage()}`);

  const analysis = await readJsonFile(path.join(DATA_DIR, "dashboard", "serenity_analysis.json"));
  const row = (analysis.rows || []).find((item) => item.entityId === options.entityId);
  if (!row) throw new Error(`Unknown entityId: ${options.entityId}`);
  const outputPath = path.join(DATA_DIR, "analysis", "serenity_outputs", `${row.entityId}.json`);
  const existingOutput = await readOptionalJsonFile(outputPath);

  const runDir = options.runDir ? path.resolve(options.runDir) : await latestFormalRunDir(row.entityId);
  if (!runDir) throw new Error(`No Serenity formal run found for ${row.entityId}`);

  const requestedSymbol =
    row.display?.stockRadar?.symbol ||
    row.sourceInputPack?.ticker ||
    existingOutput?.display?.stockRadar?.symbol ||
    existingOutput?.sourceInputPack?.ticker;
  if (!requestedSymbol) throw new Error(`No stock symbol found for ${row.entityId}`);
  const manifestPath = await findManifestPath(path.join(runDir, "data"));
  if (!manifestPath) throw new Error(`No Serenity manifest found for ${row.entityId}`);
  const manifest = await readJsonFile(manifestPath);
  const symbol =
    (typeof manifest.symbol === "string" ? manifest.symbol : manifest.symbol?.symbol) ||
    requestedSymbol;
  const dataDir = path.dirname(manifestPath);
  const reviewDir = path.join(runDir, "ai_research", symbol);
  const dossierPath = path.join(reviewDir, "ai_research_dossier.json");
  const overlayPath = path.join(reviewDir, "ai_research_overlay.json");
  const scorecardResultPath = path.join(runDir, "scorecard_result.json");
  const currentQuotePath = path.join(dataDir, `${symbol}_current_quote.json`);
  const valuationInputsPath = path.join(dataDir, `${symbol}_valuation_inputs.json`);
  const customerEvidencePath = path.join(dataDir, `${symbol}_customer_order_capacity_evidence.json`);
  const financialsPath = path.join(dataDir, `${symbol}_financials.json`);

  const [dossier, overlay, scorecardResult, currentQuote, valuationInputs, customerEvidence, financials] =
    await Promise.all([
      readJsonFile(dossierPath),
      readJsonFile(overlayPath),
      readJsonFile(scorecardResultPath),
      readOptionalJsonFile(currentQuotePath),
      readOptionalJsonFile(valuationInputsPath),
      readOptionalJsonFile(customerEvidencePath),
      readOptionalJsonFile(financialsPath),
    ]);
  if (isDeterministicTemplateDossier(dossier)) {
    throw new Error(
      `${row.name} dossier is a deterministic batch template, not a completed Serenity deep review.`
    );
  }

  const validation = {
    dossier: await execSerenity([
      "scripts/validate_ai_research_dossier.py",
      dossierPath,
      "--manifest",
      manifestPath,
    ]),
    score: await execSerenity([
      "scripts/score_ai_research_dossier.py",
      dossierPath,
      "--manifest",
      manifestPath,
    ]),
    overlay: await execSerenity([
      "scripts/validate_ai_overlay.py",
      overlayPath,
      "--manifest",
      manifestPath,
    ]),
  };

  const generatedAt = nowShanghai();
  const output = buildSerenityOutput(row, {
    generatedAt,
    runDir,
    manifestPath,
    dossierPath,
    overlayPath,
    dossier,
    overlay,
    dossierScore: JSON.parse(validation.score.stdout),
    scorecardResult,
    currentQuote,
    valuationInputs,
    customerEvidence,
    financials,
    sourceRadar: row.display?.stockRadar || existingOutput?.display?.stockRadar || {},
  });

  await writeJsonFile(outputPath, output);
  return { writtenCount: 1, output };
}

function buildSerenityOutput(row, context) {
  const { dossier, overlay, dossierScore, scorecardResult } = context;
  const stockRadar = buildStockRadar(row, context);
  const judgment = cleanList(dossier.judgment);
  const observed = cleanList(dossier.observed);
  const currentFocus = judgment[0] || cleanText(overlay.action_condition_summary);
  const triggerItems = Object.entries(dossier.trigger_table || {})
    .flatMap(([period, items]) => cleanList(items).map((item) => `${periodLabel(period)}：${item}`))
    .slice(0, 4);

  return {
    id: `saout_${row.entityId}_${hash(`${context.generatedAt}|ai_review|${overlay.symbol}`, 12)}`,
    entityId: row.entityId,
    name: row.name,
    generatedAt: context.generatedAt,
    contractType: "serenity_analysis_output_v0",
    status: "serenity_ai_review",
    provider: {
      name: "serenity_chan_ai_reviewer_v0",
      type: "ai_review",
      mode: "validated_dossier_projection",
      externalCall: true,
      note: "直接读取并校验 Serenity formal workspace 生成的 dossier 与 overlay。",
    },
    sourceInputPack: {
      contractType: row.contractType,
      analysisStatus: row.analysisStatus,
      ticker: overlay.symbol,
      symbol: overlay.symbol,
    },
    inputRefs: {
      providerRunDir: context.runDir,
      manifestPath: context.manifestPath,
      dossierPath: context.dossierPath,
      overlayPath: context.overlayPath,
      dashboardRefs: ["dashboard/serenity_analysis.json", "dashboard/research_reading.json"],
    },
    display: {
      mode: "serenity_ai_review",
      label: "Serenity 深度分析",
      title: `${row.name} · Serenity 深度分析`,
      summary: currentFocus,
      currentFocus,
      toVerify: cleanList(overlay.research_questions).slice(0, 4),
      viewLabel: "Serenity 当前判断",
      view: currentFocus,
      followup: triggerItems.join("；"),
      materialLine: cleanText(overlay.layer),
      inputState: `深度分析已通过 Serenity 校验 · ${dossierScore.quality_band || "合格"}`,
      stockRadar,
      analysisSections: [
        {
          title: "当前判断",
          body: currentFocus,
          items: judgment.slice(1, 3),
        },
        {
          title: "核心事实",
          items: observed.slice(0, 3),
        },
        triggerItems.length ? { title: "接下来盯什么", items: triggerItems } : null,
      ].filter(Boolean),
    },
    layers: {
      factNotes: observed.map((text) => ({ label: "已确认", text })),
      candidateSignals: cleanList(dossier.inferred).map((text) => ({ label: "分析", text })),
      analysisNotes: judgment.map((text) => ({ label: "判断", text })),
      evidenceGaps: cleanList(overlay.contrary_evidence).map((text) => ({ text, status: "open" })),
      nextVerificationQuestions: cleanList(overlay.research_questions).map((question) => ({
        question,
        status: "open",
      })),
      marketContext: {},
      forecastCandidates: [],
    },
    rawArtifacts: {
      aiReviewStatus: dossier.research_status,
      dossierScore,
      scorecard: scorecardResult,
      actionGrade: stockRadar.ai?.actionGrade || null,
      overlay,
      scenarioView: dossier.scenario_view || {},
      actionConditions: dossier.action_conditions || {},
    },
  };
}

function isDeterministicTemplateDossier(dossier) {
  const observed = Array.isArray(dossier?.observed) ? dossier.observed : [];
  const inferred = Array.isArray(dossier?.inferred) ? dossier.inferred : [];
  return (
    observed.some((text) =>
      String(text).startsWith(
        "Serenity 正式数据包中的行情、长期复权走势、财务、公告、订单/客户/产能证据和估值输入均已取数"
      )
    ) ||
    inferred.some((text) =>
      /当前的财务兑现状态为“(?:增长与现金流相互验证|财务质量偏弱|基本稳定、仍需验证)”/u.test(
        String(text)
      )
    )
  );
}

function buildStockRadar(row, context) {
  const { overlay, dossier, scorecardResult: scorecard, sourceRadar } = context;
  const actionGrade = buildSerenityActionGrade(context);
  const quote = context.currentQuote || {};
  const valuation = context.valuationInputs || {};
  const customerSummary = context.customerEvidence?.summary || {};
  const price = quote.regular_market_price ?? valuation.regular_market_price ?? sourceRadar.quote?.price ?? null;
  const previousClose = quote.previous_close ?? sourceRadar.quote?.previousClose ?? null;
  const changePct =
    typeof price === "number" && typeof previousClose === "number" && previousClose
      ? ((price - previousClose) / previousClose) * 100
      : sourceRadar.quote?.changePct ?? null;
  const turnover = quote.regular_market_turnover ?? sourceRadar.quote?.turnover ?? null;
  const techDetails = scorecard.module_results?.technical_timing?.details || {};
  const payoffDetails = scorecard.module_results?.market_payoff?.details || {};
  const technicalObservation = cleanList(dossier.observed).find((item) =>
    /均线|趋势|买点|技术/.test(item)
  );
  const officialReports = context.financials?.official_report_evidence?.reports || [];
  const primaryReportUrl =
    officialReports.find((item) => item.report_kind === "annual" && item.line_extraction?.status === "OK")?.pdf_url ||
    officialReports.find((item) => item.line_extraction?.status === "OK")?.pdf_url ||
    null;
  const latestReportUrl =
    officialReports.find((item) => item.announcement_date === context.financials?.latest_period)?.pdf_url ||
    officialReports.find((item) => item.line_extraction?.status === "OK")?.pdf_url ||
    primaryReportUrl;
  const evidenceTests = dossier.research_path?.evidence_tests || [];
  const alignedEvidenceReasons = alignEvidenceTestReasons(evidenceTests, cleanList(dossier.inferred));

  return {
    source: "serenity",
    symbol: overlay.symbol,
    name: row.name,
    generatedAt: context.generatedAt,
    quote: {
      price,
      previousClose,
      changePct,
      high: quote.regular_market_day_high ?? sourceRadar.quote?.high ?? null,
      low: quote.regular_market_day_low ?? sourceRadar.quote?.low ?? null,
      open: quote.regular_market_open ?? sourceRadar.quote?.open ?? null,
      volume: quote.regular_market_volume ?? sourceRadar.quote?.volume ?? null,
      turnover,
      turnoverText: sourceRadar.quote?.turnoverText || formatTurnoverText(turnover),
      currency: quote.currency || valuation.currency || sourceRadar.quote?.currency || "CNY",
      asOf: quote.regular_market_time || valuation.as_of_date || dossier.as_of_date,
    },
    ai: {
      rating: actionGrade.researchRating,
      ratingCap: scorecard.rating_cap || null,
      priorityScore: actionGrade.overallScore,
      technicalTimingScore: actionGrade.timingScore,
      marketPayoffScore: actionGrade.valuationScore,
      dataReadinessScore: scorecard.data_readiness_score ?? null,
      type: actionGrade.label,
      currentAction: actionGrade.nextCondition,
      actionReadiness: actionGrade.tier,
      watchlistBucket: actionGrade.tier,
      confidence: overlay.ai_confidence || null,
      companyScore: actionGrade.companyScore,
      evidenceScore: actionGrade.evidenceScore,
      valuationScore: actionGrade.valuationScore,
      timingScore: actionGrade.timingScore,
      riskScore: actionGrade.riskScore,
      decisionReason: actionGrade.reason,
      actionGrade,
    },
    movement: {
      confirmed: cleanList(dossier.observed),
      possible: cleanList(dossier.inferred),
      unexplained: [],
    },
    sentiment: {
      available: typeof actionGrade.valuationScore === "number",
      marketPayoffScore: actionGrade.valuationScore,
      crowdingControl: payoffDetails.crowding_control ?? null,
      evidenceSupportedGrowth: cleanText(overlay.evidence_supported_growth),
      note: cleanText(overlay.posterior_basis),
    },
    trend: {
      // The daily AI review refreshes the conclusion, but the price series is
      // produced by the stock-radar pipeline. Keep those visual fields so a
      // deep-review refresh cannot make the K-line section disappear.
      ...(sourceRadar.trend || {}),
      available: typeof actionGrade.timingScore === "number",
      technicalTimingScore: actionGrade.timingScore,
      dailyBuyPointScore: techDetails.daily_buy_point ?? null,
      dmaAlignmentScore: techDetails.gf_dma_alignment ?? null,
      state: technicalObservation || "Serenity 当前未确认上升趋势。",
      buyPoint:
        technicalObservation ||
        (scorecard.action_readiness === "WAIT_FOR_BUY_POINT"
          ? "当前没有确认买点，继续等待走势转强。"
          : "Serenity 当前没有给出确认买点。"),
    },
    risk: cleanList(dossier.bear_case),
    triggers: Object.fromEntries(
      Object.entries(dossier.trigger_table || {}).map(([period, items]) => [period, cleanList(items)])
    ),
    scenarios: Object.fromEntries(
      Object.entries(dossier.scenario_view || {}).map(([key, scenario]) => [
        key,
        {
          summary: cleanText(scenario?.summary),
          probability: scenario?.probability ?? null,
          conditions: cleanList(scenario?.conditions),
        },
      ])
    ),
    actionConditions: Object.fromEntries(
      Object.entries(dossier.action_conditions || {}).map(([key, items]) => [key, cleanList(items)])
    ),
    nextEvidence: [overlay.required_next_evidence, ...(overlay.research_questions || [])]
      .map(cleanText)
      .filter(Boolean),
    evidence: {
      directCustomerOrderCount: customerSummary.direct_evidence_count ?? null,
      leadCustomerOrderCount: customerSummary.lead_evidence_count ?? null,
      customerOrderStatus: customerSummary.evidence_status || null,
      h4h5EvidenceBarMet: overlay.h4_h5_evidence_bar_met,
      cards: evidenceTests.map((item, index) => ({
        title: cleanText(item.test),
        fact: cleanText(item.current_result),
        reason: cleanText(
          /反方|风险/u.test(item.test)
            ? "这条反方事实会直接拖慢收入、利润或现金流兑现，是判断能否成立的主要风险。"
            : alignedEvidenceReasons[index] || item.method
        ),
        status: item.evidence_status || "LEAD",
        sourceRefs:
          /价格/u.test(item.test)
            ? cleanList(item.source_refs)
            : [(/财务/u.test(item.test) ? latestReportUrl : primaryReportUrl) || cleanList(item.source_refs)[0]].filter(Boolean),
      })),
    },
  };
}

function buildSerenityActionGrade(context) {
  const periods = [...(context.financials?.periods || [])]
    .map((item) => ({
      ...normalizeFinancialPeriod(item),
      period_type: item.period_type || (/12-31$/u.test(String(item.period)) ? "annual" : item.period_type),
    }))
    .sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const latest = periods.at(-1);
  const comparable = periods
    .filter((item) => item.period_type === latest?.period_type && item.period !== latest?.period)
    .at(-1);
  const annuals = periods.filter((item) => item.period_type === "annual");
  const latestAnnual = annuals.at(-1);
  const previousAnnual = annuals.at(-2);
  const comparison = comparable || previousAnnual;
  const revenueGrowth = ratioGrowth(latest?.revenue, comparison?.revenue);
  const profitGrowth = ratioGrowth(latest?.net_income, comparison?.net_income);
  const annualRevenueGrowth = ratioGrowth(latestAnnual?.revenue, previousAnnual?.revenue);
  const annualProfitGrowth = ratioGrowth(latestAnnual?.net_income, previousAnnual?.net_income);
  const effectiveRevenueGrowth = revenueGrowth ?? annualRevenueGrowth;
  const effectiveProfitGrowth = profitGrowth ?? annualProfitGrowth;
  const cashConversion =
    numericValue(latest?.operating_cash_flow) != null &&
    numericValue(latest?.net_income) != null &&
    numericValue(latest?.net_income) !== 0
      ? numericValue(latest.operating_cash_flow) / numericValue(latest.net_income)
      : null;
  const debtRatio =
    numericValue(latest?.liabilities) != null &&
    numericValue(latest?.assets) != null &&
    numericValue(latest?.assets) !== 0
      ? numericValue(latest.liabilities) / numericValue(latest.assets)
      : null;

  const tests = context.dossier?.research_path?.evidence_tests || [];
  const financialTest = tests.find((item) => /财务|收入|现金/u.test(item.test || ""));
  const businessTest = tests.find((item) => /核心业务|订单|客户|产能|项目|商业/u.test(item.test || ""));
  const riskTest = tests.find((item) => /反方|风险/u.test(item.test || ""));
  const priceTest = tests.find((item) => /价格|技术|买点/u.test(item.test || ""));
  const reportCount = (context.financials?.official_report_evidence?.reports || [])
    .filter((item) => item.line_extraction?.status === "OK").length;

  let companyScore = 50;
  companyScore += growthScore(effectiveRevenueGrowth, { strong: 0.15, positive: 0.05, weak: -0.1, gain: 10, loss: 10 });
  companyScore += growthScore(effectiveProfitGrowth, { strong: 0.2, positive: 0.05, weak: -0.15, gain: 12, loss: 12 });
  if (cashConversion != null) {
    companyScore += cashConversion >= 1 ? 10 : cashConversion >= 0.6 ? 6 : cashConversion >= 0 ? 1 : -10;
  }
  companyScore += evidenceStatusScore(businessTest?.evidence_status, 12, -10, 2);
  companyScore += evidenceStatusScore(financialTest?.evidence_status, 6, -6, 0);
  companyScore = clampScore(companyScore);

  let evidenceScore = 42;
  evidenceScore += periods.length >= 3 ? 12 : periods.length >= 2 ? 8 : 0;
  evidenceScore += reportCount >= 2 ? 12 : reportCount === 1 ? 8 : 0;
  evidenceScore += evidenceStatusScore(businessTest?.evidence_status, 18, -10, 5);
  evidenceScore += evidenceStatusScore(financialTest?.evidence_status, 12, -8, 3);
  evidenceScore = clampScore(evidenceScore);

  let riskScore = 72;
  if (riskTest?.evidence_status === "CONFLICTED") riskScore -= 8;
  if (cashConversion != null && cashConversion < 0) riskScore -= 10;
  if (debtRatio != null && debtRatio > 0.75) riskScore -= 10;
  else if (debtRatio != null && debtRatio > 0.65) riskScore -= 5;
  if ((effectiveRevenueGrowth ?? 0) < -0.1) riskScore -= 5;
  if ((effectiveProfitGrowth ?? 0) < -0.15) riskScore -= 7;
  riskScore = clampScore(riskScore);

  const marketCap =
    numericValue(context.valuationInputs?.total_market_cap) ??
    numericValue(context.valuationInputs?.float_market_cap);
  const valuationCurrency = String(context.valuationInputs?.currency || "").toUpperCase();
  const financialCurrency = String(latestAnnual?.currency || latest?.currency || "").toUpperCase();
  const currencyComparable =
    !valuationCurrency ||
    !financialCurrency ||
    valuationCurrency === financialCurrency ||
    (valuationCurrency === "CNY" && financialCurrency === "RMB") ||
    (valuationCurrency === "RMB" && financialCurrency === "CNY");
  const annualRevenue = numericValue(latestAnnual?.revenue);
  const annualProfit = numericValue(latestAnnual?.net_income);
  const pe =
    currencyComparable && marketCap != null && annualProfit != null && annualProfit > 0
      ? marketCap / annualProfit
      : null;
  const ps =
    currencyComparable && marketCap != null && annualRevenue != null && annualRevenue > 0
      ? marketCap / annualRevenue
      : null;
  const priceFact = cleanText(priceTest?.current_result);
  const return20 = parseSignedPercent(priceFact.match(/近20(?:个交易日)?涨跌([+-]?\d+(?:\.\d+)?)%/u)?.[1]);
  let valuationScore = valuationBaseScore(pe, ps);
  if ((annualProfitGrowth ?? effectiveProfitGrowth ?? 0) > 0.2) valuationScore += 7;
  if ((annualRevenueGrowth ?? effectiveRevenueGrowth ?? 0) > 0.15) valuationScore += 4;
  if ((annualProfitGrowth ?? effectiveProfitGrowth ?? 0) < -0.15) valuationScore -= 8;
  if (return20 != null && return20 > 0.45) valuationScore -= 16;
  else if (return20 != null && return20 > 0.25) valuationScore -= 8;
  valuationScore = clampScore(valuationScore);

  const rawTimingScore = clampScore(
    numericValue(context.scorecardResult?.technical_timing_score) ??
      (priceTest?.evidence_status === "DIRECT" ? 68 : priceTest?.evidence_status === "CONFLICTED" ? 38 : 50)
  );
  const timingScore =
    priceTest?.evidence_status === "DIRECT"
      ? rawTimingScore
      : priceTest?.evidence_status === "CONFLICTED"
        ? Math.min(rawTimingScore, 45)
        : Math.min(rawTimingScore, 57);
  const fundamentalScore = roundScore(companyScore * 0.55 + evidenceScore * 0.3 + riskScore * 0.15);
  const overallScore = roundScore(fundamentalScore * 0.5 + valuationScore * 0.25 + timingScore * 0.25);

  let tier;
  let label;
  let reason;
  let nextCondition;
  if (
    fundamentalScore >= 70 &&
    evidenceScore >= 68 &&
    valuationScore >= 62 &&
    timingScore >= 58 &&
    riskScore >= 50 &&
    priceTest?.evidence_status === "DIRECT"
  ) {
    tier = "BUY_CANDIDATE";
    label = "适合买入候选";
    reason = "公司兑现、证据、价格和走势四项都达到 Serenity 的行动门槛。";
    nextCondition = "继续确认下一份正式披露没有削弱财务和业务判断。";
  } else if (
    fundamentalScore >= 66 &&
    evidenceScore >= 62 &&
    valuationScore >= 55 &&
    timingScore >= 52 &&
    riskScore >= 45
  ) {
    tier = "NEAR_BUY_POINT";
    label = "接近买点";
    reason = "公司和证据基本通过，但价格或走势只达到临界水平，还不够稳。";
    nextCondition = valuationScore < 62 ? "等待价格更有安全空间。" : "等待走势进一步确认。";
  } else if (fundamentalScore >= 66 && evidenceScore >= 62) {
    tier = "WAIT_FOR_PRICE";
    label = "公司可看，价格不合适";
    reason = valuationScore < 55
      ? "公司基本面可以继续看，但当前价格相对盈利和增长不够划算。"
      : "公司基本面可以继续看，但走势还没有形成可验证的买点。";
    nextCondition = valuationScore < 55 ? "等待估值回到更合理区间。" : "等待价格和成交共同确认。";
  } else if (fundamentalScore >= 55) {
    tier = "WATCH_FOR_EVIDENCE";
    label = "继续观察，等证据";
    reason = "公司存在值得跟踪的事实，但业务、财务或反方风险尚未形成完整闭环。";
    nextCondition = "等待下一份财报或公告补齐最关键的公司级证据。";
  } else {
    tier = "AVOID_FOR_NOW";
    label = "当前不优先";
    reason = "现有业务兑现、财务质量或风险收益不足以支持行动。";
    nextCondition = "只有核心业务和现金流明显改善，才重新评估。";
  }

  const researchRating =
    fundamentalScore >= 84 ? "A" : fundamentalScore >= 70 ? "B" : fundamentalScore >= 55 ? "C" : "D";
  return {
    methodology: "serenity_evidence_first_action_grade_v2",
    tier,
    label,
    researchRating,
    overallScore,
    fundamentalScore,
    companyScore,
    evidenceScore,
    valuationScore,
    timingScore,
    riskScore,
    reason,
    nextCondition,
    metrics: {
      pe: roundNullable(pe),
      ps: roundNullable(ps),
      revenueGrowth: roundNullable(effectiveRevenueGrowth),
      profitGrowth: roundNullable(effectiveProfitGrowth),
      cashConversion: roundNullable(cashConversion),
      debtRatio: roundNullable(debtRatio),
      return20: roundNullable(return20),
    },
  };
}

function growthScore(value, options) {
  if (value == null) return 0;
  if (value >= options.strong) return options.gain;
  if (value >= options.positive) return Math.round(options.gain * 0.6);
  if (value >= 0) return 2;
  if (value <= options.weak) return -options.loss;
  return -Math.round(options.loss * 0.4);
}

function evidenceStatusScore(status, direct, conflicted, lead) {
  if (status === "DIRECT") return direct;
  if (status === "CONFLICTED") return conflicted;
  return lead;
}

function valuationBaseScore(pe, ps) {
  if (pe != null) {
    if (pe <= 12) return 84;
    if (pe <= 20) return 74;
    if (pe <= 30) return 65;
    if (pe <= 45) return 56;
    if (pe <= 65) return 45;
    return 32;
  }
  if (ps != null) {
    if (ps <= 1.5) return 68;
    if (ps <= 3) return 60;
    if (ps <= 5) return 50;
    if (ps <= 8) return 40;
    return 28;
  }
  return 45;
}

function ratioGrowth(current, previous) {
  const currentValue = numericValue(current);
  const previousValue = numericValue(previous);
  return currentValue != null && previousValue != null && previousValue !== 0
    ? currentValue / previousValue - 1
    : null;
}

function normalizeFinancialPeriod(period) {
  const unit = String(period?.unit || "").toLowerCase();
  const multiplier =
    unit === "million" || unit === "million_yuan"
      ? 1_000_000
      : unit === "thousand_yuan"
        ? 1_000
        : 1;
  if (multiplier === 1) return period;
  const monetaryFields = [
    "assets",
    "liabilities",
    "equity",
    "parent_equity",
    "cash",
    "revenue",
    "operating_income",
    "profit_before_tax",
    "total_net_profit",
    "net_income",
    "operating_cash_flow",
    "investing_cash_flow",
    "financing_cash_flow",
  ];
  return {
    ...period,
    ...Object.fromEntries(
      monetaryFields
        .filter((field) => numericValue(period?.[field]) != null)
        .map((field) => [field, normalizeMonetaryValue(period, field, multiplier)])
    ),
    normalized_unit: "yuan",
  };
}

function normalizeMonetaryValue(period, field, multiplier) {
  const value = numericValue(period[field]);
  const balanceFields = new Set(["assets", "liabilities", "equity", "parent_equity", "cash"]);
  const referenceField = balanceFields.has(field) ? "assets" : "revenue";
  const reference = Math.abs(numericValue(period?.[referenceField]) || 0);
  const alreadyNormalized =
    field !== referenceField &&
    reference > 0 &&
    Math.abs(value) / reference >= 50;
  return alreadyNormalized ? value : value * multiplier;
}

function numericValue(value) {
  if (value === null || value === undefined || value === "") return null;
  const result = Number(value);
  return Number.isFinite(result) ? result : null;
}

function parseSignedPercent(value) {
  const result = numericValue(value);
  return result == null ? null : result / 100;
}

function clampScore(value) {
  return roundScore(Math.max(0, Math.min(100, Number(value) || 0)));
}

function roundScore(value) {
  return Math.round(Number(value) * 100) / 100;
}

function roundNullable(value) {
  return value == null ? null : Math.round(Number(value) * 10000) / 10000;
}

function cleanList(items) {
  return (items || []).map(cleanText).filter(Boolean);
}

function cleanText(value) {
  return String(value || "")
    .replace(/\s*[（(](?:supporting |basis )?source_ref:[^)）]+[)）]/gi, "")
    .replace(/(\d{9,}(?:\.\d+)?)元/g, (_, amount) => `${(Number(amount) / 100000000).toFixed(2)}亿元`)
    .replace(/market_implied_growth\s*=\s*H3/gi, "市场价格隐含较高增长预期")
    .replace(/evidence_supported_growth\s*=\s*H2/gi, "现有证据只支持温和增长")
    .replace(/market_implied_growth/gi, "市场隐含增长预期")
    .replace(/evidence_supported_growth/gi, "证据支持的增长")
    .replace(/WEAK_OR_DOWNTREND/gi, "弱势或下跌趋势")
    .replace(/NO_BUY_POINT/gi, "没有确认买点")
    .replace(/research_only/gi, "仅研究跟踪")
    .replace(/preflight/gi, "初步估值")
    .replace(/L0\/L1/gi, "官方原始披露")
    .replace(/行动候选/g, "可考虑买入的候选")
    .replace(/正式研究跟踪/g, "继续重点跟踪")
    .replace(/商业闭环/g, "订单和收入兑现")
    .replace(/资本行动/g, "解禁、增发等股本事项")
    .replace(/行动赔率/g, "当前买入的风险收益")
    .replace(/行动时点/g, "买入时机")
    .replace(/行动条件/g, "买入条件")
    .replace(/行动状态/g, "买入判断")
    .replace(/高质量现有热管理业务/g, "现有热管理业务质量较好")
    .replace(/待验证智能驱动增量/g, "智能驱动新业务仍待订单和收入验证")
    .replace(/当前不升级为可考虑买入的候选/g, "当前不适合买入")
    .replace(/保持公司级正向兑现/g, "保持增长")
    .replace(
      /已经形成从产品和客户供应链到收入、利润与经营现金流的公司级闭环/g,
      "已经得到产品、客户、收入、利润和现金流的完整验证"
    )
    .replace(/证据支持增长由H2向H3靠拢/g, "现有证据开始支持更高增长")
    .replace(/H2证据支持被下调/g, "现有增长判断需要下调")
    .replace(/公司级正向兑现/g, "公司整体保持增长")
    .replace(/公司级闭环/g, "公司整体收入、利润和现金流验证")
    .replace(/同等级闭环/g, "同等程度的订单和收入验证")
    .replace(/订单及独立收入尚未闭环/g, "订单和独立收入尚未得到验证")
    .replace(/尚未形成同等程度的订单和收入验证/g, "还没有得到同等程度的订单和收入验证")
    .replace(/证据支持增长由温和增长向较高增长靠拢/g, "现有证据开始支持更高增长")
    .replace(/温和增长证据支持被下调/g, "现有增长判断需要下调")
    .replace(/L0\/L1客户定点/g, "官方披露客户确认采用")
    .replace(/客户定点/g, "客户确认采用")
    .replace(/官方原始披露客户确认采用/g, "官方公告披露客户采用")
    .replace(/PE和PS/gi, "市盈率和市销率")
    .replace(/\bH2\b/g, "温和增长")
    .replace(/\bH3\b/g, "较高增长")
    .replace(/\s+/g, " ")
    .trim();
}

function periodLabel(period) {
  return { "30d": "未来30天", "90d": "未来90天", "180d": "未来180天" }[period] || period;
}

function formatTurnoverText(value) {
  if (typeof value !== "number") return null;
  return `${(value / 10000).toFixed(2)}亿`;
}

async function readOptionalJsonFile(filePath) {
  try {
    return await readJsonFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
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
  return (
    entries
      .filter((entry) => entry.isDirectory() && entry.name.endsWith(`_${entityId}`))
      .map((entry) => path.join(root, entry.name))
      .sort((a, b) => String(b).localeCompare(String(a)))[0] || null
  );
}

async function findManifestPath(root) {
  let entries = [];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
  for (const entry of entries) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === "manifest.json") return candidate;
    if (entry.isDirectory()) {
      const nested = await findManifestPath(candidate);
      if (nested) return nested;
    }
  }
  return null;
}

function execSerenity(command) {
  const python = process.env.SERENITY_PYTHON || DEFAULT_PYTHON;
  return new Promise((resolve, reject) => {
    const child = spawn(python, command, {
      cwd: process.env.SERENITY_HOME || DEFAULT_SERENITY_HOME,
      env: {
        ...process.env,
        SERENITY_DATA_DIR: process.env.SERENITY_DATA_DIR || path.join(DATA_DIR, "serenity_provider"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    child.on("error", (error) => reject(Object.assign(error, { stdout, stderr })));
    child.on("close", (exitCode) => {
      if (exitCode === 0) resolve({ exitCode, stdout, stderr });
      else reject(Object.assign(new Error(`Serenity validator exited with ${exitCode}: ${stderr}`), { exitCode }));
    });
  });
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") result.help = true;
    else if (item.startsWith("--")) {
      const key = item.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      result[key] = argv[index + 1];
      index += 1;
    }
  }
  return result;
}
