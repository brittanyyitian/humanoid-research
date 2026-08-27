import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./data-utils.mjs";
import { hash, nowShanghai } from "./services/router-service.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const DATASET_LABELS = {
  current_quote: "当前行情",
  price_history_adjusted: "历史K线",
  valuation_inputs: "估值输入",
  financials: "财务数据",
  filings_announcements: "公告材料",
  customer_order_capacity_evidence: "订单/客户/产能证据",
};
const DATASET_IMPACTS = {
  current_quote: "缺当前价格，不能判断实时涨跌和估值位置",
  price_history_adjusted: "缺历史K线，不能判断趋势和买点",
  valuation_inputs: "缺市值、股本等估值输入，不能判断估值是否匹配",
  financials: "缺财务数据，不能验证收入、利润和现金流兑现",
  filings_announcements: "缺公告材料，不能验证正式披露",
  customer_order_capacity_evidence: "缺订单、客户或产能证据，不能确认业务兑现",
};
const STATUS_LABELS = {
  FAILED: "缺失",
  PARTIAL: "部分",
  OK: "已覆盖",
  READY: "已覆盖",
  MISSING: "缺失",
};

const args = parseArgs(process.argv.slice(2));

function usage() {
  return `Usage:
  node scripts/run_serenity_stock_radar.mjs --entity-id <entity_id>
  node scripts/run_serenity_stock_radar.mjs --entity-ids <id_a,id_b>
  node scripts/run_serenity_stock_radar.mjs --all --limit <n>

Options:
  --refresh-formal   Run Serenity formal before projecting stockRadar.
  --force            Regenerate even if the entity already has stockRadar.
  --replace-ai-review Allow overwriting existing serenity_ai_review output.
  --refresh-ai-review-market Keep AI dossier facts, but refresh its daily quote, scores and timing.
  --dry-run          Print selected rows without writing.
`;
}

if (args.help) {
  console.log(usage());
  process.exit(0);
}

