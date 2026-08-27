import fs from "node:fs/promises";
import path from "node:path";

const SECTOR_RULES = {
  robotics: {
    demand: "机器人需求必须经过客户验证、订单、交付，再进入收入和现金流",
    proof: "机器人相关客户、订单、交付、收入或产量",
    keywords: ["机器人", "减速器", "丝杠", "执行器", "传感器", "伺服", "控制器", "订单", "客户", "交付", "产量"],
    distinctive: ["机器人", "减速器", "丝杠", "执行器", "传感器", "伺服", "控制器"],
  },
  semiconductor: {
    demand: "半导体景气必须经过产品、客户验证和产能利用，再进入收入和现金流",
    proof: "核心产品、客户验证、产量、产能利用率或分部收入",
    keywords: ["半导体", "芯片", "晶圆", "封装", "测试", "设备", "材料", "EDA", "客户", "产量", "产能", "收入"],
    distinctive: ["半导体", "芯片", "晶圆", "封装", "测试", "EDA", "光刻", "刻蚀", "存储器"],
  },
  drone: {
    demand: "无人机需求必须经过型号、订单和交付，再进入收入和现金流",
    proof: "型号、批量订单、交付数量或无人机业务收入",
    keywords: ["无人机", "航空", "机载", "连接器", "订单", "合同", "中标", "交付", "批产", "产量"],
    distinctive: ["无人机", "航空", "航天", "防务", "机载", "连接器", "批产"],
  },
  oil: {
    demand: "油气景气必须经过产销量、服务工作量和成本，再进入利润和现金流",
    proof: "油气产量、销量、服务订单、成本或经营现金流",
    keywords: ["原油", "天然气", "油气", "成品油", "销量", "产量", "储量", "作业", "合同", "订单", "现金流"],
    distinctive: ["原油", "天然气", "油气", "成品油", "汽油", "柴油", "加油站", "储量"],
  },
  power: {
    demand: "电力资产价值必须经过发电量、电价、利用小时和成本，再进入现金流",
    proof: "发电量、上网电量、电价、利用小时或燃料成本",
    keywords: ["发电量", "上网电量", "利用小时", "电价", "装机", "投产", "水电", "火电", "煤价", "现金流"],
    distinctive: ["发电量", "上网电量", "利用小时", "电价", "装机", "水电", "火电", "煤价"],
  },
  innovative_drug: {
    demand: "创新药价值必须经过临床、获批和销售，再进入利润和现金流",
    proof: "临床或审批进展、产品销售、授权收入或研发效率",
    keywords: ["临床", "获批", "批准", "上市申请", "药品", "产品销售", "授权", "许可", "研发", "收入"],
    distinctive: ["临床", "获批", "批准", "上市申请", "药品", "制剂", "原料药", "研发", "集采", "一致性评价"],
  },
  precious_metals: {
    demand: "贵金属价格必须经过产量、单位成本和销量，再进入利润和现金流",
    proof: "资源量、储量、产量、单位成本、销量或经营现金流",
    keywords: ["黄金", "白银", "矿产金", "矿产银", "铜", "储量", "资源量", "产量", "单位成本", "销量", "现金流"],
    distinctive: ["黄金", "白银", "矿产金", "矿产银", "铜", "矿山", "储量", "资源量"],
  },
};

const PROJECT_ROOT = path.resolve(import.meta.dirname, "../..");
const DAILY_MARKET_DIR = path.join(PROJECT_ROOT, "data", "stocks");

