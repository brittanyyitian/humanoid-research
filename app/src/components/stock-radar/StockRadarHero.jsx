export default function StockRadarHero({
  curatorPickCount,
  deepAnalysisCount,
  latestTime,
  sectorCount,
  userFocusCount,
  withheldCount,
}) {
  return (
    <section className="stock-radar-hero" aria-label="股票雷达更新状态">
      <div className="stock-radar-update">
        <span>更新于 {latestTime}</span>
        <i aria-hidden="true">↻</i>
      </div>
      <div className="stock-radar-meta">
        <span>{sectorCount} 支标的 · {deepAnalysisCount} 支深度分析 · {withheldCount} 支待深研</span>
        {userFocusCount || curatorPickCount ? (
          <small>你的重点 {userFocusCount} · 建议关注 {curatorPickCount}</small>
        ) : null}
      </div>
    </section>
  );
}
