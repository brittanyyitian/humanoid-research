function compactProvider(provider) {
  if (!provider) return null;
  return {
    externalCall: Boolean(provider.externalCall),
  };
}

function compactRadar(radar) {
  if (!radar) return null;
  return {
    generatedAt: radar.generatedAt || null,
    symbol: radar.symbol || null,
    quote: radar.quote || null,
    ai: radar.ai
      ? {
          actionGrade: radar.ai.actionGrade
            ? {
                tier: radar.ai.actionGrade.tier || null,
                label: radar.ai.actionGrade.label || null,
              }
            : null,
          actionReadiness: radar.ai.actionReadiness || null,
          currentAction: radar.ai.currentAction || null,
          priorityScore: radar.ai.priorityScore ?? null,
        }
      : null,
    review: radar.review
      ? {
          status: radar.review.status || "pending",
        }
      : null,
  };
}

function searchTextFor(row, radar) {
  return [
    row.name,
    row.display?.summary,
    row.display?.view,
    row.display?.currentFocus,
    ...(row.display?.toVerify || []),
    radar?.symbol,
    radar?.ai?.actionGrade?.label,
    radar?.ai?.type,
    radar?.ai?.currentAction,
    ...(radar?.movement?.confirmed || []),
    ...(radar?.movement?.possible || []),
    ...(radar?.risk || []),
  ]
    .filter(Boolean)
    .join(" ");
}

export function projectSerenityOutputSummary(row) {
  const radar = row?.display?.stockRadar || null;
  return {
    id: row.id,
    entityId: row.entityId,
    name: row.name,
    generatedAt: row.generatedAt || null,
    status: row.status || null,
    provider: compactProvider(row.provider),
    searchText: searchTextFor(row, radar),
    display: {
      summary: row.display?.summary || null,
      stockRadar: compactRadar(radar),
    },
    analysisQuote: row.analysisQuote || null,
    latestQuote: row.latestQuote || null,
    quoteStatus: row.quoteStatus || null,
  };
}

export function projectSerenityOutputIndex(outputs) {
  return {
    date: outputs.date,
    generatedAt: outputs.generatedAt,
    contractType: outputs.contractType,
    totals: outputs.totals,
    rows: (outputs.rows || []).map(projectSerenityOutputSummary),
  };
}

export function serenityDetailFileName(entityId) {
  const value = String(entityId || "");
  if (!/^[a-z0-9_]+$/u.test(value)) {
    throw new Error(`Invalid Serenity detail entity id: ${value || "<empty>"}`);
  }
  return `${value}.json`;
}
