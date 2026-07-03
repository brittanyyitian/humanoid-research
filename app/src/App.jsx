import { Fragment, useMemo, useState } from "react";
import { ArrowUpRight, X } from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import today from "@data/dashboard/today.json";
import market from "@data/dashboard/market.json";
import heat from "@data/dashboard/heat.json";
import timeline from "@data/dashboard/timeline.json";
import followup from "@data/dashboard/followup.json";
import watchlist from "@data/dashboard/watchlist.json";
import stats from "@data/dashboard/stats.json";
import relations from "@data/dashboard/relations.json";
import sourceRegistry from "@data/dashboard/sources.json";

const navItems = [
  { id: "dashboard", label: "首页" },
  { id: "market", label: "市场" },
  { id: "followup", label: "跟踪" },
  { id: "timeline", label: "时间轴" },
  { id: "heat", label: "热度" },
  { id: "supply", label: "供应链" },
  { id: "relations", label: "关系" },
  { id: "stats", label: "统计" },
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

function stockCodeText(row) {
  if (!row.stockCode) return row.listed ? "缺股票代码" : "未上市";
  return `${row.stockCode}${row.market ? ` · ${row.market}` : ""}`;
}

function firstSource(item) {
  return item?.sources?.[0] || null;
}

function itemHasSource(item) {
  return Boolean(firstSource(item)?.url || item?.url);
}

function buildMarketEvidence(row) {
  const company = row.displayName || row.company || row.name;
  return {
    title: `${company}行情快照`,
    fact: `${company}（${stockCodeText(row)}）：价格 ${formatValue(row.price)}，涨跌幅 ${formatPct(row.changePct)}，成交额 ${formatValue(row.turnoverAmount)}，换手率 ${formatRate(row.turnoverRate)}，总市值 ${formatValue(row.totalMarketCap)}，流通市值 ${formatValue(row.floatMarketCap)}，近5日 ${formatPct(row.fiveDayChangePct)}，近20日 ${formatPct(row.twentyDayChangePct)}。`,
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

function getMarketRows() {
  const stockByEntity = new Map((market.rows || []).map((row) => [row.entityId, row]));
  const statusRank = { 已更新: 0, 待抓取: 1, 缺代码: 2 };

  return (watchlist.rows || [])
    .filter((row) => row.listed)
    .map((row) => {
      const stock = stockByEntity.get(row.id);
      if (stock) {
        return {
          ...row,
          ...stock,
          displayName: stock.company || row.name,
          quoteStatus: "已更新",
        };
      }

      return {
        ...row,
        displayName: row.name,
        price: null,
        changePct: null,
        turnoverAmount: null,
        turnoverRate: null,
        totalMarketCap: null,
        floatMarketCap: null,
        mainNetInflow: null,
        fiveDayChangePct: null,
        twentyDayChangePct: null,
        capturedAt: null,
        sources: [],
        quoteStatus: row.stockCode ? "待抓取" : "缺代码",
      };
    })
    .sort((a, b) => (statusRank[a.quoteStatus] ?? 9) - (statusRank[b.quoteStatus] ?? 9));
}

function MarketRow({ row, openEvidence, compact = false }) {
  const hasSource = itemHasSource(row);
  const changeClass =
    typeof row.changePct === "number" && row.changePct > 0
      ? "rise"
      : typeof row.changePct === "number" && row.changePct < 0
        ? "fall"
        : "";
  const Wrapper = hasSource ? "button" : "div";

  return (
    <Wrapper
      className={`market-row ${compact ? "market-row-compact" : ""}`}
      onClick={hasSource ? () => openEvidence(buildMarketEvidence(row)) : undefined}
    >
      <div className="market-company">
        <strong>{row.displayName || row.company || row.name}</strong>
        <span>{stockCodeText(row)}</span>
      </div>
      <div className="market-price">
        <strong>{formatValue(row.price)}</strong>
        <span className={changeClass}>{formatPct(row.changePct)}</span>
      </div>
      {!compact ? (
      <div className="market-extra">
        <span>成交额 {formatValue(row.turnoverAmount)}</span>
        <span>换手 {formatRate(row.turnoverRate)}</span>
        <span>总市值 {formatValue(row.totalMarketCap)}</span>
        <span>流通 {formatValue(row.floatMarketCap)}</span>
        <span>主力 {formatValue(row.mainNetInflow)}</span>
        <span>近5日 {formatPct(row.fiveDayChangePct)}</span>
        <span>近20日 {formatPct(row.twentyDayChangePct)}</span>
        <span>数据 {formatTime(row.capturedAt)}</span>
      </div>
      ) : null}
      <span className="quote-status">{row.quoteStatus}</span>
    </Wrapper>
  );
}

function EventRow({ event, openEvidence, compact = false }) {
  return (
    <button className={`event-row ${compact ? "event-row-compact" : ""}`} onClick={() => openEvidence(event)}>
      <div>
        <strong>{event.title}</strong>
        {!compact ? <p>{event.fact}</p> : null}
      </div>
      <span>{eventLabels[event.eventType] || event.eventType || "事件"}</span>
      <EvidenceBadge level={event.evidenceLevel} />
    </button>
  );
}

function TimelineNodes({ nodes, openEvidence, limit }) {
  const rows = typeof limit === "number" ? nodes.slice(0, limit) : nodes;
  if (!rows.length) return <EmptyState />;

  return (
    <div className="vertical-timeline">
      {rows.map((node) => (
        <button key={node.id} className="timeline-node" onClick={() => openEvidence(node)}>
          <time>{node.date}</time>
          <span className="timeline-dot" />
          <div>
            <strong>{node.title}</strong>
            <small>
              {node.module || "未分类"}｜{node.evidenceLevel || "--"}级来源
            </small>
          </div>
        </button>
      ))}
    </div>
  );
}

function Dashboard({ setView, openEvidence }) {
  const marketRows = getMarketRows();
  const updatedMarketRows = marketRows.filter((row) => row.quoteStatus === "已更新").length;
  const pendingRows = followup.rows.filter((item) => item.status === "pending");
  const chronologicalNodes = timeline.nodes || [];
  const latestNodes = timeline.recentNodes || chronologicalNodes.slice().reverse();
  const recentTimelineNodes = chronologicalNodes.slice(-5);
  const focusEvents = today.importantEvents.length ? today.importantEvents : latestNodes.slice(0, 3);
  const marketTopRows = marketRows
    .filter((row) => row.quoteStatus === "已更新")
    .sort((a, b) => Math.abs(b.changePct || 0) - Math.abs(a.changePct || 0))
    .concat(marketRows.filter((row) => row.quoteStatus !== "已更新"));
  const heatRows = Object.entries(today.moduleCounts || {}).map(([name, count]) => ({ name, count }));

  return (
    <div className="dashboard-v2">
      <section className="overview-strip" aria-label="今日概览">
        <OverviewItem label="今日新增" value={today.totals.changes} note={`${today.date}`} />
        <OverviewItem label="重点事件" value={today.importantEvents.length} note="已验证" />
        <OverviewItem
          label="关注股票"
          value={marketRows.length}
          note={`${updatedMarketRows}已更新 / ${marketRows.length - updatedMarketRows}待补`}
        />
        <OverviewItem label="待验证" value={pendingRows.length} note="待处理" />
      </section>

      <section className="dashboard-lead">
        <div>
          <span>今日</span>
          <h2>{today.importantEvents.length ? "有新增重点事件" : "暂无新增重点事件"}</h2>
        </div>
        <button onClick={() => setView("timeline")}>查看时间轴</button>
      </section>

      <div className="dashboard-columns">
        <section className="panel panel-focus">
          <header>
            <h3>{today.importantEvents.length ? "今日重点" : "最近重点"}</h3>
            <button onClick={() => setView("timeline")}>全部</button>
          </header>
          {focusEvents.length ? (
            <div className="event-list">
              {focusEvents.slice(0, 3).map((event) => (
                <EventRow key={event.id} event={event} openEvidence={openEvidence} />
              ))}
            </div>
          ) : (
            <EmptyState>暂无入库事件</EmptyState>
          )}
        </section>

        <section className="panel panel-market">
          <header>
            <h3>今日股票异动</h3>
            <button onClick={() => setView("market")}>全部</button>
          </header>
          {marketRows.length ? (
            <div className="market-list">
              {marketTopRows.slice(0, 5).map((row) => (
                <MarketRow key={row.id || row.stockCode} row={row} openEvidence={openEvidence} compact />
              ))}
            </div>
          ) : (
            <EmptyState>暂无关注股票</EmptyState>
          )}
        </section>

        <section className="panel panel-followup">
          <header>
            <h3>待验证</h3>
            <button onClick={() => setView("followup")}>全部</button>
          </header>
          {pendingRows.length ? (
            <div className="followup-list">
              {pendingRows.slice(0, 5).map((item) => (
                <button key={item.id} onClick={() => openEvidence(item)}>
                  <strong>{item.subject}</strong>
                  <span>{item.entityNames?.join(" / ") || "未关联公司"}</span>
                </button>
              ))}
            </div>
          ) : (
            <EmptyState>暂无待验证事项</EmptyState>
          )}
        </section>
      </div>

      <section className="panel timeline-panel">
        <header>
          <h3>最近产业时间轴</h3>
          <button onClick={() => setView("timeline")}>全部</button>
        </header>
        <TimelineNodes nodes={recentTimelineNodes} openEvidence={openEvidence} />
      </section>

      <section className="heat-strip" aria-label="今日热度分布">
        <span>今日热度分布</span>
        <div>
          {(heatRows.length
            ? heatRows
            : [
                { name: "整机厂", count: 0 },
                { name: "产业链", count: 0 },
                { name: "政策", count: 0 },
              ]
          )
            .slice(0, 5)
            .map((row) => (
            <p key={row.name}>
              <b>{row.name}</b>
              <i style={{ width: `${Math.max(4, Math.min(100, row.count * 22))}%` }} />
              <strong>{row.count}</strong>
            </p>
          ))}
        </div>
      </section>
    </div>
  );
}

function MarketView({ openEvidence }) {
  const rows = getMarketRows();

  return (
    <DetailShell title="市场" meta={market.date}>
      <div className="market-page-list">
        {rows.length ? (
          rows.map((row) => <MarketRow key={row.id || row.stockCode} row={row} openEvidence={openEvidence} />)
        ) : (
          <EmptyState>暂无市场数据</EmptyState>
        )}
      </div>
    </DetailShell>
  );
}

function FollowupView({ openEvidence }) {
  const statuses = ["pending", "confirmed", "completed", "archived", "cancelled", "stale"];

  return (
    <DetailShell title="跟踪" meta={followup.date}>
      <div className="status-board">
        {statuses.map((status) => (
          <OverviewItem
            key={status}
            label={followupLabels[status] || status}
            value={followup.statusCounts[status] || 0}
          />
        ))}
      </div>
      {followup.rows.length ? (
        <div className="followup-table">
          {followup.rows.map((row) => (
            <button key={row.id} onClick={() => openEvidence(row)}>
              <strong>{row.subject}</strong>
              <span>{followupLabels[row.status] || row.status}</span>
              <small>{row.entityNames?.join(" / ") || "--"}</small>
            </button>
          ))}
        </div>
      ) : (
        <EmptyState>暂无跟踪事项</EmptyState>
      )}
    </DetailShell>
  );
}

function TimelineView({ openEvidence }) {
  return (
    <DetailShell title="时间轴" meta={timeline.date}>
      <TimelineNodes nodes={timeline.nodes} openEvidence={openEvidence} />
    </DetailShell>
  );
}

function HeatView() {
  const chartRows = heat.modules?.length ? heat.modules : [{ name: "暂无", count: 0 }];

  return (
    <DetailShell title="热度" meta={`近${heat.windowDays || 30}天`}>
      <div className="chart-panel">
        <ResponsiveContainer width="100%" height={300}>
          <BarChart data={chartRows} margin={{ top: 10, right: 18, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="#eeeeee" vertical={false} />
            <XAxis dataKey="name" tickLine={false} axisLine={false} />
            <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
            <Tooltip cursor={{ fill: "#f6f6f6" }} />
            <Bar dataKey="count" radius={[3, 3, 0, 0]} fill="#111111" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </DetailShell>
  );
}

function SupplyView() {
  const rows = ["宇树科技", "智元机器人", "优必选", "银河通用", "傅利叶"];
  const cols = ["力传感器", "丝杠", "减速器", "灵巧手", "电机", "控制器"];

  return (
    <DetailShell title="供应链" meta="公开证据">
      <div className="matrix-large">
        <div className="matrix-head">整机厂</div>
        {cols.map((col) => (
          <div className="matrix-head" key={col}>
            {col}
          </div>
        ))}
        {rows.map((row) => (
          <Fragment key={row}>
            <div className="matrix-row-head">{row}</div>
            {cols.map((col) => (
              <button className="matrix-cell-empty" key={`${row}-${col}`}>
                未公开
              </button>
            ))}
          </Fragment>
        ))}
      </div>
    </DetailShell>
  );
}

function RelationsView({ openEvidence }) {
  return (
    <DetailShell title="关系" meta="公开合作">
      {relations.rows.length ? (
        <div className="relation-list">
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
        <EmptyState>暂无公开关系</EmptyState>
      )}
    </DetailShell>
  );
}

function StatsView({ openEvidence }) {
  const sourceRows = sourceRegistry.rows || [];
  const levelRows = Object.entries(stats.evidenceLevels || {});

  return (
    <DetailShell title="统计" meta={stats.date}>
      <div className="status-board stats-board">
        <OverviewItem label="公司" value={stats.entities} />
        <OverviewItem label="事件" value={stats.events} />
        <OverviewItem label="合作" value={stats.relations} />
        <OverviewItem label="股票快照" value={stats.stockSnapshots} />
        <OverviewItem label="来源" value={stats.sources} />
      </div>

      <div className="level-list">
        {levelRows.map(([level, value]) => (
          <p key={level}>
            <span>{level}级来源</span>
            <strong>{value}</strong>
          </p>
        ))}
      </div>

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
  const [evidence, setEvidence] = useState(null);

  const content = useMemo(() => {
    const props = { setView: setActiveView, openEvidence: setEvidence };
    switch (activeView) {
      case "market":
        return <MarketView openEvidence={setEvidence} />;
      case "followup":
        return <FollowupView openEvidence={setEvidence} />;
      case "timeline":
        return <TimelineView openEvidence={setEvidence} />;
      case "heat":
        return <HeatView />;
      case "supply":
        return <SupplyView />;
      case "relations":
        return <RelationsView openEvidence={setEvidence} />;
      case "stats":
        return <StatsView openEvidence={setEvidence} />;
      default:
        return <Dashboard {...props} />;
    }
  }, [activeView]);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div>
          <span className="eyebrow">国内人形机器人产业</span>
          <h1>研究看板</h1>
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
