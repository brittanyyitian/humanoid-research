import { lazy, Suspense, useEffect, useMemo, useState } from "react";
import {
  ArrowUpRight,
  Search,
  X,
} from "lucide-react";

import StockRadarQuoteSummary from "./components/StockRadarQuoteSummary.jsx";
import StockRadarDailyReview from "./components/stock-radar/StockRadarDailyReview.jsx";
import StockRadarHero from "./components/stock-radar/StockRadarHero.jsx";
import StockRadarList from "./components/stock-radar/StockRadarList.jsx";
import StockRadarToolbar from "./components/stock-radar/StockRadarToolbar.jsx";
import {
  quoteProjectionOf,
  stockRadarForDisplay,
} from "./domain/serenity/quotes.js";

import companies from "@data/dashboard/companies.json";
import candidateFunnelData from "@data/dashboard/candidate_funnel.json";
import changeWall from "@data/dashboard/change_wall.json";
import dataAcquisitionMatrixData from "@data/dashboard/data_acquisition_matrix.json";
import entityProfilesData from "@data/dashboard/entity_profiles.json";
import eventDashboard from "@data/dashboard/events.json";
import followup from "@data/dashboard/followup.json";
import freshness from "@data/dashboard/freshness.json";
import gaps from "@data/dashboard/gaps.json";
import market from "@data/dashboard/market.json";
import marketContextsData from "@data/dashboard/market_contexts.json";
import observations from "@data/dashboard/observations.json";
import researchReading from "@data/dashboard/research_reading.json";
import researchGatesData from "@data/dashboard/research_gates.json";
import reviewCycleData from "@data/dashboard/review_cycle.json";
import serenityJudgmentIndex from "@data/dashboard/serenity_judgment_index.json";
import serenityOutputIndex from "@data/dashboard/serenity_output_index.json";
import timeline from "@data/dashboard/timeline.json";
import windowSummary from "@data/dashboard/window_summary.json";

const dashboardMeta = {
  date: serenityOutputIndex.date,
  generatedAt: serenityOutputIndex.generatedAt,
};

const DatabasePage = lazy(() =>
  import("./pages/DatabasePage.jsx").catch(() => ({
    default: DatabaseLoadError,
  }))
);
const CompanyPage = lazy(() =>
  import("./pages/CompanyMarketPages.jsx")
    .then((module) => ({ default: module.CompanyPage }))
    .catch(() => ({ default: CompanyLoadError }))
);
const MarketPage = lazy(() =>
  import("./pages/CompanyMarketPages.jsx")
    .then((module) => ({ default: module.MarketPage }))
    .catch(() => ({ default: MarketLoadError }))
);
const TimelinePage = lazy(() =>
  import("./pages/TimelinePage.jsx").catch(() => ({
    default: TimelineLoadError,
  }))
);

const serenityOutputDetailLoaders = Object.fromEntries(
  Object.entries(
    import.meta.glob(
      "@data/dashboard/serenity_output_details/*.json",
      { import: "default" }
    )
  ).map(([filePath, loader]) => [
    filePath.split("/").at(-1).replace(/\.json$/u, ""),
    loader,
  ])
);
const serenityJudgmentDetailLoaders = Object.fromEntries(
  Object.entries(
    import.meta.glob(
      "@data/dashboard/serenity_judgment_details/*.json",
      { import: "default" }
    )
  ).map(([filePath, loader]) => [
    filePath.split("/").at(-1).replace(/\.json$/u, ""),
    loader,
  ])
);

const navItems = [
  { id: "dashboard", label: "股票雷达" },
  { id: "companies", label: "公司" },
  { id: "market", label: "市场" },
  { id: "timeline", label: "时间轴" },
  { id: "database", label: "数据库" },
];

function DatabaseLoadError() {
  return (
    <DetailShell title="数据库" meta={dashboardMeta.date}>
      <div className="empty-state">
        <span>数据库加载失败，请重新加载后再试。</span>
        <button type="button" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    </DetailShell>
  );
}

function SecondaryPageLoadError({ title }) {
  return (
    <DetailShell title={title} meta={dashboardMeta.date}>
      <div className="empty-state">
        <span>{title}页面加载失败，请重新加载后再试。</span>
        <button type="button" onClick={() => window.location.reload()}>
          重新加载
        </button>
      </div>
    </DetailShell>
  );
}

function CompanyLoadError() {
  return <SecondaryPageLoadError title="公司" />;
}

function MarketLoadError() {
  return <SecondaryPageLoadError title="市场" />;
}

function TimelineLoadError() {
  return <SecondaryPageLoadError title="时间轴" />;
}

const stockSectorDefinitions = [
  { id: "robotics", label: "机器人" },
  { id: "semiconductor", label: "半导体" },
  { id: "drone", label: "无人机" },
  { id: "oil", label: "石油" },
  { id: "power", label: "电力" },
  { id: "innovative_drug", label: "创新药" },
  { id: "precious_metals", label: "贵金属" },
];

const eventLabels = {
  order: "订单",
  ipo: "IPO",
  funding: "融资",
  conference: "会议",
  policy: "政策",
  partnership: "合作",
  demo: "演示",
  factory: "工厂",
  hiring: "招聘",
  patent: "专利",
  product: "产品",
  delivery: "交付",
  announcement: "公告",
  financial_report: "财报",
};

const followupLabels = {
  pending: "待验证",
  confirmed: "已确认",
  completed: "已完成",
  archived: "已归档",
  cancelled: "已取消",
  stale: "已过期",
};

const sourceTypeLabels = {
  webpage: "网页",
  pdf: "PDF",
  announcement: "公告",
  news: "新闻",
  exchange: "交易所",
};

const laneLabels = {
  product: "产品/技术",
  company: "公司动态",
  supply_chain: "产业链/供应链",
  policy: "政策/行业",
  market: "股票市场",
};

const laneShortLabels = {
  product: "产品",
  company: "公司",
  supply_chain: "供应链",
  policy: "政策",
  market: "股票",
};

const statusLabels = {
  verified: "已验证",
  pending_review: "待审核",
  candidate: "候选",
  market_snapshot: "行情事实",
  final: "收盘事实",
  required: "必验",
  optional: "可选",
};

function formatPct(value) {
  if (typeof value !== "number") return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "--";
  return value;
}

function formatRate(value) {
  if (typeof value !== "number") return "--";
  return `${value.toFixed(2)}%`;
}

function formatTime(value) {
  if (!value) return "--";
  return String(value).replace("T", " ").replace("+08:00", "");
}

function datePart(value) {
  if (!value) return "--";
  return String(value).slice(5);
}

function stockCodeText(row) {
  if (!row?.stockCode) return row?.listed ? "缺股票代码" : "未上市";
  const suffixByMarket = {
    SSE: "SH",
    SZSE: "SZ",
    HKEX: "HK",
  };
  const suffix = suffixByMarket[row.market] || row.market;
  return suffix ? `${row.stockCode}.${suffix}` : row.stockCode;
}

function firstSource(item) {
  return item?.sources?.[0] || null;
}

function changeClass(value) {
  if (typeof value !== "number") return "";
  if (value > 0) return "rise";
  if (value < 0) return "fall";
  return "";
}

function amountRank(value) {
  if (typeof value !== "string") return -1;
  const number = Number.parseFloat(value);
  if (!Number.isFinite(number)) return -1;
  if (value.includes("亿")) return number * 100000000;
  if (value.includes("万")) return number * 10000;
  return number;
}

function sourceNames(sources = []) {
  const names = Array.from(new Set(sources.map((source) => source.publisher || source.title).filter(Boolean)));
  return names.slice(0, 3);
}

function freshnessLabel(status) {
  const labels = {
    fresh: "新",
    aging: "待复查",
    stale: "已过期",
    missing: "缺失",
    clear: "清",
    needs_review: "待审",
    has_gaps: "缺口",
    has_failures: "失败",
  };
  return labels[status] || status || "--";
}

function laneLabel(lane) {
  return laneLabels[lane] || lane || "--";
}

function laneShortLabel(lane) {
  return laneShortLabels[lane] || laneLabel(lane);
}

function statusLabel(status) {
  return statusLabels[status] || status || "--";
}

