import candidateFunnelData from "@data/dashboard/candidate_funnel.json";
import dataAcquisitionMatrixData from "@data/dashboard/data_acquisition_matrix.json";
import gaps from "@data/dashboard/gaps.json";
import relations from "@data/dashboard/relations.json";
import researchGatesData from "@data/dashboard/research_gates.json";
import reviewCycleData from "@data/dashboard/review_cycle.json";
import serenityAnalysis from "@data/dashboard/serenity_analysis.json";
import serenityBridge from "@data/dashboard/serenity_bridge.json";
import serenityMaterials from "@data/dashboard/serenity_materials.json";
import serenityOutputs from "@data/dashboard/serenity_outputs.json";
import sourceRegistry from "@data/dashboard/sources.json";
import stats from "@data/dashboard/stats.json";
import upcoming from "@data/dashboard/upcoming.json";

function formatTime(value) {
  if (!value) return "--";
  return String(value).replace("T", " ").replace("+08:00", "");
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
    title: row.status === "serenity_ai_review"
      ? `${row.name} · Serenity 看法`
      : row.display?.title || `${row.name} 研究重点`,
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

function buildEvidenceFromSource(source) {
  return {
    title: source.title,
    fact: source.title,
    evidenceLevel: source.evidenceLevel,
    module: source.sourceType,
    date: source.publishedAt || source.capturedAt || stats.date,
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

export default function DatabasePage({ openEvidence }) {
  const sourceRows = sourceRegistry.rows || [];
  const levelRows = Object.entries(stats.evidenceLevels || {});
  const serenityTotals = serenityBridge.totals || {};
  const analysisTotals = serenityAnalysis.totals || {};
  const analysisRows = serenityAnalysis.rows || [];
  const outputTotals = serenityOutputs.totals || {};
  const outputRows = serenityOutputs.rows || [];
  const materialTotals = serenityMaterials.totals || {};
  const materialRows = serenityMaterials.rows || [];
  const acquisitionRows = dataAcquisitionMatrixData.rows || [];
  const acquisitionBlocked = acquisitionRows.filter((row) => row.acquisitionState === "has_blockers").length;
  const acquisitionPartial = acquisitionRows.filter((row) => row.acquisitionState === "partial").length;
  const gateRows = researchGatesData.rows || [];
  const gateCounts = gateRows.reduce((acc, row) => {
    acc[row.gate] = (acc[row.gate] || 0) + 1;
    return acc;
  }, {});
  const funnelLayers = candidateFunnelData.layerRows || [];
  const funnelShortlist = candidateFunnelData.shortlist || [];
  const reviewSummary = reviewCycleData.summary || {};

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

      <section className="workspace-section system-status-section">
        <header>
          <h3>系统状态</h3>
          <span>{formatTime(serenityAnalysis.generatedAt)}</span>
        </header>
        <div className="research-command-grid system-command-grid">
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
            <strong>{reviewSummary.due || 0}</strong>
            <small>{reviewSummary.total || 0} 个任务 · 已到期</small>
          </div>
        </div>

        <div className="layer-command-row system-layer-row">
          {funnelLayers.slice(0, 6).map((layer) => (
            <button key={layer.layerId} className="layer-command-chip">
              <strong>{layer.label}</strong>
              <span>{layer.entityCount} 对象 · {layer.readyCount} 可复核</span>
              <em>瓶颈 {layer.bottleneckRank}/10</em>
            </button>
          ))}
        </div>
      </section>

      <section className="workspace-section">
        <header>
          <h3>Serenity Materials</h3>
          <span>{materialTotals.materials || 0}</span>
        </header>
        <div className="status-board database-board">
          <OverviewItem label="材料" value={materialTotals.materials || 0} />
          <OverviewItem
            label="可读正文"
            value={(materialTotals.fullText || 0) + (materialTotals.structuredPayload || 0)}
          />
          <OverviewItem label="仅标题" value={materialTotals.metadataOnly || 0} />
          <OverviewItem label="待审 Claim" value={materialTotals.pendingClaims || 0} />
        </div>
        <div className="database-list">
          {materialRows.slice(0, 8).map((row) => (
            <button
              key={row.id}
              onClick={() =>
                openEvidence({
                  title: row.title,
                  fact: row.nextAction,
                  module: row.materialType,
                  evidenceLevel: row.sourceLevel || "--",
                  sources: [
                    {
                      id: row.sourceId,
                      title: row.publisher,
                      publisher: row.publisher,
                      url: row.url,
                      evidenceLevel: row.sourceLevel || "--",
                    },
                  ],
                })
              }
            >
              <span>{row.bodyStatusLabel}</span>
              <strong>{row.title}</strong>
              <small>
                {row.entityNames?.join(" / ") || "未绑定对象"} · {row.materialType} · {row.nextAction}
              </small>
            </button>
          ))}
        </div>
      </section>

      <section className="workspace-section">
        <header>
          <h3>研究重点</h3>
          <span>{outputTotals.researchBriefs || outputTotals.outputs || 0} 已整理</span>
        </header>
        <div className="status-board database-board">
          <OverviewItem label="对象" value={analysisTotals.rows || 0} />
          <OverviewItem label="可分析" value={analysisTotals.readyForSerenity || 0} />
          <OverviewItem label="已整理" value={outputTotals.outputs || 0} />
          <OverviewItem label="观察问题" value={outputTotals.forecastCandidates || 0} />
        </div>
        <div className="database-list">
          {outputRows.length ? outputRows.slice(0, 6).map((row) => (
            <button key={row.id} onClick={() => openEvidence(buildSerenityOutputEvidence(row))}>
              <span>{row.provider?.externalCall ? "Serenity" : row.display?.label || "研究重点"}</span>
              <strong>{row.name}</strong>
              <small>
                {row.display?.currentFocus || row.display?.summary} 待验证：
                {row.display?.toVerify?.slice(0, 3).join(" / ") || "等待新材料"}
              </small>
            </button>
          )) : analysisRows.slice(0, 6).map((row) => (
            <button
              key={row.entityId}
              onClick={() =>
                openEvidence({
                  title: `${row.name} 待整理`,
                  fact: row.analysisStatus?.reason || row.analysisDraft?.text,
                  module: "研究重点",
                  evidenceLevelLabel: "待整理",
                  sources:
                    row.inputPack?.topMaterialRefs?.slice(0, 5).map((material) => ({
                      id: material.rawArtifactId,
                      title: material.title,
                      publisher: material.publisher,
                      url: material.url,
                      evidenceLevel: material.sourceLevel || "--",
                    })) || [],
                })
              }
            >
              <span>{row.analysisStatus?.label || "待整理"}</span>
              <strong>{row.name}</strong>
              <small>
                {row.analysisStatus?.reason || "等待材料整理"} 下一问：
                {row.nextQuestions?.[0] || "等待新材料"}
              </small>
            </button>
          ))}
        </div>
      </section>

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
                <small>{row.reviewStatus} · {row.confidence}</small>
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
                <strong>{row.entityAName} → {row.entityBName}</strong>
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
