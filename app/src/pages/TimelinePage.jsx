import timeline from "@data/dashboard/timeline.json";

function datePart(value) {
  if (!value) return "--";
  return String(value).slice(5);
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

function groupTimeline(nodes) {
  const groups = new Map();
  for (const node of nodes || []) {
    const year = String(node.date || "").slice(0, 4) || "未知";
    if (!groups.has(year)) groups.set(year, []);
    groups.get(year).push(node);
  }
  return Array.from(groups.entries()).sort(([a], [b]) => b.localeCompare(a));
}

export default function TimelinePage({ openEvidence }) {
  const nodes = timeline.recentNodes || (timeline.nodes || []).slice().reverse();
  const groups = groupTimeline(nodes);

  return (
    <DetailShell title="时间轴" meta={timeline.date}>
      {groups.length ? (
        <div className="github-timeline">
          {groups.map(([year, rows]) => (
            <section key={year}>
              <h3>{year}</h3>
              <div>
                {rows.map((node) => (
                  <button
                    key={node.id}
                    className="github-timeline-node"
                    onClick={() => openEvidence(node)}
                  >
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
      ) : <EmptyState>暂无时间轴事件</EmptyState>}
    </DetailShell>
  );
}
