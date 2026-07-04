import { useMemo, useState } from "react";
import {
  ArrowUpRight,
  Boxes,
  BriefcaseBusiness,
  Building2,
  CalendarDays,
  ChartNoAxesCombined,
  Grid3X3,
  Landmark,
  Network,
  Search,
  X,
} from "lucide-react";

import companies from "@data/dashboard/companies.json";
import changeWall from "@data/dashboard/change_wall.json";
import eventDashboard from "@data/dashboard/events.json";
import followup from "@data/dashboard/followup.json";
import freshness from "@data/dashboard/freshness.json";
import gaps from "@data/dashboard/gaps.json";
import market from "@data/dashboard/market.json";
import observations from "@data/dashboard/observations.json";
import relations from "@data/dashboard/relations.json";
import serenityBridge from "@data/dashboard/serenity_bridge.json";
import sourceRegistry from "@data/dashboard/sources.json";
import stats from "@data/dashboard/stats.json";
import timeline from "@data/dashboard/timeline.json";
import today from "@data/dashboard/today.json";
import upcoming from "@data/dashboard/upcoming.json";
import windowSummary from "@data/dashboard/window_summary.json";

const navItems = [
  { id: "dashboard", label: "首页" },
  { id: "companies", label: "公司" },
  { id: "market", label: "市场" },
  { id: "timeline", label: "时间轴" },
  { id: "database", label: "数据库" },
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
  return `${row.stockCode}${row.market ? ` · ${row.market}` : ""}`;
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

function LaneIcon({ lane, size = 16 }) {
  const props = { size, strokeWidth: 2 };
  if (lane === "product") return <Boxes {...props} />;
  if (lane === "company") return <Building2 {...props} />;
  if (lane === "supply_chain") return <Network {...props} />;
  if (lane === "policy") return <Landmark {...props} />;
  if (lane === "market") return <ChartNoAxesCombined {...props} />;
  return <BriefcaseBusiness {...props} />;
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

function buildEvidenceFromSource(source) {
  return {
    title: source.title,
    fact: source.title,
    evidenceLevel: source.evidenceLevel,
    module: source.sourceType,
    date: source.publishedAt || source.capturedAt || today.date,
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

function Dashboard({ setView, openCompany, openEvidence }) {
  const rows = changeWall.rows || [];
  const timelineRows = changeWall.timelineDates || [];
  const laneRows = changeWall.lanes || [];
  const marketChanges = changeWall.marketChanges || [];
  const verificationRows = changeWall.verificationQueue || [];
  const [selectedDate, setSelectedDate] = useState(timelineRows[0]?.date || rows[0]?.date || changeWall.date);
  const [selectedChangeId, setSelectedChangeId] = useState(rows[0]?.id || null);
  const [activeLane, setActiveLane] = useState("all");
  const [activeRange, setActiveRange] = useState(30);
  const [searchTerm, setSearchTerm] = useState("");
  const [detailOpen, setDetailOpen] = useState(false);
  const latestDate = timelineRows[0]?.date || rows[0]?.date || changeWall.date;
  const laneFilterRows = [{ id: "all", label: "全部", count: rows.length }, ...laneRows];
  const rangeOptions = [
    { label: "7天", value: 7 },
    { label: "30天", value: 30 },
    { label: "90天", value: 90 },
    { label: "180天", value: 180 },
    { label: "全部", value: "all" },
  ];

  const filteredRows = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    const latest = latestDate ? new Date(`${latestDate}T00:00:00`) : null;

    return rows.filter((row) => {
      if (activeLane !== "all" && row.lane !== activeLane) return false;
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
  }, [activeLane, activeRange, latestDate, rows, searchTerm]);

  const dateRows = useMemo(() => {
    const timelineDates = timelineRows.length
      ? timelineRows.map((row) => row.date)
      : Array.from(new Set(rows.map((row) => row.date).filter(Boolean)));
    return timelineDates
      .map((date) => {
        const changes = filteredRows.filter((row) => row.date === date);
        return { date, total: changes.length };
      })
      .filter((row) => row.total > 0 || !searchTerm.trim())
      .slice(0, 12);
  }, [filteredRows, rows, searchTerm, timelineRows]);

  const activeDate = dateRows.some((row) => row.date === selectedDate) ? selectedDate : dateRows[0]?.date || selectedDate;
  const selectedDateChanges = filteredRows.filter((row) => row.date === activeDate);
  const selectedLaneIds = new Set(selectedDateChanges.map((row) => row.lane));
  const visibleLaneRows =
    activeLane === "all" ? laneRows.filter((lane) => selectedLaneIds.has(lane.id)) : laneRows.filter((lane) => lane.id === activeLane);
  const selectedChange =
    filteredRows.find((row) => row.id === selectedChangeId) || selectedDateChanges[0] || filteredRows[0] || null;
  const relatedSameDay = rows
    .filter((row) => row.date === selectedChange?.date && row.id !== selectedChange?.id)
    .slice(0, 3);
  const selectedMarketChanges = selectedDateChanges.filter((row) => row.lane === "market");
  const selectedMarketRows = selectedMarketChanges.map(firstMarketRow).filter(Boolean);
  const allMarketRows = (market.rows || []).length ? market.rows : marketChanges.map(firstMarketRow).filter(Boolean);
  const marketRowsForOverview = selectedMarketRows.length ? selectedMarketRows : allMarketRows;
  const topMarketRows = marketRowsForOverview
    .slice()
    .sort((a, b) => (b.changePct || 0) - (a.changePct || 0))
    .slice(0, 5);
  const marketGainers = marketRowsForOverview.filter((row) => (row.changePct || 0) > 0).length;
  const marketFallers = marketRowsForOverview.filter((row) => (row.changePct || 0) < 0).length;
  const keyChanges = selectedDateChanges.filter((row) => row.lane !== "market").slice(0, 3);
  const keyChangeRows = keyChanges.length ? keyChanges : selectedDateChanges.slice(0, 4);

  const selectChange = (change) => {
    setSelectedChangeId(change.id);
    if (change.date) setSelectedDate(change.date);
    setDetailOpen(true);
  };

  const openChangeEvidence = (change) => {
    const evidenceRows = change.evidence || [];
    openEvidence({
      title: change.title,
      fact: change.change,
      date: change.date,
      module: change.lane,
      evidenceLevel: change.evidenceLevel,
      entityNames: change.entityNames,
      sources: change.sources || [],
      evidenceSummary: evidenceRows.length
        ? {
            claimCount: change.sourceType === "claim" ? 1 : 0,
            evidenceCount: evidenceRows.length,
            strongestSourceLevel: change.evidenceLevel,
          }
        : null,
    });
  };

  return (
    <div className="change-wall-page">
      <section className="terminal-strip">
        <div className="terminal-title">
          <strong>时间轴</strong>
          <span>{activeDate || changeWall.date}</span>
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
          <button aria-label="回到今天" onClick={() => setSelectedDate(dateRows[0]?.date || latestDate)}>
            <CalendarDays size={15} />
          </button>
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

        <div className="lane-tabs">
          {laneFilterRows.map((lane) => (
            <button
              key={lane.id}
              className={activeLane === lane.id ? "active" : ""}
              onClick={() => setActiveLane(lane.id)}
            >
              {lane.id === "all" ? <Grid3X3 size={14} /> : <LaneIcon lane={lane.id} size={14} />}
              {lane.id === "all" ? lane.label : laneShortLabel(lane.id)}
            </button>
          ))}
        </div>
      </section>

      {rows.length ? (
        <section className="change-terminal-layout">
          <aside className="date-rail" aria-label="日期轴">
            <div className="date-rail-line">
              {dateRows.length ? (
                dateRows.map((dateRow) => (
                  <button
                    key={dateRow.date}
                    className={activeDate === dateRow.date ? "active" : ""}
                    onClick={() => {
                      setSelectedDate(dateRow.date);
                      const first = filteredRows.find((row) => row.date === dateRow.date);
                      if (first) setSelectedChangeId(first.id);
                      setDetailOpen(false);
                    }}
                  >
                    <i />
                    <strong>{datePart(dateRow.date)}</strong>
                    <small>{dateRow.total}</small>
                  </button>
                ))
              ) : (
                <EmptyState>暂无匹配日期</EmptyState>
              )}
            </div>
          </aside>

          <div className="change-lane-board">
            {visibleLaneRows.map((lane) => {
              const laneChanges = selectedDateChanges.filter((change) => change.lane === lane.id);
              return (
                <section className={`change-lane lane-tone-${lane.id}`} key={lane.id}>
                  <header>
                    <div>
                      <span className={`lane-dot lane-${lane.id}`} />
                      <h3>{laneShortLabel(lane.id)}</h3>
                    </div>
                  </header>

                  <div className="change-card-stack">
                    {laneChanges.length ? (
                      laneChanges.slice(0, 4).map((change) => {
                        const marketRow = firstMarketRow(change);
                        return (
                          <button
                            key={change.id}
                            className={`change-card ${selectedChange?.id === change.id ? "active" : ""}`}
                            onClick={() => selectChange(change)}
                          >
                            <span className="change-card-dot" />
                            <strong>{change.objectName}</strong>
                            <b>{compactChangeTitle(change.title)}</b>
                            {change.lane === "market" && marketRow ? (
                              <div className="change-stock-snapshot">
                                <em className={changeClass(marketRow.changePct)}>{formatPct(marketRow.changePct)}</em>
                                <MiniSparkline value={marketRow.changePct} />
                              </div>
                            ) : null}
                            <footer>
                              <span>
                                {compactTime(change.time)} · {change.evidenceLevel || "--"}级 ·{" "}
                                {statusLabel(change.status)}
                              </span>
                            </footer>
                          </button>
                        );
                      })
                    ) : (
                      null
                    )}
                  </div>

                </section>
              );
            })}
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
                <strong>{selectedChange.title}</strong>
                <div className="detail-meta-grid">
                  <div>
                    <span>证据</span>
                    <b>{selectedChange.evidenceLevel || "--"}级</b>
                  </div>
                  <div>
                    <span>状态</span>
                    <b>{statusLabel(selectedChange.status)}</b>
                  </div>
                  <div>
                    <span>时间</span>
                    <b>{formatTime(selectedChange.time)}</b>
                  </div>
                  <div>
                    <span>来源</span>
                    <b>{firstSource(selectedChange)?.publisher || firstSource(selectedChange)?.title || "--"}</b>
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
                    <small>市场</small>
                    <div className="detail-stock-list">
                      {selectedChange.marketContext.slice(0, 3).map((row) => (
                        <button key={row.id || row.entityId} onClick={() => openCompany(row.entityId)}>
                          <span>
                            {row.company} · {stockCodeText(row)}
                          </span>
                          <b className={changeClass(row.changePct)}>{formatPct(row.changePct)}</b>
                          <small>
                            {formatValue(row.price)} · 成交额 {formatValue(row.turnoverAmount)}
                          </small>
                        </button>
                      ))}
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
                      {selectedChange.entityNames.map((name) => (
                        <span key={name}>{name}</span>
                      ))}
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
            <strong>24h</strong>
          </header>
          <div className="key-change-list">
            {keyChangeRows.length ? (
              keyChangeRows.map((change) => (
                <button key={change.id} onClick={() => selectChange(change)}>
                  <span>{laneLabel(change.lane)}</span>
                  <strong>{compactChangeTitle(change.title)}</strong>
                  <small>
                    {change.evidenceLevel || "--"}级 · {statusLabel(change.status)} · {compactTime(change.time)}
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
            <strong>市场</strong>
          </header>
          <div className="market-stat-grid">
            <OverviewItem label="样本" value={marketRowsForOverview.length || 0} />
            <OverviewItem label="涨" value={marketGainers} />
            <OverviewItem label="跌" value={marketFallers} />
            <OverviewItem label="更新" value={datePart(market.generatedAt || market.date)} />
          </div>
          <div className="market-top-list">
            {topMarketRows.map((row, index) => (
              <button key={row.id || row.entityId} onClick={() => openCompany(row.entityId)}>
                <span>{index + 1}</span>
                <strong>{row.company}</strong>
                <small>{stockCodeText(row)}</small>
                <MiniSparkline value={row.changePct} />
                <b className={changeClass(row.changePct)}>{formatPct(row.changePct)}</b>
              </button>
            ))}
          </div>
        </div>

        <div className="change-mini-panel">
          <header>
            <strong>待验证 · {verificationRows.length}</strong>
          </header>
          <div className="verify-list">
            {verificationRows.length ? (
              verificationRows.slice(0, 5).map((item) => (
                <button
                  key={item.id}
                  onClick={() =>
                    openEvidence({
                      title: item.subject,
                      fact: item.subject,
                      module: "待验证",
                      date: changeWall.date,
                      entityNames: item.entityNames,
                      sources: item.sources || [],
                    })
                  }
                >
                  <span>{item.entityNames?.join(" / ") || "未绑定对象"}</span>
                  <strong>{item.subject}</strong>
                  <small>{statusLabel(item.status)}</small>
                </button>
              ))
            ) : (
              <EmptyState>暂无待验证项</EmptyState>
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

function CompaniesView({ selectedCompanyId, setSelectedCompanyId, openCompany, openEvidence }) {
  const companyRows = companies.rows || [];
  const selected = companyRows.find((company) => company.id === selectedCompanyId) || companyRows[0];

  if (!selected) {
    return (
      <DetailShell title="公司" meta={companies.date}>
        <EmptyState>暂无公司数据</EmptyState>
      </DetailShell>
    );
  }

  const selectedStock = stockFromCompany(selected);

  return (
    <DetailShell title={selected.name} meta={`${selected.segment || selected.kind}｜${stockCodeText(selected)}`}>
      <div className="company-layout">
        <aside className="company-rail">
          {companyRows.map((company) => (
            <button
              key={company.id}
              className={company.id === selected.id ? "active" : ""}
              onClick={() => setSelectedCompanyId(company.id)}
            >
              <strong>{company.name}</strong>
              <span>{company.segment || company.kind}</span>
            </button>
          ))}
        </aside>

        <div className="company-workspace">
          <StockCard row={selectedStock} openCompany={openCompany} openEvidence={openEvidence} />

          <section className="workspace-section">
            <header>
              <h3>最近事件</h3>
              <span>{selected.events?.length || 0}</span>
            </header>
            {selected.events?.length ? (
              <div className="event-card-grid single">
                {selected.events.slice(0, 4).map((event) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    openCompany={openCompany}
                    openEvidence={openEvidence}
                    compact
                  />
                ))}
              </div>
            ) : (
              <EmptyState>暂无直接入库事件</EmptyState>
            )}
          </section>

          <section className="workspace-section">
            <header>
              <h3>Follow-up</h3>
              <span>{selected.followups?.length || 0}</span>
            </header>
            {selected.followups?.length ? (
              <div className="mini-followups">
                {selected.followups.map((item) => (
                  <button key={item.id} onClick={() => openEvidence(item)}>
                    <strong>{item.subject}</strong>
                    <span>{followupLabels[item.status] || item.status}</span>
                  </button>
                ))}
              </div>
            ) : (
              <EmptyState>暂无待验证事项</EmptyState>
            )}
          </section>

          <section className="workspace-section">
            <header>
              <h3>来源</h3>
              <span>{selected.sources?.length || 0}</span>
            </header>
            {selected.sources?.length ? (
              <div className="source-links">
                {selected.sources.slice(0, 8).map((source) => (
                  <a key={source.id || source.url} href={source.url} target="_blank" rel="noreferrer">
                    <span>{source.publisher || sourceTypeLabels[source.sourceType] || "来源"}</span>
                    <strong>{source.title}</strong>
                    <ArrowUpRight size={14} />
                  </a>
                ))}
              </div>
            ) : (
              <EmptyState>暂无来源</EmptyState>
            )}
          </section>
        </div>
      </div>
    </DetailShell>
  );
}

function MarketView({ openCompany, openEvidence }) {
  const rows = marketRows();
  const updatedRows = rows.filter((row) => row.quoteStatus === "已更新");
  const topGainers = updatedRows.slice().sort((a, b) => (b.changePct || 0) - (a.changePct || 0)).slice(0, 5);
  const topTurnover = updatedRows
    .slice()
    .sort((a, b) => amountRank(b.turnoverAmount) - amountRank(a.turnoverAmount))
    .slice(0, 5);

  return (
    <DetailShell title="市场" meta={market.date}>
      <div className="market-summary-grid">
        <section>
          <h3>涨幅Top</h3>
          {topGainers.map((row) => (
            <StockLine key={row.id || row.entityId} row={row} />
          ))}
        </section>
        <section>
          <h3>成交额Top</h3>
          {topTurnover.map((row) => (
            <StockLine key={row.id || row.entityId} row={row} />
          ))}
        </section>
      </div>

      <div className="stock-card-grid">
        {rows.length ? (
          rows.map((row) => (
            <StockCard key={row.id || row.entityId} row={row} openCompany={openCompany} openEvidence={openEvidence} />
          ))
        ) : (
          <EmptyState>暂无市场数据</EmptyState>
        )}
      </div>
    </DetailShell>
  );
}

function groupTimeline(nodes) {
  const groups = new Map();
  for (const node of nodes || []) {
    const year = String(node.date || "").slice(0, 4) || "未知";
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year).push(node);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => b.localeCompare(a));
}

function GithubTimeline({ nodes, openEvidence }) {
  const groups = groupTimeline(nodes);
  if (!groups.length) return <EmptyState>暂无时间轴事件</EmptyState>;

  return (
    <div className="github-timeline">
      {groups.map(([year, rows]) => (
        <section key={year}>
          <h3>{year}</h3>
          <div>
            {rows.map((node) => (
              <button key={node.id} className="github-timeline-node" onClick={() => openEvidence(node)}>
                <span>{datePart(node.date)}</span>
                <i />
                <div>
                  <strong>{node.title}</strong>
                  <small>
                    {node.module || "未分类"}｜{node.evidenceLevel || "--"}级来源
                  </small>
                </div>
              </button>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function TimelineView({ openEvidence }) {
  const nodes = timeline.recentNodes || (timeline.nodes || []).slice().reverse();

  return (
    <DetailShell title="时间轴" meta={timeline.date}>
      <GithubTimeline nodes={nodes} openEvidence={openEvidence} />
    </DetailShell>
  );
}

function DatabaseView({ openEvidence }) {
  const sourceRows = sourceRegistry.rows || [];
  const levelRows = Object.entries(stats.evidenceLevels || {});
  const serenityTotals = serenityBridge.totals || {};

  return (
    <DetailShell title="数据库" meta={stats.date}>
      <div className="status-board database-board">
        <OverviewItem label="公司" value={stats.entities} />
        <OverviewItem label="原始材料" value={stats.rawArtifacts || 0} />
        <OverviewItem label="Claim" value={stats.claims || 0} />
        <OverviewItem label="Evidence" value={stats.evidence || 0} />
        <OverviewItem label="事件" value={stats.events} />
        <OverviewItem label="合作" value={stats.relations} />
        <OverviewItem label="跟踪" value={stats.followups} />
        <OverviewItem label="Observation" value={stats.observations || 0} />
        <OverviewItem label="抓取记录" value={stats.fetchRuns || 0} />
        <OverviewItem label="未来节点" value={stats.milestones || 0} />
        <OverviewItem label="数据缺口" value={stats.dataGaps || 0} />
        <OverviewItem label="股票快照" value={stats.stockSnapshots} />
        <OverviewItem label="来源" value={stats.sources} />
      </div>

      <section className="workspace-section">
        <header>
          <h3>Serenity Bridge</h3>
          <span>{serenityTotals.fetchRuns || 0}</span>
        </header>
        <div className="status-board database-board">
          <OverviewItem label="Raw" value={serenityTotals.rawArtifacts || 0} />
          <OverviewItem label="候选" value={serenityTotals.claimCandidates || 0} />
          <OverviewItem label="行情" value={serenityTotals.stockSnapshots || 0} />
          <OverviewItem label="缺口" value={serenityTotals.dataGaps || 0} />
        </div>
        {serenityBridge.dataGaps?.length ? (
          <div className="gap-list">
            {serenityBridge.dataGaps.slice(0, 4).map((row) => (
              <div key={`${row.fetchRunId}_${row.kind}`}>
                <strong>{row.dataset}</strong>
                <span>{row.evidenceLevel || "--"}级</span>
                <p>{row.description}</p>
              </div>
            ))}
          </div>
        ) : null}
        {serenityBridge.claimCandidates?.length ? (
          <div className="database-list">
            {serenityBridge.claimCandidates.slice(0, 4).map((row) => (
              <button
                key={row.id}
                onClick={() =>
                  openEvidence({
                    title: row.text,
                    fact: row.text,
                    module: "Serenity Bridge",
                    evidenceLevel: row.evidence?.[0]?.sourceLevel || "--",
                    sources: row.evidence?.map((item) => item.source).filter(Boolean) || [],
                  })
                }
              >
                <span>{row.claimType}</span>
                <strong>{row.text}</strong>
                <small>
                  {row.reviewStatus} · {row.confidence}
                </small>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState>暂无 Serenity 候选</EmptyState>
        )}
      </section>

      <section className="workspace-section">
        <header>
          <h3>未来验证</h3>
          <span>{upcoming.rows?.length || 0}</span>
        </header>
        {upcoming.rows?.length ? (
          <div className="database-list">
            {upcoming.rows.slice(0, 8).map((row) => (
              <button key={row.id} onClick={() => openEvidence(row)}>
                <span>{row.dueAt}</span>
                <strong>{row.title}</strong>
                <small>{row.entityNames?.join(" / ") || "未绑定公司"}</small>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState>暂无未来验证节点</EmptyState>
        )}
      </section>

      <section className="workspace-section">
        <header>
          <h3>数据缺口</h3>
          <span>{gaps.rows?.length || 0}</span>
        </header>
        {gaps.rows?.length ? (
          <div className="gap-list">
            {gaps.rows.slice(0, 12).map((row) => (
              <div key={row.entityId}>
                <strong>{row.name}</strong>
                <span>{row.segment || "未分类"}</span>
                <p>{row.gaps.join(" / ")}</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState>暂无数据缺口</EmptyState>
        )}
      </section>

      <section className="workspace-section">
        <header>
          <h3>证据等级</h3>
        </header>
        <div className="level-list">
          {levelRows.map(([level, value]) => (
            <p key={level}>
              <span>{level}级来源</span>
              <strong>{value}</strong>
            </p>
          ))}
        </div>
      </section>

      <section className="workspace-section">
        <header>
          <h3>公开合作</h3>
          <span>{relations.rows?.length || 0}</span>
        </header>
        {relations.rows?.length ? (
          <div className="database-list">
            {relations.rows.map((row) => (
              <button key={row.id} onClick={() => openEvidence(row)}>
                <span>{row.date || "--"}</span>
                <strong>
                  {row.entityAName} → {row.entityBName}
                </strong>
                <EvidenceBadge level={row.evidenceLevel} />
              </button>
            ))}
          </div>
        ) : (
          <EmptyState>暂无公开合作</EmptyState>
        )}
      </section>

      <section className="workspace-section">
        <header>
          <h3>来源</h3>
          <span>{sourceRows.length}</span>
        </header>
        <div className="source-table">
          {sourceRows.map((row) => (
            <button key={row.id} onClick={() => openEvidence(buildEvidenceFromSource(row))}>
              <div>
                <strong>{row.title}</strong>
                <span>{row.publisher}</span>
              </div>
              <EvidenceBadge level={row.evidenceLevel} />
            </button>
          ))}
        </div>
      </section>
    </DetailShell>
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

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <aside className="evidence-drawer" onClick={(event) => event.stopPropagation()}>
        <header>
          <div>
            <span>证据</span>
            <h2>{evidence.title || evidence.fact || "来源"}</h2>
          </div>
          <button onClick={onClose} aria-label="关闭证据抽屉">
            <X size={18} />
          </button>
        </header>

        <p className="drawer-fact">{evidence.fact || evidence.title || "--"}</p>

        <div className="drawer-meta">
          <span>{evidence.date || today.date}</span>
          <span>{evidence.module || "--"}</span>
          <span>{evidence.evidenceLevel || "--"}级来源</span>
          {evidence.entityNames?.length ? <span>{evidence.entityNames.join(" / ")}</span> : null}
        </div>

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
      </aside>
    </div>
  );
}

export default function App() {
  const [activeView, setActiveView] = useState("dashboard");
  const [selectedCompanyId, setSelectedCompanyId] = useState(
    companies.rows?.find((company) => company.listed)?.id || companies.rows?.[0]?.id || null
  );
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
          <CompaniesView
            {...shared}
            selectedCompanyId={selectedCompanyId}
            setSelectedCompanyId={setSelectedCompanyId}
          />
        );
      case "market":
        return <MarketView {...shared} />;
      case "timeline":
        return <TimelineView openEvidence={setEvidence} />;
      case "database":
        return <DatabaseView openEvidence={setEvidence} />;
      default:
        return <Dashboard {...shared} />;
    }
  }, [activeView, selectedCompanyId]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand-lockup">
          <h1>研究终端</h1>
        </div>
        <div className="topbar-meta">
          <span>{today.date}</span>
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
