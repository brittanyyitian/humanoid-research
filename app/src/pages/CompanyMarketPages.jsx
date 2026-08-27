import { ArrowUpRight } from "lucide-react";

import companies from "@data/dashboard/companies.json";
import market from "@data/dashboard/market.json";

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

function EmptyState({ children = "暂无已验证数据" }) {
  return <div className="empty-state">{children}</div>;
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

function EvidenceBadge({ level }) {
  return <span className="evidence-badge">{level || "--"}级</span>;
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
          <p><span>成交额</span><strong>{formatValue(row.turnoverAmount)}</strong></p>
          <p><span>换手率</span><strong>{formatRate(row.turnoverRate)}</strong></p>
          <p><span>近5日</span><strong>{formatPct(row.fiveDayChangePct)}</strong></p>
          <p><span>近20日</span><strong>{formatPct(row.twentyDayChangePct)}</strong></p>
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

function EventCard({ event, openCompany, openEvidence }) {
  const directStocks = event.directMarketRows || [];
  const contextStocks = event.watchlistMarketContext || [];
  const stockRows = directStocks.length ? directStocks : contextStocks.slice(0, 3);
  const followups = event.followups || [];

  return (
    <article className="event-card event-card-compact">
      <button className="event-card-head" onClick={() => openEvidence(event)}>
        <span>
          {event.date}｜{event.module || "未分类"}｜{eventLabels[event.eventType] || "事件"}
        </span>
        <h3>{event.title}</h3>
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
          <small>同日 Watchlist 股票表现</small>
          {stockRows.length ? (
            <div className="stock-mini-list">
              {stockRows.map((row) => (
                <StockLine key={row.id || row.entityId} row={row} />
              ))}
            </div>
          ) : <span className="muted-text">暂无行情快照</span>}
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
          ) : <span className="muted-text">暂无直接跟踪项</span>}
        </section>
      </div>

      <footer>
        <EvidenceBadge level={event.evidenceLevel} />
        <button onClick={() => openEvidence(event)}>查看来源</button>
      </footer>
    </article>
  );
}

export function CompanyPage({
  selectedCompanyId,
  setSelectedCompanyId,
  openCompany,
  openEvidence,
}) {
  const companyRows = companies.rows || [];
  const selected = companyRows.find((company) => company.id === selectedCompanyId)
    || companyRows.find((company) => company.listed)
    || companyRows[0];

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
            <header><h3>最近事件</h3><span>{selected.events?.length || 0}</span></header>
            {selected.events?.length ? (
              <div className="event-card-grid single">
                {selected.events.slice(0, 4).map((event) => (
                  <EventCard
                    key={event.id}
                    event={event}
                    openCompany={openCompany}
                    openEvidence={openEvidence}
                  />
                ))}
              </div>
            ) : <EmptyState>暂无直接入库事件</EmptyState>}
          </section>

          <section className="workspace-section">
            <header><h3>Follow-up</h3><span>{selected.followups?.length || 0}</span></header>
            {selected.followups?.length ? (
              <div className="mini-followups">
                {selected.followups.map((item) => (
                  <button key={item.id} onClick={() => openEvidence(item)}>
                    <strong>{item.subject}</strong>
                    <span>{followupLabels[item.status] || item.status}</span>
                  </button>
                ))}
              </div>
            ) : <EmptyState>暂无待验证事项</EmptyState>}
          </section>

          <section className="workspace-section">
            <header><h3>来源</h3><span>{selected.sources?.length || 0}</span></header>
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
            ) : <EmptyState>暂无来源</EmptyState>}
          </section>
        </div>
      </div>
    </DetailShell>
  );
}

export function MarketPage({ openCompany, openEvidence }) {
  const rows = marketRows();
  const updatedRows = rows.filter((row) => row.quoteStatus === "已更新");
  const topGainers = updatedRows.slice()
    .sort((a, b) => (b.changePct || 0) - (a.changePct || 0))
    .slice(0, 5);
  const topTurnover = updatedRows.slice()
    .sort((a, b) => amountRank(b.turnoverAmount) - amountRank(a.turnoverAmount))
    .slice(0, 5);

  return (
    <DetailShell title="市场" meta={market.date}>
      <div className="market-summary-grid">
        <section>
          <h3>涨幅Top</h3>
          {topGainers.map((row) => <StockLine key={row.id || row.entityId} row={row} />)}
        </section>
        <section>
          <h3>成交额Top</h3>
          {topTurnover.map((row) => <StockLine key={row.id || row.entityId} row={row} />)}
        </section>
      </div>

      <div className="stock-card-grid">
        {rows.length ? rows.map((row) => (
          <StockCard
            key={row.id || row.entityId}
            row={row}
            openCompany={openCompany}
            openEvidence={openEvidence}
          />
        )) : <EmptyState>暂无市场数据</EmptyState>}
      </div>
    </DetailShell>
  );
}
