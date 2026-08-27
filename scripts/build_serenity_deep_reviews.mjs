import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { DATA_DIR, readJsonFile, writeJsonFile } from "./data-utils.mjs";
import { buildEvidenceDossier } from "./services/serenity-evidence-dossier-service.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const SERENITY_HOME = path.join(ROOT, "vendor", "serenity-chan");
const PYTHON =
  "/Users/edy/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";

const args = parseArgs(process.argv.slice(2));
const sectorRules = {
  robotics: {
    demand: "机器人落地需要稳定的零部件、感知、控制或制造能力",
    proof: "正式客户、订单、交付记录或机器人相关收入拆分",
    weak: "产品、合作和展会信息不能单独证明订单与收入",
    peer: "机器人产业链同环节公司",
    proofPattern: /订单|客户|交付|中标|定点|产能/u,
  },
  semiconductor: {
    demand: "半导体需求最终要通过客户验证、产能利用率和产品收入体现",
    proof: "核心产品收入、客户验证、份额或产能利用率",
    weak: "行业景气和国产替代叙事不能单独证明公司兑现",
    peer: "半导体同环节公司",
    proofPattern: /订单|客户|验证|量产|产能|扩产|销售|收入/u,
  },
  drone: {
    demand: "无人机需求最终要通过项目定型、批量订单和实际交付体现",
    proof: "型号定型、批量订单、交付数量或无人机业务收入",
    weak: "产品亮相和项目进展不能单独证明批量收入",
    peer: "无人机产业链同环节公司",
    proofPattern: /订单|合同|中标|交付|定型|批产/u,
  },
  oil: {
    demand: "油气景气最终要通过产销量、服务工作量、成本和现金流体现",
    proof: "产销量、服务订单、成本变化和经营现金流",
    weak: "油价上涨不能自动等同于公司利润改善",
    peer: "油气产业链同环节公司",
    proofPattern: /产量|销量|合同|订单|中标|作业|油气/u,
  },
  power: {
    demand: "电力资产价值最终要通过发电量、电价、利用小时和现金流体现",
    proof: "发电量、利用小时、电价、燃料成本和经营现金流",
    weak: "装机规模不能单独证明盈利质量",
    peer: "电力行业同类型公司",
    proofPattern: /发电量|利用小时|上网电价|装机|投产|电量/u,
  },
  innovative_drug: {
    demand: "创新药价值最终要通过临床进度、获批、产品销售和现金流体现",
    proof: "临床或审批进展、产品销售、研发效率和经营现金流",
    weak: "管线数量不能单独证明商业化兑现",
    peer: "创新药同阶段公司",
    proofPattern: /临床|批准|获批|上市申请|销售|授权|许可/u,
  },
  precious_metals: {
    demand: "金属价格机会最终要通过产量、成本、利润和现金流体现",
    proof: "资源量、产量、单位成本、利润和经营现金流",
    weak: "金属价格上涨不能自动等同于公司利润同步增长",
    peer: "贵金属同类型公司",
    proofPattern: /产量|资源量|储量|扩产|投产|采矿|金|银|铜/u,
  },
};

if (!args.all && !args.entityIds && !args.entityId) {
  console.error("Usage: node scripts/build_serenity_deep_reviews.mjs --all|--entity-id <id>|--entity-ids <a,b> [--force]");
  process.exit(1);
}

