const SEMANTIC_TERMS = [
  "订单",
  "产量",
  "核心产品",
  "收入",
  "客户",
  "人形机器人",
  "量产",
  "采购",
  "产能",
  "利用率",
  "项目",
  "延期",
  "精度",
  "工艺",
  "交付",
  "利润",
  "现金流",
  "存货",
  "库存",
  "应收",
  "回款",
  "价格",
  "估值",
  "市场",
  "技术",
  "买点",
  "走势",
  "增长",
  "风险",
  "债务",
  "成本",
];

function semanticOverlap(left, right) {
  const leftText = String(left || "");
  const rightText = String(right || "");
  return SEMANTIC_TERMS.reduce(
    (score, term) => score + Number(leftText.includes(term) && rightText.includes(term)),
    0
  );
}

function fixedInferenceIndex(title) {
  if (/财务/u.test(title)) return 0;
  if (/核心业务|业务是否/u.test(title)) return 1;
  if (/价格/u.test(title)) return 2;
  return null;
}

export function alignEvidenceTestReasons(evidenceTests, inferredReasons) {
  const tests = Array.isArray(evidenceTests) ? evidenceTests : [];
  const reasons = (Array.isArray(inferredReasons) ? inferredReasons : [])
    .map((item) => String(item || "").trim())
    .filter(Boolean);

  return tests.map((item, index) => {
    const title = String(item?.test || "");
    if (/反方|风险/u.test(title)) return null;

    const fixedIndex = fixedInferenceIndex(title);
    if (fixedIndex !== null && reasons[fixedIndex]) return reasons[fixedIndex];
    if (index >= reasons.length) return null;

    const evidenceText = [item?.test, item?.current_result, item?.method]
      .filter(Boolean)
      .join(" ");
    const currentScore = semanticOverlap(evidenceText, reasons[index]);
    let bestIndex = index;
    let bestScore = currentScore;

    reasons.forEach((reason, reasonIndex) => {
      const score = semanticOverlap(evidenceText, reason);
      if (score > bestScore) {
        bestIndex = reasonIndex;
        bestScore = score;
      }
    });

    return bestScore >= 2 && bestScore > currentScore
      ? reasons[bestIndex]
      : reasons[index] || null;
  });
}