export async function buildEvidenceDossier(row, context) {
  const profile = row.inputPack?.factInputs?.profile || {};
  const rule = SECTOR_RULES[profile.sector] || SECTOR_RULES.robotics;
  const financial = financialSnapshot(context.financials);
  const report = await loadPrimaryReport(context.financials);
  const reportBody = report?.body || "";
  const business = pickReportEvidence(reportBody, rule.keywords, {
    negative: false,
    companyName: row.name,
    distinctive: rule.distinctive,
  });
  const risk = pickReportEvidence(reportBody, [...rule.keywords, "风险", "依赖", "下降", "减值", "诉讼"], {
    negative: true,
    companyName: row.name,
    exclude: business?.text,
    distinctive: rule.distinctive,
  });
  const trend = await priceTrend(context.dataDir, row.entityId);
  const valuation = valuationSnapshot(context.valuation);

  const businessFact = business?.text
    ? normalizeExcerpt(business.text)
    : `${row.name}最新正式报告没有单独量化${rule.proof}，现阶段只能用公司整体财务和后续公告继续验证。`;
  const riskFact = risk?.text
    ? normalizeExcerpt(risk.text)
    : financial.score < 0
      ? `${row.name}最新财务中最需要警惕的是：${financial.latestFact}${financial.cashFact}`
    : financial.debtRatio != null
      ? `${row.name}最新期末资产负债率为${percent(financial.debtRatio)}；当前没有抽取到更强的公司级反方原文，后续以新公告和现金流变化复核。`
      : `${row.name}最新正式报告没有提供足够清晰的可量化风险段落，后续以财报和公告变化复核。`;
  const businessEffect = negativeText(businessFact) ? "CONFLICTED" : business?.text ? "DIRECT" : "LEAD";
  const financialEffect = financial.score > 0 ? "DIRECT" : financial.score < 0 ? "CONFLICTED" : "LEAD";
  const riskEffect = risk?.text || financial.score < 0 ? "CONFLICTED" : "LEAD";
  const trendEffect = trend.score > 0 ? "DIRECT" : trend.score < 0 ? "CONFLICTED" : "LEAD";
  const score = financial.score + (businessEffect === "DIRECT" ? 1 : businessEffect === "CONFLICTED" ? -1 : 0) + trend.score;
  const judgment = judgmentFor(row.name, score, financial, businessFact, trend);
  const asOf = context.manifest.as_of_date || new Date().toISOString().slice(0, 10);
  const reportRef = `financials:${context.financials?.source || "official_report"}`;
  const reportLabel = report?.title || "最新正式报告";
  const reportDate = report?.date || asOf;
  const financialRef = `financials:${context.financials?.source || "official_report"}`;
  const trendRef = "price_history_adjusted";
  const valuationRef = `valuation_inputs:${context.valuation?.source || "market_quote"}`;
  const reportReading = report?.body
    ? `已逐字读取${reportLabel}正文，抽取与${profile.role || profile.sectorRole || "公司核心业务"}直接相关的经营事实和风险。`
    : `已读取结构化财务原始行；${reportLabel}正文暂未能作为本次判断依据。`;
  const financialFact = `${financial.annualFact}${financial.latestFact}`;
  const financialWhy = financial.score > 0
    ? "收入、利润和经营现金流方向较一致，说明增长不只停留在账面利润。"
    : financial.score < 0
      ? "收入、利润或现金流没有同向改善，说明当前增长质量存在明显缺口。"
      : "公司整体经营仍可跟踪，但还没有形成连续、同方向的改善。";
  const businessWhy = businessEffect === "DIRECT"
    ? `这条原文直接说明${rule.proof}已经出现，能检验行业逻辑是否落到公司。`
    : businessEffect === "CONFLICTED"
      ? `这条原文暴露了${rule.proof}传导中的阻力，不能只看行业景气。`
      : `报告没有把${rule.proof}单独量化，行业逻辑暂时不能全部归到公司。`;
  const riskWhy = "这条反方事实决定公司即使有增长，利润质量和兑现速度是否会被拖累。";
  const trendWhy = trend.score > 0
    ? "价格已回到近期多数交易者平均成本上方，但只能作为时点确认，不能反推基本面。"
    : trend.score < 0
      ? "价格仍低于近期平均成本，市场尚未确认基本面改善，当前不适合追涨。"
      : "价格没有给出清晰方向，只能等待基本面与走势共同确认。";

  const evidenceTests = [
    {
      test: "财务是否真正兑现",
      method: `核对${financial.periodLabel}与可比期的营收、归母净利润和经营现金流原始报表行。`,
      current_result: financialFact,
      evidence_status: financialEffect,
      source_refs: [financialRef],
    },
    {
      test: "核心业务是否落到公司",
      method: `逐字读取${reportDate}发布的${reportLabel}，只保留与${rule.proof}直接相关的公司事实。`,
      current_result: businessFact,
      evidence_status: businessEffect,
      source_refs: [reportRef],
    },
    {
      test: "最重要的反方是什么",
      method: `在同一份${reportLabel}中寻找会削弱收入、利润或现金流兑现的原文。`,
      current_result: riskFact,
      evidence_status: riskEffect,
      source_refs: [reportRef],
    },
    {
      test: "价格有没有确认",
      method: "用复权收盘价比较20日和60日平均成本，并检查近20日涨跌。",
      current_result: trend.fact,
      evidence_status: trendEffect,
      source_refs: [trendRef],
    },
  ];

  const observed = [financialFact, businessFact, riskFact, trend.fact];
  const inferred = [
    `${row.name}当前财务信号为：${financialWhy}`,
    `${row.name}当前业务信号为：${businessWhy}`,
    `${row.name}当前价格信号为：${trendWhy}`,
  ];
  const confidence = report?.body && financial.periods >= 2 ? "HIGH" : "MEDIUM";

  return {
    contract_type: "serenity_ai_research_dossier",
    schema_version: "1.0",
    symbol: context.ticker,
    as_of_date: asOf,
    research_status: "COMPLETED",
    source_reading_log: [
      {
        source_ref: financialRef,
        source_level: normalizeLevel(context.financials?.source_level, "L0"),
        read_status: "READ",
        finding: financialFact,
        claim_boundary: "财务表验证公司整体经营，不能自动证明某个概念业务已经兑现。",
      },
      {
        source_ref: reportRef,
        source_level: "L0",
        read_status: report?.body ? "READ" : "PARTIAL_READ",
        finding: `${reportReading}${businessFact}`,
        claim_boundary: "只把报告原文写成事实，不把行业数据、计划或愿景写成公司订单和收入。",
      },
      {
        source_ref: reportRef,
        source_level: "L0",
        read_status: report?.body ? "READ" : "PARTIAL_READ",
        finding: riskFact,
        claim_boundary: "风险原文用于反证，不因当前股价表现而删除。",
      },
      {
        source_ref: trendRef,
        source_level: "L2",
        read_status: "READ",
        finding: trend.fact,
        claim_boundary: "价格只用于判断时点，不能证明基本面因果。",
      },
      {
        source_ref: valuationRef,
        source_level: "L2",
        read_status: "READ",
        finding: valuation.fact,
        claim_boundary: "行情和总市值只作为市场背景，不单独构成买入理由。",
      },
    ],
    research_path: {
      core_question: `${row.name}的${profile.role || profile.sectorRole || "核心业务"}是否已转成可持续收入、利润和现金流，当前是否值得重点看？`,
      decision_use: "帮助用户决定关注优先级、看懂支撑结论的事实，并用后续数据验证判断。",
      base_rate_anchor: rule.demand,
      reflexivity_check: "股价上涨可能先反映预期，不能用涨幅反过来证明公司业务已经兑现。",
      hypotheses: [
        {
          hypothesis: `${row.name}的核心业务正在形成可持续兑现。`,
          current_view: score >= 2 ? "SUPPORTED" : score <= -2 ? "CONFLICTED" : "PARTIAL",
          why_it_matters: "决定公司是否值得持续占用研究注意力。",
          evidence_needed: rule.proof,
        },
        {
          hypothesis: "利润质量得到经营现金流验证。",
          current_view: financial.cashConversion != null && financial.cashConversion >= 0.8 ? "SUPPORTED" : "PARTIAL",
          why_it_matters: "决定增长是真实回款还是账面增长。",
          evidence_needed: "下一期营收、净利润和经营现金流继续同向。",
        },
        {
          hypothesis: "当前价格位置适合立即追入。",
          current_view: trend.score > 0 && score >= 3 ? "PARTIAL" : "CONFLICTED",
          why_it_matters: "好公司也可能处在不合适的价格位置。",
          evidence_needed: trend.upgrade,
        },
      ],
      evidence_tests: evidenceTests,
      unresolved_questions: [
        `下一份正式披露能否继续量化${rule.proof}？`,
        `${row.name}的经营现金流能否跟上净利润，且应收、库存或投入不再更快占用现金？`,
        trend.upgrade,
      ],
    },
    observed,
    inferred,
    judgment: [judgment.current, judgment.why, judgment.watch],
    claim_graph: [
      {
        claim: `${row.name}值得进入重点观察。`,
        supporting_refs: score >= 1 ? [financialRef, reportRef] : [],
        opposing_refs: score < 1 ? [financialRef, reportRef] : [],
        status: score >= 2 ? "SUPPORTED" : score <= -2 ? "CONFLICTED" : "PARTIAL",
        decision_impact: judgment.current,
      },
      {
        claim: `${rule.proof}已经在公司层面得到验证。`,
        supporting_refs: businessEffect === "DIRECT" ? [reportRef] : [],
        opposing_refs: businessEffect !== "DIRECT" ? [reportRef] : [],
        status: businessEffect === "DIRECT" ? "SUPPORTED" : businessEffect === "CONFLICTED" ? "CONFLICTED" : "PARTIAL",
        decision_impact: businessWhy,
      },
      {
        claim: "利润质量得到经营现金流验证。",
        supporting_refs: financial.cashConversion != null && financial.cashConversion >= 0.8 ? [financialRef] : [],
        opposing_refs: financial.cashConversion == null || financial.cashConversion < 0.8 ? [financialRef] : [],
        status: financial.cashConversion != null && financial.cashConversion >= 0.8 ? "SUPPORTED" : "PARTIAL",
        decision_impact: financialWhy,
      },
      {
        claim: "当前价格走势已经确认判断。",
        supporting_refs: trend.score > 0 ? [trendRef] : [],
        opposing_refs: trend.score <= 0 ? [trendRef] : [],
        status: trend.score > 0 ? "PARTIAL" : "UNSUPPORTED",
        decision_impact: trendWhy,
      },
    ],
    causal_chain: [
      {
        step: rule.demand,
        mechanism: businessFact,
        evidence_status: businessEffect,
      },
      {
        step: "业务进展进入收入和利润。",
        mechanism: financialFact,
        evidence_status: financialEffect,
      },
      {
        step: "利润最终转成现金。",
        mechanism: financial.cashFact,
        evidence_status: financial.cashConversion != null && financial.cashConversion >= 0.8 ? "DIRECT" : "CONFLICTED",
      },
    ],
    same_layer_comparison: [
      {
        peer: `${profile.sectorLabel || "同板块"}同类公司`,
        comparison_axis: "核心业务兑现、财务质量与价格位置",
        relative_position: `${row.name}本期营收变化${signedPercent(financial.revenueGrowth)}、利润变化${signedPercent(financial.profitGrowth)}，经营现金流${money(financial.latest?.operating_cash_flow)}。`,
        evidence_needed: "网站后续用同一报告期和同一财务口径进行板块内比较。",
      },
    ],
    bear_case: [
      riskFact,
      financial.score < 0 ? financialWhy : `若下一期现金流明显落后于利润，${row.name}的增长质量需要下调。`,
      trend.score < 0 ? trendWhy : `若价格跌回60日平均成本下方且基本面没有上修，${row.name}需要重新判断。`,
    ],
    scenario_view: {
      base: {
        summary: judgment.current,
        probability: 0.55,
        conditions: [financial.latestFact, businessFact],
      },
      upside: {
        summary: `${row.name}的业务与财务继续同向改善，关注等级上调。`,
        probability: 0.25,
        conditions: [rule.proof, "下一期收入、利润和经营现金流继续改善", trend.upgrade],
      },
      downside: {
        summary: `${row.name}的业务兑现或现金质量转弱，关注等级下调。`,
        probability: 0.2,
        conditions: [riskFact, "经营现金流持续弱于利润", trend.invalidate],
      },
    },
    trigger_table: {
      "30d": [`自动检查${row.name}的新公告是否出现${rule.proof}，出现后重新读取正文。`],
      "90d": [`下一次财报发布后，重新计算营收、利润、现金流和负债变化，不沿用本次结论。`],
      "180d": [`复盘${judgment.current.replace(/^Serenity 当前判断：/u, "")}是否被业务、财务和价格共同验证。`],
    },
    action_conditions: {
      upgrade_to_action: [`${rule.proof}继续得到原文和数字验证，财务与价格同时满足：${trend.upgrade}`],
      add_or_size_up: ["本站只训练判断，不提供仓位指令。"],
      trim_or_exit: [`若${riskFact}继续恶化，或${trend.invalidate}，则下调研究等级。`],
      stay_research_only: [judgment.watch],
    },
    confidence_dampers: [
      report?.body ? "年报原文来自公司正式披露，但公司自述仍需用后续财务和公告验证。" : "本次缺少可读取的完整年报正文。",
      financial.cashConversion == null ? "现金流与利润暂不可比。" : financial.cashFact,
      "价格和总市值不能替代业务兑现。",
    ],
    overlay_projection: {
      layer: profile.role || profile.sectorRole || "核心业务",
      bottleneck_reason: `${rule.demand}；本次最关键的公司原文是：${businessFact}`,
      revenue_transmission: `${businessWhy}${financialWhy}`,
      serenity_fit: clamp(0.5 + score * 0.06, 0.25, 0.82),
      layer_score: clamp(58 + score * 6, 30, 84),
      company_fit: clamp(56 + score * 7, 28, 86),
      evidence_supported_growth: score >= 3 ? "H3" : score >= 0 ? "H2" : "H1",
      h4_h5_evidence_bar_met: false,
      required_next_evidence: `${rule.proof}与下一期现金流继续同向验证`,
      posterior_basis: `${financialFact}${businessFact}${riskFact}${trend.fact}`,
      ai_confidence: confidence,
      thesis_quality_delta: clamp(score, -4, 4),
      evidence_confidence_delta: report?.body ? 2 : 0,
      risk_adjustment: financial.score < 0 || trend.score < 0 ? -3 : -1,
      action_condition_summary: judgment.watch,
    },
  };
}

