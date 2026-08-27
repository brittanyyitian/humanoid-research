function formatPct(value) {
  if (typeof value !== "number") return "--";
  return `${value > 0 ? "+" : ""}${value.toFixed(2)}%`;
}

function formatQuoteDate(value) {
  if (!value) return "--";
  const text = String(value);
  if (/^\d{10}$|^\d{13}$/u.test(text)) {
    const milliseconds = text.length === 10 ? Number(text) * 1000 : Number(text);
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? "--" : date.toISOString().slice(0, 10);
  }
  if (/^(?:19|20)\d{6}/u.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  return text.slice(0, 10);
}

function formatPrice(value) {
  return value === null || value === undefined || value === "" ? "--" : value;
}

export default function StockRadarQuoteSummary({
  analysisQuote,
  displayQuote,
  judgmentDate,
  judgmentPrice,
  quoteStatus,
}) {
  const usesLatestMarket = quoteStatus?.displaySource === "latest_market";
  const pricesDiffer =
    usesLatestMarket &&
    typeof analysisQuote?.price === "number" &&
    analysisQuote.price !== displayQuote?.price;

  return (
    <div className="radar-decision-meta">
      <span>{usesLatestMarket ? "最新价" : "分析记录价"} {formatPrice(displayQuote?.price)}</span>
      <span>今日 {formatPct(displayQuote?.changePct)}</span>
      <span>行情 {formatQuoteDate(quoteStatus?.latestAsOf || quoteStatus?.analysisAsOf)}</span>
      {pricesDiffer ? (
        <span>分析行情 {formatPrice(analysisQuote.price)} · {formatQuoteDate(quoteStatus?.analysisAsOf)}</span>
      ) : null}
      {typeof judgmentPrice === "number" ? (
        <span>复盘记录价 {judgmentPrice} · {formatQuoteDate(judgmentDate)}</span>
      ) : null}
    </div>
  );
}
