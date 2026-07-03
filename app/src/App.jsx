import { Fragment, useMemo, useState } from "react";
import {
  Activity,
  ArrowUpRight,
  BarChart3,
  CalendarDays,
  Database,
  FileSearch,
  Gauge,
  GitBranch,
  LineChart,
  Network,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
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
  { id: "dashboard", label: "Dashboard" },
  { id: "market", label: "Market" },
  { id: "followup", label: "Follow-up" },
  { id: "timeline", label: "Timeline" },
  { id: "heat", label: "Heat" },
  { id: "supply", label: "Supply Chain" },
  { id: "relations", label: "Relations" },
  { id: "stats", label: "Statistics" },
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

const signalMap = {
  green: { label: "Update", className: "signal-green" },
  yellow: { label: "Light", className: "signal-yellow" },
  neutral: { label: "No Update", className: "signal-neutral" },
  stale: { label: "Stale", className: "signal-stale" },
};

function formatPct(value) {
  if (typeof value !== "number") return "N/A";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function firstSource(item) {
  return item?.sources?.[0] || null;
}

function Signal({ tone = "neutral" }) {
  const signal = signalMap[tone] || signalMap.neutral;
  return (
    <span className={`signal ${signal.className}`}>
      <span />
      {signal.label}
    </span>
  );
}

function Widget({ title, icon: Icon, signal = "neutral", action, children, className = "" }) {
  return (
    <section className={`widget ${className}`} onClick={action}>
      <header className="widget-header">
        <div className="widget-title">
          {Icon ? <Icon size={15} strokeWidth={1.7} /> : null}
          <span>{title}</span>
        </div>
        <Signal tone={signal} />
      </header>
      {children}
    </section>
  );
}

function EmptyState({ label = "No verified data" }) {
  return <div className="empty-state">{label}</div>;
}

function SourceButton({ item, onOpen, compact = false }) {
  const source = firstSource(item) || item;
  if (!source?.url) return <span className="source-muted">No source</span>;
  return (
    <button
      className={`source-button ${compact ? "source-button-compact" : ""}`}
      onClick={(event) => {
        event.stopPropagation();
        onOpen({
          title: item.title || item.fact || source.title,
          fact: item.fact || source.title,
          date: item.date || today.date,
          evidenceLevel: item.evidenceLevel || source.evidenceLevel,
          module: item.module || item.sourceType,
          entityNames: item.entityNames || [],
          sources: item.sources || [source],
        });
      }}
    >
      Source
      <ArrowUpRight size={12} />
    </button>
  );
}

function Metric({ label, value, detail }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong>{value}</strong>
      {detail ? <small>{detail}</small> : null}
    </div>
  );
}

function Dashboard({ setView, openEvidence }) {
  const topMarket = market.rows.slice(0, 3);
  const followupRows = followup.rows.slice(0, 4);
  const heatRows = heat.modules.length
    ? heat.modules
    : [
        { name: "整机", count: 0 },
        { name: "力传感器", count: 0 },
        { name: "丝杠", count: 0 },
        { name: "减速器", count: 0 },
        { name: "AI", count: 0 },
      ];

  return (
    <div className="dashboard-grid">
      <section className="hero-strip">
        <Metric label="Today Changes" value={`+${today.totals.changes}`} detail={today.date} />
        <Metric label="Market" value={`${market.summary.up} Up / ${market.summary.down} Down`} />
        <Metric label="Heat Score" value={`${heat.score}/100`} />
        <Metric label="A Sources" value={stats.evidenceLevels.A || 0} detail={`${stats.sources} sources`} />
      </section>

      <Widget
        title="Today Focus"
        icon={Activity}
        signal={today.signals.changes}
        action={() => setView("timeline")}
      >
        {today.importantEvents.length ? (
          <div className="focus-list">
            {today.importantEvents.map((event) => (
              <button className="focus-row" key={event.id} onClick={() => openEvidence(event)}>
                <span>{eventLabels[event.eventType] || event.eventType}</span>
                <strong>{event.title}</strong>
                <em>{event.evidenceLevel}</em>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState />
        )}
      </Widget>

      <Widget title="Market" icon={LineChart} signal={today.signals.market} action={() => setView("market")}>
        {topMarket.length ? (
          <div className="market-mini">
            {topMarket.map((row) => (
              <button className="market-line" key={row.id} onClick={() => openEvidence(row)}>
                <span>{row.company}</span>
                <strong className={Number(row.changePct) >= 0 ? "rise" : "fall"}>{formatPct(row.changePct)}</strong>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState />
        )}
      </Widget>

      <Widget title="Follow-up" icon={FileSearch} signal={today.signals.followup} action={() => setView("followup")}>
        <div className="status-stack">
          {["pending", "confirmed", "completed", "stale"].map((status) => (
            <div className="status-row" key={status}>
              <span>{status}</span>
              <strong>{followup.statusCounts[status] || 0}</strong>
            </div>
          ))}
        </div>
      </Widget>

      <Widget title="Supply Chain Matrix" icon={Network} signal="neutral" action={() => setView("supply")}>
        <MiniMatrix />
      </Widget>

      <Widget title="Timeline" icon={CalendarDays} signal={today.signals.changes} action={() => setView("timeline")}>
        {timeline.nodes.length ? (
          <div className="timeline-mini">
            {timeline.nodes.slice(0, 4).map((node) => (
              <button key={node.id} onClick={() => openEvidence(node)}>
                <span>{node.date}</span>
                <strong>{node.title}</strong>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState />
        )}
      </Widget>

      <Widget title="Heat Map" icon={Gauge} signal={heat.score > 0 ? "yellow" : "neutral"} action={() => setView("heat")}>
        <div className="heat-bars">
          {heatRows.slice(0, 5).map((row) => (
            <div className="heat-row" key={row.name}>
              <span>{row.name}</span>
              <div>
                <i style={{ width: `${Math.min(100, row.count * 18)}%` }} />
              </div>
              <strong>{row.count}</strong>
            </div>
          ))}
        </div>
      </Widget>

      <Widget
        title="Cooperation Graph"
        icon={GitBranch}
        signal={relations.rows.length ? "yellow" : "neutral"}
        action={() => setView("relations")}
      >
        {relations.rows.length ? (
          <div className="relation-mini">
            {relations.rows.slice(0, 2).map((row) => (
              <button key={row.id} onClick={() => openEvidence(row)}>
                <span>{row.entityAName}</span>
                <i />
                <strong>{row.entityBName}</strong>
              </button>
            ))}
          </div>
        ) : (
          <EmptyState />
        )}
      </Widget>

      <Widget title="Watchlist" icon={ShieldCheck} signal="neutral" action={() => setView("stats")}>
        <div className="watch-mini">
          {watchlist.rows.slice(0, 6).map((row) => (
            <span key={row.id}>{row.name}</span>
          ))}
        </div>
      </Widget>

      <Widget title="Database Stats" icon={Database} signal="neutral" action={() => setView("stats")}>
        <div className="stats-mini">
          <Metric label="Entities" value={stats.entities} />
          <Metric label="Events" value={stats.events} />
          <Metric label="Sources" value={stats.sources} />
        </div>
      </Widget>
    </div>
  );
}

function MiniMatrix() {
  const rows = ["宇树科技", "智元机器人", "优必选"];
  const cols = ["力", "丝", "减", "手", "电"];
  return (
    <div className="mini-matrix" aria-label="Supply chain matrix preview">
      <div />
      {cols.map((col) => (
        <b key={col}>{col}</b>
      ))}
      {rows.map((row) => (
        <FragmentRow key={row} row={row} cols={cols} />
      ))}
    </div>
  );
}

function FragmentRow({ row, cols }) {
  return (
    <>
      <span>{row}</span>
      {cols.map((col) => (
        <i key={`${row}-${col}`} title="No verified data" />
      ))}
    </>
  );
}

function MarketView({ openEvidence }) {
  return (
    <DetailShell title="Market" meta={market.date}>
      <div className="table-shell">
        <table>
          <thead>
            <tr>
              <th>Company</th>
              <th>Code</th>
              <th>Price</th>
              <th>Change</th>
              <th>Turnover</th>
              <th>Source</th>
            </tr>
          </thead>
          <tbody>
            {market.rows.length ? (
              market.rows.map((row) => (
                <tr key={row.id}>
                  <td>{row.company}</td>
                  <td>{row.stockCode}</td>
                  <td>{row.price ?? "N/A"}</td>
                  <td className={Number(row.changePct) >= 0 ? "rise" : "fall"}>{formatPct(row.changePct)}</td>
                  <td>{row.turnoverAmount || "N/A"}</td>
                  <td>
                    <SourceButton item={row} onOpen={openEvidence} compact />
                  </td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan="6">
                  <EmptyState />
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </DetailShell>
  );
}

function FollowupView({ openEvidence }) {
  return (
    <DetailShell title="Follow-up" meta={followup.date}>
      <div className="status-board">
        {["pending", "confirmed", "completed", "archived", "cancelled", "stale"].map((status) => (
          <Metric key={status} label={status} value={followup.statusCounts[status] || 0} />
        ))}
      </div>
      <ListRows rows={followup.rows} openEvidence={openEvidence} empty="No open follow-up" />
    </DetailShell>
  );
}

function TimelineView({ openEvidence }) {
  return (
    <DetailShell title="Timeline" meta={timeline.date}>
      <div className="timeline-list">
        {timeline.nodes.length ? (
          timeline.nodes.map((node) => (
            <button key={node.id} onClick={() => openEvidence(node)}>
              <span>{node.date}</span>
              <strong>{node.title}</strong>
              <em>{node.evidenceLevel}</em>
            </button>
          ))
        ) : (
          <EmptyState />
        )}
      </div>
    </DetailShell>
  );
}

function HeatView() {
  const chartRows = heat.modules.length ? heat.modules : [{ name: "No verified data", count: 0 }];
  const pieRows = Object.entries(stats.evidenceLevels).map(([name, value]) => ({ name, value }));

  return (
    <DetailShell title="Heat" meta={`${heat.score}/100`}>
      <div className="chart-grid">
        <section className="chart-panel">
          <h3>Module Heat</h3>
          <ResponsiveContainer width="100%" height={260}>
            <BarChart data={chartRows}>
              <CartesianGrid stroke="#e8e4dc" vertical={false} />
              <XAxis dataKey="name" tickLine={false} axisLine={false} />
              <YAxis allowDecimals={false} tickLine={false} axisLine={false} />
              <Tooltip cursor={{ fill: "#f3f0e8" }} />
              <Bar dataKey="count" radius={[4, 4, 0, 0]} fill="#171717" />
            </BarChart>
          </ResponsiveContainer>
        </section>
        <section className="chart-panel">
          <h3>Evidence</h3>
          {pieRows.length ? (
            <ResponsiveContainer width="100%" height={260}>
              <PieChart>
                <Pie data={pieRows} dataKey="value" nameKey="name" outerRadius={86} innerRadius={54}>
                  {pieRows.map((entry, index) => (
                    <Cell key={entry.name} fill={["#111111", "#6b7280", "#a16207", "#991b1b"][index % 4]} />
                  ))}
                </Pie>
                <Tooltip />
              </PieChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState />
          )}
        </section>
      </div>
    </DetailShell>
  );
}

function SupplyView() {
  const rows = ["宇树科技", "智元机器人", "优必选", "银河通用", "傅利叶"];
  const cols = ["力传感器", "丝杠", "减速器", "灵巧手", "电机", "控制器"];
  return (
    <DetailShell title="Supply Chain Matrix" meta="Evidence only">
      <div className="matrix-large">
        <div className="matrix-head">OEM</div>
        {cols.map((col) => (
          <div className="matrix-head" key={col}>
            {col}
          </div>
        ))}
        {rows.map((row) => (
          <Fragment key={row}>
            <div className="matrix-row-head" key={`${row}-head`}>
              {row}
            </div>
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
    <DetailShell title="Company Relation" meta="Evidence only">
      {relations.rows.length ? (
        <div className="relation-list">
          {relations.rows.map((row) => (
            <button key={row.id} onClick={() => openEvidence(row)}>
              <span>{row.date || "N/A"}</span>
              <strong>
                {row.entityAName} {"->"} {row.entityBName}
              </strong>
              <em>{row.evidenceLevel}</em>
            </button>
          ))}
        </div>
      ) : (
        <div className="relation-canvas">
          <EmptyState />
        </div>
      )}
    </DetailShell>
  );
}

function StatsView({ openEvidence }) {
  const rows = sourceRegistry.rows;
  return (
    <DetailShell title="Database Statistics" meta={stats.date}>
      <div className="status-board">
        <Metric label="Entities" value={stats.entities} />
        <Metric label="Events" value={stats.events} />
        <Metric label="Relations" value={stats.relations} />
        <Metric label="Stocks" value={stats.stockSnapshots} />
        <Metric label="Sources" value={stats.sources} />
      </div>
      <div className="table-shell source-table">
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Publisher</th>
              <th>Level</th>
              <th>Link</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>{row.title}</td>
                <td>{row.publisher}</td>
                <td>{row.evidenceLevel}</td>
                <td>
                  <SourceButton item={row} onOpen={openEvidence} compact />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </DetailShell>
  );
}

function DetailShell({ title, meta, children }) {
  return (
    <section className="detail-shell">
      <header>
        <h2>{title}</h2>
        <span>{meta}</span>
      </header>
      {children}
    </section>
  );
}

function ListRows({ rows, openEvidence, empty }) {
  if (!rows.length) return <EmptyState label={empty} />;
  return (
    <div className="list-rows">
      {rows.map((row) => (
        <button key={row.id} onClick={() => openEvidence(row)}>
          <strong>{row.subject || row.title}</strong>
          <span>{row.status || row.evidenceLevel}</span>
        </button>
      ))}
    </div>
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
            <span>Evidence</span>
            <h2>{evidence.title || evidence.fact || "Source"}</h2>
          </div>
          <button onClick={onClose} aria-label="Close evidence drawer">
            <X size={18} />
          </button>
        </header>
        <dl>
          <div>
            <dt>Fact</dt>
            <dd>{evidence.fact || evidence.title || "N/A"}</dd>
          </div>
          <div>
            <dt>Date</dt>
            <dd>{evidence.date || today.date}</dd>
          </div>
          <div>
            <dt>Level</dt>
            <dd>{evidence.evidenceLevel || "N/A"}</dd>
          </div>
          <div>
            <dt>Module</dt>
            <dd>{evidence.module || "N/A"}</dd>
          </div>
          <div>
            <dt>Entity</dt>
            <dd>{evidence.entityNames?.join(" / ") || "N/A"}</dd>
          </div>
        </dl>
        <div className="drawer-sources">
          {sources.length ? (
            sources.map((source) => (
              <a key={source.id || source.url} href={source.url} target="_blank" rel="noreferrer">
                <span>{source.publisher || source.sourceType}</span>
                <strong>{source.title}</strong>
                <ArrowUpRight size={14} />
              </a>
            ))
          ) : (
            <EmptyState label="No source link" />
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
          <span className="eyebrow">China Humanoid Robotics</span>
          <h1>Research Dashboard</h1>
        </div>
        <div className="topbar-meta">
          <span>{today.date}</span>
          <Signal tone={today.status === "empty" ? "neutral" : "green"} />
        </div>
      </header>

      <nav className="nav-strip">
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
