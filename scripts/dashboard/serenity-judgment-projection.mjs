import { serenityDetailFileName } from "./serenity-output-projection.mjs";

function judgmentDateKey(snapshot) {
  return String(snapshot?.date || snapshot?.capturedAt || "");
}

export function judgmentBaselineOf(history) {
  const snapshots = (history?.snapshots || [])
    .filter((snapshot) => typeof snapshot?.price === "number")
    .slice()
    .sort((a, b) => judgmentDateKey(a).localeCompare(judgmentDateKey(b)));
  const baseline = snapshots[0]
    || (typeof history?.latest?.price === "number" ? history.latest : null);

  if (!baseline) return null;
  return {
    date: baseline.date || null,
    market: baseline.market || null,
    price: baseline.price,
  };
}

export function projectSerenityJudgmentIndex(judgments) {
  return {
    date: judgments.date,
    generatedAt: judgments.generatedAt,
    contractType: judgments.contractType,
    rows: (judgments.rows || []).map((history) => ({
      entityId: history.entityId,
      baseline: judgmentBaselineOf(history),
    })),
  };
}

export function serenityJudgmentDetailFileName(entityId) {
  return serenityDetailFileName(entityId);
}