function financialSnapshot(financials) {
  const periods = [...(financials?.periods || [])]
    .map((item) => ({
      ...normalizeFinancialPeriod(item),
      period_type: item.period_type || (/12-31$/u.test(String(item.period)) ? "annual" : item.period_type),
    }))
    .sort((a, b) => String(a.period).localeCompare(String(b.period)));
  const annuals = periods.filter((item) => item.period_type === "annual");
  const latestAnnual = annuals.at(-1);
  const previousAnnual = annuals.at(-2);
  const latest = periods.at(-1);
  const comparable = periods.filter((item) => item.period_type === latest?.period_type && item.period !== latest?.period).at(-1);
  const basis = comparable || previousAnnual;
  const revenueGrowth = growth(latest?.revenue, basis?.revenue);
  const profitGrowth = growth(latest?.net_income, basis?.net_income);
  const annualRevenueGrowth = growth(latestAnnual?.revenue, previousAnnual?.revenue);
  const annualProfitGrowth = growth(latestAnnual?.net_income, previousAnnual?.net_income);
  const cashConversion = finite(latest?.operating_cash_flow) && finite(latest?.net_income) && Number(latest.net_income) !== 0
    ? Number(latest.operating_cash_flow) / Number(latest.net_income)
    : null;
  const debtRatio = finite(latest?.liabilities) && finite(latest?.assets) && Number(latest.assets)
    ? Number(latest.liabilities) / Number(latest.assets)
    : null;
  let score = 0;
  if ((revenueGrowth ?? annualRevenueGrowth ?? 0) > 0.05) score += 1;
  if ((revenueGrowth ?? annualRevenueGrowth ?? 0) < -0.05) score -= 1;
  if ((profitGrowth ?? annualProfitGrowth ?? 0) > 0.08) score += 1;
  if ((profitGrowth ?? annualProfitGrowth ?? 0) < -0.08) score -= 1;
  if (cashConversion != null && cashConversion >= 0.8) score += 1;
  if (cashConversion != null && cashConversion < 0) score -= 1;
  const annualFact = latestAnnual
    ? `${latestAnnual.period.slice(0, 4)}年营收${money(latestAnnual.revenue)}，同比${signedPercent(annualRevenueGrowth)}；归母净利润${money(latestAnnual.net_income)}，同比${signedPercent(annualProfitGrowth)}。`
    : "";
  const latestFact = latest
    ? `${latest.period}营收${money(latest.revenue)}，较可比期${signedPercent(revenueGrowth)}；归母净利润${money(latest.net_income)}，较可比期${signedPercent(profitGrowth)}；经营现金流${money(latest.operating_cash_flow)}。`
    : "最新财务期数据缺失。";
  const cashFact = cashConversion == null
    ? "经营现金流与净利润暂不可比。"
    : cashConversion < 0
      ? `最新期经营现金流为${money(latest?.operating_cash_flow)}，与净利润方向相反。`
      : `最新期经营现金流相当于净利润的${percent(cashConversion)}。`;
  const reports = financials?.official_report_evidence?.reports || [];
  const sourceReport = reports.find((item) => item.report_kind === latest?.source_report_kind && item.announcement_date === latest?.source_announcement_date)
    || reports.find((item) => item.line_extraction?.status === "OK");
  return {
    periods: periods.length,
    latest,
    latestAnnual,
    revenueGrowth,
    profitGrowth,
    annualRevenueGrowth,
    annualProfitGrowth,
    cashConversion,
    debtRatio,
    score,
    annualFact,
    latestFact,
    cashFact,
    periodLabel: latest?.source_title || latest?.period || "最新财报",
    sourceUrl: sourceReport?.pdf_url,
  };
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
        .filter((field) => finite(period?.[field]))
        .map((field) => [field, normalizeMonetaryValue(period, field, multiplier)])
    ),
    normalized_unit: "yuan",
  };
}

