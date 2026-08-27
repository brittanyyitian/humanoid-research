import path from "node:path";
import {
  DATA_DIR,
  ensureArray,
  readJsonDir,
  readJsonFile,
  todayInShanghai,
  writeJsonFile,
} from "./data-utils.mjs";
import { nowShanghai } from "./services/router-service.mjs";

const targetDate = process.env.RESEARCH_DATE || todayInShanghai();
const outputRows = (await readJsonDir("analysis/serenity_outputs")).map((row) => row.data);
const marketRows = (await readJsonDir("stocks"))
  .flatMap((row) => ensureArray(row.data))
  .filter((row) => row.entityId && typeof row.price === "number")
  .sort((a, b) => String(a.date).localeCompare(String(b.date)));
const marketByEntityAndDate = new Map(marketRows.map((row) => [`${row.entityId}:${row.date}`, row]));
let writtenCount = 0;

for (const output of outputRows) {
  const radar = output.display?.stockRadar;
  if (!radar || !output.entityId) continue;
  const currentMarket = marketByEntityAndDate.get(`${output.entityId}:${targetDate}`);
  const filePath = path.join(DATA_DIR, "analysis", "serenity_judgments", `${output.entityId}.json`);
  const existing = await readOptionalJson(filePath);
  const snapshots = ensureArray(existing?.snapshots);
  const previous = snapshots.filter((item) => item.date < targetDate).sort((a, b) => b.date.localeCompare(a.date))[0];
  const snapshot = buildSnapshot(output, radar, currentMarket, previous);
  const nextSnapshots = [...snapshots.filter((item) => item.date !== targetDate), snapshot]
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-730)
    .map((item) => ({ ...item, validation: buildValidation(item) }));
  await writeJsonFile(filePath, {
    contractType: "serenity_judgment_history_v0",
    entityId: output.entityId,
    name: output.name,
    updatedAt: nowShanghai(),
    snapshots: nextSnapshots,
  });
  writtenCount += 1;
}

console.log(`Serenity judgment snapshots updated. date=${targetDate}, written=${writtenCount}`);

function buildSnapshot(output, radar, currentMarket, previous) {
  const price = currentMarket?.price ?? radar.quote?.price ?? null;
  const action = actionLabel(radar.ai?.actionReadiness, radar.ai?.currentAction);
  const reason = cleanReason(radar.ai?.type || output.display?.summary || radar.ai?.currentAction);
  return {
    id: `serenity_judgment_${output.entityId}_${targetDate}`,
    entityId: output.entityId,
    name: output.name,
    symbol: radar.symbol || output.sourceInputPack?.ticker || null,
    market: currentMarket?.market || null,
    date: targetDate,
    capturedAt: nowShanghai(),
    analysisGeneratedAt: output.generatedAt,
    analysisType: output.status === "serenity_ai_review" ? "deep_review" : "scorecard",
    action,
    actionReadiness: radar.ai?.actionReadiness || null,
    confidence: radar.ai?.confidence || null,
    reason,
    price,
    currency: radar.quote?.currency || "CNY",
    changePct: currentMarket?.changePct ?? radar.quote?.changePct ?? null,
    technicalTimingScore: radar.ai?.technicalTimingScore ?? radar.trend?.technicalTimingScore ?? null,
    marketPayoffScore: radar.ai?.marketPayoffScore ?? radar.sentiment?.marketPayoffScore ?? null,
    rating: radar.ai?.rating || null,
    judgmentChanged: Boolean(previous && (previous.action !== action || previous.reason !== reason)),
    triggers: {
      "30d": shortCheck(radar.triggers?.["30d"]?.[0], "买点是否出现"),
      "90d": shortCheck(radar.triggers?.["90d"]?.[0], "订单是否兑现"),
      "180d": shortCheck(radar.triggers?.["180d"]?.[0], "收入是否兑现"),
    },
  };
}