const dashboard = await readJsonFile(path.join(DATA_DIR, "dashboard", "serenity_analysis.json"));
const selectedIds = new Set(
  String(args.entityIds || args.entityId || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
);
const rows = (dashboard.rows || [])
  .filter((row) => row.inputPack?.factInputs?.profile?.ticker)
  .filter((row) => args.all || selectedIds.has(row.entityId));

let completed = 0;
let insufficient = 0;
let failed = 0;

for (const row of rows) {
  try {
    const existing = await readOptionalJson(
      path.join(DATA_DIR, "analysis", "serenity_outputs", `${row.entityId}.json`)
    );
    if (!args.force && existing?.status === "serenity_ai_review") {
      console.log(`${row.name}: keep existing validated deep review`);
      completed += 1;
      continue;
    }
    if (args.onlyEvidenceGenerated && !(await hasEvidenceGeneratedDossier(row))) {
      const reviewRunDir = await latestFormalRunDirWithAiResearch(row.entityId);
      if (!reviewRunDir) throw new Error("missing validated higher-detail AI research run");
      runNode([
        "scripts/run_serenity_ai_review.mjs",
        "--entity-id",
        row.entityId,
        "--run-dir",
        reviewRunDir,
      ]);
      console.log(`${row.name}: keep and regrade existing higher-detail validated review`);
      completed += 1;
      continue;
    }
    const result = await buildOne(row);
    if (result === "COMPLETED") completed += 1;
    else insufficient += 1;
  } catch (error) {
    failed += 1;
    console.error(`${row.name}: ${error.message}`);
  }
}

async function hasEvidenceGeneratedDossier(row) {
  const runDir = await latestFormalRunDir(row.entityId);
  if (!runDir) return false;
  const dossierPath = await findNamedFile(runDir, "ai_research_dossier.json");
  if (!dossierPath) return false;
  const dossier = await readOptionalJson(dossierPath);
  const tests = dossier?.research_path?.evidence_tests || [];
  return tests.some((item) => item.test === "财务是否真正兑现")
    && tests.some((item) => item.test === "核心业务是否落到公司");
}

console.log(
  `Serenity deep reviews complete. selected=${rows.length}, completed=${completed}, insufficient=${insufficient}, failed=${failed}`
);
if (failed) process.exitCode = 1;

async function buildOne(row) {
  const requestedTicker = row.inputPack.factInputs.profile.ticker;
  const runDir = await latestFormalRunDir(row.entityId);
  if (!runDir) throw new Error("missing formal run");
  const manifestPath = await findNamedFile(runDir, "manifest.json");
  if (!manifestPath) throw new Error("missing manifest");
  const manifest = await readJsonFile(manifestPath);
  const ticker =
    (typeof manifest.symbol === "string" ? manifest.symbol : manifest.symbol?.symbol) ||
    requestedTicker;
  if (!manifest.data_acquisition?.full_research_ready) {
    runNode(["scripts/run_serenity_ai_outcomes.mjs", "--entity-id", row.entityId, "--force"]);
    console.log(`${row.name}: evidence insufficient`);
    return "FAILED_INSUFFICIENT_EVIDENCE";
  }

  const dataDir = path.dirname(manifestPath);
  const financials = await readDataset(dataDir, "_financials.json");
  const filings = await readDataset(dataDir, "_filings_announcements.json");
  const customer = await readDataset(dataDir, "_customer_order_capacity_evidence.json");
  const valuation = await readDataset(dataDir, "_valuation_inputs.json");
  const scorecard = await readJsonFile(path.join(runDir, "scorecard_result.json"));
  if (!financials?.periods?.length) throw new Error("formal financial periods are empty");

  const dossier = await buildEvidenceDossier(row, {
    ticker,
    manifest,
    financials,
    filings,
    customer,
    valuation,
    scorecard,
    dataDir,
  });
  const overlay = {
    symbol: ticker,
    as_of_date: dossier.as_of_date,
    dossier_ref: "ai_research_dossier.json",
    ...dossier.overlay_projection,
    key_evidence_refs: [
      {
        claim: "官方财务报表已抽取收入、利润、现金流、资产、负债和权益核心字段。",
        source_ref: sourceRef("financials", financials),
        source_level: normalizeLevel(financials.source_level, "L0"),
        confidence: 0.84,
      },
      {
        claim: "客户、订单和产能判断只使用正式披露证据通道，并保留未验证边界。",
        source_ref: sourceRef("customer_order_capacity_evidence", customer),
        source_level: normalizeLevel(customer?.source_level, "L0"),
        confidence: 0.8,
      },
    ],
    contrary_evidence: dossier.bear_case.slice(0, 3),
    research_questions: dossier.research_path.unresolved_questions,
  };

  const reviewDir = path.join(runDir, "ai_research", ticker);
  await fs.mkdir(reviewDir, { recursive: true });
  const dossierPath = path.join(reviewDir, "ai_research_dossier.json");
  const overlayPath = path.join(reviewDir, "ai_research_overlay.json");
  await writeJsonFile(dossierPath, dossier);
  await writeJsonFile(overlayPath, overlay);

  runSerenity([
    "scripts/validate_ai_research_dossier.py",
    dossierPath,
    "--manifest",
    manifestPath,
  ]);
  runSerenity([
    "scripts/score_ai_research_dossier.py",
    dossierPath,
    "--manifest",
    manifestPath,
  ]);
  runSerenity(["scripts/validate_ai_overlay.py", overlayPath, "--manifest", manifestPath]);
  runNode(["scripts/run_serenity_ai_review.mjs", "--entity-id", row.entityId, "--run-dir", runDir]);
  console.log(`${row.name}: deep review completed`);
  return "COMPLETED";
}

function buildDossier(row, context) {
  const profile = row.inputPack.factInputs.profile;
  const rule = sectorRules[profile.sector] || sectorRules.robotics;
  const periods = [...context.financials.periods].sort((a, b) =>
    String(a.period).localeCompare(String(b.period))
  );
  const annuals = periods.filter((item) => item.period_type === "annual");
  const latestAnnual = annuals.at(-1);
  const previousAnnual = annuals.at(-2);
  const latestPeriod = periods.at(-1);
  const comparable = periods
    .filter(
      (item) =>
        item.period_type === latestPeriod.period_type &&
        item.period !== latestPeriod.period
    )
    .at(-1);
  const basis = comparable || previousAnnual;
  const revenueGrowth = growth(latestPeriod.revenue, basis?.revenue);
  const profitGrowth = growth(latestPeriod.net_income, basis?.net_income);
  const annualRevenueGrowth = growth(latestAnnual?.revenue, previousAnnual?.revenue);
  const annualProfitGrowth = growth(latestAnnual?.net_income, previousAnnual?.net_income);
  const cashConversion =
    finite(latestPeriod.operating_cash_flow) && finite(latestPeriod.net_income) && latestPeriod.net_income !== 0
      ? latestPeriod.operating_cash_flow / latestPeriod.net_income
      : null;
  const debtRatio =
    finite(latestPeriod.liabilities) && finite(latestPeriod.assets) && latestPeriod.assets
      ? latestPeriod.liabilities / latestPeriod.assets
      : null;
  const customerSummary = context.customer?.summary || {};
  const laneDirect = number(customerSummary.direct_evidence_count) || 0;
  const leads = number(customerSummary.lead_evidence_count) || 0;
  const announcements = (context.filings?.recent_announcements || [])
    .map((item) => item.title || item.announcementTitle || item.announcement_title)
    .filter(Boolean)
    .slice(0, 4);
  const filingDirect = announcements.filter((title) => rule.proofPattern?.test(title)).length;
  const direct = laneDirect + filingDirect;
  const financialState = classifyFinancials({
    revenueGrowth,
    profitGrowth,
    annualRevenueGrowth,
    annualProfitGrowth,
    cashConversion,
  });
  const evidenceState = direct > 0 ? "有直接披露" : leads > 0 ? "只有线索" : "尚无直接披露";
  const judgment = judgmentFor({
    name: row.name,
    financialState,
    evidenceState,
    direct,
    cashConversion,
    action: context.scorecard.action_readiness,
  });
  const sourceFinancial = sourceRef("financials", context.financials);
  const sourceFilings = sourceRef("filings_announcements", context.filings);
  const sourceCustomer = sourceRef("customer_order_capacity_evidence", context.customer);
  const sourceValuation = sourceRef("valuation_inputs", context.valuation);
  const annualFact = latestAnnual
    ? `${latestAnnual.period.slice(0, 4)}年营收${money(latestAnnual.revenue)}、归母净利润${money(latestAnnual.net_income)}，同比${pct(annualRevenueGrowth)}和${pct(annualProfitGrowth)}。`
    : "年度财务数据已读取，但缺少可比年度。";
  const periodFact = `${latestPeriod.period}营收${money(latestPeriod.revenue)}、归母净利润${money(latestPeriod.net_income)}、经营现金流${money(latestPeriod.operating_cash_flow)}；相对可比期营收${pct(revenueGrowth)}、利润${pct(profitGrowth)}。`;
  const customerFact = `正式业务披露中，可直接用于验证当前逻辑的材料${direct}条、待核线索${leads}条，当前属于“${evidenceState}”。`;
  const valuationFact = context.valuation
    ? `当前价格约${round(context.valuation.regular_market_price)}元，总市值约${money(context.valuation.total_market_cap)}；估值只作为市场背景。`
    : "当前估值口径仍需补充。";
  const asOf = context.manifest.as_of_date || new Date().toISOString().slice(0, 10);
  const role = profile.role || profile.sectorRole || "所在产业环节";
  const cashText =
    cashConversion == null
      ? "现金流转换暂不可比"
      : cashConversion >= 0.8
        ? "利润大部分转成了经营现金流"
        : cashConversion >= 0
          ? "利润转成现金的速度偏慢"
          : "经营现金流为负，需要重点核查";
  const titleText = announcements.length
    ? `近期正式公告包括：${announcements.join("；")}。`
    : "近期公告已读取，暂未发现能改变判断的新增直接证据。";

  return {
    contract_type: "serenity_ai_research_dossier",
    schema_version: "1.0",
    symbol: context.ticker,
    as_of_date: asOf,
    research_status: "COMPLETED",
    source_reading_log: [
      {
        source_ref: sourceFinancial,
        source_level: normalizeLevel(context.financials.source_level, "L0"),
        read_status: "READ",
        finding: `${annualFact}${periodFact}`,
        claim_boundary: "财务表能验证公司整体兑现，不能自动证明特定概念业务已经兑现。",
      },
      {
        source_ref: sourceFilings,
        source_level: "L0",
        read_status: "READ",
        finding: titleText,
        claim_boundary: "公告只按原文支持事实，不把活动、合作或计划写成订单和收入。",
      },
      {
        source_ref: sourceCustomer,
        source_level: "L0",
        read_status: "READ",
        finding: customerFact,
        claim_boundary: "只有直接披露才能支持客户、订单、交付或产能结论。",
      },
      {
        source_ref: sourceValuation,
        source_level: "L2",
        read_status: "READ",
        finding: valuationFact,
        claim_boundary: "行情和估值不用于反推基本面，也不单独构成买点。",
      },
    ],
    research_path: {
      core_question: `${row.name}是否有足够的业务兑现和财务质量，值得进入重点观察？`,
      decision_use: "帮助用户判断应该重点看什么、为什么看，以及未来用什么证据验证；不输出个性化交易建议。",
      base_rate_anchor: `${rule.demand}；${rule.weak}。`,
      reflexivity_check: "股价上涨可能领先于业务证据，不能用涨幅反过来证明判断正确。",
      hypotheses: [
        {
          hypothesis: `${row.name}在${role}环节具备持续观察价值。`,
          current_view: financialState === "WEAK" ? "PARTIAL" : "SUPPORTED",
          why_it_matters: "决定是否值得持续占用研究注意力。",
          evidence_needed: rule.proof,
        },
        {
          hypothesis: "业务进展已经转成收入、利润和现金流。",
          current_view: financialState === "STRONG" ? "SUPPORTED" : "PARTIAL",
          why_it_matters: "决定产业逻辑是否真正闭环。",
          evidence_needed: "连续财报中的收入、利润和经营现金流相互验证。",
        },
        {
          hypothesis: "当前市场价格没有明显跑在证据前面。",
          current_view: "PARTIAL",
          why_it_matters: "决定现在适合继续观察还是等待更合适的位置。",
          evidence_needed: "用长期走势、估值口径和下一期兑现共同复核。",
        },
      ],
      evidence_tests: [
        {
          test: "业务兑现测试",
          method: `检查正式披露是否出现${rule.proof}。`,
          current_result: customerFact,
          evidence_status: direct > 0 ? "DIRECT" : leads > 0 ? "LEAD" : "MISSING",
          source_refs: [sourceCustomer, sourceFilings],
        },
        {
          test: "财务质量测试",
          method: "比较最新财报与可比期的收入、利润、现金流和负债。",
          current_result: `${periodFact}${cashText}，资产负债率约${ratioPct(debtRatio)}。`,
          evidence_status: financialState === "WEAK" ? "LEAD" : "DIRECT",
          source_refs: [sourceFinancial],
        },
        {
          test: "价格与证据错位测试",
          method: "检查长期走势和当前估值是否明显领先于业务证据。",
          current_result: `Serenity 技术状态为${context.scorecard.action_readiness || "待判断"}，不能只凭价格升级基本面结论。`,
          evidence_status: "INFERRED",
          source_refs: [sourceValuation],
        },
      ],
      unresolved_questions: [
        `下一份公告或财报能否新增${rule.proof}？`,
        "收入增长能否继续转成利润和经营现金流，而不是只增加应收、库存或投入？",
        "如果业务证据没有升级，当前价格是否仍有足够安全边界？",
      ],
    },
    observed: [
      "Serenity 正式数据包中的行情、长期复权走势、财务、公告、订单/客户/产能证据和估值输入均已取数。",
      `${annualFact}${periodFact}`,
      customerFact,
      `${cashText}，资产负债率约${ratioPct(debtRatio)}。`,
    ],
    inferred: [
      `${row.name}当前的财务兑现状态为“${financialLabel(financialState)}”。`,
      direct > 0
        ? `正式披露已出现${rule.proof}相关证据，但仍要看它能否连续进入收入和现金流。`
        : `${rule.proof}尚未形成直接证据，产业逻辑还没有完全闭环。`,
      "价格表现只能说明市场预期，不能替代后续业务和财务验证。",
    ],
    judgment: [
      judgment.current,
      judgment.why,
      judgment.watch,
    ],
    claim_graph: [
      {
        claim: `${row.name}值得进入重点观察。`,
        supporting_refs: [sourceFinancial, sourceFilings],
        opposing_refs: financialState === "WEAK" ? [sourceFinancial] : [],
        status: financialState === "WEAK" ? "PARTIAL" : "SUPPORTED",
        decision_impact: judgment.current,
      },
      {
        claim: `${rule.proof}已经得到直接验证。`,
        supporting_refs: direct > 0 ? [sourceCustomer] : [],
        opposing_refs: direct > 0 ? [] : [sourceCustomer],
        status: direct > 0 ? "SUPPORTED" : "UNSUPPORTED",
        decision_impact: direct > 0 ? "支持继续重点跟踪兑现。" : "阻止把产业逻辑写成已经兑现。",
      },
      {
        claim: "利润质量得到经营现金流验证。",
        supporting_refs: cashConversion != null && cashConversion >= 0.8 ? [sourceFinancial] : [],
        opposing_refs: cashConversion == null || cashConversion < 0.8 ? [sourceFinancial] : [],
        status: cashConversion != null && cashConversion >= 0.8 ? "SUPPORTED" : "PARTIAL",
        decision_impact: cashText,
      },
    ],
    causal_chain: [
      {
        step: rule.demand,
        mechanism: `${row.name}通过${role}承接相关需求。`,
        evidence_status: "INFERRED",
      },
      {
        step: "需求转成订单、客户或实际交付。",
        mechanism: `需要${rule.proof}的正式披露。`,
        evidence_status: direct > 0 ? "DIRECT" : leads > 0 ? "LEAD" : "MISSING",
      },
      {
        step: "订单转成收入、利润和现金流。",
        mechanism: `${periodFact}${cashText}。`,
        evidence_status: financialState === "WEAK" ? "LEAD" : "DIRECT",
      },
    ],
    same_layer_comparison: [
      {
        peer: rule.peer,
        comparison_axis: "业务兑现与财务质量",
        relative_position: `${row.name}当前${financialLabel(financialState)}，订单/客户证据为“${evidenceState}”。`,
        evidence_needed: "用相同期间的收入增速、利润增速、现金流和直接订单证据做同口径比较。",
      },
    ],
    bear_case: [
      rule.weak,
      cashConversion != null && cashConversion < 0.8
        ? "利润没有充分转成经营现金流，增长质量可能弱于表面。"
        : "后续经营现金流弱于利润，增长质量可能下降。",
      "市场价格先反映乐观预期，但下一期财报或公告没有提供新的兑现证据。",
    ],
    scenario_view: {
      base: {
        summary: judgment.current,
        probability: 0.55,
        conditions: ["现有财务趋势延续", "直接业务证据没有明显恶化"],
      },
      upside: {
        summary: "研究等级上调：业务证据和财务兑现同时增强。",
        probability: 0.25,
        conditions: [rule.proof, "收入、利润和经营现金流连续改善"],
      },
      downside: {
        summary: "研究等级下调：业务证据没有兑现，财务质量转弱。",
        probability: 0.2,
        conditions: ["关键进展延期或没有转成收入", "利润或经营现金流明显恶化"],
      },
    },
    trigger_table: {
      "30d": [`每天自动检查是否出现${rule.proof}相关正式公告；没有新证据则维持原判断。`],
      "90d": ["下一次财报或经营数据发布时，重新比较收入、利润和经营现金流。"],
      "180d": ["复盘业务证据是否连续出现，以及最初判断是否被价格和财务共同验证。"],
    },
    action_conditions: {
      upgrade_to_action: [`${rule.proof}得到直接验证，且收入、利润和经营现金流方向一致。`],
      add_or_size_up: ["本网站不输出买卖或加仓指令，只展示研究升级条件。"],
      trim_or_exit: ["本网站不输出减仓或卖出指令；若核心证据被证伪，则研究等级下调。"],
      stay_research_only: [judgment.watch],
    },
    confidence_dampers: [
      direct > 0 ? "直接业务证据仍需连续验证。" : `${rule.proof}缺少直接披露。`,
      cashText,
      "市场价格和估值不能替代业务兑现。",
    ],
    overlay_projection: {
      layer: role,
      bottleneck_reason: `${rule.demand}，但必须穿透到${rule.proof}。`,
      revenue_transmission: `产业需求需要先形成${rule.proof}，再进入收入、利润和经营现金流；当前财务状态为“${financialLabel(financialState)}”。`,
      serenity_fit: financialState === "STRONG" ? 0.72 : financialState === "STABLE" ? 0.6 : 0.46,
      layer_score: financialState === "STRONG" ? 76 : financialState === "STABLE" ? 64 : 48,
      company_fit: direct > 0 ? 68 : 56,
      evidence_supported_growth: financialState === "STRONG" && direct > 0 ? "H3" : "H2",
      h4_h5_evidence_bar_met: false,
      required_next_evidence: rule.proof,
      posterior_basis: `${annualFact}${periodFact}${customerFact}${cashText}。`,
      ai_confidence: financialState === "WEAK" ? "LOW" : direct > 0 ? "HIGH" : "MEDIUM",
      thesis_quality_delta: financialState === "STRONG" ? 2 : financialState === "WEAK" ? -2 : 0.5,
      evidence_confidence_delta: direct > 0 ? 1.5 : -1.5,
      risk_adjustment: cashConversion != null && cashConversion < 0 ? -3 : -1,
      action_condition_summary: judgment.watch,
    },
  };
}

function classifyFinancials(values) {
  const revenue = values.revenueGrowth ?? values.annualRevenueGrowth;
  const profit = values.profitGrowth ?? values.annualProfitGrowth;
  if ((revenue ?? 0) > 0.08 && (profit ?? 0) > 0.08 && (values.cashConversion ?? 0) >= 0.6) return "STRONG";
  if ((revenue ?? 0) < -0.08 || (profit ?? 0) < -0.15 || (values.cashConversion ?? 0) < 0) return "WEAK";
  return "STABLE";
}

function judgmentFor({ name, financialState, evidenceState, direct, cashConversion, action }) {
  if (financialState === "STRONG" && direct > 0) {
    return {
      current: `Serenity 当前判断：${name}值得重点观察，但仍要等待更合适的价格和后续兑现。`,
      why: "业务证据、收入利润和经营现金流已经形成初步闭环。",
      watch: `先看${action || "走势确认"}，再看下一期业务证据和现金流能否延续。`,
    };
  }
  if (financialState === "WEAK") {
    return {
      current: `Serenity 当前判断：${name}暂不列为重点，先等财务质量改善。`,
      why: cashConversion != null && cashConversion < 0
        ? "利润或收入没有转成经营现金流，当前闭环不完整。"
        : "最新财务变化偏弱，现有证据不足以支持更高优先级。",
      watch: "只有收入、利润和经营现金流重新同向改善，才重新上调关注等级。",
    };
  }
  return {
    current: `Serenity 当前判断：${name}可以继续观察，暂不升级为高优先级。`,
    why: evidenceState === "有直接披露"
      ? "已有业务证据，但财务兑现还需要连续验证。"
      : "公司财务基本可跟踪，但关键业务证据还没有完全闭环。",
    watch: "等待关键业务证据和下一期财务共同确认，不根据短期涨跌追逐。",
  };
}

function sourceRef(dataset, artifact) {
  return `${dataset}:${artifact?.source_name || artifact?.source || defaultSource(dataset)}`;
}

function defaultSource(dataset) {
  if (dataset === "financials") return "CNINFO_FinancialReports_L0";
  if (dataset === "filings_announcements") return "CNINFO_Announcements_L0";
  if (dataset === "valuation_inputs") return "Tencent_Quote_Kline_L2";
  return "Disclosure_Customer_Order_Capacity_Evidence_L0";
}

async function readDataset(dataDir, suffix) {
  const entries = await fs.readdir(dataDir);
  const file = entries.find((name) => name.endsWith(suffix));
  return file ? readJsonFile(path.join(dataDir, file)) : null;
}

async function latestFormalRunDir(entityId) {
  const root = path.join(DATA_DIR, "serenity_provider", "formal_runs");
  const entries = await fs.readdir(root, { withFileTypes: true });
  const candidates = entries
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(`_${entityId}`))
    .map((entry) => path.join(root, entry.name))
    .sort();
  return candidates.at(-1) || null;
}