function normalizeMonetaryValue(period, field, multiplier) {
  const value = Number(period[field]);
  const balanceFields = new Set(["assets", "liabilities", "equity", "parent_equity", "cash"]);
  const referenceField = balanceFields.has(field) ? "assets" : "revenue";
  const reference = Math.abs(Number(period?.[referenceField]));
  // 少数报告抽取结果会把净利润等字段提前换算为“元”，而收入仍保留报表单位。
  // 若某字段相对同表基准大两个数量级以上，视为已经换算，避免重复乘单位。
  const alreadyNormalized =
    field !== referenceField &&
    Number.isFinite(reference) &&
    reference > 0 &&
    Math.abs(value) / reference >= 50;
  return alreadyNormalized ? value : value * multiplier;
}

async function loadPrimaryReport(financials) {
  const reports = financials?.official_report_evidence?.reports || [];
  const report = reports
    .filter((item) => item.line_extraction?.status === "OK" && item.line_extraction?.text_path)
    .sort((a, b) => {
      const kind = (item) => item.report_kind === "annual" ? 3 : item.report_kind === "interim" ? 2 : 1;
      return kind(b) - kind(a) || String(b.announcement_date).localeCompare(String(a.announcement_date));
    })[0];
  if (!report) return null;
  try {
    return {
      title: report.title || "正式报告",
      date: report.announcement_date,
      url: report.pdf_url,
      body: await fs.readFile(report.line_extraction.text_path, "utf8"),
    };
  } catch {
    return null;
  }
}