function compactChangeTitle(title = "") {
  return String(title)
    .replace(/股份有限公司/g, "")
    .replace(/有限责任公司/g, "")
    .replace(/存在官方产品材料《(.+?)》。?/, "$1")
    .replace(/存在官方产品材料/g, "产品材料")
    .replace(/机器人/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function compactTime(value) {
  if (!value) return "--";
  const text = String(value);
  if (text.includes("T")) return text.slice(11, 16);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return datePart(text);
  return text.slice(0, 5);
}

function firstMarketRow(change) {
  return change?.marketContext?.[0] || null;
}

function changeEntityIds(change) {
  const ids = change?.entityIds?.length ? change.entityIds : [change?.objectId];
  return Array.from(new Set(ids.filter(Boolean)));
}

function changeTimeValue(change) {
  const value = change?.time || change?.date;
  if (!value) return 0;
  const text = String(value);
  const timestamp = Date.parse(text.includes("T") ? text : `${text}T00:00:00+08:00`);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function changeTypeLabel(change = {}) {
  if (change.changeLabel) return change.changeLabel;
  const text = `${change.title || ""} ${change.change || ""}`;
  if (change.lane === "market") return "市场/行情事实";
  if (change.lane === "product") {
    if (/量产|下线|产线/.test(text)) return "产品/量产进展";
    if (/交付|客户/.test(text)) return "产品/交付线索";
    if (/发布|上市|新品/.test(text)) return "产品/发布进展";
    return "产品/技术进展";
  }
  if (change.lane === "company") {
    if (/公告|报告书|财报|定增|发行/.test(text)) return "公司/公告材料";
    if (/合作|生态|计划/.test(text)) return "公司/经营动作";
    return "公司/公开动态";
  }
  if (change.lane === "supply_chain") return "产业链/供应链线索";
  if (change.lane === "policy") return "政策/行业节点";
  return laneLabel(change.lane);
}

function verificationLine(change = {}) {
  if (change.nextQuestion) return change.nextQuestion;
  if (change.lane === "market") return "市场事实，不作因果";
  if (change.verificationItems?.length) {
    return `待验证：${change.verificationItems
      .slice(0, 2)
      .map((item) => item.subject)
      .join(" / ")}`;
  }
  if (change.status === "pending_review" || change.status === "candidate") return "待验证：来源/事实";
  return "";
}

function changeEvidenceLevel(change = {}) {
  return change.evidenceSummary?.level || change.evidenceLevel || "--";
}

function changeStatusText(change = {}) {
  return change.verificationLabel || statusLabel(change.verificationState || change.status);
}

function changeSourceSummary(change = {}) {
  return change.evidenceSummary?.sourceLabel || firstSource(change)?.publisher || firstSource(change)?.title || "--";
}

function gateTone(gate) {
  if (gate === "READY_FOR_REVIEW") return "ready";
  if (gate === "DATA_GATED") return "data";
  if (gate === "EVIDENCE_GATED") return "evidence";
  return "watch";
}

function acquisitionTone(status) {
  if (status === "OK") return "ready";
  if (status === "PARTIAL") return "partial";
  if (status === "FAILED" || status === "PENDING") return "blocked";
  return "neutral";
}

function MiniSparkline({ value }) {
  const positive = typeof value === "number" && value >= 0;
  const points = positive ? "2,24 20,18 38,20 56,11 74,14 92,6" : "2,8 20,13 38,10 56,18 74,16 92,24";
  return (
    <svg className={`mini-sparkline ${positive ? "rise" : "fall"}`} viewBox="0 0 94 30" aria-hidden="true">
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

function stockFromCompany(company) {
  const stock = company.stock;
  return {
    id: stock?.id || `pending_${company.id}`,
    entityId: company.id,
    company: company.name,
    displayName: company.name,
    stockCode: company.stockCode,
    market: company.market,
    listed: company.listed,
    price: stock?.price ?? null,
    changePct: stock?.changePct ?? null,
    turnoverAmount: stock?.turnoverAmount ?? null,
    turnoverRate: stock?.turnoverRate ?? null,
    totalMarketCap: stock?.totalMarketCap ?? null,
    floatMarketCap: stock?.floatMarketCap ?? null,
    fiveDayChangePct: stock?.fiveDayChangePct ?? null,
    twentyDayChangePct: stock?.twentyDayChangePct ?? null,
    capturedAt: stock?.capturedAt ?? null,
    quoteTime: stock?.quoteTime ?? null,
    sources: stock?.sources || [],
    quoteStatus: stock ? "已更新" : company.stockCode ? "待抓取" : "缺代码",
  };
}

function marketRows() {
  return (companies.rows || [])
    .filter((company) => company.listed)
    .map(stockFromCompany)
    .sort((a, b) => {
      if (a.quoteStatus !== b.quoteStatus) return a.quoteStatus === "已更新" ? -1 : 1;
      return Math.abs(b.changePct || 0) - Math.abs(a.changePct || 0);
    });
}

function buildMarketEvidence(row) {
  const company = row.displayName || row.company || row.name;
  return {
    title: `${company}行情快照`,
    fact: `${company}（${stockCodeText(row)}）：价格 ${formatValue(row.price)}，涨跌幅 ${formatPct(row.changePct)}，成交额 ${formatValue(row.turnoverAmount)}，换手率 ${formatRate(row.turnoverRate)}，近5日 ${formatPct(row.fiveDayChangePct)}，近20日 ${formatPct(row.twentyDayChangePct)}。`,
    date: row.capturedAt || market.date,
    evidenceLevel: firstSource(row)?.evidenceLevel || "B",
    module: "市场",
    entityNames: [company],
    sources: row.sources || [],
  };
}

function buildSerenityOutputEvidence(row) {
  const analysisSections = (row.display?.analysisSections || []).filter(
    (section) => section?.body || section?.items?.length
  );
  const fallbackSections = [
    {
      title: row.display?.viewLabel || "看法",
      body: row.display?.view || row.display?.summary,
    },
    {
      title: "验证",
      items: row.display?.toVerify || [],
    },
  ].filter((section) => section.body || section.items?.length);

  return {
    title: row.status === "serenity_ai_review" ? `${row.name} · Serenity 看法` : row.display?.title || `${row.name} 研究重点`,
    fact: row.display?.view || row.display?.summary || row.display?.currentFocus,
    date: row.generatedAt,
    module: row.status === "serenity_ai_review" ? "Serenity AI Review" : "研究重点",
    evidenceLevelLabel: "分析层",
    hideSources: true,
    isAnalysis: true,
    entityNames: [row.name].filter(Boolean),
    briefSections: analysisSections.length ? analysisSections : fallbackSections,
    sources: [],
  };
}

function isSerenityAiReview(row) {
  return row?.status === "serenity_ai_review" && Boolean(row.provider?.externalCall);
}

function isCompleteSerenityAnalysis(row) {
  return isSerenityAiReview(row) && Boolean(stockRadarOf(row));
}

function isSerenityReviewOutcome(row) {
  return row?.status === "serenity_ai_review_outcome" && Boolean(stockRadarOf(row)?.review);
}

function stockRadarOf(row) {
  return stockRadarForDisplay(row);
}

function formatSerenityMoney(value) {
  if (typeof value !== "number") return "--";
  if (Math.abs(value) >= 100000000) return `${(value / 100000000).toFixed(2)}亿`;
  if (Math.abs(value) >= 10000) return `${(value / 10000).toFixed(2)}万`;
  return String(Math.round(value));
}

function serenityTurnoverText(quote) {
  return quote?.turnoverText || formatSerenityMoney(quote?.turnover);
}

function serenityField(value, fallback = "Serenity 未给出") {
  if (value === null || value === undefined || value === "") return fallback;
  return value;
}

function hasSerenityNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function hasSerenityPayoff(radar) {
  return Boolean(radar?.sentiment?.available && hasSerenityNumber(radar.sentiment.marketPayoffScore));
}

function hasSerenityTrend(radar) {
  return Boolean(radar?.trend?.available && hasSerenityNumber(radar.trend.technicalTimingScore));
}

const entityProfileById = new Map((entityProfilesData.rows || []).map((profile) => [profile.entityId || profile.id, profile]));
const serenityJudgmentBaselineByEntityId = new Map(
  (serenityJudgmentIndex.rows || []).map((row) => [row.entityId, row.baseline])
);

const serenityActionLabels = {
  BUY_CANDIDATE: "适合买入候选",
  NEAR_BUY_POINT: "接近买点",
  WAIT_FOR_PRICE: "公司可看，价格不合适",
  WATCH_FOR_EVIDENCE: "继续观察，等证据",
  AVOID_FOR_NOW: "当前不优先",
  CORE_CANDIDATE: "核心候选",
  STRONG_OBSERVE: "值得重点观察",
  CANDIDATE_POOL: "放入候选池",
  WAIT_FOR_BUY_POINT: "等待更合适的买点",
  DATA_GATED: "关键数据不足，暂不行动",
  RESEARCH_GATED: "分析尚未完成",
  LEAD_TRACKING: "继续跟踪线索",
  ELIMINATE: "暂时排除",
  OBSERVE_ONLY: "只观察",
};

function stockProfileOf(row) {
  return entityProfileById.get(row?.entityId) || {};
}

function companyRoleOf(row) {
  const profile = stockProfileOf(row);
  return profile.sectorRole || profile.roboticsRole || profile.industryRole || profile.role || "";
}

function stockSectorOf(row) {
  return stockProfileOf(row).sector || "robotics";
}

function stockSectorLabelOf(row) {
  return stockProfileOf(row).sectorLabel || stockSectorDefinitions.find((item) => item.id === stockSectorOf(row))?.label || "其他";
}

function stockSelectionLabel(row) {
  const profile = stockProfileOf(row);
  if (profile.userFocus) return "你的重点";
  if (profile.curatorPick && isCompleteSerenityAnalysis(row)) return "建议关注";
  return null;
}

function scorecardOf(row) {
  return row?.rawArtifacts?.scorecard || row?.scorecardSummary || {};
}

function serenityActionOf(radar) {
  if (radar?.review?.status) return "证据不足，暂不判断";
  return (
    radar?.ai?.actionGrade?.label ||
    radar?.ai?.type ||
    serenityActionLabels[radar?.ai?.actionReadiness] ||
    String(radar?.ai?.currentAction || "").replace(/[。.]$/, "") ||
    "Serenity 暂未给出动作"
  );
}

function serenityReadinessOf(radar) {
  const readiness = radar?.ai?.actionReadiness;
  if (!readiness) return "待确认";
  return serenityActionLabels[readiness] || readiness;
}

function serenityNextActionOf(radar) {
  return String(
    radar?.ai?.actionGrade?.nextCondition ||
    radar?.ai?.currentAction ||
    "等待下一次数据更新"
  ).replace(/[。.]$/u, "");
}

function technicalMeaning(score) {
  if (!hasSerenityNumber(score)) return "暂无技术判断";
  if (score >= 70) return "买入时机较好";
  if (score >= 55) return "接近可观察区，等走势确认";
  if (score >= 40) return "时机一般，继续等待";
  return "当前时机偏弱，不适合追涨";
}

function payoffMeaning(score) {
  if (!hasSerenityNumber(score)) return "暂无风险收益判断";
  if (score >= 70) return "风险收益条件较有利";
  if (score >= 55) return "风险收益条件一般";
  if (score >= 40) return "上涨空间与下跌风险吸引力偏低";
  return "当前风险收益条件不理想";
}

function payoffLabel(score) {
  if (!hasSerenityNumber(score)) return "暂无判断";
  if (score >= 70) return "较有利";
  if (score >= 55) return "一般";
  if (score >= 40) return "偏低";
  return "不理想";
}

function fivePointMeaning(value) {
  if (!hasSerenityNumber(value)) return "暂无数据";
  if (value >= 3.8) return "较强";
  if (value >= 2.8) return "一般";
  return "偏弱";
}

function scorecardBasisItems(row) {
  const scorecard = scorecardOf(row);
  const evidenceNote = scorecard?.evidence_notes?.[0] || {};
  const trend = scorecard?.module_results?.technical_timing?.details || {};
  const payoff = scorecard?.module_results?.market_payoff?.details || {};
  const items = [];

  if (
    hasSerenityNumber(trend.monthly_trend) ||
    hasSerenityNumber(trend.weekly_structure) ||
    hasSerenityNumber(trend.daily_buy_point)
  ) {
    items.push({
      label: "价格走势",
      text: [
        hasSerenityNumber(trend.monthly_trend) ? `较长时间走势${fivePointMeaning(trend.monthly_trend)}` : "",
        hasSerenityNumber(trend.weekly_structure) ? `最近几周走势${fivePointMeaning(trend.weekly_structure)}` : "",
        hasSerenityNumber(trend.daily_buy_point)
          ? trend.daily_buy_point >= 3.5
            ? "当前价格接近可关注位置"
            : trend.daily_buy_point >= 2.6
              ? "当前价格可以继续观察"
              : "当前价格还不适合追"
          : "",
      ]
        .filter(Boolean)
        .join("，"),
    });
  }

  if (
    hasSerenityNumber(payoff.valuation_discount) ||
    hasSerenityNumber(payoff.upside_downside) ||
    hasSerenityNumber(payoff.liquidity_capacity)
  ) {
    items.push({
      label: "价格与风险",
      text: [
        hasSerenityNumber(payoff.valuation_discount)
          ? `现在的价格${payoff.valuation_discount >= 3.8 ? "较便宜" : payoff.valuation_discount >= 2.8 ? "不算便宜" : "偏贵"}`
          : "",
        hasSerenityNumber(payoff.upside_downside)
          ? `可能上涨和下跌的空间${fivePointMeaning(payoff.upside_downside)}`
          : "",
        hasSerenityNumber(payoff.liquidity_capacity)
          ? `平时买卖${payoff.liquidity_capacity >= 3.8 ? "较活跃" : payoff.liquidity_capacity >= 2.8 ? "一般" : "不够活跃"}`
          : "",
      ]
        .filter(Boolean)
        .join("，"),
    });
  }

  if (evidenceNote.supports) {
    items.push({
      label: "数据依据",
      text: String(evidenceNote.supports)
        .replace(/20日变化/g, "近20日涨跌")
        .replace(/60日变化/g, "近60日涨跌")
        .replace(/客户\/产能证据\s*(\d+)\s*条直接、\s*(\d+)\s*条线索/g, "正式披露 $1 条，待验证线索 $2 条"),
    });
  }

  if (evidenceNote.missing_proof) {
    items.push({
      label: "仍缺证据",
      text: String(evidenceNote.missing_proof).replace(/\s*\/\s*/g, "、"),
    });
  }

  return items.filter((item) => item.text);
}

const serenityConfidenceLabels = {
  HIGH: "高",
  MEDIUM: "中",
  LOW: "低",
  A: "高",
  B: "中",
  C: "低",
};

const researchStageLabels = ["预期", "产品", "送样", "定点", "订单", "收入", "利润"];
const sectorLogicLabels = {
  oil: ["产量", "售价", "成本", "利润", "现金流"],
  power: ["发电量", "电价", "成本", "利润", "现金流"],
  innovative_drug: ["临床", "获批", "销售", "利润", "现金流"],
  precious_metals: ["资源", "投产", "产量", "成本", "利润", "现金流"],
};
const evidenceCategoryLabels = {
  quality: "收入和现金",
  commercial: "订单与收入",
  execution: "项目进度",
  valuation: "价格和预期",
  timing: "买入时机",
  risk: "主要风险",
  other: "其他依据",
};

function readableConfidence(radar) {
  return serenityConfidenceLabels[String(radar?.ai?.confidence || "").toUpperCase()] || "待验证";
}

function shortSerenityText(value, maxLength = 34) {
  const text = String(value || "")
    .replace(/^Serenity\s*判断为[“"]?/u, "")
    .replace(/[”"]，?适合继续.*$/u, "")
    .replace(/[。；;]+$/u, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (text.length <= maxLength) return text;
  const first = text.split(/[；。]/u).find(Boolean)?.trim() || text;
  return first;
}

function completeEvidenceText(value) {
  return String(value || "")
    .replace(/\s+/gu, " ")
    .trim();
}

function evidenceEffect(text) {
  if (/未|尚无|尚不能|不能证明|仍待|缺少|缺乏|不足|低于|弱势|下跌|延期|推迟|偏高|偏弱|不匹配|没有确认|不允许|只支持|false|(?:同比|较可比期)-|经营现金流-/u.test(text)) {
    return "against";
  }
  if (/已验证|完整验证|批量供应|稳定|增长|改善|订单|交付|收入|利润|现金流/u.test(text)) {
    return "support";
  }
  return "unknown";
}

function evidenceCategory(text) {
  if (/均线|趋势|买点|技术/u.test(text)) return "timing";
  if (/估值|市场隐含|预期差|风险收益/u.test(text)) return "valuation";
  if (/项目|产能|验收|延期|建设/u.test(text)) return "execution";
  if (/营业收入|净利润|现金流|毛利|财务/u.test(text)) return "quality";
  if (/订单|客户|交付|送样|定点|收入/u.test(text)) return "commercial";
  return "other";
}

function shortEvidenceFact(text) {
  const evidenceCounts = String(text).match(/正式披露\s*(\d+)\s*条.*待验证线索\s*(\d+)\s*条/u);
  if (evidenceCounts) return `${evidenceCounts[1]}条正式证据，${evidenceCounts[2]}条待验证线索`;
  if (/利润增长.*现金流偏弱|现金流偏弱.*利润增长/u.test(text)) return "利润增长，但现金流偏弱";
  if (/新签订单与在手订单.*6至24个月/u.test(text)) return "订单已有可见度，但兑现周期长";
  if (/客户\d+.*量产采购|从研发.*量产采购/u.test(text)) return "已有客户量产采购，但收入规模仍未确认";
  if (/低于20日.*50日.*200日|低于.*20日.*50日.*200日/u.test(text)) return "价格低于20/50/200日均线";
  if (/BASE_BUILDING_WATCH|筑底/u.test(text)) return "技术结构仍在筑底观察";
  if (/未单独披露.*收入.*订单|订单.*收入.*未|没有.*订单.*收入|缺.*订单/u.test(text)) {
    return "机器人订单和独立收入未验证";
  }
  if (/客户.*批量供应|批量供应.*客户/u.test(text)) return "现有业务已有客户和批量供应";
  if (/营业收入.*净利润.*现金流/u.test(text)) return "收入、利润和现金流已披露";
  if (/谐波减速器.*收入/u.test(text)) {
    return /未披露.*人形机器人|未披露.*收入占比/u.test(text)
      ? "减速器业务已兑现，但人形机器人收入占比未披露"
      : "减速器收入已经披露";
  }
  if (/项目.*延期|项目.*推迟|预定可使用状态.*推迟/u.test(text)) return "项目验收时间推迟";
  if (/市场.*隐含.*增长.*证据|预期.*高于.*证据/u.test(text)) return "市场预期高于现有证据";
  if (/正式订单.*客户名称.*交付|缺正式订单/u.test(text)) return "订单、客户和交付仍缺验证";
  return shortSerenityText(text, 28);
}

function evidenceReason(text, category, effect) {
  if (category === "timing") return "公司不错也不代表现在就适合买，价格走势还要确认";
  if (category === "valuation") return "股价跑在事实前面时，一旦结果不及预期，容易跌得更多";
  if (category === "execution") return "项目进度决定产能和订单何时能验证";
  if (category === "quality" && effect === "against") return "利润和现金流不同步，增长质量要继续验证";
  if (category === "quality") return "收入、利润和现金流能交叉验证业务质量";
  if (category === "commercial" && effect === "support") {
    return /未披露|未知/u.test(text)
      ? "量产采购支持继续观察，但不足以确认收入规模"
      : "客户、订单和交付能证明业务已兑现";
  }
  if (category === "commercial") return "产品或送样不能证明订单和收入";
  return effect === "support" ? "这条事实增强当前判断" : "这条事实让当前判断需要更保守";
}

function scorecardEvidenceItems(row) {
  const radar = stockRadarOf(row) || {};
  const sector = stockSectorOf(row);
  const operationalCategory = ["oil", "power", "precious_metals"].includes(sector)
    ? "quality"
    : sector === "innovative_drug"
      ? "execution"
      : "commercial";
  return scorecardBasisItems(row).map((item) => {
    const category = item.label === "价格走势" ? "timing" : item.label === "价格与风险" ? "valuation" : operationalCategory;
    const effect =
      category === "timing"
        ? /不适合追|偏弱|继续等待/u.test(item.text)
          ? "against"
          : (radar.trend?.technicalTimingScore || 0) >= 55
          ? "support"
          : "against"
        : category === "valuation"
          ? /偏贵|不算便宜|偏弱|不理想/u.test(item.text)
            ? "against"
            : (radar.sentiment?.marketPayoffScore || 0) >= 60
            ? "support"
            : "against"
          : item.label === "数据依据" && /已读取\s*\d+\s*份正式公告/u.test(item.text)
            ? "support"
          : item.label === "仍缺证据" || /缺|待验证|尚未/u.test(item.text)
            ? "against"
            : "unknown";
    const reason =
      item.label === "数据依据"
        ? "公告正文和财报是判断底稿，避免只看标题或市场传闻"
        : item.label === "仍缺证据"
          ? "这些变量决定原来的判断能不能兑现"
          : evidenceReason(item.text, category, effect);
    return {
      category,
      effect,
      fact: completeEvidenceText(item.text),
      summary: shortEvidenceFact(item.text),
      reason,
    };
  });
}

function decisionEvidenceItems(row) {
  const radar = stockRadarOf(row) || {};
  if (!isCompleteSerenityAnalysis(row)) return scorecardEvidenceItems(row).slice(0, 4);

  const structuredCards = radar.evidence?.cards || [];
  if (structuredCards.length) {
    return structuredCards.map((card) => {
      const category =
        /财务/u.test(card.title || "")
          ? "quality"
          : /核心业务/u.test(card.title || "")
            ? "commercial"
            : /反方|风险/u.test(card.title || "")
              ? "risk"
              : /价格/u.test(card.title || "")
                ? "timing"
                : evidenceCategory(`${card.title || ""} ${card.fact || ""}`);
      const semanticEffect = evidenceEffect(card.fact || "");
      return {
        category: category === "other" ? "commercial" : category,
        effect: card.status === "CONFLICTED"
          ? "against"
          : semanticEffect !== "unknown"
            ? semanticEffect
            : card.status === "DIRECT"
            ? "support"
            : "unknown",
        fact: completeEvidenceText(card.fact),
        summary: card.title,
        reason: completeEvidenceText(card.reason),
        sourceRefs: card.sourceRefs || [],
      };
    });
  }

  const sourceItems = [
    ...(radar.movement?.confirmed || []),
    ...(radar.movement?.possible || []),
  ];
  const byCategory = new Map();
  sourceItems.forEach((text) => {
    const category = evidenceCategory(text);
    if (category === "other") return;
    let effect = evidenceEffect(text);
    if (category === "timing") effect = (radar.trend?.technicalTimingScore || 0) >= 55 ? "support" : "against";
    if (category === "commercial" && /持续采购|量产采购|进入量产|批量供应/u.test(text)) effect = "support";
    if (category === "valuation") {
      effect = /市场.*(?:高于|领先).*证据|market_ahead_of_evidence|仍需.*复核/u.test(text)
        ? "against"
        : (radar.sentiment?.marketPayoffScore || 0) >= 60
          ? "support"
          : "against";
    }
    const existing = byCategory.get(category);
    const priority = { unknown: 1, support: 2, against: 3 };
    if (existing && priority[existing.effect] >= priority[effect]) return;
    byCategory.set(category, {
      category,
      effect,
      fact: completeEvidenceText(text),
      summary: shortEvidenceFact(text),
      reason: evidenceReason(text, category, effect),
    });
  });
  return ["quality", "commercial", "execution", "valuation", "timing"]
    .map((category) => byCategory.get(category))
    .filter(Boolean);
}

function currentReasonOf(row, evidenceItems) {
  const radar = stockRadarOf(row) || {};
  if (isCompleteSerenityAnalysis(row)) {
    const support = evidenceItems.find((item) => item.effect === "support");
    const negativeFacts = evidenceItems
      .filter((item) => item.effect === "against")
      .map((item) => (item.summary || item.fact).replace(/^利润增长，但/u, ""))
      .slice(0, 2);
    const supportFact = support?.summary || support?.fact;
    if (supportFact && negativeFacts.length) return `${supportFact}；主要风险是${negativeFacts.join("、")}`;
    if (supportFact) return supportFact;
    if (negativeFacts.length) return `${negativeFacts.join("、")}，所以保持谨慎`;
  }
  const negative = evidenceItems.find((item) => item.effect === "against");
  return negative
    ? `${String(negative.fact).replace(/[。；;，,]+$/u, "")}，所以暂不升级判断`
    : "现有证据还不足以升级判断";
}

function researchStageOf(row) {
  const radar = stockRadarOf(row) || {};
  const text = [...(radar.movement?.confirmed || []), ...(radar.movement?.possible || [])].join(" ");
  const hasCommercialGap =
    /(?:机器人|执行器|丝杠|减速器|新业务)[^。；]{0,42}(?:未|没有|尚无|缺|待)[^。；]{0,28}(?:订单|收入|交付)/u.test(text);
  const affirmative = (pattern) =>
    pattern.test(text) && !new RegExp(`(?:未|无|缺|待)[^。；]{0,12}(?:${pattern.source})`, "u").test(text);
  if (!hasCommercialGap && affirmative(/机器人[^。；]{0,20}(?:利润|毛利)|(?:减速器|丝杠|执行器)[^。；]{0,20}(?:利润|毛利)/u)) return 6;
  if (!hasCommercialGap && affirmative(/独立收入|分部收入|(?:机器人|减速器|丝杠|执行器)[^。；]{0,20}收入/u)) return 5;
  if (!hasCommercialGap && affirmative(/批量订单|正式订单/u)) return 4;
  if (affirmative(/定点/u)) return 3;
  if (affirmative(/送样/u)) return 2;
  if (/产品|研发|试制/u.test(text)) return 1;
  return 0;
}

function researchLesson(stage) {
  return [
    "先分清题材关联和真实产品",
    "有产品不等于有客户验证",
    "送样不等于客户定点",
    "定点不等于批量订单",
    "订单还要验证交付和收入",
    "收入增长还要验证利润",
    "利润还要和现金流相互验证",
  ][stage];
}

function evidenceSignals(item) {
  const text = `${item.summary || ""} ${item.fact || ""}`;
  if (item.category === "quality") {
    return [
      /利润.*增长|净利润.*增长/u.test(text) ? "利润 ↑" : "利润待验",
      /现金流.*偏弱|现金流.*下降|现金流.*不同步/u.test(text) ? "现金流 ↓" : "现金流待验",
      /存货|库存/u.test(text) ? "库存压力" : "回款待验",
    ];
  }
  if (item.category === "commercial") {
    return [
      /客户.*采购|持续采购/u.test(text) ? "已有客户采购" : "客户待确认",
      /量产|批量/u.test(text) ? "进入量产" : "批量待确认",
      /未披露.*收入|收入占比.*未/u.test(text) ? "收入占比未知" : "收入待验证",
    ];
  }
  if (item.category === "execution") {
    const utilization = text.match(/利用率\s*(\d+(?:\.\d+)?)%/u)?.[1];
    const delayedTo = text.match(/延期至\s*(\d{4})年/u)?.[1];
    return [utilization ? `利用率 ${utilization}%` : "产能待验证", delayedTo ? `延期至 ${delayedTo}` : "进度待验证"];
  }
  if (item.category === "valuation") return ["股价先涨", "事实还要验证", "价格是否合理待确认"];
  if (item.category === "timing") return ["走势还要确认", "现在先不追"];
  return [];
}

function stageNowText(stage) {
  return ["仍在题材预期", "已有产品", "已有送样", "已有客户定点", "已有订单", "已有收入", "已有利润"][stage];
}

function stageGapText(stage) {
  return ["真实产品", "客户验证", "客户定点", "批量订单", "交付与收入", "利润兑现", "现金流匹配"][stage];
}

function stageNextText(stage) {
  return stage < researchStageLabels.length - 1
    ? `自动关注${researchStageLabels[stage + 1]}证据`
    : "自动验证利润与现金流是否匹配";
}

function shortTrigger(value) {
  const text = String(value || "");
  if (/买点|均线|技术结构|趋势/u.test(text)) return "买点是否出现";
  if (/订单|客户采用|客户确认/u.test(text)) return "订单是否兑现";
  if (/收入|分部|财报/u.test(text)) return "收入是否兑现";
  if (/验收|项目/u.test(text)) return "项目是否按期";
  if (/估值|股本|市盈率|市销率/u.test(text)) return "估值是否匹配";
  if (/现金流|利润/u.test(text)) return "业绩是否兑现";
  if (/供应链|供应关系|合作披露|官方材料/u.test(text)) return "供应关系是否确认";
  return shortSerenityText(text, 16) || "关键证据是否出现";
}

function changeFromPrice(basePrice, currentPrice) {
  if (!hasSerenityNumber(basePrice) || !hasSerenityNumber(currentPrice) || basePrice === 0) return null;
  return ((currentPrice - basePrice) / basePrice) * 100;
}

function maxDrawdownFromSnapshots(snapshots, currentPrice) {
  const prices = snapshots.map((item) => item.price).filter(hasSerenityNumber);
  if (hasSerenityNumber(currentPrice) && prices[prices.length - 1] !== currentPrice) prices.push(currentPrice);
  if (!prices.length) return null;
  let peak = prices[0];
  let drawdown = 0;
  prices.forEach((price) => {
    peak = Math.max(peak, price);
    drawdown = Math.min(drawdown, ((price - peak) / peak) * 100);
  });
  return drawdown;
}

function dailyReviewOf(history, radar, stockRows) {
  const snapshots = [...(history?.snapshots || [])].sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const latest = history?.latest || snapshots[snapshots.length - 1] || null;
  const previous = snapshots.length > 1 ? snapshots[snapshots.length - 2] : null;
  const baseline = snapshots[0] || latest;
  const currentPrice = radar?.quote?.price;
  const stockReturnPct = changeFromPrice(baseline?.price, currentPrice);
  const poolReturns = stockRows
    .map((row) => {
      const rowBaseline = serenityJudgmentBaselineByEntityId.get(row.entityId);
      if (!rowBaseline || (latest?.market && rowBaseline.market !== latest.market)) return null;
      return changeFromPrice(rowBaseline.price, stockRadarOf(row)?.quote?.price);
    })
    .filter(hasSerenityNumber);
  const poolReturnPct = poolReturns.length ? poolReturns.reduce((sum, value) => sum + value, 0) / poolReturns.length : null;
  const excessReturnPct = hasSerenityNumber(stockReturnPct) && hasSerenityNumber(poolReturnPct)
    ? stockReturnPct - poolReturnPct
    : null;
  const maxDrawdownPct = maxDrawdownFromSnapshots(snapshots, currentPrice);
  const changed = Boolean(previous && latest && previous.action !== latest.action);
  const hasHistory = snapshots.length > 0;
  const hasMovement = hasSerenityNumber(stockReturnPct) && Math.abs(stockReturnPct) >= 0.1;
  let assessment = hasHistory ? "尚不能判定对错" : "等待首次自动复盘";
  if (hasHistory && hasMovement) {
    if (["WAIT_FOR_BUY_POINT", "OBSERVE_ONLY"].includes(latest?.actionReadiness)) {
      assessment = hasSerenityNumber(excessReturnPct) && excessReturnPct >= 8
        ? "出现反证：可能错过行情"
        : stockReturnPct <= 0 || maxDrawdownPct <= -8
          ? "市场暂时支持等待"
          : "目前还不能判定对错";
    } else if (["CORE_CANDIDATE", "STRONG_OBSERVE"].includes(latest?.actionReadiness)) {
      assessment = stockReturnPct > 0 && (!hasSerenityNumber(excessReturnPct) || excessReturnPct > 0)
        ? "市场暂时支持原判断"
        : "市场暂时不支持原判断";
    } else {
      assessment = "继续收集证据";
    }
  }
  const status = !hasHistory ? "等待首次复盘" : snapshots.length === 1 ? "已建立判断基线" : changed ? "判断已调整" : "判断未变";
  const evidenceUpdate = !hasHistory
    ? "今日判断尚未写入自动复盘账本"
    : !previous
      ? "当前事实、行情与判断已经保存为比较基线"
      : previous.analysisGeneratedAt !== latest.analysisGeneratedAt
        ? "Serenity 已吸收新一轮分析材料"
        : "暂无能够改变判断的新证据";
  const statusReason = !hasHistory
    ? "系统将在下一次每日任务中建立基线"
    : !previous
      ? "后续每次更新都会与这次判断自动比较"
      : changed
        ? `判断从“${previous.action}”调整为“${latest.action}”`
        : "新事实和市场变化都没有触发改判条件";
  const timeline = snapshots.slice().reverse().slice(0, 4).map((snapshot, index) => ({
    date: snapshot.date,
    label: snapshots.length === 1 ? "建立判断" : snapshot.judgmentChanged ? "调整判断" : index === 0 ? "每日复盘" : "判断记录",
    action: snapshot.action,
  }));
  return {
    assessment,
    changed,
    evidenceUpdate,
    excessReturnPct,
    maxDrawdownPct,
    status,
    statusReason,
    stockReturnPct,
    timeline,
    updatedAt: history?.updatedAt || latest?.capturedAt || radar?.generatedAt,
  };
}

function dailyWatchItems(history, radar, stage) {
  const items = [];
  if (["WAIT_FOR_BUY_POINT", "OBSERVE_ONLY"].includes(radar?.ai?.actionReadiness)) items.push("买点出现");
  items.push(stage < 6 ? `${researchStageLabels[stage + 1]}证据` : "利润与现金流匹配");
  Object.values(history?.latest?.triggers || {}).forEach((item) => items.push(String(item).replace(/是否/u, "")));
  return Array.from(new Set(items.filter(Boolean))).slice(0, 4);
}

const serenityScenarioLabels = {
  base: "最可能",
  upside: "偏强情况",
  downside: "偏弱情况",
};

function serenityScenarioItems(radar) {
  return ["base", "upside", "downside"]
    .map((key) => {
      const scenario = radar?.scenarios?.[key];
      if (!scenario?.summary) return null;
      const probability = hasSerenityNumber(scenario.probability)
        ? `${Math.round(scenario.probability * 100)}%`
        : "";
      return `${serenityScenarioLabels[key]}${probability ? ` ${probability}` : ""}：${scenario.summary}`;
    })
    .filter(Boolean);
}

function buildStockRadarEvidence(row) {
  const radar = stockRadarOf(row) || {};
  const deepAnalysis = isCompleteSerenityAnalysis(row);
  const outcome = isSerenityReviewOutcome(row);
  const role = companyRoleOf(row);
  const action = serenityActionOf(radar);
  const scenarioItems = serenityScenarioItems(radar);
  const scorecardBasis = scorecardBasisItems(row);
  const triggerItems = deepAnalysis
    ? [
        ...(radar.triggers?.["30d"] || []).map((item) => `未来30天：${item}`),
        ...(radar.triggers?.["90d"] || []).map((item) => `未来90天：${item}`),
        ...(radar.triggers?.["180d"] || []).map((item) => `未来180天：${item}`),
      ]
    : [];
  const briefSections = [
    role
      ? {
          title: "这家公司做什么",
          body: role,
        }
      : null,
    outcome
      ? {
          title: "分析结果",
          body: radar.review?.reason || row.display?.summary,
          items: (radar.review?.requiredEvidence || []).map((item) => `缺：${item}`),
        }
      : null,
    {
      title: "Serenity 现在怎么看",
      body: action,
      items: [radar.ai?.type || row.display?.summary || ""].filter(Boolean),
    },
    {
      title: "股票变动",
      body:
        radar.quote?.price !== undefined && radar.quote?.price !== null
          ? `当前价 ${radar.quote.price} ${radar.quote.currency || ""}，涨跌 ${formatPct(radar.quote.changePct)}，成交额 ${serenityTurnoverText(radar.quote)}。`
          : "",
    },
    deepAnalysis
      ? {
          title: "影响因素",
          items: [
            ...(radar.movement?.confirmed || []).map((item) => `已确认：${item}`),
            ...(radar.movement?.possible || []).map((item) => `可能因素：${item}`),
            ...(radar.movement?.unexplained || []),
          ],
        }
      : null,
    hasSerenityTrend(radar)
      ? {
          title: "趋势和买入时机",
          items: [
            `买入时机 ${radar.trend.technicalTimingScore}/100：${technicalMeaning(radar.trend.technicalTimingScore)}`,
            radar.trend.state || "",
            radar.trend.buyPoint || "",
          ].filter(Boolean),
        }
      : null,
    hasSerenityPayoff(radar)
      ? {
          title: "上涨空间和下跌风险",
          body: `${radar.sentiment.marketPayoffScore}/100：${payoffMeaning(radar.sentiment.marketPayoffScore)}`,
          items: ["该分数综合估值、上涨与下跌空间、流动性和交易拥挤度，不是市场情绪。"],
        }
      : null,
    !deepAnalysis && scorecardBasis.length
      ? {
          title: "判断依据",
          items: scorecardBasis.map((item) => `${item.label}：${item.text}`),
        }
      : null,
    deepAnalysis && scenarioItems.length
      ? { title: "后续可能怎么走", items: scenarioItems }
      : null,
    deepAnalysis && radar.risk?.length ? { title: "主要风险", items: radar.risk } : null,
    triggerItems.length ? { title: "接下来盯什么", items: triggerItems } : null,
  ].filter((section) => section && (section.body || section.items?.length));

  return {
    title: `${row.name} · Serenity 判断依据`,
    fact: `${action}。${technicalMeaning(radar.trend?.technicalTimingScore)}。`,
    date: String(radar.generatedAt || row.generatedAt || "").slice(0, 10),
    module: deepAnalysis ? "Serenity 深度分析" : "Serenity 量化判断",
    evidenceLevelLabel: deepAnalysis ? "已完成 AI 深研" : "已完成评分",
    hideSources: true,
    isAnalysis: true,
    entityNames: [],
    briefSections,
    sources: [],
  };
}

function buildEvidenceFromSource(source) {
  return {
    title: source.title,
    fact: source.title,
    evidenceLevel: source.evidenceLevel,
    module: source.sourceType,
    date: source.publishedAt || source.capturedAt || dashboardMeta.date,
    sources: [source],
  };
}

function EvidenceBadge({ level }) {
  return <span className="evidence-badge">{level || "--"}级</span>;
}

function OverviewItem({ label, value, note }) {
  return (
    <div className="overview-item">
      <span>{label}</span>
      <strong>{value}</strong>
      {note ? <small>{note}</small> : null}
    </div>
  );
}

function EmptyState({ children = "暂无已验证数据" }) {
  return <div className="empty-state">{children}</div>;
}

function FreshnessStrip() {
  const rows = freshness.rows || [];

  return (
    <section className="freshness-strip" aria-label="数据状态">
      {rows.map((row) => (
        <div key={row.id}>
          <span>{row.label}</span>
          <strong>{freshnessLabel(row.status)}</strong>
          <small>{formatTime(row.lastSeenAt)}</small>
        </div>
      ))}
    </section>
  );
}

function WindowSummaryStrip() {
  const windows = windowSummary.windows || [];
  const visible = ["today", "last_30_days", "last_180_days", "future_90_days"]
    .map((id) => windows.find((row) => row.id === id))
    .filter(Boolean);

  return (
    <section className="window-summary-strip" aria-label="时间窗口">
      {visible.map((row) => (
        <div key={row.id}>
          <span>{row.label}</span>
          <strong>{row.direction === "future" ? row.milestones || 0 : row.observations || 0}</strong>
          <small>{row.direction === "future" ? "验证节点" : "Observation"}</small>
        </div>
      ))}
    </section>
  );
}

function StockLine({ row }) {
  return (
    <div className="stock-line">
      <div>
        <strong>{row.displayName || row.company}</strong>
        <span>{stockCodeText(row)}</span>
      </div>
      <b>{formatValue(row.price)}</b>
      <em className={changeClass(row.changePct)}>{formatPct(row.changePct)}</em>
    </div>
  );
}

function StockCard({ row, openCompany, openEvidence, compact = false }) {
  return (
    <article className={`stock-card ${compact ? "stock-card-compact" : ""}`}>
      <button className="stock-card-main" onClick={() => openCompany(row.entityId)}>
        <span>{stockCodeText(row)}</span>
        <strong>{row.displayName || row.company}</strong>
        <b>{formatValue(row.price)}</b>
        <em className={changeClass(row.changePct)}>{formatPct(row.changePct)}</em>
      </button>

      {!compact ? (
        <div className="stock-card-metrics">
          <p>
            <span>成交额</span>
            <strong>{formatValue(row.turnoverAmount)}</strong>
          </p>
          <p>
            <span>换手率</span>
            <strong>{formatRate(row.turnoverRate)}</strong>
          </p>
          <p>
            <span>近5日</span>
            <strong>{formatPct(row.fiveDayChangePct)}</strong>
          </p>
          <p>
            <span>近20日</span>
            <strong>{formatPct(row.twentyDayChangePct)}</strong>
          </p>
        </div>
      ) : null}

      <div className="stock-card-foot">
        <span>{row.quoteStatus === "已更新" ? formatTime(row.capturedAt) : row.quoteStatus}</span>
        {row.sources?.length ? (
          <button onClick={() => openEvidence(buildMarketEvidence(row))}>来源</button>
        ) : null}
      </div>
    </article>
  );
}

function SummaryStockText({ rows }) {
  const visibleRows = rows.slice(0, 2);
  if (!visibleRows.length) return <span className="summary-muted">暂无行情</span>;

  return (
    <>
      {visibleRows.map((row, index) => (
        <span key={row.id || row.entityId}>
          {index > 0 ? "、" : ""}
          {row.company} {formatPct(row.changePct)}
        </span>
      ))}
    </>
  );
}

function EventCard({ event, openCompany, openEvidence, compact = false }) {
  const directStocks = event.directMarketRows || [];
  const contextStocks = event.watchlistMarketContext || [];
  const stockRows = directStocks.length ? directStocks : contextStocks.slice(0, 3);
  const stockTitle = "同日 Watchlist 股票表现";
  const followups = event.followups || [];

  return (
    <article className={`event-card ${compact ? "event-card-compact" : ""}`}>
      <button className="event-card-head" onClick={() => openEvidence(event)}>
        <span>
          {event.date}｜{event.module || "未分类"}｜{eventLabels[event.eventType] || "事件"}
        </span>
        <h3>{event.title}</h3>
        {!compact ? <p>{event.fact}</p> : null}
      </button>

      <div className="event-card-body">
        <section>
          <small>涉及公司</small>
          <div className="pill-list">
            {(event.entities || []).map((entity) => (
              <button key={entity.id} onClick={() => openCompany(entity.id)}>
                {entity.name}
              </button>
            ))}
          </div>
        </section>

        <section>
          <small>{stockTitle}</small>
          {stockRows.length ? (
            <div className="stock-mini-list">
              {stockRows.map((row) => (
                <StockLine key={row.id || row.entityId} row={row} />
              ))}
            </div>
          ) : (
            <span className="muted-text">暂无行情快照</span>
          )}
        </section>

        <section>
          <small>待验证</small>
          {followups.length ? (
            <div className="mini-followups">
              {followups.slice(0, 3).map((item) => (
                <button key={item.id} onClick={() => openEvidence(item)}>
                  {item.subject}
                </button>
              ))}
            </div>
          ) : (
            <span className="muted-text">暂无直接跟踪项</span>
          )}
        </section>
      </div>

      <footer>
        <EvidenceBadge level={event.evidenceLevel} />
        <button onClick={() => openEvidence(event)}>查看来源</button>
      </footer>
    </article>
  );
}

function ObservationCard({ observation, openCompany, openEvidence, expanded, onToggle }) {
  const stockRows = observation.sameDayWatchlistRows || [];
  const followups = observation.followups || [];
  const relatedRows = observation.relatedObservations || [];
  const publishers = sourceNames(observation.sources);
  const companyNames = (observation.entities || []).map((entity) => entity.name).slice(0, 3);
  const sourceLabel = observation.evidenceLevel ? `${observation.evidenceLevel}级` : "--";
  const evidenceSummary = observation.evidenceSummary || {};
  const sourceTimes = observation.sourceTimes || {};

  return (
    <article className={`observation-card ${expanded ? "is-expanded" : "is-collapsed"}`}>
      <div className="observation-summary">
        <button className="observation-title" onClick={() => openEvidence(observation)}>
          <span>
            {observation.number}｜{observation.date}｜{observation.module || "未分类"}
          </span>
          <h3>{observation.title}</h3>
        </button>

        <div className="summary-cell">
          <small>涉及公司</small>
          <strong>{companyNames.length ? companyNames.join("、") : "--"}</strong>
        </div>

        <div className="summary-cell">
          <small>同日 Watchlist</small>
          <strong>
            <SummaryStockText rows={stockRows} />
          </strong>
        </div>

        <div className="summary-cell compact">
          <small>Claim / 证据</small>
          <strong>
            {evidenceSummary.claimCount || 0} 条 · {evidenceSummary.evidenceCount || 0} 证据
          </strong>
        </div>

        <button className="summary-expand" onClick={onToggle}>
          {expanded ? "收起" : "展开"}
        </button>
      </div>

      {expanded ? (
        <div className="observation-detail">
          <div className="observation-fact">
            <small>完整事实</small>
            <p>{observation.fact}</p>
          </div>

          <div className="observation-grid">
            <section>
              <small>Why now</small>
              <p className="observation-note">{observation.whyNow || "按证据等级和重要性进入研究队列"}</p>
            </section>

            <section>
              <small>证据链</small>
              <div className="evidence-chain-mini">
                <span>Claim {evidenceSummary.claimCount || 0}</span>
                <span>Evidence {evidenceSummary.evidenceCount || 0}</span>
                <span>{evidenceSummary.strongestSourceLevel || sourceLabel}级最高来源</span>
              </div>
            </section>

            <section>
              <small>涉及公司</small>
              <div className="research-company-list">
                {(observation.entities || []).map((entity) => (
                  <button key={entity.id} onClick={() => openCompany(entity.id)}>
                    <span>✓</span>
                    {entity.name}
                  </button>
                ))}
              </div>
            </section>

            <section>
              <small>同日 Watchlist 股票表现</small>
              {stockRows.length ? (
                <div className="observation-stock-list">
                  {stockRows.slice(0, 4).map((row) => (
                    <button key={row.id || row.entityId} onClick={() => openCompany(row.entityId)}>
                      <div>
                        <strong>{row.company}</strong>
                        <span>{stockCodeText(row)}</span>
                      </div>
                      <b>{formatValue(row.price)}</b>
                      <em className={changeClass(row.changePct)}>{formatPct(row.changePct)}</em>
                      <p>
                        成交额 {formatValue(row.turnoverAmount)}｜近5日 {formatPct(row.fiveDayChangePct)}
                      </p>
                    </button>
                  ))}
                </div>
              ) : (
                <span className="muted-text">暂无同日行情快照</span>
              )}
            </section>

            <section>
              <small>待验证</small>
              {followups.length ? (
                <div className="observation-checklist">
                  {followups.slice(0, 4).map((item) => (
                    <div key={item.id}>
                      <span>□</span>
                      <strong>{item.subject}</strong>
                    </div>
                  ))}
                </div>
              ) : (
                <span className="muted-text">暂无直接待验证事项</span>
              )}
            </section>

            <section>
              <small>来源</small>
              {publishers.length ? (
                <div className="source-chip-list">
                  {publishers.map((name) => (
                    <button key={name} onClick={() => openEvidence(observation)}>
                      {name}
                    </button>
                  ))}
                </div>
              ) : (
                <span className="muted-text">暂无来源</span>
              )}
            </section>

            <section>
              <small>来源时间</small>
              <div className="source-time-list">
                <span>发生 {formatTime(sourceTimes.occurredAt)}</span>
                <span>发布 {formatTime(sourceTimes.publishedAt)}</span>
                <span>发现 {formatTime(sourceTimes.firstSeenAt)}</span>
                <span>抓取 {formatTime(sourceTimes.capturedAt)}</span>
              </div>
            </section>
          </div>

          <div className="related-observations">
            <small>相关 Observation</small>
            {relatedRows.length ? (
              <div>
                {relatedRows.map((row) => (
                  <button key={row.id} onClick={() => openEvidence(row)}>
                    <span>{row.date}</span>
                    <strong>{row.title}</strong>
                  </button>
                ))}
              </div>
            ) : (
              <span className="muted-text">暂无历史相似项</span>
            )}
          </div>

          <footer>
            <EvidenceBadge level={observation.evidenceLevel} />
            <button onClick={() => openEvidence(observation)}>查看证据</button>
          </footer>
        </div>
      ) : null}
    </article>
  );
}

function DataGapStrip({ setView }) {
  const totals = gaps.totals || {};

  return (
    <section className="data-gap-strip">
      <div>
        <span>数据缺口</span>
        <strong>{totals.companiesWithGaps || 0}</strong>
        <small>家公司仍需补资料</small>
      </div>
      <p>
        缺事件 {totals.missingEvents || 0} · 缺Follow-up {totals.missingFollowups || 0} · 缺来源{" "}
        {totals.missingSources || 0}
      </p>
      <button onClick={() => setView("database")}>查看清单</button>
    </section>
  );
}

const coverageFieldLabels = {
  product: "产品材料",
  officialSource: "官方来源",
  supplyChain: "供应链线索",
  customerOrder: "客户订单",
  financials: "财务兑现",
  marketSnapshot: "市场快照",
};

const coverageStatusLabels = {
  ok: "已覆盖",
  partial: "部分",
  missing: "缺失",
  not_listed: "非上市",
  not_applicable: "不适用",
};

const rangeOptions = [
  { label: "7天", value: 7 },
  { label: "30天", value: 30 },
  { label: "90天", value: 90 },
  { label: "180天", value: 180 },
  { label: "全部", value: "all" },
];

function inResearchRange(value, activeRange, latestDate) {
  if (activeRange === "all") return true;
  if (!value || !latestDate) return false;
  const latest = new Date(`${latestDate}T00:00:00+08:00`);
  const current = new Date(`${String(value).slice(0, 10)}T00:00:00+08:00`);
  const diffDays = (latest - current) / 86400000;
  return diffDays >= 0 && diffDays <= activeRange;
}

function groupResearchTimeline(rows = []) {
  const groups = new Map();
  rows.forEach((row) => {
    if (!groups.has(row.date)) groups.set(row.date, []);
    groups.get(row.date).push(row);
  });
  return Array.from(groups.entries())
    .map(([date, changes]) => ({
      date,
      changes: changes.slice().sort((a, b) => changeTimeValue(b) - changeTimeValue(a)),
    }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

function chartPath(rows, key, xOf, yOf) {
  return rows
    .map((row, index) => Number.isFinite(row[key]) ? `${index ? "L" : "M"}${xOf(index).toFixed(1)},${yOf(row[key]).toFixed(1)}` : "")
    .filter(Boolean)
    .join(" ");
}

function compactChartNumber(value) {
  if (!Number.isFinite(value)) return "--";
  const absolute = Math.abs(value);
  if (absolute >= 100000000) return `${(value / 100000000).toFixed(2).replace(/\.0+$/, "")}亿`;
  if (absolute >= 10000) return `${(value / 10000).toFixed(1).replace(/\.0$/, "")}万`;
  return String(Math.round(value));
}

function chartPrice(value) {
  if (!Number.isFinite(value)) return "--";
  return value >= 100 ? value.toFixed(1) : value.toFixed(2);
}

function spacedChartLabels(labels, top, bottom, gap = 19) {
  const sorted = labels
    .filter((item) => Number.isFinite(item.y))
    .sort((a, b) => a.y - b.y)
    .map((item) => ({ ...item, labelY: Math.max(top, Math.min(bottom, item.y)) }));
  for (let index = 1; index < sorted.length; index += 1) {
    sorted[index].labelY = Math.max(sorted[index].labelY, sorted[index - 1].labelY + gap);
  }
  if (sorted.at(-1)?.labelY > bottom) {
    const shift = sorted.at(-1).labelY - bottom;
    sorted.forEach((item) => { item.labelY -= shift; });
  }
  return sorted;
}

function PlainTrendPanel({ trend }) {
  const rows = trend?.chart || [];
  const reading = trend?.plainReading;
  const [selectedDate, setSelectedDate] = useState(null);
  const [isInspecting, setIsInspecting] = useState(false);
  if (!reading) return null;

  const width = 760;
  const plotLeft = 44;
  const plotRight = width - 8;
  const priceTop = 14;
  const priceBottom = 174;
  const volumeTop = 200;
  const volumeBottom = 238;
  const priceValues = rows.flatMap((row) => [row.close, row.average20, row.average60]).filter(Number.isFinite);
  const priceMin = priceValues.length ? Math.min(...priceValues) : 0;
  const priceMax = priceValues.length ? Math.max(...priceValues) : 1;
  const priceSpan = Math.max(priceMax - priceMin, Math.abs(priceMax || 1) * 0.04);
  const volumeMax = Math.max(...rows.map((row) => row.volume || 0), 1);
  const xOf = (index) => rows.length <= 1 ? plotLeft : plotLeft + (index / (rows.length - 1)) * (plotRight - plotLeft);
  const yOf = (value) => priceBottom - ((value - priceMin) / priceSpan) * (priceBottom - priceTop);
  const closePath = chartPath(rows, "close", xOf, yOf);
  const recentAveragePath = chartPath(rows, "average20", xOf, yOf);
  const longerAveragePath = chartPath(rows, "average60", xOf, yOf);
  const lastRow = rows.at(-1);
  const lastX = rows.length ? xOf(rows.length - 1) : 0;
  const lastY = lastRow?.close != null ? yOf(lastRow.close) : priceBottom;
  const selectedIndex = rows.findIndex((row) => row.date === selectedDate);
  const activeIndex = selectedDate && selectedIndex >= 0 ? selectedIndex : Math.max(0, rows.length - 1);
  const activeRow = rows[activeIndex] || lastRow;
  const activeX = rows.length ? xOf(activeIndex) : plotLeft;
  const dateTickIndexes = rows.length ? Array.from(new Set([0, Math.floor((rows.length - 1) / 2), rows.length - 1])) : [];
  const priceTicks = [priceMax, priceMin + priceSpan / 2, priceMin];
  const keyLevels = spacedChartLabels([
    { key: "current", label: "现价", value: reading.levels?.current, y: yOf(reading.levels?.current), className: "current" },
    { key: "watch", label: "关注", value: reading.levels?.recentAverage, y: yOf(reading.levels?.recentAverage), className: "watch" },
    { key: "risk", label: "看错", value: reading.levels?.recentLow, y: yOf(reading.levels?.recentLow), className: "risk" },
  ], priceTop + 8, priceBottom - 7);

  const selectFromPointer = (event) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (!rect.width || !rows.length) return;
    const viewX = ((event.clientX - rect.left) / rect.width) * width;
    const ratio = Math.max(0, Math.min(1, (viewX - plotLeft) / (plotRight - plotLeft)));
    const index = Math.round(ratio * (rows.length - 1));
    setSelectedDate(rows[index]?.date || null);
    setIsInspecting(true);
  };

  return (
    <section className="radar-trend-section">
      <div className="radar-section-heading radar-trend-heading">
        <div>
          <div className="radar-section-label">走势怎么理解</div>
          <span>系统先读取价格和成交，AI再用人话解释</span>
        </div>
        <strong>{reading.state}</strong>
      </div>
      <div className="radar-trend-layout">
        <div className="radar-trend-chart" aria-label="近期价格与成交走势">
          {rows.length ? (
            <>
              <div className="radar-trend-plot">
                <svg
                  viewBox={`0 0 ${width} 268`}
                  role="img"
                  tabIndex="0"
                  aria-label={`最近${rows.length}个交易日走势。鼠标移动或点按可查看具体数据。`}
                  onPointerDown={selectFromPointer}
                  onPointerMove={(event) => { if (event.pointerType === "mouse") selectFromPointer(event); }}
                  onPointerLeave={(event) => { if (event.pointerType === "mouse") setIsInspecting(false); }}
                  onKeyDown={(event) => {
                    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                    event.preventDefault();
                    const nextIndex = Math.max(0, Math.min(rows.length - 1, activeIndex + (event.key === "ArrowLeft" ? -1 : 1)));
                    setSelectedDate(rows[nextIndex]?.date || null);
                    setIsInspecting(true);
                  }}
                >
                  <defs>
                    <linearGradient id="trendAreaFill" x1="0" x2="0" y1="0" y2="1">
                      <stop offset="0%" stopColor="#1d1d1b" stopOpacity="0.12" />
                      <stop offset="100%" stopColor="#1d1d1b" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  {priceTicks.map((value) => (
                    <g className="trend-axis-tick" key={value}>
                      <line x1={plotLeft} x2={plotRight} y1={yOf(value)} y2={yOf(value)} />
                      <text x={plotLeft - 7} y={yOf(value) + 3}>{chartPrice(value)}</text>
                    </g>
                  ))}
                  <path d={`${closePath} L${lastX},${priceBottom} L${plotLeft},${priceBottom} Z`} fill="url(#trendAreaFill)" />
                  <path className="trend-average recent" d={recentAveragePath} />
                  <path className="trend-average longer" d={longerAveragePath} />
                  <path className="trend-price" d={closePath} />
                  {rows.map((row, index) => {
                    const barWidth = Math.max(2, (plotRight - plotLeft) / Math.max(rows.length, 1) - 2);
                    const height = ((row.volume || 0) / volumeMax) * (volumeBottom - volumeTop);
                    return (
                      <rect
                        key={`${row.date}_${index}`}
                        className="trend-volume"
                        x={Math.max(plotLeft, xOf(index) - barWidth / 2)}
                        y={volumeBottom - height}
                        width={barWidth}
                        height={Math.max(1, height)}
                      />
                    );
                  })}
                  {dateTickIndexes.map((index) => (
                    <text className="trend-date-tick" key={rows[index].date} x={xOf(index)} y="260">
                      {String(rows[index].date).slice(5)}
                    </text>
                  ))}
                  {keyLevels.map((level) => (
                    <g className={`trend-key-level ${level.className}`} key={level.key}>
                      <line x1={level.key === "risk" ? plotLeft : plotRight - 54} x2={plotRight} y1={level.y} y2={level.y} />
                      {Math.abs(level.labelY - level.y) > 2 ? <line className="connector" x1={plotRight - 8} x2={plotRight - 8} y1={level.y} y2={level.labelY} /> : null}
                      <text x={plotRight - 4} y={level.labelY + 3}>{level.label} {chartPrice(level.value)}</text>
                    </g>
                  ))}
                  <line className="trend-current-guide" x1={lastX} x2={lastX} y1={lastY} y2={volumeBottom} />
                  <circle className="trend-current-dot" cx={lastX} cy={lastY} r="5" />
                  {isInspecting && activeRow ? (
                    <g className="trend-inspection-points">
                      <line x1={activeX} x2={activeX} y1={priceTop} y2={volumeBottom} />
                      <circle className="price" cx={activeX} cy={yOf(activeRow.close)} r="4" />
                      {Number.isFinite(activeRow.average20) ? <circle className="recent" cx={activeX} cy={yOf(activeRow.average20)} r="3" /> : null}
                      {Number.isFinite(activeRow.average60) ? <circle className="longer" cx={activeX} cy={yOf(activeRow.average60)} r="3" /> : null}
                    </g>
                  ) : null}
                </svg>
                {isInspecting && activeRow ? (
                  <div
                    className={`trend-data-tip${activeX > width * 0.63 ? " align-left" : activeX < width * 0.37 ? " align-right" : ""}`}
                    style={{ left: `${(activeX / width) * 100}%` }}
                    aria-live="polite"
                  >
                    <strong>{activeRow.date}</strong>
                    <dl>
                      <div><dt>股价</dt><dd>{chartPrice(activeRow.close)}</dd></div>
                      <div><dt>近一个月平均成本</dt><dd>{chartPrice(activeRow.average20)}</dd></div>
                      <div><dt>更长时间平均成本</dt><dd>{chartPrice(activeRow.average60)}</dd></div>
                      <div><dt>成交量</dt><dd>{compactChartNumber(activeRow.volume)}股</dd></div>
                    </dl>
                  </div>
                ) : null}
              </div>
              <div className="radar-trend-legend">
                <span className="price">股价</span>
                <span className="recent">近一个月平均成本</span>
                <span className="longer">更长时间平均成本</span>
                <span className="volume">成交</span>
                <em>移动或点按看具体数据</em>
              </div>
            </>
          ) : <p>走势数据正在补齐，暂时不根据少量数据下结论。</p>}
        </div>
        <div className="radar-trend-reading">
          <div>
            <span>现在发生了什么</span>
            <p>{reading.what}</p>
          </div>
          <div>
            <span>这说明什么</span>
            <p>{reading.meaning}</p>
          </div>
          <div>
            <span>接下来怎么看</span>
            <p>{reading.watch}</p>
          </div>
          <div className="radar-trend-wrong">
            <span>什么情况说明看错了</span>
            <p>{reading.risk}</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function StockRadarDashboard({ openEvidence }) {
  const stockRows = useMemo(
    () =>
      (serenityOutputIndex.rows || [])
        .filter((row) => row.entityId && row.name && stockRadarOf(row))
        .sort((a, b) => {
          const aRadar = stockRadarOf(a);
          const bRadar = stockRadarOf(b);
          const aProfile = stockProfileOf(a);
          const bProfile = stockProfileOf(b);
          const aFocusRank = aProfile.userFocus ? 2 : aProfile.curatorPick ? 1 : 0;
          const bFocusRank = bProfile.userFocus ? 2 : bProfile.curatorPick ? 1 : 0;
          return (
            bFocusRank - aFocusRank ||
            (bRadar?.ai?.priorityScore || 0) - (aRadar?.ai?.priorityScore || 0) ||
            Math.abs(bRadar?.quote?.changePct || 0) - Math.abs(aRadar?.quote?.changePct || 0) ||
            String(b.generatedAt || "").localeCompare(String(a.generatedAt || ""))
          );
        }),
    []
  );
  const generatedCount = stockRows.length;
  const sectorOptions = useMemo(() => stockSectorDefinitions
    .map((option) => ({ ...option, count: stockRows.filter((row) => stockSectorOf(row) === option.id).length }))
    .filter((option) => option.count), [stockRows]);
  const [activeSector, setActiveSector] = useState(sectorOptions[0]?.id || "robotics");
  const [selectedId, setSelectedId] = useState(stockRows[0]?.entityId || null);
  const [searchTerm, setSearchTerm] = useState("");
  const [detailRowsByEntityId, setDetailRowsByEntityId] = useState({});
  const [detailErrorsByEntityId, setDetailErrorsByEntityId] = useState({});
  const [detailRetryToken, setDetailRetryToken] = useState(0);
  const [judgmentRowsByEntityId, setJudgmentRowsByEntityId] = useState({});
  const [judgmentLoadedByEntityId, setJudgmentLoadedByEntityId] = useState({});
  const [judgmentErrorsByEntityId, setJudgmentErrorsByEntityId] = useState({});
  const [judgmentRetryToken, setJudgmentRetryToken] = useState(0);
  const sectorRows = useMemo(
    () => stockRows.filter((row) => stockSectorOf(row) === activeSector),
    [stockRows, activeSector]
  );
  const deepAnalysisCount = sectorRows.filter(isCompleteSerenityAnalysis).length;
  const withheldCount = sectorRows.filter(isSerenityReviewOutcome).length;
  const userFocusCount = sectorRows.filter((row) => stockProfileOf(row).userFocus).length;
  const curatorPickCount = sectorRows.filter((row) => stockProfileOf(row).curatorPick).length;
  const activeSectorLabel = sectorOptions.find((option) => option.id === activeSector)?.label || stockSectorLabelOf(sectorRows[0]);
  const filteredRows = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    if (!keyword) return sectorRows;
    return sectorRows.filter((row) => {
      const radar = stockRadarOf(row);
      const profile = stockProfileOf(row);
      const haystack = [
        row.name,
        companyRoleOf(row),
        profile.industryRole,
        profile.roboticsRole,
        row.display?.summary,
        row.searchText,
        radar?.symbol,
        serenityActionOf(radar),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(keyword);
    });
  }, [sectorRows, searchTerm]);
  const selectedSummaryRow = filteredRows.find((row) => row.entityId === selectedId) || filteredRows[0] || null;
  const selectedEntityId = selectedSummaryRow?.entityId || null;
  const selectedRow = selectedEntityId ? detailRowsByEntityId[selectedEntityId] || null : null;
  const selectedDetailError = selectedEntityId ? detailErrorsByEntityId[selectedEntityId] || null : null;

  useEffect(() => {
    if (!selectedEntityId || detailRowsByEntityId[selectedEntityId]) return undefined;
    const loader = serenityOutputDetailLoaders[selectedEntityId];
    if (!loader) {
      setDetailErrorsByEntityId((current) => ({
        ...current,
        [selectedEntityId]: "未找到这支股票的分析详情。",
      }));
      return undefined;
    }

    let cancelled = false;
    setDetailErrorsByEntityId((current) => ({
      ...current,
      [selectedEntityId]: null,
    }));
    loader()
      .then((row) => {
        if (cancelled) return;
        setDetailRowsByEntityId((current) => ({
          ...current,
          [selectedEntityId]: row,
        }));
      })
      .catch(() => {
        if (cancelled) return;
        setDetailErrorsByEntityId((current) => ({
          ...current,
          [selectedEntityId]: "分析详情加载失败，请重试。",
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [selectedEntityId, detailRetryToken, detailRowsByEntityId]);

  useEffect(() => {
    if (!selectedEntityId || judgmentLoadedByEntityId[selectedEntityId]) return undefined;
    const loader = serenityJudgmentDetailLoaders[selectedEntityId];
    if (!loader) {
      setJudgmentLoadedByEntityId((current) => ({
        ...current,
        [selectedEntityId]: true,
      }));
      return undefined;
    }

    let cancelled = false;
    setJudgmentErrorsByEntityId((current) => ({
      ...current,
      [selectedEntityId]: null,
    }));
    loader()
      .then((history) => {
        if (cancelled) return;
        setJudgmentRowsByEntityId((current) => ({
          ...current,
          [selectedEntityId]: history,
        }));
        setJudgmentLoadedByEntityId((current) => ({
          ...current,
          [selectedEntityId]: true,
        }));
      })
      .catch(() => {
        if (cancelled) return;
        setJudgmentErrorsByEntityId((current) => ({
          ...current,
          [selectedEntityId]: "每日复盘加载失败，请重试。",
        }));
      });

    return () => {
      cancelled = true;
    };
  }, [selectedEntityId, judgmentRetryToken, judgmentLoadedByEntityId]);

  const selectedRadar = stockRadarOf(selectedRow);
  const selectedQuoteProjection = quoteProjectionOf(selectedRow);
  const selectedJudgmentLoaded = Boolean(
    selectedEntityId && judgmentLoadedByEntityId[selectedEntityId]
  );
  const selectedJudgmentHistory = selectedJudgmentLoaded
    ? judgmentRowsByEntityId[selectedEntityId] || null
    : null;
  const selectedJudgmentError = selectedEntityId
    ? judgmentErrorsByEntityId[selectedEntityId] || null
    : null;
  const selectedJudgmentSnapshot = selectedJudgmentHistory?.latest || null;
  const selectedProfile = stockProfileOf(selectedSummaryRow);
  const selectedRole = companyRoleOf(selectedSummaryRow);
  const selectedSector = stockSectorOf(selectedSummaryRow);
  const selectedDeepAnalysis = isCompleteSerenityAnalysis(selectedSummaryRow);
  const selectedOutcome = isSerenityReviewOutcome(selectedSummaryRow);
  const selectedEvidenceItems = selectedRow ? decisionEvidenceItems(selectedRow) : [];
  const selectedStage = selectedRow ? researchStageOf(selectedRow) : 0;
  const selectedDailyReview = selectedRow
    ? dailyReviewOf(selectedJudgmentHistory, selectedRadar, stockRows)
    : null;
  const selectedDailyWatchItems = selectedRow
    ? dailyWatchItems(selectedJudgmentHistory, selectedRadar, selectedStage)
    : [];
  const selectedEffectCounts = selectedEvidenceItems.reduce(
    (counts, item) => ({ ...counts, [item.effect]: counts[item.effect] + 1 }),
    { support: 0, against: 0, unknown: 0 }
  );
  const generatedAt = selectedRadar?.generatedAt
    || stockRadarOf(selectedSummaryRow)?.generatedAt
    || serenityOutputIndex.generatedAt
    || dashboardMeta.generatedAt;
  const stockListItems = filteredRows.map((row) => {
    const radar = stockRadarOf(row);
    const profile = stockProfileOf(row);
    return {
      id: row.id,
      entityId: row.entityId,
      name: row.name,
      role: companyRoleOf(row),
      symbol: radar?.symbol,
      active: selectedSummaryRow?.entityId === row.entityId,
      pending: !radar,
      selectionLabel: stockSelectionLabel(row),
      userFocus: Boolean(profile.userFocus),
      changeClass: changeClass(radar?.quote?.changePct),
      changeText: formatPct(radar?.quote?.changePct),
      priceText: serenityField(radar?.quote?.price, "--"),
      turnoverText: serenityTurnoverText(radar?.quote),
      verdictLabel: isCompleteSerenityAnalysis(row)
        ? "深研判断"
        : isSerenityReviewOutcome(row)
          ? "证据不足"
          : "初筛判断",
      action: serenityActionOf(radar),
    };
  });

  return (
    <div className="stock-radar-page">
      <StockRadarToolbar
        activeSector={activeSector}
        onSearchChange={setSearchTerm}
        onSectorChange={setActiveSector}
        searchTerm={searchTerm}
        sectorOptions={sectorOptions}
      />

      {filteredRows.length ? (
        <section className="stock-radar-layout">
          <div className="radar-list-pane">
            <StockRadarList items={stockListItems} onSelect={setSelectedId} />
            <StockRadarHero
              activeSectorLabel={activeSectorLabel}
              curatorPickCount={curatorPickCount}
              deepAnalysisCount={deepAnalysisCount}
              latestTime={compactTime(generatedAt)}
              sectorCount={sectorRows.length}
              userFocusCount={userFocusCount}
              withheldCount={withheldCount}
            />
          </div>

          <aside className="stock-radar-detail">
            {selectedRow && selectedRadar ? (
              <>
                <header className="radar-detail-head">
                  <div>
                    <div className="radar-detail-title">
                      <h3>{selectedRow.name}</h3>
                      <span>{selectedRadar.symbol}</span>
                    </div>
                    {selectedRole ? <p className="radar-company-role">{selectedRole}</p> : null}
                  </div>
                  <small>模拟训练 · 不真实下单</small>
                </header>

                {!selectedOutcome && selectedProfile.curatorPick && selectedProfile.selectionReason ? (
                  <div className="radar-selection-note">
                    <strong>为什么建议关注</strong>
                    <span>{selectedProfile.selectionReason}</span>
                  </div>
                ) : null}

                <section className="radar-decision-card">
                  <div className="radar-section-label">当前判断</div>
                  <div className="radar-decision-line">
                    <strong>{serenityActionOf(selectedRadar)}</strong>
                    <div className="radar-decision-tags">
                      <span>行动状态 · {serenityReadinessOf(selectedRadar)}</span>
                      <span>可信度 · {readableConfidence(selectedRadar)}</span>
                    </div>
                  </div>
                  <p>
                    {selectedOutcome
                      ? selectedRadar.review?.reason || selectedRow.display?.summary
                      : selectedRadar.ai?.decisionReason || currentReasonOf(selectedRow, selectedEvidenceItems)}
                  </p>
                  {!selectedOutcome ? (
                    <div className="radar-next-action">
                      <span>下一步</span>
                      <strong>{serenityNextActionOf(selectedRadar)}</strong>
                    </div>
                  ) : null}
                  {hasSerenityNumber(selectedRadar.ai?.companyScore) ? (
                    <div className="radar-decision-scores" aria-label="Serenity 买入分级">
                      <span><small>公司</small><b>{Math.round(selectedRadar.ai.companyScore)}</b></span>
                      <span><small>证据</small><b>{Math.round(selectedRadar.ai.evidenceScore)}</b></span>
                      <span><small>价格</small><b>{Math.round(selectedRadar.ai.valuationScore)}</b></span>
                      <span><small>时机</small><b>{Math.round(selectedRadar.ai.timingScore)}</b></span>
                    </div>
                  ) : null}
                  <StockRadarQuoteSummary
                    analysisQuote={selectedQuoteProjection.analysisQuote}
                    displayQuote={selectedQuoteProjection.displayQuote}
                    judgmentDate={selectedJudgmentSnapshot?.date}
                    judgmentPrice={selectedJudgmentSnapshot?.price}
                    quoteStatus={selectedQuoteProjection.quoteStatus}
                  />
                  <div className="radar-effect-summary" aria-label="判断依据数量">
                    <span className="support">{selectedEffectCounts.support} 支撑</span>
                    <span className="against">{selectedEffectCounts.against} 反方</span>
                    {selectedEffectCounts.unknown ? <span>{selectedEffectCounts.unknown} 待验证</span> : null}
                  </div>
                </section>

                <PlainTrendPanel trend={selectedRadar.trend} />

                <section className="radar-evidence-section">
                  {selectedOutcome ? (
                    <>
                      <div className="radar-section-heading">
                        <div className="radar-section-label">为什么暂不判断</div>
                      </div>
                      <div className="radar-evidence-grid" aria-label="Serenity 待补证据">
                        <article className="radar-evidence-brief">
                          <header><span>未完成深研</span><b className="unknown">待补</b></header>
                          <h4>正式数据已取到，但还没有逐份阅读正文</h4>
                          <div className="radar-evidence-body">
                            <div>
                              <span>必须补齐</span>
                              <p>{(selectedRadar.review?.requiredEvidence || []).join("；")}</p>
                            </div>
                            <div>
                              <span>完成标准</span>
                              <p>每条个股事实都要绑定原文、日期和来源，并解释它如何支持或削弱结论。</p>
                            </div>
                          </div>
                        </article>
                      </div>
                      <small className="radar-source-line">未完成前不展示个股判断、买点或每日验证</small>
                    </>
                  ) : (
                    <>
                      <div className="radar-section-heading">
                        <div className="radar-section-label">为什么这样判断</div>
                        <span>{selectedEffectCounts.support} 支撑 · {selectedEffectCounts.against} 削弱</span>
                      </div>
                      <div className="radar-evidence-grid" aria-label="Serenity 判断依据">
                        {selectedEvidenceItems.map((item, index) => (
                          <article className="radar-evidence-brief" key={`${item.category}_${item.fact}`}>
                            <header>
                              <span>{String(index + 1).padStart(2, "0")} · {evidenceCategoryLabels[item.category] || "关键依据"}</span>
                              <b className={item.effect}>
                                {item.effect === "support" ? "支撑" : item.effect === "against" ? "削弱" : "待验"}
                              </b>
                            </header>
                            <h4>{item.summary || "这条事实回答什么"}</h4>
                            {evidenceSignals(item).length ? (
                              <div className="radar-evidence-signals">
                                {evidenceSignals(item).map((signal) => <span key={signal}>{signal}</span>)}
                              </div>
                            ) : null}
                            <div className="radar-evidence-body">
                              <div className="radar-evidence-impact">
                                <span>所以</span>
                                <p>{item.reason}</p>
                              </div>
                              <div className="radar-evidence-fact">
                                <span>原文</span>
                                <p>{item.fact}</p>
                              </div>
                              {item.sourceRefs?.length ? (
                                <div className="radar-evidence-sources">
                                  {item.sourceRefs.map((sourceRef) =>
                                    /^https?:\/\//u.test(sourceRef) ? (
                                      <a href={sourceRef} target="_blank" rel="noreferrer" key={sourceRef}>查看原文</a>
                                    ) : (
                                      <span key={sourceRef}>{sourceRef === "price_history_adjusted" ? "复权行情数据" : "正式披露"}</span>
                                    )
                                  )}
                                </div>
                              ) : null}
                              </div>
                          </article>
                        ))}
                      </div>
                      <small className="radar-source-line">
                        {selectedDeepAnalysis ? selectedRow.display?.inputState || "已完成 Serenity 深研校验" : "来自 Serenity 正式评分卡"}
                      </small>
                    </>
                  )}
                </section>

                {!selectedOutcome ? <section className="radar-pattern-section">
                  {sectorLogicLabels[selectedSector] ? (
                    <>
                      <div className="radar-section-label">判断要看哪条链</div>
                      <div className="radar-stage-flow sector-logic-flow" role="list" aria-label={`${activeSectorLabel}判断顺序`}>
                        {sectorLogicLabels[selectedSector].map((label, index, labels) => (
                          <div role="listitem" key={label} className="radar-stage-flow-step future">
                            <strong>{label}</strong>
                            {index < labels.length - 1 ? <i aria-hidden="true">→</i> : null}
                          </div>
                        ))}
                      </div>
                      <p><b>看法：</b>前面的变化最终要落到利润和现金流，否则只算线索，不算兑现。</p>
                    </>
                  ) : (
                    <>
                      <div className="radar-section-label">业务走到哪一步</div>
                      <div className="radar-stage-flow" role="list" aria-label={`当前处于${researchStageLabels[selectedStage]}阶段`}>
                        {researchStageLabels.map((label, index) => (
                          <div
                            role="listitem"
                            key={label}
                            className={`radar-stage-flow-step ${index === selectedStage ? "active" : index < selectedStage ? "passed" : "future"}`}
                          >
                            {index < selectedStage ? <span>✓ {label}</span> : index === selectedStage ? <strong>当前：{label}</strong> : <span>{label}</span>}
                            {index < researchStageLabels.length - 1 ? <i aria-hidden="true">→</i> : null}
                          </div>
                        ))}
                      </div>
                      <div className="radar-stage-reading">
                        <div><span>现在</span><strong>{stageNowText(selectedStage)}</strong></div>
                        <div><span>缺口</span><strong>{stageGapText(selectedStage)}</strong></div>
                        <div><span>下一步</span><strong>{stageNextText(selectedStage)}</strong></div>
                      </div>
                      <p><b>当前规律：</b>{researchLesson(selectedStage)}</p>
                    </>
                  )}
                </section> : null}

                {!selectedOutcome ? (
                  selectedJudgmentError ? (
                    <section className="radar-validation-section radar-daily-review">
                      <EmptyState>
                        <span>{selectedJudgmentError}</span>
                        <button
                          type="button"
                          onClick={() => setJudgmentRetryToken((value) => value + 1)}
                        >
                          重新加载每日复盘
                        </button>
                      </EmptyState>
                    </section>
                  ) : !selectedJudgmentLoaded ? (
                    <section className="radar-validation-section radar-daily-review">
                      <EmptyState>正在加载每日复盘…</EmptyState>
                    </section>
                  ) : (
                    <StockRadarDailyReview
                      effectCounts={selectedEffectCounts}
                      review={selectedDailyReview}
                      watchItems={selectedDailyWatchItems}
                    />
                  )
                ) : null}
              </>
            ) : selectedSummaryRow ? (
              <EmptyState>
                {selectedDetailError ? (
                  <>
                    <span>{selectedDetailError}</span>
                    <button
                      type="button"
                      onClick={() => setDetailRetryToken((value) => value + 1)}
                    >
                      重新加载
                    </button>
                  </>
                ) : (
                  <span>正在加载 {selectedSummaryRow.name} 的分析详情…</span>
                )}
              </EmptyState>
            ) : (
              <EmptyState>暂无 Serenity 股票判断</EmptyState>
            )}
          </aside>
        </section>
      ) : (
        <section className="stock-radar-empty">
          <strong>没有符合条件的股票</strong>
          <span>换一个股票名称、代码或公司业务关键词。</span>
        </section>
      )}
    </div>
  );
}

function ResearchDashboard({ openCompany, openEvidence }) {
  const rows = researchReading.rows || [];
  const externalSerenityOutputs = useMemo(
    () => (serenityOutputIndex.rows || []).filter(isSerenityAiReview),
    []
  );
  const serenityOutputByEntityId = useMemo(
    () => new Map(externalSerenityOutputs.map((row) => [row.entityId, row])),
    [externalSerenityOutputs]
  );
  const [selectedEntityId, setSelectedEntityId] = useState(rows[0]?.entityId || null);
  const [selectedChangeId, setSelectedChangeId] = useState(null);
  const [activeRange, setActiveRange] = useState(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const [verificationExpanded, setVerificationExpanded] = useState(false);
  const latestDate = researchReading.date || dashboardMeta.date;

  const filteredRows = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    return rows.filter((row) => {
      const timeline = row.timeline || [];
      const hasRangeMatch = timeline.length
        ? timeline.some((change) => inResearchRange(change.date, activeRange, latestDate))
        : true;
      if (!hasRangeMatch) return false;
      if (!keyword) return true;
      const haystack = [
        row.name,
        row.profile?.role,
        row.profile?.listedStatus,
        row.researchSummary?.summary,
        row.whyWatch?.join(" "),
        row.researchSummary?.newFacts?.join(" "),
        row.researchSummary?.missingEvidence?.join(" "),
        row.marketContext?.observedCompanies?.map((item) => `${item.name} ${item.role} ${item.reason}`).join(" "),
        timeline.map((change) => `${change.title} ${change.changeLabel} ${change.nextQuestion}`).join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(keyword);
    });
  }, [activeRange, latestDate, rows, searchTerm]);

  const selectedReading = filteredRows.length
    ? filteredRows.find((row) => row.entityId === selectedEntityId) || filteredRows[0]
    : null;
  const selectedSerenityOutput = selectedReading ? serenityOutputByEntityId.get(selectedReading.entityId) : null;
  const selectedSerenityEvidencePoint =
    selectedSerenityOutput?.display?.analysisSections?.find((section) => section.title === "依据")?.items?.[0] || "";
  const selectedTimeline = useMemo(() => {
    if (!selectedReading) return [];
    return (selectedReading.timeline || []).filter((change) => inResearchRange(change.date, activeRange, latestDate));
  }, [activeRange, latestDate, selectedReading]);
  const timelineRows = selectedTimeline.length ? selectedTimeline : selectedReading?.timeline || [];
  const timelineGroups = useMemo(() => groupResearchTimeline(timelineRows), [timelineRows]);
  const defaultSelectedChange =
    timelineRows.find((change) => change.lane !== "market") ||
    timelineRows[0] ||
    selectedReading?.timeline?.find((change) => change.lane !== "market") ||
    selectedReading?.timeline?.[0] ||
    null;
  const selectedChange =
    timelineRows.find((change) => change.id === selectedChangeId) || defaultSelectedChange;
  const systemStatus = researchReading.systemStatus || {};
  const marketContext = selectedReading?.marketContext || {};
  const observedCompanies = marketContext.observedCompanies || [];
  const coverageEntries = Object.entries(coverageFieldLabels);
  const observationOnly = selectedReading ? (selectedReading.counts?.nonMarketChangeCount || 0) === 0 : false;
  const whyWatchItems = observationOnly ? [] : (selectedReading?.whyWatch || []).slice(0, 3);
  const summaryFactCells = observationOnly
    ? [
        { label: "研究材料", value: "暂无" },
        { label: "已有", value: selectedReading?.researchSummary?.knownEvidence?.join("、") || "市场快照" },
        { label: "等待", value: "公开材料、订单、客户、交付或财务披露" },
      ]
    : [
        { label: "新增", value: selectedReading?.researchSummary?.newFacts?.join("、") || "暂无新增非行情事实" },
        { label: "已验证", value: selectedReading?.researchSummary?.verifiedEvidence?.filter((item) => item !== "市场快照").join("、") || "暂无" },
        {
          label: "待补",
          value:
            [
              ...(selectedReading?.researchSummary?.signalEvidence || []).slice(0, 2),
              ...(selectedReading?.researchSummary?.missingEvidence || []).slice(0, 2).map((item) => `缺${item}`),
            ].join("、") || "暂无关键缺口",
        },
      ];
  const nextVerificationRows = selectedReading?.nextVerifications || [];
  const visibleNextVerifications = verificationExpanded
    ? nextVerificationRows
    : nextVerificationRows.slice(0, 3);
  const marketTone = marketContext.tone || marketContext.mode || "snapshot";

  const openChangeEvidence = (change) => {
    openEvidence({
      title: change.title,
      fact: change.change,
      date: change.date,
      module: change.changeLabel || laneLabel(change.lane),
      evidenceLevel: change.evidenceSummary?.level || "--",
      entityNames: change.entityNames,
      sources: change.sources || [],
      evidenceSummary: change.evidenceSummary || null,
    });
  };

  const selectChange = (change) => {
    setSelectedChangeId(change.id);
    setDetailOpen(true);
  };

  return (
    <div className="change-wall-page research-reading-page">
      <section className="terminal-strip">
        <div className="terminal-title">
          <strong>研究阅读</strong>
          <span>{selectedReading ? `${selectedReading.name} · ${selectedReading.counts?.changeCount || 0} 个变化` : "暂无匹配对象"}</span>
        </div>
        <div className="change-search">
          <Search size={16} />
          <input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="搜索公司 / 角色 / 事实 / 缺口"
            aria-label="搜索研究对象"
          />
        </div>

        <div className="range-tabs">
          {rangeOptions.map((option) => (
            <button
              key={option.label}
              className={activeRange === option.value ? "active" : ""}
              onClick={() => setActiveRange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <section className="research-status-strip" aria-label="数据更新">
        <span>
          数据更新：<strong>{systemStatus.healthLabel || "正常"}</strong>
        </span>
        <span>
          待审核 <strong>{systemStatus.pendingReview ?? 0}</strong>
        </span>
        <span>
          复查任务 <strong>{systemStatus.dueReviewTasks ?? 0}</strong>
        </span>
        <span>
          最新生成 <strong>{compactTime(systemStatus.generatedAt || researchReading.generatedAt)}</strong>
        </span>
      </section>

      {externalSerenityOutputs.length ? (
        <section className="serenity-alert-strip" aria-label="Serenity 分析">
          <div>
            <span>Serenity 看法已生成</span>
            <strong>{externalSerenityOutputs[0].name}</strong>
            <small>{externalSerenityOutputs[0].display?.view || externalSerenityOutputs[0].display?.summary}</small>
          </div>
          <button
            type="button"
            onClick={() => {
              setSelectedEntityId(externalSerenityOutputs[0].entityId);
              setSelectedChangeId(null);
              setDetailOpen(false);
              setVerificationExpanded(false);
            }}
          >
            查看
          </button>
        </section>
      ) : null}

      {selectedReading ? (
        <section className="research-reading-layout">
          <aside className="entity-rail" aria-label="研究对象">
            <div className="entity-rail-list">
              {filteredRows.length ? (
                filteredRows.map((row) => (
                  <button
                    key={row.entityId}
                    className={selectedReading.entityId === row.entityId ? "active" : ""}
                    onClick={() => {
                      setSelectedEntityId(row.entityId);
                      setSelectedChangeId(null);
                      setDetailOpen(false);
                      setVerificationExpanded(false);
                    }}
                  >
                    <strong>{row.name}</strong>
                    <span>
                      {row.profile?.role || "观察对象"} / {row.counts?.changeCount || 0} 个变化
                    </span>
                    <em>{row.researchState?.label || "观察中"}</em>
                    <small>{row.counts?.recent30DayChangeCount ?? row.counts?.changeCount ?? 0}</small>
                  </button>
                ))
              ) : (
                <EmptyState>暂无匹配对象</EmptyState>
              )}
            </div>
          </aside>

          <div className="research-reading-workspace">
            <header className="entity-timeline-head reading-entity-head">
              <div>
                <span>当前研究对象</span>
                <h2>{selectedReading.name}</h2>
                <p className="entity-profile-line">
                  {selectedReading.profile?.role || "观察对象"}｜{selectedReading.profile?.listedStatus || "--"}｜近30天{" "}
                  {selectedReading.counts?.recent30DayChangeCount || 0} 个变化
                </p>
              </div>
              <div>
                <span>{selectedReading.researchState?.label || "观察中"}</span>
                <span>{selectedReading.marketContext?.modeLabel || "市场背景"}</span>
                {selectedReading.profile?.ticker ? <span>{selectedReading.profile.ticker}</span> : null}
              </div>
            </header>

            <section className="reading-section current-summary-section">
              <header>
                <span>Current Research Summary</span>
                <strong>当前研究摘要</strong>
              </header>
              <p className="reading-summary-text">{selectedReading.researchSummary?.summary || "暂无研究摘要。"}</p>
              <div className="summary-fact-grid">
                {summaryFactCells.map((item) => (
                  <div key={item.label}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                  </div>
                ))}
              </div>
            </section>

            {selectedSerenityOutput ? (
              <section className="reading-section serenity-analysis-section">
                <header>
                  <span>Serenity Analysis</span>
                  <strong>Serenity 分析</strong>
                </header>
                <div className="serenity-analysis-card">
                  <div>
                    <span>{selectedSerenityOutput.display?.viewLabel || "Serenity 看法"}</span>
                    <strong>{selectedSerenityOutput.display?.view || selectedSerenityOutput.display?.summary}</strong>
                    {selectedSerenityEvidencePoint ? <small>依据：{selectedSerenityEvidencePoint}</small> : null}
                    <small>验证：{selectedSerenityOutput.display?.toVerify?.[0] || "等待新材料"}</small>
                  </div>
                  <button type="button" onClick={() => openEvidence(buildSerenityOutputEvidence(selectedSerenityOutput))}>
                    看依据
                  </button>
                </div>
              </section>
            ) : null}

            <div className="reading-section-grid">
              <section className="reading-section">
                <header>
                  <span>Why Watch</span>
                  <strong>为什么进入观察</strong>
                </header>
                <div className="fact-list">
                  {whyWatchItems.length ? (
                    whyWatchItems.map((item) => <span key={item}>{item}</span>)
                  ) : (
                    <div className="soft-empty-state">
                      <strong>暂无事实触发原因</strong>
                      <span>
                        {observationOnly
                          ? "当前仅有市场快照，尚未进入研究材料跟踪。"
                          : "等待官方材料、订单、客户或交付证据进入证据链。"}
                      </span>
                    </div>
                  )}
                </div>
              </section>

              <section className="reading-section">
                <header>
                  <span>Evidence Coverage</span>
                  <strong>证据覆盖</strong>
                </header>
                <div className="coverage-grid">
                  {coverageEntries.map(([key, label]) => {
                    const status = selectedReading.evidenceCoverage?.[key] || "missing";
                    const detail = selectedReading.evidenceCoverageDetails?.[key];
                    return (
                      <div key={key} className={`coverage-chip coverage-${status}`}>
                        <span>{label}</span>
                        <strong>{detail?.label || coverageStatusLabels[status] || status}</strong>
                        {detail?.note ? <small>{detail.note}</small> : null}
                      </div>
                    );
                  })}
                </div>
              </section>
            </div>

            <section className="reading-section">
              <header>
                <span>Next Verification</span>
                <strong>下一步验证</strong>
              </header>
              <div className="next-verification-list">
                {nextVerificationRows.length ? (
                  visibleNextVerifications.map((item) => (
                    <button
                      key={item.id}
                      onClick={() =>
                        openEvidence({
                          title: item.subject,
                          fact: item.subject,
                          module: item.probeType || "下一步验证",
                          date: item.dueAt || researchReading.date,
                          entityNames: item.entityNames,
                          sources: [],
                        })
                      }
                    >
                      <span>{item.dueAt || "--"}</span>
                      <strong>{item.subject}</strong>
                      <small>{statusLabel(item.status)}</small>
                    </button>
                  ))
                ) : (
                  <div className="soft-empty-state">
                    <strong>当前没有待验证项</strong>
                    <span>后续出现订单、客户、交付或财务材料时会进入这里。</span>
                  </div>
                )}
              </div>
              {nextVerificationRows.length > 3 ? (
                <button
                  type="button"
                  className="verification-toggle"
                  onClick={() => setVerificationExpanded((value) => !value)}
                >
                  {verificationExpanded ? "收起" : `查看全部 ${nextVerificationRows.length} 项`}
                </button>
              ) : null}
            </section>

            <section className="reading-section timeline-reading-section">
              <header>
                <span>Timeline</span>
                <strong>详细时间线</strong>
              </header>
              <div className="reading-timeline">
                {timelineGroups.length ? (
                  timelineGroups.map((group) => (
                    <section className="reading-time-node" key={group.date}>
                      <header className="entity-node-date">
                        <strong>{datePart(group.date)}</strong>
                        <span>{group.date}</span>
                        <small>{group.changes.length} 个变化</small>
                      </header>
                      <div className="change-card-stack">
                        {group.changes.map((change) => {
                          const readingCard = change.readingCard || {};
                          return (
                            <button
                              key={change.id}
                              className={`change-card reading-change-card ${selectedChange?.id === change.id ? "active" : ""}`}
                              onClick={() => selectChange(change)}
                            >
                              <span className="change-card-dot" />
                              <small className="change-card-type">
                                {readingCard.meta ||
                                  `${change.changeLabel || laneLabel(change.lane)} · ${change.evidenceSummary?.level || "--"}级 · ${
                                    change.verificationLabel || "--"
                                  }`}
                              </small>
                              <b>{readingCard.title || compactChangeTitle(change.title)}</b>
                              <footer>
                                <span>{readingCard.next || `下一步：${change.nextQuestion || "继续跟踪公开材料"}`}</span>
                              </footer>
                            </button>
                          );
                        })}
                      </div>
                    </section>
                  ))
                ) : (
                  <div className="soft-empty-state">
                    <strong>{observationOnly ? "暂无研究材料" : "当前时间范围无变化"}</strong>
                    <span>{observationOnly ? "等待公开材料进入证据链。" : "切换时间范围可以查看历史材料。"}</span>
                  </div>
                )}
              </div>
            </section>
          </div>

          <aside className={`entity-market-panel reading-market-panel market-mode-${marketTone}`}>
            <header>
              <strong>市场背景</strong>
              <span className="market-mode-pill">{marketContext.modeLabel || marketContext.subtitle || "观察池市场快照"}</span>
              {marketContext.modeDescription || marketContext.disclaimer ? (
                <p>{marketContext.modeDescription || marketContext.disclaimer}</p>
              ) : null}
            </header>

            <div className="observed-company-list">
              {observedCompanies.length ? (
                observedCompanies.map((item, index) => (
                  <button key={item.entityId || item.name} onClick={() => item.entityId && openCompany(item.entityId)}>
                    <span>{index + 1}</span>
                    <div>
                      <strong>{item.name}</strong>
                      <small>角色：{item.role || "观察对象"}</small>
                      <em>出现原因：{item.reason}</em>
                      <p>{item.marketContext}</p>
                    </div>
                    <b className={changeClass(item.marketChangePct)}>{formatPct(item.marketChangePct)}</b>
                  </button>
                ))
              ) : (
                <div className="soft-empty-state">
                  <strong>暂无市场背景</strong>
                  <span>当前仅展示研究材料，不补充市场快照。</span>
                </div>
              )}
            </div>
          </aside>

          {detailOpen ? (
            <aside className="change-detail-panel" aria-label="变化详情">
              <button className="detail-close" onClick={() => setDetailOpen(false)} aria-label="收起详情">
                <X size={15} />
              </button>
              {selectedChange ? (
                <>
                  <span className="detail-kicker">{selectedChange.date} · {laneLabel(selectedChange.lane)}</span>
                  <h3>{selectedChange.objectName}</h3>
                  <small className="detail-type">{selectedChange.changeLabel || laneLabel(selectedChange.lane)}</small>
                  <strong>{selectedChange.title}</strong>
                  <div className="detail-meta-grid">
                    <div>
                      <span>证据</span>
                      <b>{selectedChange.evidenceSummary?.level || "--"}级</b>
                    </div>
                    <div>
                      <span>状态</span>
                      <b>{selectedChange.verificationLabel || "--"}</b>
                    </div>
                    <div>
                      <span>时间</span>
                      <b>{formatTime(selectedChange.time)}</b>
                    </div>
                    <div>
                      <span>来源</span>
                      <b>{selectedChange.evidenceSummary?.sourceLabel || "--"}</b>
                    </div>
                  </div>
                  {selectedChange.sources?.length ? (
                    <section>
                      <small>来源</small>
                      <div className="detail-source-list">
                        {selectedChange.sources.slice(0, 3).map((source) => (
                          <a key={source.id || source.url} href={source.url} target="_blank" rel="noreferrer">
                            <span>{source.publisher || source.sourceType || "来源"}</span>
                            <strong>{source.title}</strong>
                          </a>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  <section>
                    <small>下一步验证</small>
                    <div className="detail-check-list">
                      <span>{selectedChange.nextQuestion || "继续跟踪后续公开材料。"}</span>
                    </div>
                  </section>
                  {selectedChange.entityNames?.length ? (
                    <section>
                      <small>对象</small>
                      <div className="object-pill-list">
                        {selectedChange.entityNames.map((name) => (
                          <span key={name}>{name}</span>
                        ))}
                      </div>
                    </section>
                  ) : null}
                  <footer>
                    <button onClick={() => openChangeEvidence(selectedChange)}>查看证据</button>
                    {selectedChange.entityIds?.[0] ? (
                      <button onClick={() => openCompany(selectedChange.entityIds[0])}>打开对象</button>
                    ) : null}
                  </footer>
                </>
              ) : (
                <EmptyState>暂无可选变化</EmptyState>
              )}
            </aside>
          ) : null}
        </section>
      ) : (
        <section className="reading-empty-shell">
          <strong>{rows.length ? "没有匹配对象" : "暂无研究阅读数据"}</strong>
          <span>{rows.length ? "调整搜索词或时间范围后再试。" : "请先生成 Research Reading 数据。"}</span>
        </section>
      )}

      <footer className="change-wall-footnote">
        <span>{formatTime(researchReading.generatedAt)}</span>
      </footer>
    </div>
  );
}

function Dashboard({ setView, openCompany, openEvidence }) {
  const rows = changeWall.rows || [];
  const timelineRows = changeWall.timelineDates || [];
  const laneRows = changeWall.lanes || [];
  const [selectedEntityId, setSelectedEntityId] = useState(null);
  const [selectedChangeId, setSelectedChangeId] = useState(rows[0]?.id || null);
  const [activeRange, setActiveRange] = useState(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const latestDate = timelineRows[0]?.date || rows[0]?.date || changeWall.date;
  const rangeOptions = [
    { label: "7天", value: 7 },
    { label: "30天", value: 30 },
    { label: "90天", value: 90 },
    { label: "180天", value: 180 },
    { label: "全部", value: "all" },
  ];
  const entityProfiles = useMemo(() => {
    const byId = new Map();
    const byName = new Map();
    (entityProfilesData.rows || []).forEach((profile) => {
      if (profile.entityId || profile.id) byId.set(profile.entityId || profile.id, profile);
      if (profile.name) byName.set(profile.name, profile);
    });
    return { byId, byName };
  }, []);
  const marketContextByEntityId = useMemo(() => {
    return new Map((marketContextsData.rows || []).map((context) => [context.entityId, context]));
  }, []);
  const acquisitionByEntityId = useMemo(() => {
    return new Map((dataAcquisitionMatrixData.rows || []).map((row) => [row.entityId, row]));
  }, []);
  const gateByEntityId = useMemo(() => {
    return new Map((researchGatesData.rows || []).map((row) => [row.entityId, row]));
  }, []);
  const candidateByEntityId = useMemo(() => {
    return new Map((candidateFunnelData.candidateRows || []).map((row) => [row.entityId, row]));
  }, []);

  const filteredRows = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    const latest = latestDate ? new Date(`${latestDate}T00:00:00`) : null;

    return rows.filter((row) => {
      if (activeRange !== "all" && latest && row.date) {
        const current = new Date(`${row.date}T00:00:00`);
        const diffDays = (latest - current) / 86400000;
        if (diffDays > activeRange) return false;
      }
      if (!keyword) return true;
      const haystack = [
        row.objectName,
        row.title,
        row.change,
        row.entityNames?.join(" "),
        row.sources?.map((source) => `${source.title} ${source.publisher}`).join(" "),
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return haystack.includes(keyword);
    });
  }, [activeRange, latestDate, rows, searchTerm]);

  const entityRows = useMemo(() => {
    const entityMap = new Map();

    filteredRows.forEach((change) => {
      changeEntityIds(change).forEach((entityId) => {
        const entityNameIndex = change.entityIds?.indexOf(entityId) ?? -1;
        const nameFromChange =
          entityNameIndex >= 0 ? change.entityNames?.[entityNameIndex] : change.objectId === entityId ? change.objectName : "";
        if (!entityMap.has(entityId)) {
          const profile = entityProfiles.byId.get(entityId);
          entityMap.set(entityId, {
            id: entityId,
            name: profile?.name || nameFromChange || change.objectName || entityId,
            profile,
            changes: [],
            dates: new Set(),
            laneCounts: {},
            marketRowsById: new Map(),
          });
        }

        const entity = entityMap.get(entityId);
        const profile = entityProfiles.byId.get(entityId);
        if (profile) {
          entity.name = profile.name;
          entity.profile = profile;
        }
        entity.changes.push(change);
        if (change.date) entity.dates.add(change.date);
        entity.laneCounts[change.lane] = (entity.laneCounts[change.lane] || 0) + 1;

        (change.marketContext || []).forEach((row) => {
          if (row.entityId === entityId || change.objectId === entityId) {
            entity.marketRowsById.set(row.id || row.entityId, row);
          }
        });
      });
    });

    return Array.from(entityMap.values())
      .map((entity) => {
        const changes = entity.changes.slice().sort((a, b) => changeTimeValue(b) - changeTimeValue(a));
        const latestTime = changes.reduce((max, change) => Math.max(max, changeTimeValue(change)), 0);
        const nonMarketCount = changes.filter((change) => change.lane !== "market").length;
        return {
          ...entity,
          changes,
          dates: Array.from(entity.dates).sort((a, b) => String(b).localeCompare(String(a))),
          latestTime,
          nonMarketCount,
          total: changes.length,
          marketRows: Array.from(entity.marketRowsById.values()),
        };
      })
      .sort((a, b) => {
        if (b.nonMarketCount !== a.nonMarketCount) return b.nonMarketCount - a.nonMarketCount;
        if (b.total !== a.total) return b.total - a.total;
        return b.latestTime - a.latestTime;
      });
  }, [entityProfiles, filteredRows]);

  const selectedEntity = entityRows.find((entity) => entity.id === selectedEntityId) || entityRows[0] || null;
  const selectedProfile = selectedEntity?.profile;
  const selectedGate = selectedEntity ? gateByEntityId.get(selectedEntity.id) : null;
  const selectedAcquisition = selectedEntity ? acquisitionByEntityId.get(selectedEntity.id) : null;
  const selectedCandidate = selectedEntity ? candidateByEntityId.get(selectedEntity.id) : null;
  const selectedReviewRows = selectedEntity
    ? (reviewCycleData.rows || [])
        .filter((row) => row.entityIds?.includes(selectedEntity.id))
        .slice(0, 5)
    : (reviewCycleData.rows || []).slice(0, 5);
  const selectedEntityChanges = selectedEntity?.changes || [];
  const selectedTimelineGroups = useMemo(() => {
    const groups = new Map();
    selectedEntityChanges.forEach((change) => {
      if (!groups.has(change.date)) groups.set(change.date, []);
      groups.get(change.date).push(change);
    });
    return Array.from(groups.entries())
      .map(([date, changes]) => ({
        date,
        changes: changes.slice().sort((a, b) => changeTimeValue(b) - changeTimeValue(a)),
      }))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)));
  }, [selectedEntityChanges]);
  const selectedChange =
    selectedEntityChanges.find((row) => row.id === selectedChangeId) || selectedEntityChanges[0] || filteredRows[0] || null;
  const relatedSameDay = rows
    .filter((row) => row.date === selectedChange?.date && row.id !== selectedChange?.id)
    .slice(0, 3);
  const entityNameProfile = (name) => entityProfiles.byName.get(name);
  const marketPanel = marketContextByEntityId.get(selectedEntity?.id) || {
    mode: "watchlist_snapshot",
    title: "观察池市场快照",
    relatedToSelectedEntity: false,
    sortBy: "latestChangePctDesc",
    disclaimer: "按最新涨跌幅排序，不表示与当前对象或当前事件存在因果关系。",
    items: [],
  };
  const marketPanelItems = marketPanel.items || [];
  const marketPanelSubtitle =
    marketPanel.subtitle ||
    (marketPanel.mode === "entity_market"
      ? `${selectedProfile?.industryRole || "当前对象"} · ${marketPanelItems.length} 条行情`
      : marketPanel.mode === "evidence_linked_market"
        ? `${marketPanelItems.length} 个对象 · 有证据连接`
        : `Watchlist · ${marketPanelItems.length} 条行情`);
  const marketGainers = marketPanelItems.filter((item) => (item.changePct || 0) > 0).length;
  const marketFallers = marketPanelItems.filter((item) => (item.changePct || 0) < 0).length;
  const keyChanges = selectedEntityChanges.filter((row) => row.lane !== "market").slice(0, 3);
  const keyChangeRows = keyChanges.length ? keyChanges : selectedEntityChanges.slice(0, 4);
  const gateRows = researchGatesData.rows || [];
  const gateCounts = gateRows.reduce((acc, row) => {
    acc[row.gate] = (acc[row.gate] || 0) + 1;
    return acc;
  }, {});
  const acquisitionRows = dataAcquisitionMatrixData.rows || [];
  const acquisitionBlocked = acquisitionRows.filter((row) => row.acquisitionState === "has_blockers").length;
  const acquisitionPartial = acquisitionRows.filter((row) => row.acquisitionState === "partial").length;
  const funnelLayers = candidateFunnelData.layerRows || [];
  const funnelShortlist = candidateFunnelData.shortlist || [];
  const reviewSummary = reviewCycleData.summary || {};
  const dueReviewCount = reviewSummary.due || 0;

  const selectChange = (change, entityId) => {
    setSelectedChangeId(change.id);
    const nextEntityId = entityId || changeEntityIds(change)[0];
    if (nextEntityId) setSelectedEntityId(nextEntityId);
    setDetailOpen(true);
  };

  const openChangeEvidence = (change) => {
    const evidenceRows = change.evidence || [];
    openEvidence({
      title: change.title,
      fact: change.change,
      date: change.date,
      module: change.lane,
      evidenceLevel: changeEvidenceLevel(change),
      entityNames: change.entityNames,
      sources: change.sources || [],
      evidenceSummary: change.evidenceSummary || (evidenceRows.length
        ? {
            claimCount: change.sourceType === "claim" ? 1 : 0,
            evidenceCount: evidenceRows.length,
            strongestSourceLevel: changeEvidenceLevel(change),
          }
        : null),
    });
  };

  return (
    <div className="change-wall-page">
      <section className="terminal-strip">
        <div className="terminal-title">
          <strong>实体时间轴</strong>
          <span>{selectedEntity ? `${selectedEntity.name} · ${selectedEntity.total} 个变化` : changeWall.date}</span>
        </div>
        <div className="change-search">
          <Search size={16} />
          <input
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="搜索公司 / 产品 / 事件 / 股票"
            aria-label="搜索变化"
          />
        </div>

        <div className="range-tabs">
          {rangeOptions.map((option) => (
            <button
              key={option.label}
              className={activeRange === option.value ? "active" : ""}
              onClick={() => setActiveRange(option.value)}
            >
              {option.label}
            </button>
          ))}
        </div>
      </section>

      <section className="research-command-panel">
        <header>
          <div>
            <span>Research Loop</span>
            <strong>研究闭环</strong>
          </div>
          <p>先看数据是否够、对象在哪一层、能否进入研究复核，再看时间线变化。</p>
        </header>

        <div className="research-command-grid">
          <div className="research-command-card">
            <span>数据矩阵</span>
            <strong>{acquisitionRows.length}</strong>
            <small>{acquisitionPartial} 个部分数据 · {acquisitionBlocked} 个阻断</small>
          </div>
          <div className="research-command-card">
            <span>候选漏斗</span>
            <strong>{funnelShortlist.length}</strong>
            <small>{funnelLayers.length} 个产业层级 · shortlist</small>
          </div>
          <div className="research-command-card">
            <span>研究门禁</span>
            <strong>{gateCounts.READY_FOR_REVIEW || 0}</strong>
            <small>{gateCounts.DATA_GATED || 0} 数据门禁 · {gateCounts.EVIDENCE_GATED || 0} 证据门禁</small>
          </div>
          <div className="research-command-card">
            <span>复查任务</span>
            <strong>{dueReviewCount}</strong>
            <small>{reviewSummary.total || 0} 个任务 · 已到期</small>
          </div>
        </div>

        <div className="layer-command-row">
          {funnelLayers.slice(0, 6).map((layer) => (
            <button key={layer.layerId} className="layer-command-chip">
              <strong>{layer.label}</strong>
              <span>{layer.entityCount} 对象 · {layer.readyCount} 可复核</span>
              <em>瓶颈 {layer.bottleneckRank}/10</em>
            </button>
          ))}
        </div>
      </section>

      {rows.length ? (
        <section className="change-terminal-layout entity-terminal-layout">
          <aside className="entity-rail" aria-label="研究对象">
            <div className="entity-rail-list">
              {entityRows.length ? (
                entityRows.map((entity) => {
                  const gate = gateByEntityId.get(entity.id);
                  const candidate = candidateByEntityId.get(entity.id);
                  return (
                    <button
                      key={entity.id}
                      className={selectedEntity?.id === entity.id ? "active" : ""}
                      onClick={() => {
                        setSelectedEntityId(entity.id);
                        if (entity.changes[0]) setSelectedChangeId(entity.changes[0].id);
                        setDetailOpen(false);
                      }}
                    >
                      <strong>{entity.name}</strong>
                      <span>
                        {candidate?.layerLabel || entity.profile?.line || "观察对象"} / {entity.total} 个变化
                      </span>
                      <em>{gate?.gateLabel || entity.profile?.gap || `${entity.dates.length} 个节点`}</em>
                      <small>{entity.total}</small>
                    </button>
                  );
                })
              ) : (
                <EmptyState>暂无匹配对象</EmptyState>
              )}
            </div>
          </aside>

          <div className="entity-timeline-workspace">
            {selectedEntity ? (
              <>
                <header className="entity-timeline-head">
                  <div>
                    <span>研究对象</span>
                    <h2>{selectedEntity.name}</h2>
                    {selectedProfile ? (
                      <p className="entity-profile-line">
                        {selectedProfile.line} · {selectedProfile.reason} · {selectedProfile.gap}
                      </p>
                    ) : null}
                  </div>
                  <div>
                    <span>{selectedEntity.total} 个变化</span>
                    <span>{selectedEntity.dates.length} 个时间节点</span>
                    <span>{selectedGate?.gateLabel || selectedProfile?.evidenceState || "待补定位"}</span>
                  </div>
                </header>

                <section className="research-readiness-strip">
                  <div className={`research-gate-card ${gateTone(selectedGate?.gate)}`}>
                    <span>研究门禁</span>
                    <strong>{selectedGate?.gateLabel || "未生成"}</strong>
                    <small>{selectedGate?.nextEvidence || selectedCandidate?.nextEvidence || "继续跟踪公开材料"}</small>
                  </div>
                  <div className="research-funnel-card">
                    <span>产业层级</span>
                    <strong>{selectedCandidate?.layerLabel || selectedProfile?.industryRole || "观察对象"}</strong>
                    <small>{selectedCandidate?.stage || "watch_only"} · 优先级 {selectedCandidate?.priorityScore ?? "--"}</small>
                  </div>
                  <div className="data-status-row">
                    {(selectedAcquisition?.datasets || []).slice(0, 5).map((item) => (
                      <span key={item.id} className={`data-status-chip ${acquisitionTone(item.status)}`}>
                        <b>{item.label}</b>
                        <em>{item.statusLabel}</em>
                      </span>
                    ))}
                  </div>
                </section>

                <div className="entity-timeline-grid">
                  <div className="entity-node-stack">
                    {selectedTimelineGroups.length ? (
                      selectedTimelineGroups.map((group) => (
                        <section className="entity-time-node" key={group.date}>
                          <header className="entity-node-date">
                            <strong>{datePart(group.date)}</strong>
                            <span>{group.date}</span>
                            <small>{group.changes.length} 个变化</small>
                          </header>

                          <div className="entity-node-lanes">
                            {laneRows.map((lane) => {
                              const laneChanges = group.changes.filter((change) => change.lane === lane.id);
                              if (!laneChanges.length) return null;

                              return (
                                <section className={`entity-node-lane lane-tone-${lane.id}`} key={`${group.date}_${lane.id}`}>
                                  <div className="entity-lane-title">
                                    <span className={`lane-dot lane-${lane.id}`} />
                                    <strong>{laneShortLabel(lane.id)}</strong>
                                  </div>

                                  <div className="change-card-stack">
                                    {laneChanges.map((change) => {
                                      const marketRow = firstMarketRow(change);
                                      const verifyText = verificationLine(change);
                                      return (
                                        <button
                                          key={change.id}
                                          className={`change-card ${selectedChange?.id === change.id ? "active" : ""}`}
                                          onClick={() => selectChange(change, selectedEntity.id)}
                                        >
                                          <span className="change-card-dot" />
                                          <strong>{change.objectName}</strong>
                                          <small className="change-card-type">{changeTypeLabel(change)}</small>
                                          <b>{compactChangeTitle(change.title)}</b>
                                          {change.lane === "market" && marketRow ? (
                                            <div className="change-stock-snapshot">
                                              <em className={changeClass(marketRow.changePct)}>{formatPct(marketRow.changePct)}</em>
                                              <MiniSparkline value={marketRow.changePct} />
                                            </div>
                                          ) : null}
                                          <footer>
                                            <span>
                                              {compactTime(change.time)} · {changeEvidenceLevel(change)}级 ·{" "}
                                              {changeStatusText(change)}
                                            </span>
                                            {verifyText ? <span>{verifyText}</span> : null}
                                          </footer>
                                        </button>
                                      );
                                    })}
                                  </div>
                                </section>
                              );
                            })}
                          </div>
                        </section>
                      ))
                    ) : (
                      <EmptyState>当前时间范围内暂无对象变化</EmptyState>
                    )}
                  </div>

                  <aside className="entity-market-panel">
                    <header>
                      <strong>{marketPanel.title}</strong>
                      <span>{marketPanelSubtitle}</span>
                      {marketPanel.disclaimer ? <p>{marketPanel.disclaimer}</p> : null}
                    </header>

                    <div className="market-top-list entity-market-list">
                      {marketPanelItems.length ? (
                        marketPanelItems.map((item, index) => {
                          return (
                            <button key={item.entityId || item.name} onClick={() => openCompany(item.entityId)}>
                              <span>{index + 1}</span>
                              <strong>{item.name}</strong>
                              <small>
                                {item.industryRole || "Watchlist"} · {item.ticker || "--"}
                              </small>
                              {item.linkReason ? <em>{item.linkReason}</em> : null}
                              <MiniSparkline value={item.changePct} />
                              <b className={changeClass(item.changePct)}>{formatPct(item.changePct)}</b>
                            </button>
                          );
                        })
                      ) : (
                        <EmptyState>暂无行情</EmptyState>
                      )}
                    </div>
                  </aside>
                </div>
              </>
            ) : (
              <EmptyState>当前时间范围内暂无匹配对象</EmptyState>
            )}
          </div>

          {detailOpen ? (
          <aside className="change-detail-panel" aria-label="变化详情">
            <button className="detail-close" onClick={() => setDetailOpen(false)} aria-label="收起详情">
              <X size={15} />
            </button>
            {selectedChange ? (
              <>
                <span className="detail-kicker">{selectedChange.date} · {laneLabel(selectedChange.lane)}</span>
                <h3>{selectedChange.objectName}</h3>
                <small className="detail-type">{changeTypeLabel(selectedChange)}</small>
                <strong>{selectedChange.title}</strong>
                <div className="detail-meta-grid">
                  <div>
                    <span>证据</span>
                    <b>{changeEvidenceLevel(selectedChange)}级</b>
                  </div>
                  <div>
                    <span>状态</span>
                    <b>{changeStatusText(selectedChange)}</b>
                  </div>
                  <div>
                    <span>时间</span>
                    <b>{formatTime(selectedChange.time)}</b>
                  </div>
                  <div>
                    <span>来源</span>
                    <b>{changeSourceSummary(selectedChange)}</b>
                  </div>
                </div>
                {selectedChange.sources?.length ? (
                  <section>
                    <small>来源</small>
                    <div className="detail-source-list">
                      {selectedChange.sources.slice(0, 3).map((source) => (
                        <a key={source.id || source.url} href={source.url} target="_blank" rel="noreferrer">
                          <span>{source.publisher || source.sourceType || "来源"}</span>
                          <strong>{source.title}</strong>
                        </a>
                      ))}
                    </div>
                  </section>
                ) : null}
                {selectedChange.marketContext?.length ? (
                  <section>
                    <small>市场上下文</small>
                    <div className="detail-stock-list">
                      {selectedChange.marketContext.slice(0, 3).map((row) => {
                        const profile = entityProfiles.byId.get(row?.entityId) || entityProfiles.byName.get(row?.company);
                        return (
                          <button key={row.id || row.entityId} onClick={() => openCompany(row.entityId)}>
                            <span>
                              {row.company} · {profile?.role || "Watchlist"}
                            </span>
                            <b className={changeClass(row.changePct)}>{formatPct(row.changePct)}</b>
                            <small>
                              {stockCodeText(row)} · 成交额 {formatValue(row.turnoverAmount)}
                            </small>
                          </button>
                        );
                      })}
                    </div>
                  </section>
                ) : null}
                {verificationLine(selectedChange) ? (
                  <section>
                    <small>下一步验证</small>
                    <div className="detail-check-list">
                      <span>{verificationLine(selectedChange)}</span>
                    </div>
                  </section>
                ) : null}
                {selectedChange.verificationItems?.length ? (
                  <section>
                    <small>待验证</small>
                    <div className="detail-check-list">
                      {selectedChange.verificationItems.slice(0, 4).map((item) => (
                        <span key={item.id}>{item.subject}</span>
                      ))}
                    </div>
                  </section>
                ) : null}
                {selectedChange.entityNames?.length ? (
                  <section>
                    <small>对象</small>
                    <div className="object-pill-list">
                      {selectedChange.entityNames.map((name) => {
                        const profile = entityNameProfile(name);
                        return <span key={name}>{profile ? `${name} · ${profile.role}` : name}</span>;
                      })}
                    </div>
                  </section>
                ) : null}
                {relatedSameDay.length ? (
                  <section>
                    <small>同日</small>
                    <div className="related-day-list">
                      {relatedSameDay.map((row) => (
                        <button key={row.id} onClick={() => selectChange(row)}>
                          <span>{datePart(row.date)} · {laneLabel(row.lane)}</span>
                          <strong>{row.title}</strong>
                        </button>
                      ))}
                    </div>
                  </section>
                ) : null}
                <footer>
                  <button onClick={() => openChangeEvidence(selectedChange)}>查看证据</button>
                  {selectedChange.entityIds?.[0] ? (
                    <button onClick={() => openCompany(selectedChange.entityIds[0])}>打开对象</button>
                  ) : null}
                </footer>
              </>
            ) : (
              <EmptyState>暂无可选变化</EmptyState>
            )}
          </aside>
          ) : null}
        </section>
      ) : (
        <EmptyState>暂无可展示变化。请先生成 Change Wall 数据。</EmptyState>
      )}

      <section className="change-bottom-grid terminal-bottom">
        <div className="change-mini-panel">
          <header>
            <strong>对象变化</strong>
            <span>{selectedEntity?.name || "--"}</span>
          </header>
          <div className="key-change-list">
            {keyChangeRows.length ? (
              keyChangeRows.map((change) => (
                <button key={change.id} onClick={() => selectChange(change)}>
                  <span>{changeTypeLabel(change)}</span>
                  <strong>{compactChangeTitle(change.title)}</strong>
                  <small>
                    {changeEvidenceLevel(change)}级 · {changeStatusText(change)} · {compactTime(change.time)}
                  </small>
                </button>
              ))
            ) : (
              <EmptyState>当前筛选无关键变化</EmptyState>
            )}
          </div>
        </div>

        <div className="change-mini-panel market-overview-panel">
          <header>
            <strong>{marketPanel.title}</strong>
            <span>{marketPanel.mode === "watchlist_snapshot" ? "非因果快照" : "有对象依据"}</span>
          </header>
          <div className="market-stat-grid">
            <OverviewItem label="样本" value={marketPanelItems.length || 0} />
            <OverviewItem label="涨" value={marketGainers} />
            <OverviewItem label="跌" value={marketFallers} />
            <OverviewItem label="更新" value={datePart(market.generatedAt || market.date)} />
          </div>
          <div className="market-top-list">
            {marketPanelItems.map((item, index) => {
              return (
                <button key={item.entityId || item.name} onClick={() => openCompany(item.entityId)}>
                  <span>{index + 1}</span>
                  <strong>{item.name}</strong>
                  <small>
                    {item.industryRole || "Watchlist"} · {item.ticker || "--"}
                  </small>
                  {item.linkReason ? <em>{item.linkReason}</em> : null}
                  <MiniSparkline value={item.changePct} />
                  <b className={changeClass(item.changePct)}>{formatPct(item.changePct)}</b>
                </button>
              );
            })}
          </div>
        </div>

        <div className="change-mini-panel">
          <header>
            <strong>复查任务 · {selectedReviewRows.length}</strong>
            <span>{selectedEntity?.name || "全部对象"}</span>
          </header>
          <div className="verify-list">
            {selectedReviewRows.length ? (
              selectedReviewRows.map((item) => (
                <button
                  key={item.id}
                  onClick={() =>
                    openEvidence({
                      title: item.subject,
                      fact: item.subject,
                      module: item.probeType || "复查任务",
                      date: item.dueAt || reviewCycleData.date,
                      entityNames: item.entityNames,
                      sources: item.sources || [],
                    })
                  }
                >
                  <span>{item.entityNames?.join(" / ") || "未绑定对象"}</span>
                  <strong>{item.subject}</strong>
                  <small>{item.dueAt || "--"} · {statusLabel(item.status)}</small>
                </button>
              ))
            ) : (
              <EmptyState>暂无复查任务</EmptyState>
            )}
          </div>
        </div>
      </section>

      <footer className="change-wall-footnote">
        <span>{formatTime(changeWall.generatedAt)}</span>
      </footer>
    </div>
  );
}

function DetailShell({ title, meta, children }) {
  return (
    <section className="detail-shell">
      <header>
        <div>
          <span>{meta}</span>
          <h2>{title}</h2>
        </div>
      </header>
      {children}
    </section>
  );
}

function EvidenceDrawer({ evidence, onClose }) {
  if (!evidence) return null;
  const sources = evidence.sources || [];
  const claims = evidence.claims || [];
  const evidenceSummary = evidence.evidenceSummary || null;
  const briefSections = evidence.briefSections || [];
  const evidenceLevelLabel = evidence.evidenceLevelLabel || `${evidence.evidenceLevel || "--"}级来源`;
  const drawerLabel = evidence.isAnalysis ? "分析" : "证据";

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside
        className={`evidence-drawer${evidence.isAnalysis ? " analysis-drawer" : ""}`}
        onClick={(event) => event.stopPropagation()}
      >
        <header>
          <div>
            <span>{drawerLabel}</span>
            <h2>{evidence.title || evidence.fact || "来源"}</h2>
          </div>
          <button onClick={onClose} aria-label="关闭证据抽屉">
            <X size={18} />
          </button>
        </header>

        <p className="drawer-fact">{evidence.fact || evidence.title || "--"}</p>

        <div className="drawer-meta">
          <span>{evidence.date || dashboardMeta.date}</span>
          <span>{evidence.module || "--"}</span>
          <span>{evidenceLevelLabel}</span>
          {evidence.entityNames?.length ? <span>{evidence.entityNames.join(" / ")}</span> : null}
        </div>

        {briefSections.length ? (
          <div className="drawer-brief">
            {briefSections
              .filter((section) => section?.body || section?.items?.length)
              .map((section) => (
                <section key={section.title}>
                  <h3>{section.title}</h3>
                  {section.body ? <p>{section.body}</p> : null}
                  {section.items?.length ? (
                    <ol>
                      {section.items.slice(0, 4).map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ol>
                  ) : null}
                </section>
              ))}
          </div>
        ) : null}

        {evidenceSummary ? (
          <div className="drawer-evidence-summary">
            <p>
              <span>Claim</span>
              <strong>{evidenceSummary.claimCount || 0}</strong>
            </p>
            <p>
              <span>Evidence</span>
              <strong>{evidenceSummary.evidenceCount || 0}</strong>
            </p>
            <p>
              <span>最高来源</span>
              <strong>{evidenceSummary.strongestSourceLevel || "--"}级</strong>
            </p>
          </div>
        ) : null}

        {claims.length ? (
          <div className="drawer-claims">
            <h3>Claims</h3>
            {claims.map((claim) => (
              <div key={claim.id}>
                <span>
                  {claim.claimType} · {claim.status} · {claim.confidence}
                </span>
                <strong>{claim.normalizedFact || claim.text}</strong>
                <small>
                  发布 {formatTime(claim.publishedAt)}｜发现 {formatTime(claim.firstSeenAt)}｜处理{" "}
                  {formatTime(claim.processedAt)}
                </small>
              </div>
            ))}
          </div>
        ) : null}

        {evidence.hideSources ? null : (
          <div className="drawer-sources">
            {sources.length ? (
              sources.map((source) => (
                <a key={source.id || source.url} href={source.url} target="_blank" rel="noreferrer">
                  <span>{source.publisher || sourceTypeLabels[source.sourceType] || "来源"}</span>
                  <strong>{source.title}</strong>
                  <ArrowUpRight size={14} />
                </a>
              ))
            ) : (
              <EmptyState>暂无来源链接</EmptyState>
            )}
          </div>
        )}
      </aside>
    </div>
  );
}

export default function App() {
  const [activeView, setActiveView] = useState("dashboard");
  const [selectedCompanyId, setSelectedCompanyId] = useState(null);
  const [evidence, setEvidence] = useState(null);

  const openCompany = (companyId) => {
    setSelectedCompanyId(companyId);
    setActiveView("companies");
  };

  const content = useMemo(() => {
    const shared = {
      setView: setActiveView,
      openCompany,
      openEvidence: setEvidence,
    };

    switch (activeView) {
      case "companies":
        return (
          <Suspense
            fallback={
              <DetailShell title="公司" meta={dashboardMeta.date}>
                <EmptyState>正在加载公司页面…</EmptyState>
              </DetailShell>
            }
          >
            <CompanyPage
              openCompany={openCompany}
              openEvidence={setEvidence}
              selectedCompanyId={selectedCompanyId}
              setSelectedCompanyId={setSelectedCompanyId}
            />
          </Suspense>
        );
      case "market":
        return (
          <Suspense
            fallback={
              <DetailShell title="市场" meta={dashboardMeta.date}>
                <EmptyState>正在加载市场页面…</EmptyState>
              </DetailShell>
            }
          >
            <MarketPage openCompany={openCompany} openEvidence={setEvidence} />
          </Suspense>
        );
      case "timeline":
        return (
          <Suspense
            fallback={
              <DetailShell title="时间轴" meta={dashboardMeta.date}>
                <EmptyState>正在加载时间轴…</EmptyState>
              </DetailShell>
            }
          >
            <TimelinePage openEvidence={setEvidence} />
          </Suspense>
        );
      case "database":
        return (
          <Suspense
            fallback={
              <DetailShell title="数据库" meta={dashboardMeta.date}>
                <EmptyState>正在加载数据库…</EmptyState>
              </DetailShell>
            }
          >
            <DatabasePage
              openEvidence={setEvidence}
            />
          </Suspense>
        );
      default:
        return <StockRadarDashboard {...shared} />;
    }
  }, [activeView, selectedCompanyId]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <h1>Serenity 股票雷达</h1>
        </div>
        <div className="topbar-meta">
          <span>{dashboardMeta.date}</span>
        </div>
      </header>

      <nav className="nav-strip" aria-label="主导航">
        {navItems.map((item) => (
          <button
            key={item.id}
            className={activeView === item.id ? "active" : ""}
            onClick={() => setActiveView(item.id)}
          >
            {item.label}
          </button>
        ))}
      </nav>

      <main>{content}</main>
      <EvidenceDrawer evidence={evidence} onClose={() => setEvidence(null)} />
    </div>
  );
}