async function latestFormalRunDirWithAiResearch(entityId) {
  const root = path.join(DATA_DIR, "serenity_provider", "formal_runs");
  const entries = (await fs.readdir(root, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(`_${entityId}`))
    .map((entry) => path.join(root, entry.name))
    .sort()
    .reverse();
  for (const runDir of entries) {
    const dossierPath = await findNamedFile(runDir, "ai_research_dossier.json");
    const overlayPath = await findNamedFile(runDir, "ai_research_overlay.json");
    if (dossierPath && overlayPath) return runDir;
  }
  return null;
}

async function findNamedFile(root, fileName) {
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const candidate = path.join(root, entry.name);
    if (entry.isFile() && entry.name === fileName) return candidate;
    if (entry.isDirectory()) {
      const nested = await findNamedFile(candidate, fileName);
      if (nested) return nested;
    }
  }
  return null;
}

function runSerenity(command) {
  const result = spawnSync(PYTHON, command, {
    cwd: SERENITY_HOME,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command[0]} failed: ${result.stderr || result.stdout}`);
  }
}

function runNode(command) {
  const result = spawnSync(process.execPath, command, {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`${command[0]} failed: ${result.stderr || result.stdout}`);
}

function growth(current, previous) {
  return finite(current) && finite(previous) && previous !== 0 ? current / previous - 1 : null;
}

function money(value) {
  if (!finite(value)) return "未披露";
  const abs = Math.abs(value);
  if (abs >= 1e8) return `${round(value / 1e8)}亿元`;
  if (abs >= 1e4) return `${round(value / 1e4)}万元`;
  return `${round(value)}元`;
}

function pct(value) {
  return finite(value) ? `${value >= 0 ? "+" : ""}${round(value * 100)}%` : "不可比";
}

function ratioPct(value) {
  return finite(value) ? `${round(value * 100)}%` : "不可比";
}

function financialLabel(value) {
  return value === "STRONG" ? "增长与现金流相互验证" : value === "WEAK" ? "财务质量偏弱" : "基本稳定、仍需验证";
}

function normalizeLevel(value, fallback) {
  const match = String(value || "").match(/L[0-3]/);
  return match?.[0] || fallback;
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function round(value) {
  return Number(Number(value).toFixed(2));
}

async function readOptionalJson(filePath) {
  try {
    return await readJsonFile(filePath);
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--all") parsed.all = true;
    else if (token === "--force") parsed.force = true;
    else if (token === "--only-evidence-generated") parsed.onlyEvidenceGenerated = true;
    else if (token === "--entity-id") parsed.entityId = argv[++index];
    else if (token === "--entity-ids") parsed.entityIds = argv[++index];
  }
  return parsed;
}