function pickReportEvidence(body, keywords, options = {}) {
  if (!body) return null;
  const normalized = body.replace(/\r/g, "").replace(/[ \t]+/g, " ").replace(/\n+/g, " ");
  const sentences = normalized
    .split(/(?<=[。；！？])\s*|(?<=[.!?])\s+(?=[A-Z])/u)
    .map((item) => item.trim())
    .filter((item) => item.length >= 35 && item.length <= 520);
  const negativeWords = ["下降", "减少", "亏损", "为负", "风险", "依赖", "减值", "诉讼", "延期", "下滑", "承压", "不利", "集中"];
  const positiveWords = ["成功", "增长", "提升", "突破", "改善", "增加", "扩大"];
  const operatingWords = ["报告期内", "2025年", "2026年", "同比", "实现营业收入", "实现收入", "签订合同", "在手订单", "新签订单", "产量", "销量", "发电量", "利用小时", "获批", "临床", "交付", "投产", "产能利用率"];
  const metricWords = ["营业收入", "销售收入", "同比", "订单", "合同额", "交付", "产量", "销量", "经营总量", "发电量", "上网电量", "利用小时", "装机", "产能利用率", "获批", "临床研究", "期临床", "注册批件", "一致性评价", "研发投入", "授权收入", "投产"];
  const scored = sentences
    .filter((text) => text !== options.exclude)
    .map((text) => {
      const keywordHits = keywords.filter((word) => text.includes(word)).length;
      const distinctiveHits = (options.distinctive || []).filter((word) => text.includes(word)).length;
      const operatingHits = operatingWords.filter((word) => text.includes(word)).length;
      const metricHits = metricWords.filter((word) => text.includes(word)).length;
      const numeric = /(?:\d+(?:\.\d+)?%|\d+(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?(?:亿元|万元|万台|吨|万千瓦|小时|个|项|家|月)|[ⅠⅡⅢⅣⅤ]+期)/u.test(text);
      const companySpecific = text.includes(options.companyName || "") || /报告期内|公司|子公司|本集团|本公司/u.test(text);
      const negativeHits = negativeWords.filter((word) => text.includes(word)).length;
      const materialNegativeHits = negativeWords.filter((word) => word !== "风险" && text.includes(word)).length;
      const positiveHits = positiveWords.filter((word) => text.includes(word)).length;
      const generic = /根据.{0,30}(?:统计|数据)|全国|全球|行业规模|荣誉|奖项|协会/u.test(text);
      const definition = /第一节\s*释义|常用词语释义|的缩写|是指|多指|又称|广义上|4英寸|5英寸|6英寸/u.test(text);
      const tableNoise = /--- page|单位：|□适用|√不适用|主要指标|主要会计数据|发生变动的情况|项目名称|公告编号/u.test(text);
      const personnelNoise = /历任|个人简历|出生于|现任公司|董事、监事|高级管理人员/u.test(text);
      const accountingPolicyNoise = /信用风险自初始确认|信用风险资产管理|预期信用|信用减值|信用等级较高|不存在重大信用风险|利用账龄|账龄组合|单项计提|应收款.{0,30}减值|应收款项融资|会计政策|金融工具|金融资产|流动性风险是指|信用风险主要产生于|信用风险集中度|本集团对信用风险|多样化投资及业务组合|风险管理政策|交易对手|整个存续期|下一会计年度资产和负债|重大会计估计|研究阶段支出和开发阶段|套期保值效果|市值管理制度|证券法|公司章程|法律法规|证券或行业分析师|利润分配预案|敬请查阅|风险因素主要集中/u.test(text);
      let score = keywordHits * 3 + operatingHits * 5 + (numeric ? 4 : 0) + (companySpecific ? 2 : 0) - (generic ? 25 : 0) - (definition ? 18 : 0) - (tableNoise ? 14 : 0);
      if (personnelNoise || accountingPolicyNoise) score -= 30;
      if (!options.negative && operatingHits === 0) score -= 40;
      if (!options.negative && metricHits === 0) score -= 40;
      if (!options.negative && !companySpecific) score -= 20;
      if (!options.negative && distinctiveHits === 0) score -= 18;
      if (options.negative) {
        score += negativeHits * 4 + (text.includes("风险") ? 10 : 0) + (text.includes("依赖") ? 8 : 0);
        if (negativeHits === 0) score -= 24;
        if (distinctiveHits === 0 && !text.includes("风险")) score -= 12;
        if (distinctiveHits === 0 && negativeHits <= 1) score -= 20;
        if (materialNegativeHits === 0 && positiveHits > 0) score -= 30;
        if (text.includes("风险评估")) score -= 24;
        if (/成功实施|成功开发|显著提升/u.test(text)) score -= 50;
      }
      else score -= negativeHits;
      return { text, score, negativeHits };
    })
    .filter((item) => item.score >= (options.negative ? 7 : 8))
    .sort((a, b) => b.score - a.score || a.text.length - b.text.length);
  return scored[0] || null;
}

async function priceTrend(dataDir, entityId) {
  let entries = [];
  try {
    entries = await fs.readdir(dataDir);
  } catch {
    return neutralTrend();
  }
  const file = entries.find((name) => name.endsWith("_price_history_adjusted.csv"));
  if (!file) return neutralTrend();
  const raw = await fs.readFile(path.join(dataDir, file), "utf8");
  const formalRows = raw.trim().split(/\r?\n/u).slice(1).map((line) => {
    const cells = line.split(",");
    return { date: cells[0], close: Number(cells[6] || cells[4]) };
  }).filter((item) => finite(item.close));
  const dailyRows = await loadDailyClosingPrices(entityId);
  const dailyDates = new Set(dailyRows.map((item) => item.date));
  const today = localDate();
  const rowsByDate = new Map(
    [
      ...formalRows.filter((item) => item.date !== today || dailyDates.has(today)),
      ...dailyRows,
    ]
      .filter((item) => item.date && finite(item.close))
      .map((item) => [item.date, item])
  );
  const rows = [...rowsByDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (rows.length < 20) return neutralTrend();
  const latest = rows.at(-1);
  const ma20 = average(rows.slice(-20).map((item) => item.close));
  const ma60 = average(rows.slice(-60).map((item) => item.close));
  const start20 = rows.at(-21)?.close;
  const return20 = growth(latest.close, start20);
  let score = 0;
  if (latest.close > ma20 && ma20 >= ma60) score = 1;
  else if (latest.close < ma20 && ma20 <= ma60) score = -1;
  const position = latest.close > ma20 ? "高于" : "低于";
  return {
    score,
    fact: `${latest.date}复权收盘${round(latest.close)}元，${position}20日平均成本${round(ma20)}元；60日平均成本${round(ma60)}元，近20个交易日涨跌${signedPercent(return20)}。`,
    upgrade: `价格站上20日平均成本${round(ma20)}元并保持，且下一份正式披露没有削弱业务判断`,
    invalidate: `价格跌破60日平均成本${round(ma60)}元，同时公司基本面没有改善`,
  };
}

async function loadDailyClosingPrices(entityId) {
  if (!entityId) return [];
  let files = [];
  try {
    files = (await fs.readdir(DAILY_MARKET_DIR))
      .filter((name) => /^market_\d{4}_\d{2}_\d{2}\.json$/u.test(name))
      .sort();
  } catch {
    return [];
  }
  const today = localDate();
  const closes = [];
  for (const file of files) {
    try {
      const payload = JSON.parse(await fs.readFile(path.join(DAILY_MARKET_DIR, file), "utf8"));
      const rows = Array.isArray(payload) ? payload : payload?.rows || [];
      const quote = rows.find((item) => item.entityId === entityId);
      if (!quote || !finite(quote.price) || !quote.date) continue;
      // 当天只接收已明确标记为收盘的数据；历史日期视为该交易日最终留档。
      if (quote.date === today && quote.isFinal !== true) continue;
      closes.push({ date: quote.date, close: Number(quote.price) });
    } catch {
      // 单个历史快照损坏不应阻断整只股票的研究。
    }
  }
  return closes;
}

function localDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function neutralTrend() {
  return {
    score: 0,
    fact: "复权历史暂时不足以形成稳定的20日与60日价格比较。",
    upgrade: "补齐复权历史并等待价格与基本面共同确认",
    invalidate: "基本面被新公告或财报证伪",
  };
}

function valuationSnapshot(valuation) {
  if (!valuation) return { fact: "当前行情估值背景暂不可用。" };
  return {
    fact: `当前价格约${round(valuation.regular_market_price)}元，总市值约${money(valuation.total_market_cap)}；只作为市场预期背景。`,
  };
}

function judgmentFor(name, score, financial, businessFact, trend) {
  if (score >= 3) {
    return {
      current: `Serenity 当前判断：${name}值得重点观察，但等待价格与下一次兑现共同确认。`,
      why: `${financial.latestFact}${businessFact}`,
      watch: `先看${trend.upgrade}。`,
    };
  }
  if (score >= 1) {
    return {
      current: `Serenity 当前判断：${name}值得继续观察，暂不追涨。`,
      why: `${financial.latestFact}${businessFact}`,
      watch: `下一次财报继续验证现金流，并看${trend.upgrade}。`,
    };
  }
  if (score >= -1) {
    return {
      current: `Serenity 当前判断：${name}保留观察，但现在不急着买。`,
      why: `${financial.latestFact}${businessFact}`,
      watch: "等业务原文、财务现金流和价格三项至少有两项同时改善。",
    };
  }
  return {
    current: `Serenity 当前判断：${name}当前不列为优先关注。`,
    why: `${financial.latestFact}${businessFact}`,
    watch: "只有核心业务兑现和经营现金流重新改善，才上调关注等级。",
  };
}

function normalizeExcerpt(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 360 ? `${text.slice(0, 357)}…` : text;
}

function negativeText(text) {
  return /下降|减少|亏损|为负|风险|依赖|减值|诉讼|延期|下滑|承压|不利/u.test(text);
}

function normalizeLevel(value, fallback) {
  return String(value || "").match(/L[0-3]/u)?.[0] || fallback;
}

function growth(current, previous) {
  return finite(current) && finite(previous) && Number(previous) !== 0 ? Number(current) / Number(previous) - 1 : null;
}

function money(value) {
  if (!finite(value)) return "未披露";
  const number = Number(value);
  const abs = Math.abs(number);
  if (abs >= 1e8) return `${round(number / 1e8)}亿元`;
  if (abs >= 1e4) return `${round(number / 1e4)}万元`;
  return `${round(number)}元`;
}

function signedPercent(value) {
  return finite(value) ? `${Number(value) >= 0 ? "+" : ""}${round(Number(value) * 100)}%` : "不可比";
}

function percent(value) {
  return finite(value) ? `${round(Number(value) * 100)}%` : "不可比";
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : null;
}

function finite(value) {
  return Number.isFinite(Number(value));
}

function round(value) {
  return Number(Number(value).toFixed(2));
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}
