export function quoteProjectionOf(row) {
  const radar = row?.display?.stockRadar || null;
  const analysisQuote = row?.analysisQuote || radar?.quote || null;
  const latestQuote = row?.latestQuote || null;
  const displayQuote = latestQuote
    ? { ...(analysisQuote || {}), ...latestQuote }
    : analysisQuote;

  return {
    analysisQuote,
    latestQuote,
    displayQuote,
    quoteStatus: row?.quoteStatus || {
      displaySource: latestQuote ? "latest_market" : analysisQuote ? "analysis_record" : "missing",
      latestAvailable: Boolean(latestQuote),
      analysisAsOf: analysisQuote?.asOf || row?.generatedAt || null,
      latestAsOf: latestQuote?.asOf || null,
      analysisIsOlder: false,
    },
  };
}

export function stockRadarForDisplay(row) {
  const radar = row?.display?.stockRadar || null;
  if (!radar) return null;
  const { displayQuote } = quoteProjectionOf(row);
  return displayQuote ? { ...radar, quote: displayQuote } : radar;
}