function buildValidation(snapshot) {
  return [30, 90, 180].map((days) => {
    const dueDate = addDays(snapshot.date, days);
    if (targetDate < dueDate) return { days, dueDate, status: "pending" };
    const endRow = marketRows.find((row) => row.entityId === snapshot.entityId && row.date >= dueDate);
    if (!endRow || typeof snapshot.price !== "number") return { days, dueDate, status: "missing_market" };
    const stockReturnPct = percentChange(snapshot.price, endRow.price);
    const poolReturnPct = observationPoolReturn(snapshot, endRow.date);
    const maxDrawdownPct = maxDrawdown(snapshot.entityId, snapshot.date, endRow.date, snapshot.price);
    return {
      days,
      dueDate,
      checkedAt: endRow.date,
      status: "verified",
      stockReturnPct,
      poolReturnPct,
      excessReturnPct: typeof poolReturnPct === "number" ? stockReturnPct - poolReturnPct : null,
      maxDrawdownPct,
      result: marketResult(snapshot.actionReadiness, stockReturnPct, poolReturnPct, maxDrawdownPct),
    };
  });
}

function observationPoolReturn(snapshot, endDate) {
  const group = marketGroup(snapshot.market);
  const startRows = marketRows.filter((row) => row.date === snapshot.date && marketGroup(row.market) === group);
  const returns = startRows
    .map((start) => {
      const end = marketByEntityAndDate.get(`${start.entityId}:${endDate}`);
      return end ? percentChange(start.price, end.price) : null;
    })
    .filter((value) => typeof value === "number")
    .sort((a, b) => a - b);
  if (!returns.length) return null;
  const middle = Math.floor(returns.length / 2);
  return returns.length % 2 ? returns[middle] : (returns[middle - 1] + returns[middle]) / 2;
}

function maxDrawdown(entityId, startDate, endDate, startPrice) {
  const prices = [
    startPrice,
    ...marketRows
      .filter((row) => row.entityId === entityId && row.date > startDate && row.date <= endDate)
      .map((row) => row.price),
  ];
  let peak = prices[0];
  let drawdown = 0;
  prices.forEach((price) => {
    peak = Math.max(peak, price);
    drawdown = Math.min(drawdown, ((price - peak) / peak) * 100);
  });
  return drawdown;
}

function marketResult(actionReadiness, stockReturn, poolReturn, maxDrawdownValue) {
  const excess = typeof poolReturn === "number" ? stockReturn - poolReturn : null;
  if (actionReadiness === "WAIT_FOR_BUY_POINT" || actionReadiness === "OBSERVE_ONLY") {
    if (typeof excess === "number" && excess >= 8) return "可能错过";
    if (stockReturn <= 0 || maxDrawdownValue <= -8) return "等待合理";
    return "仍不明确";
  }
  if (actionReadiness === "CORE_CANDIDATE" || actionReadiness === "STRONG_OBSERVE") {
    return stockReturn > 0 && (excess === null || excess > 0) ? "市场支持" : "市场不支持";
  }
  return "仅记录";
}

function shortCheck(value, fallback) {
  const text = String(value || "");
  if (/买点|均线|技术结构|趋势/u.test(text)) return "买点是否出现";
  if (/订单|客户采用|客户确认/u.test(text)) return "订单是否兑现";
  if (/收入|分部|财报/u.test(text)) return "收入是否兑现";
  if (/验收|项目/u.test(text)) return "项目是否按期";
  if (/估值|股本|市盈率|市销率/u.test(text)) return "估值是否匹配";
  return text.replace(/[。；]+$/u, "").slice(0, 16) || fallback;
}

function cleanReason(value) {
  return String(value || "")
    .replace(/^Serenity\s*判断为[“"]?/u, "")
    .replace(/[”"]，?适合继续.*$/u, "")
    .replace(/[。；]+$/u, "")
    .slice(0, 48);
}

function actionLabel(readiness, fallback) {
  return {
    CORE_CANDIDATE: "核心候选",
    STRONG_OBSERVE: "值得重点观察",
    CANDIDATE_POOL: "放入候选池",
    WAIT_FOR_BUY_POINT: "等待更合适的买点",
    DATA_GATED: "关键数据不足",
    RESEARCH_GATED: "分析尚未完成",
    LEAD_TRACKING: "继续跟踪线索",
    ELIMINATE: "暂时排除",
    OBSERVE_ONLY: "只观察",
  }[readiness] || String(fallback || "等待验证").replace(/[。.]$/u, "");
}

function marketGroup(market) {
  return market === "HKEX" ? "HK" : "CN";
}

function percentChange(start, end) {
  return ((end - start) / start) * 100;
}

function addDays(value, days) {
  const date = new Date(`${value}T00:00:00+08:00`);
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

async function readOptionalJson(filePath) {
  try {
    return await readJsonFile(filePath);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
