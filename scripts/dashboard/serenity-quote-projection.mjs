function quoteDate(value) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{10}$|^\d{13}$/u.test(text)) {
    const milliseconds = text.length === 10 ? Number(text) * 1000 : Number(text);
    const date = new Date(milliseconds);
    return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
  }
  if (/^(?:19|20)\d{6}/u.test(text)) {
    return `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  }
  const match = text.match(/^\d{4}-\d{2}-\d{2}/u);
  return match?.[0] || null;
}

function latestQuoteFromMarket(marketRow, targetDate) {
  if (!marketRow) return null;
  return {
    price: marketRow.price ?? null,
    changePct: marketRow.changePct ?? null,
    turnoverText: marketRow.turnoverAmount ?? null,
    turnoverRate: marketRow.turnoverRate ?? null,
    totalMarketCap: marketRow.totalMarketCap ?? null,
    floatMarketCap: marketRow.floatMarketCap ?? null,
    fiveDayChangePct: marketRow.fiveDayChangePct ?? null,
    twentyDayChangePct: marketRow.twentyDayChangePct ?? null,
    capturedAt: marketRow.capturedAt ?? null,
    quoteTime: marketRow.quoteTime ?? null,
    asOf: marketRow.quoteTime || marketRow.capturedAt || targetDate,
    source: "daily_market_snapshot",
  };
}

export function projectSerenityQuotes(output, marketRow, targetDate) {
  const analysisQuote = output.display?.stockRadar?.quote || null;
  const latestQuote = latestQuoteFromMarket(marketRow, targetDate);
  const analysisAsOf = analysisQuote?.asOf || output.generatedAt || null;
  const latestAsOf = latestQuote?.asOf || null;
  const analysisDate = quoteDate(analysisAsOf);
  const latestDate = quoteDate(latestAsOf);

  return {
    analysisQuote,
    latestQuote,
    quoteStatus: {
      displaySource: latestQuote ? "latest_market" : analysisQuote ? "analysis_record" : "missing",
      latestAvailable: Boolean(latestQuote),
      analysisAsOf,
      latestAsOf,
      analysisIsOlder: Boolean(analysisDate && latestDate && analysisDate < latestDate),
    },
  };
}

export function assertSerenityQuoteProjection(row, marketRow) {
  if (!marketRow) return;
  if (!row.latestQuote) {
    throw new Error(`Serenity quote projection missing latestQuote for ${row.entityId}`);
  }
  if (row.latestQuote.price !== marketRow.price) {
    throw new Error(
      `Serenity quote projection price mismatch for ${row.entityId}: ${row.latestQuote.price} !== ${marketRow.price}`
    );
  }
  if (row.latestQuote.changePct !== marketRow.changePct) {
    throw new Error(
      `Serenity quote projection change mismatch for ${row.entityId}: ${row.latestQuote.changePct} !== ${marketRow.changePct}`
    );
  }
}
