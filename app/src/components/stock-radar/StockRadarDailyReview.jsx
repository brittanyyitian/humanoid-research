function formatPct(value) {
  if (typeof value !== "number") return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function compactTime(value) {
  if (!value) return "--";
  const text = String(value);
  if (text.includes("T")) return text.slice(11, 16);
  return text.slice(0, 5);
}

export default function StockRadarDailyReview({
  effectCounts,
  review,
  watchItems,
}) {
  return (
    <section className="radar-validation-section radar-daily-review">
      <header className="radar-daily-head">
        <div>
          <span>AI 每日复盘</span>
          <strong>{review.status}</strong>
        </div>
        <time>{String(review.updatedAt || "").slice(0, 10) || "--"} · {compactTime(review.updatedAt)}</time>
      </header>

      <div className="radar-daily-overview">
        <div className="radar-daily-assessment">
          <span>当前评价</span>
          <strong>{review.assessment}</strong>
          <p>{review.statusReason}</p>
        </div>
        <dl className="radar-daily-metrics">
          <div><dt>判断后涨跌</dt><dd>{formatPct(review.stockReturnPct)}</dd></div>
          <div><dt>相对观察池</dt><dd>{formatPct(review.excessReturnPct)}</dd></div>
          <div><dt>最大回撤</dt><dd>{formatPct(review.maxDrawdownPct)}</dd></div>
        </dl>
      </div>

      <div className="radar-daily-logic">
        <div><span>新证据</span><p>{review.evidenceUpdate}</p></div>
        <div>
          <span>{review.changed ? "为什么改判" : "为什么没改判"}</span>
          <p>{review.statusReason}</p>
        </div>
        <div>
          <span>理由状态</span>
          <p>
            {effectCounts.support} 条支撑 · {effectCounts.against} 条约束
            {effectCounts.unknown ? ` · ${effectCounts.unknown} 条待验` : ""}
          </p>
        </div>
      </div>

      <div className="radar-daily-ledger">
        <strong>判断变化记录</strong>
        {review.timeline.length ? review.timeline.map((item) => (
          <div key={`${item.date}_${item.label}`}>
            <time>{item.date}</time>
            <span>{item.label}</span>
            <b>{item.action}</b>
          </div>
        )) : <p>等待首次自动复盘记录。</p>}
      </div>

      <div className="radar-daily-watch">
        <span>接下来由系统自动关注</span>
        <div>{watchItems.map((item) => <b key={item}>{item}</b>)}</div>
      </div>
    </section>
  );
}