try {
  const result = await runStockRadar({
    all: Boolean(args.all),
    entityId: args.entityId,
    entityIds: args.entityIds,
    limit: Number.parseInt(args.limit || "", 10),
    refreshFormal: Boolean(args.refreshFormal),
    force: Boolean(args.force),
    replaceAiReview: Boolean(args.replaceAiReview),
    refreshAiReviewMarket: Boolean(args.refreshAiReviewMarket),
    dryRun: Boolean(args.dryRun),
  });
  if (args.dryRun) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(
      `Serenity stock radar complete. selected=${result.selectedCount}, written=${result.writtenCount}, skipped=${result.skippedCount}, failed=${result.failedCount}`
    );
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

async function runStockRadar(options) {
  if (!options.all && !options.entityId && !options.entityIds) throw new Error(`Missing --all, --entity-id or --entity-ids\n${usage()}`);
  const dashboard = await readJsonFile(path.join(DATA_DIR, "dashboard", "serenity_analysis.json"));
  const marketDashboard = await readOptionalJson(path.join(DATA_DIR, "dashboard", "market.json"));
  const marketByEntityId = new Map((marketDashboard?.rows || []).map((row) => [row.entityId, row]));
  const marketHistoryByEntityId = await loadLocalMarketHistory();
  const rows = selectRows(dashboard.rows || [], options);
  if (options.dryRun) {
    return {
      selectedCount: rows.length,
      rows: rows.map((row) => ({
        entityId: row.entityId,
        name: row.name,
        ticker: tickerForRow(row),
      })),
    };
  }

  let writtenCount = 0;
  let skippedCount = 0;
  let failedCount = 0;
  for (const row of rows) {
    const outputPath = path.join(DATA_DIR, "analysis", "serenity_outputs", `${row.entityId}.json`);
    const existing = await readOptionalJson(outputPath);
    const refreshExistingAiReview =
      existing?.status === "serenity_ai_review" && options.refreshAiReviewMarket && !options.replaceAiReview;
    const refreshExistingReviewOutcome =
      existing?.status === "serenity_ai_review_outcome" &&
      options.refreshAiReviewMarket &&
      !options.replaceAiReview;
    if (existing?.status === "serenity_ai_review" && !options.replaceAiReview && !refreshExistingAiReview) {
      skippedCount += 1;
      continue;
    }
    if (
      existing?.status === "serenity_ai_review_outcome" &&
      !options.replaceAiReview &&
      !refreshExistingReviewOutcome
    ) {
      skippedCount += 1;
      continue;
    }
    if (existing?.display?.stockRadar && !options.force) {
      skippedCount += 1;
      continue;
    }
    try {
      if (options.refreshFormal) await runFormal(row.entityId);
      const projected = await buildOutputForRow(row, {
        marketSnapshot: marketByEntityId.get(row.entityId) || null,
        marketHistory: marketHistoryByEntityId.get(row.entityId) || [],
      });
      const output = refreshExistingAiReview
        ? mergeDailyAiReview(existing, projected)
        : refreshExistingReviewOutcome
          ? mergeDailyReviewOutcome(existing, projected)
          : projected;
      await writeJsonFile(outputPath, output);
      writtenCount += 1;
    } catch (error) {
      if (!existing && options.force) {
        const failed = buildFailedOutput(row, error);
        await writeJsonFile(outputPath, failed);
      }
      failedCount += 1;
    }
  }
  return { selectedCount: rows.length, writtenCount, skippedCount, failedCount };
}

function mergeDailyReviewOutcome(existing, projected) {
  const previousRadar = existing?.display?.stockRadar || {};
  const dailyRadar = projected?.display?.stockRadar || {};
  const stockRadar = {
    ...previousRadar,
    generatedAt: projected.generatedAt,
    quote: dailyRadar.quote || previousRadar.quote,
    dailyRefresh: {
      generatedAt: projected.generatedAt,
      source: "market_snapshot_only",
      note: "仅刷新行情；在逐份正文深研完成前，不生成或刷新个股判断。",
    },
  };
  return {
    ...existing,
    generatedAt: projected.generatedAt,
    display: {
      ...existing.display,
      stockRadar,
    },
    rawArtifacts: {
      ...(existing.rawArtifacts || {}),
      dailyRefresh: stockRadar.dailyRefresh,
    },
  };
}

function mergeDailyAiReview(existing, projected) {
  const previousRadar = existing?.display?.stockRadar || {};
  const dailyRadar = projected?.display?.stockRadar || {};
  const updatedAi = {
    ...(previousRadar.ai || {}),
    rating: dailyRadar.ai?.rating ?? previousRadar.ai?.rating ?? null,
    ratingCap: dailyRadar.ai?.ratingCap ?? previousRadar.ai?.ratingCap ?? null,
    priorityScore: dailyRadar.ai?.priorityScore ?? previousRadar.ai?.priorityScore ?? null,
    technicalTimingScore:
      dailyRadar.ai?.technicalTimingScore ?? previousRadar.ai?.technicalTimingScore ?? null,
    marketPayoffScore: dailyRadar.ai?.marketPayoffScore ?? previousRadar.ai?.marketPayoffScore ?? null,
    dataReadinessScore: dailyRadar.ai?.dataReadinessScore ?? previousRadar.ai?.dataReadinessScore ?? null,
    actionReadiness: dailyRadar.ai?.actionReadiness || previousRadar.ai?.actionReadiness || null,
    watchlistBucket: dailyRadar.ai?.watchlistBucket || previousRadar.ai?.watchlistBucket || null,
  };
  const stockRadar = {
    ...previousRadar,
    generatedAt: projected.generatedAt,
    quote: dailyRadar.quote || previousRadar.quote,
    ai: updatedAi,
    sentiment: dailyRadar.sentiment || previousRadar.sentiment,
    trend: dailyRadar.trend || previousRadar.trend,
    evidence: {
      ...(previousRadar.evidence || {}),
      ...(dailyRadar.evidence || {}),
    },
    dailyRefresh: {
      generatedAt: projected.generatedAt,
      source: "serenity_formal_scorecard",
      note: "保留已校验 AI dossier 的业务事实，每日刷新行情、估值、技术时机和行动就绪度。",
    },
  };
  return {
    ...existing,
    generatedAt: projected.generatedAt,
    display: {
      ...existing.display,
      stockRadar,
      inputState: `${String(existing.display?.inputState || "Serenity 深研已校验")
        .split(" · ")
        .filter((part) => part && part !== "行情每日更新")
        .join(" · ")} · 行情每日更新`,
    },
    rawArtifacts: {
      ...(existing.rawArtifacts || {}),
      scorecard: projected.rawArtifacts?.scorecard || existing.rawArtifacts?.scorecard,
      dailyRefresh: stockRadar.dailyRefresh,
    },
  };
}

function selectRows(rows, options) {
  let selected = rows.filter((row) => tickerForRow(row));
  if (options.entityId) selected = selected.filter((row) => row.entityId === options.entityId);
  if (options.entityIds) {
    const selectedEntityIds = new Set(String(options.entityIds).split(",").map((value) => value.trim()).filter(Boolean));
    selected = selected.filter((row) => selectedEntityIds.has(row.entityId));
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

async function runFormal(entityId) {
  const child = spawn(process.execPath, ["scripts/run_serenity_formal.mjs", "--entity-id", entityId], {
    cwd: ROOT,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  if (exitCode !== 0) {
    throw Object.assign(new Error(`Serenity formal failed for ${entityId}`), { stdout, stderr, exitCode });
  }
}

async function buildOutputForRow(row, options = {}) {
  const ticker = tickerForRow(row);
  const symbol = ticker;
  const runDir = await latestFormalRunDir(row.entityId);
  if (!runDir) throw new Error(`${row.name} has no Serenity formal workspace.`);

  const manifestPath = await findManifestPath(runDir, symbol);
  if (!manifestPath) throw new Error(`${row.name} formal workspace has no manifest.json.`);
  const dataDir = path.dirname(manifestPath);
  const code = String(symbol).split(".")[0];
  const generatedAt = nowShanghai();
  const scorecard = await readJsonFile(path.join(runDir, "scorecard_result.json"));
  const currentQuote = await readOptionalJson(path.join(dataDir, `${symbol}_current_quote.json`)) ||
    (await readOptionalJson(path.join(dataDir, `${code}_current_quote.json`)));
  const valuationInputs = await readOptionalJson(path.join(dataDir, `${symbol}_valuation_inputs.json`)) ||
    (await readOptionalJson(path.join(dataDir, `${code}_valuation_inputs.json`)));
  const customerEvidence = await readOptionalJson(path.join(dataDir, `${symbol}_customer_order_capacity_evidence.json`)) ||
    (await readOptionalJson(path.join(dataDir, `${code}_customer_order_capacity_evidence.json`)));
  const priceHistoryText =
    (await readOptionalText(path.join(dataDir, `${symbol}_price_history_adjusted.csv`))) ||
    (await readOptionalText(path.join(dataDir, `${code}_price_history_adjusted.csv`))) ||
    "";
  const scoreMarkdown = await readOptionalText(path.join(runDir, "scorecard.md"));
  const formalPriceRows = parsePriceHistory(priceHistoryText);
  const stockRadar = buildStockRadar(row, {
    generatedAt,
    symbol,
    scorecard,
    currentQuote,
    valuationInputs,
    customerEvidence,
    priceRows: formalPriceRows.length >= 20 ? formalPriceRows : options.marketHistory || [],
    marketSnapshot: options.marketSnapshot,
  });

  return {
    id: `saout_${row.entityId}_${hash(`${symbol}|${generatedAt}|stock_radar|${scorecard.candidate_priority_score}`, 12)}`,
    entityId: row.entityId,
    name: row.name,
    generatedAt,
    contractType: "serenity_analysis_output_v0",
    status: "serenity_stock_radar",
    provider: {
      name: "serenity_chan_formal_scorecard_v0",
      type: "vendored_cli",
      mode: "formal_scorecard_projection",
      externalCall: true,
      note: "前台 stockRadar 只投影 Serenity formal workspace 里的 scorecard、行情、估值和证据字段；未生成 AI dossier 的内容不会补写。",
    },
    sourceInputPack: {
      contractType: row.contractType,
      analysisStatus: row.analysisStatus,
      ticker,
      symbol,
    },
    inputRefs: {
      providerRunDir: runDir,
      manifestPath,
      scoreResultPath: path.join(runDir, "scorecard_result.json"),
      dashboardRefs: ["dashboard/serenity_analysis.json"],
    },
    display: {
      mode: "serenity_stock_radar",
      label: "Serenity Stock Radar",
      title: `${row.name} Serenity Stock Radar`,
      summary: scorecard.verdict || `${row.name} 已生成 Serenity stockRadar。`,
      currentFocus: scorecard.verdict || "",
      toVerify: [
        ...(scorecard.decision_blockers || []).map(formatBlocker).filter(Boolean),
        ...(scorecard.falsification_points || []).map(formatSerenityText).filter(Boolean).slice(0, 2),
      ].slice(0, 4),
      viewLabel: "Serenity 动作",
      view: scorecard.verdict || "",
      followup: formatSerenityText((scorecard.falsification_points || [])[0]) || "等待 Serenity 后续 review。",
      materialLine: `候选优先级 ${scorecard.candidate_priority_score ?? "--"}/100`,
      inputState: `${scorecard.action_readiness || "--"} · 评级 ${scorecard.final_rating || "--"}`,
      stockRadar,
    },
    layers: {
      factNotes: (scorecard.evidence_notes || []).map((item) => ({ label: "Evidence", text: item.claim })),
      candidateSignals: [],
      analysisNotes: [{ label: "Serenity verdict", text: scorecard.verdict || "" }].filter((item) => item.text),
      evidenceGaps: (scorecard.decision_blockers || []).map((item) => ({ text: formatBlocker(item), status: "open" })),
      nextVerificationQuestions: (scorecard.falsification_points || [])
        .map(formatSerenityText)
        .filter(Boolean)
        .map((question) => ({ question, status: "open" })),
      marketContext: {},
      forecastCandidates: [],
    },
    rawArtifacts: {
      scorecard,
      scorecardMarkdownExcerpt: scoreMarkdown.slice(0, 4000),
    },
    calibration: {
      status: "not_started",
      note: "Stock radar projection has not entered Serenity review calibration yet.",
    },
    guardrails: [
      "该 stockRadar 只来自 Serenity formal scorecard 和取数字段。",
      "未生成 AI dossier 的股票不展示 AI 深研结论。",
      "不输出收益承诺或个性化仓位建议。",
    ],
  };
}

async function loadLocalMarketHistory() {
  const stocksDir = path.join(DATA_DIR, "stocks");
  const byEntityId = new Map();
  const entries = await fs.readdir(stocksDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && /^market_\d{4}_\d{2}_\d{2}\.json$/u.test(entry.name))
    .map((entry) => entry.name)
    .sort();
  for (const fileName of files) {
    const rows = await readOptionalJson(path.join(stocksDir, fileName));
    for (const row of Array.isArray(rows) ? rows : []) {
      if (!row.entityId || !Number.isFinite(finiteNumber(row.price))) continue;
      const entityRows = byEntityId.get(row.entityId) || [];
      entityRows.push({
        date: row.date || fileName.slice(7, 17).replaceAll("_", "-"),
        open: finiteNumber(row.open),
        high: finiteNumber(row.high),
        low: finiteNumber(row.low),
        close: finiteNumber(row.price),
        volume: finiteNumber(row.volume),
      });
      byEntityId.set(row.entityId, entityRows);
    }
  }
  for (const rows of byEntityId.values()) rows.sort((a, b) => String(a.date).localeCompare(String(b.date)));
  return byEntityId;
}

function buildStockRadar(row, context) {
  const { generatedAt, symbol, scorecard, currentQuote, valuationInputs, customerEvidence, priceRows, marketSnapshot } = context;
  const quote = currentQuote || {};
  const valuation = valuationInputs || {};
  const customerSummary = customerEvidence?.summary || {};
  const price = marketSnapshot?.price ?? quote.regular_market_price ?? valuation.regular_market_price ?? null;
  const marketChangePct = typeof marketSnapshot?.changePct === "number" ? marketSnapshot.changePct : null;
  const previousClose =
    (typeof price === "number" && typeof marketChangePct === "number"
      ? price / (1 + marketChangePct / 100)
      : quote.previous_close ?? null);
  const changePct =
    typeof price === "number" && typeof previousClose === "number" && previousClose
      ? ((price - previousClose) / previousClose) * 100
      : marketChangePct;
  const techDetails = scorecard.module_results?.technical_timing?.details || {};
  const marketPayoffDetails = scorecard.module_results?.market_payoff?.details || {};
  const hasMarketPayoff = isDatasetOk(scorecard, "current_quote", marketSnapshot) && isDatasetOk(scorecard, "valuation_inputs");
  const hasTechnicalTiming = isDatasetOk(scorecard, "price_history_adjusted");
  const plainTrend = buildPlainTrendReading(priceRows, price);
  const displayBlockers = (scorecard.decision_blockers || []).filter(
    (item) => !(marketSnapshot && item?.dataset === "current_quote")
  );

  return {
    source: "serenity",
    symbol,
    name: row.name,
    generatedAt,
    quote: {
      price,
      previousClose,
      changePct,
      high: quote.regular_market_day_high ?? null,
      low: quote.regular_market_day_low ?? null,
      open: quote.regular_market_open ?? null,
      volume: quote.regular_market_volume ?? null,
      turnover: quote.regular_market_turnover ?? parseMarketMoney(marketSnapshot?.turnoverAmount),
      turnoverText: marketSnapshot?.turnoverAmount || null,
      currency: quote.currency || valuation.currency || "CNY",
      asOf: marketSnapshot?.quoteTime || marketSnapshot?.capturedAt || valuation.as_of_date || String(generatedAt).slice(0, 10),
      source: marketSnapshot ? "daily_market_snapshot" : currentQuote ? "serenity_current_quote" : "missing",
    },
    ai: {
      rating: scorecard.final_rating || scorecard.research_rating || null,
      ratingCap: scorecard.rating_cap || null,
      priorityScore: scorecard.candidate_priority_score ?? null,
      technicalTimingScore: scorecard.technical_timing_score ?? null,
      marketPayoffScore: scorecard.market_payoff_score ?? null,
      dataReadinessScore: scorecard.data_readiness_score ?? null,
      type: scorecard.verdict || null,
      currentAction: actionText(scorecard),
      actionReadiness: scorecard.action_readiness || null,
      watchlistBucket: scorecard.watchlist_bucket || null,
      confidence: scorecard.evidence_confidence_rating || null,
    },
    movement: {
      confirmed: (scorecard.evidence_notes || []).map((item) => item.claim).filter(Boolean),
      possible: [scorecard.verdict].filter(Boolean),
      unexplained: ["Serenity scorecard 不把涨跌解释成单一事件因果；行情只作为市场事实。"],
    },
    sentiment: hasMarketPayoff
      ? {
          available: true,
          marketPayoffScore: scorecard.market_payoff_score ?? null,
          crowdingControl: marketPayoffDetails.crowding_control ?? null,
          evidenceSupportedGrowth: null,
          note: `候选优先级 ${scorecard.candidate_priority_score ?? "--"}/100；行动就绪 ${scorecard.action_readiness || "--"}。`,
        }
      : null,
    trend: hasTechnicalTiming
      ? {
          available: true,
          technicalTimingScore: scorecard.technical_timing_score ?? null,
          dailyBuyPointScore: techDetails.daily_buy_point ?? null,
          dmaAlignmentScore: techDetails.gf_dma_alignment ?? null,
          state: "Serenity formal scorecard 技术时机字段。",
          buyPoint: buyPointText(scorecard),
          chart: plainTrend.chart,
          plainReading: plainTrend.reading,
        }
      : null,
    risk: [
      ...displayBlockers.map(formatBlocker).filter(Boolean),
      ...(scorecard.falsification_points || []).map(formatSerenityText).filter(Boolean),
    ],
    triggers: {
      "30d": [formatSerenityText((scorecard.falsification_points || [])[0]) || "复核订单、客户、交付和财报兑现。"],
      "90d": [formatSerenityText((scorecard.falsification_points || [])[1]) || "复核财报是否出现机器人相关收入或业务线。"],
      "180d": [formatSerenityText((scorecard.falsification_points || [])[2]) || "复核供应链和合作披露是否能被官方材料交叉验证。"],
    },
    nextEvidence: [
      ...displayBlockers.map(formatBlocker).filter(Boolean),
      ...(scorecard.falsification_points || []).map(formatSerenityText).filter(Boolean),
    ],
    evidence: {
      directCustomerOrderCount: customerSummary.direct_evidence_count ?? null,
      leadCustomerOrderCount: customerSummary.lead_evidence_count ?? null,
      customerOrderStatus: customerSummary.evidence_status || null,
      h4h5EvidenceBarMet: null,
    },
  };
}

function isDatasetOk(scorecard, dataset, fallbackValue = null) {
  if (dataset === "current_quote" && fallbackValue) return true;
  return scorecard?.data_readiness?.details?.[dataset]?.status === "OK";
}

function parseMarketMoney(value) {
  if (typeof value === "number") return value;
  if (!value) return null;
  const text = String(value).replaceAll(",", "").trim();
  const amount = Number.parseFloat(text);
  if (!Number.isFinite(amount)) return null;
  if (text.includes("亿")) return amount * 100000000;
  if (text.includes("万")) return amount * 10000;
  return amount;
}

function actionText(scorecard) {
  if (scorecard.action_readiness === "DATA_GATED") return "数据门控：先观察，不作为行动候选。";
  if (scorecard.action_readiness === "BUY_POINT_GATED") return "等待买点：需要技术结构确认。";
  if (scorecard.action_readiness === "WAIT_FOR_BUY_POINT") return "等待买点。";
  if (scorecard.action_readiness === "CANDIDATE_POOL") return "候选池观察。";
  if (scorecard.action_readiness === "CORE_CANDIDATE") return "核心候选观察。";
  return scorecard.verdict || "Serenity 未给出动作。";
}

function buyPointText(scorecard) {
  if (scorecard.action_readiness === "BUY_POINT_GATED" || scorecard.action_readiness === "WAIT_FOR_BUY_POINT") {
    return "Serenity 标记为等待买点，需要技术结构确认。";
  }
  if ((scorecard.technical_timing_score ?? 0) < 50) return "Serenity 技术时机分偏低，未给出确认买点。";
  return "Serenity 未输出明确买点；只显示技术时机分。";
}

function parsePriceHistory(text) {
  const lines = String(text || "").trim().split(/\r?\n/u).filter(Boolean);
  if (lines.length <= 1) return [];
  return lines.slice(1).map((line) => {
    const [date, open, high, low, close, volume, adjustedClose, rawClose] = line.split(",");
    return {
      date,
      open: finiteNumber(open),
      high: finiteNumber(high),
      low: finiteNumber(low),
      close: finiteNumber(adjustedClose) ?? finiteNumber(close) ?? finiteNumber(rawClose),
      volume: finiteNumber(volume),
    };
  }).filter((row) => row.date && Number.isFinite(row.close));
}

function buildPlainTrendReading(rows = [], currentPrice = null) {
  const cleanRows = rows.filter((row) => Number.isFinite(row.close) && row.close > 0);
  if (cleanRows.length < 20) {
    return {
      chart: [],
      reading: {
        state: "走势数据还不够",
        what: "目前没有足够的历史价格可供比较。",
        meaning: "现在不能只凭一两天涨跌判断方向。",
        watch: "等历史数据补齐后，再观察价格是否真正站稳。",
        risk: "数据不足时，不把短期波动当成买点。",
      },
    };
  }

  const close = Number.isFinite(currentPrice) ? currentPrice : cleanRows.at(-1).close;
  const average20 = averageClose(cleanRows.slice(-20));
  const average60 = averageClose(cleanRows.slice(-60));
  const previousAverage20 = averageClose(cleanRows.slice(-25, -5));
  const recentHigh = Math.max(...cleanRows.slice(-20).map((row) => row.high || row.close));
  const recentLow = Math.min(...cleanRows.slice(-10).map((row) => row.low || row.close));
  const averageVolume = averageNumber(cleanRows.slice(-21, -1).map((row) => row.volume));
  const latestVolume = cleanRows.at(-1).volume;
  const volumeRatio = averageVolume && latestVolume ? latestVolume / averageVolume : null;
  const aboveShortCost = Number.isFinite(average20) && close >= average20;
  const aboveLongCost = Number.isFinite(average60) && close >= average60;
  const shortCostRising = Number.isFinite(previousAverage20) && average20 > previousAverage20;

  let state = "方向还不清楚";
  let meaning = "价格没有形成持续向上或持续向下的状态，先等它自己走出来。";
  if (aboveShortCost && aboveLongCost && shortCostRising) {
    state = "走势正在变强";
    meaning = "价格高于近期多数人的平均成本，而且近期平均成本也在抬高。";
  } else if (!aboveShortCost && !aboveLongCost && !shortCostRising) {
    state = "走势仍然偏弱";
    meaning = "价格低于近期多数人的平均成本，反弹还没有改变原来的弱势。";
  } else if (aboveShortCost && !aboveLongCost) {
    state = "短期反弹，尚未完全转强";
    meaning = "最近有所修复，但更长一段时间形成的压力还没有越过。";
  } else if (!aboveShortCost && aboveLongCost) {
    state = "上涨后正在回落确认";
    meaning = "中期方向还没有明显走坏，但短期需要重新站稳。";
  }

  const volumeText = volumeRatio == null
    ? "成交数据暂时不足"
    : volumeRatio >= 1.35
      ? "今天成交明显增多"
      : volumeRatio <= 0.72
        ? "今天成交明显减少"
        : "今天成交与平时接近";
  const costText = aboveShortCost ? "现价在近一个月平均成本上方" : "现价还在近一个月平均成本下方";
  const what = `${costText}；${volumeText}。`;
  const watch = aboveShortCost
    ? `接下来能守住 ${formatPrice(average20)} 附近，上涨时成交没有明显缩小，才算继续变好。`
    : `先看能否重新站上 ${formatPrice(average20)} 附近并保持几天，再谈走势变强。`;
  const risk = `如果跌破近期低点 ${formatPrice(recentLow)}，说明走势比现在更差，需要重新判断。`;
  const chart = cleanRows.slice(-90).map((row, visibleIndex, visibleRows) => {
    const sourceIndex = cleanRows.length - visibleRows.length + visibleIndex;
    return {
      date: row.date,
      close: roundNumber(row.close),
      volume: roundNumber(row.volume),
      average20: roundNumber(averageClose(cleanRows.slice(Math.max(0, sourceIndex - 19), sourceIndex + 1))),
      average60: roundNumber(averageClose(cleanRows.slice(Math.max(0, sourceIndex - 59), sourceIndex + 1))),
    };
  });

  return {
    chart,
    reading: {
      state,
      what,
      meaning,
      watch,
      risk,
      levels: {
        current: roundNumber(close),
        recentAverage: roundNumber(average20),
        longerAverage: roundNumber(average60),
        recentHigh: roundNumber(recentHigh),
        recentLow: roundNumber(recentLow),
      },
    },
  };
}

function averageClose(rows = []) {
  return averageNumber(rows.map((row) => row.close));
}

function averageNumber(values = []) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return clean.reduce((sum, value) => sum + value, 0) / clean.length;
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(String(value).replaceAll(",", ""));
  return Number.isFinite(number) ? number : null;
}

function roundNumber(value) {
  return Number.isFinite(value) ? Number(value.toFixed(3)) : null;
}

function formatPrice(value) {
  if (!Number.isFinite(value)) return "这个位置";
  return value >= 100 ? value.toFixed(1) : value.toFixed(2);
}

function buildFailedOutput(row, error) {
  const generatedAt = nowShanghai();
  return {
    id: `saout_${row.entityId}_${hash(`${generatedAt}|stock_radar_failed`, 12)}`,
    entityId: row.entityId,
    name: row.name,
    generatedAt,
    contractType: "serenity_analysis_output_v0",
    status: "serenity_stock_radar_failed",
    provider: {
      name: "serenity_stock_radar_projector_v0",
      type: "local_projection",
      mode: "failed",
      externalCall: false,
      note: "Stock radar projection failed.",
    },
    display: {
      mode: "serenity_stock_radar_failed",
      label: "Serenity Stock Radar 失败",
      title: `${row.name} Stock Radar 失败`,
      summary: error.message,
      currentFocus: error.message,
      toVerify: ["检查 formal workspace", "重新运行 Serenity formal"],
      viewLabel: "失败原因",
      view: error.stderr || error.stdout || error.message,
    },
    layers: {
      factNotes: [],
      candidateSignals: [],
      analysisNotes: [],
      evidenceGaps: [{ text: error.message, status: "open" }],
      nextVerificationQuestions: [{ question: "重新运行 Serenity formal", status: "open" }],
      marketContext: {},
      forecastCandidates: [],
    },
  };
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

async function findManifestPath(runDir, symbol) {
  const code = String(symbol || "").split(".")[0];
  const direct = path.join(runDir, "data", code, "manifest.json");
  if (await exists(direct)) return direct;
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

async function readOptionalText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
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

function formatBlocker(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  if (item.dataset) {
    const dataset = DATASET_LABELS[item.dataset] || String(item.dataset).replaceAll("_", " ");
    const status = STATUS_LABELS[item.status] || item.status;
    const impact = DATASET_IMPACTS[item.dataset] || item.rating_impact || item.decision_impact || item.gap_type;
    return `${dataset}${status ? ` ${status}` : ""}${impact ? `：${impact}` : ""}`;
  }
  if (item.name) {
    const label = String(item.name).replaceAll("_", " ");
    return `${label}${item.effect ? `：${item.effect}` : ""}`;
  }
  return formatSerenityText(item);
}

function formatSerenityText(item) {
  if (!item) return "";
  if (typeof item === "string") return item;
  if (item.question) return String(item.question);
  if (item.text) return String(item.text);
  if (item.claim) return String(item.claim);
  if (item.next_action) return String(item.next_action);
  try {
    return JSON.stringify(item);
  } catch {
    return String(item);
  }
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--help" || item === "-h") result.help = true;
    else if (
      item === "--all" ||
      item === "--refresh-formal" ||
      item === "--force" ||
      item === "--replace-ai-review" ||
      item === "--refresh-ai-review-market" ||
      item === "--dry-run"
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
