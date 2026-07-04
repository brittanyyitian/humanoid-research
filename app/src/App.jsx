import { useMemo, useState } from "react";
import { ArrowUpRight, X } from "lucide-react";

import companies from "@data/dashboard/companies.json";
import eventDashboard from "@data/dashboard/events.json";
import followup from "@data/dashboard/followup.json";
import freshness from "@data/dashboard/freshness.json";
import gaps from "@data/dashboard/gaps.json";
import market from "@data/dashboard/market.json";
import observations from "@data/dashboard/observations.json";
import relations from "@data/dashboard/relations.json";
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
    has_failures: "失败",
  };
  return labels[status] || status || "--";
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
  const [expandedObservationId, setExpandedObservationId] = useState(null);
  const rows = marketRows();
  const updatedMarketRows = rows.filter((row) => row.quoteStatus === "已更新");
  const pendingRows = followup.rows.filter((item) => item.status === "pending");
  const observationRows = observations.researchRows || [];
  const todayObservationRows = observations.todayRows || [];
  const involvedCompanies = new Set(observationRows.flatMap((row) => row.entityIds || []));

  return (
    <div className="dashboard-v3">
      <section className="overview-strip" aria-label="今日概览">
        <OverviewItem label="值得研究" value={observationRows.length} note="Observation" />
        <OverviewItem label="今日新增" value={todayObservationRows.length} note={today.date} />
        <OverviewItem label="涉及公司" value={involvedCompanies.size} note="卡片内公司" />
        <OverviewItem label="关注股票" value={rows.length} note={`${updatedMarketRows.length}已更新`} />
      </section>

      <FreshnessStrip />
      <WindowSummaryStrip />

      <section className="dashboard-lead">
        <div>
          <span>今日研究</span>
          <h2>{observationRows.length ? `值得研究 ${observationRows.length} 件事情` : "暂无正式 Observation"}</h2>
        </div>
        <button onClick={() => setView("database")}>查看数据库</button>
      </section>

      <section className="whats-new-panel">
        <div>
          <span>What’s New</span>
          <strong>{observations.whatsNew?.addedToday || 0}</strong>
          <small>今日新增 Observation</small>
        </div>
        <p>
          昨日库 {observations.whatsNew?.previousTotal || 0} · 今日库{" "}
          {observations.whatsNew?.currentTotal || 0} · 待验证 {pendingRows.length}
        </p>
      </section>

      <DataGapStrip setView={setView} />

      <section className="observation-stack">
        {observationRows.length ? (
          observationRows.slice(0, 5).map((observation) => (
            <ObservationCard
              key={observation.id}
              observation={observation}
              openCompany={openCompany}
              openEvidence={openEvidence}
              expanded={expandedObservationId === observation.id}
              onToggle={() =>
                setExpandedObservationId((current) => (current === observation.id ? null : observation.id))
              }
            />
          ))
        ) : (
          <EmptyState>暂无 Observation 数据</EmptyState>
        )}
      </section>
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
        <div>
          <span className="eyebrow">国内人形机器人产业</span>
          <h1>研究终端</h1>
        </div>
        <div className="topbar-meta">
          <span>{today.date}</span>
          <span>{today.status === "empty" ? "今日无新增" : "今日有更新"}</span>
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
