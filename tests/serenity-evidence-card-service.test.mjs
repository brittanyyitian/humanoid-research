import assert from "node:assert/strict";
import test from "node:test";

import { alignEvidenceTestReasons } from "../scripts/services/serenity-evidence-card-service.mjs";

test("evidence conclusions follow their semantic test instead of array position", () => {
  const tests = [
    {
      test: "订单是否已转化为核心产品收入",
      current_result: "订单、产量和核心产品收入连续上升。",
    },
    {
      test: "人形机器人客户证据是否达到可识别量产",
      current_result: "客户持续采购并进入量产。",
    },
    {
      test: "增长是否继续在2026年一季度兑现",
      current_result: "收入和利润增长，但经营现金流偏弱。",
    },
    {
      test: "产能是否已形成紧缺瓶颈",
      current_result: "产能仍有余量，新项目延期。",
    },
    {
      test: "市场隐含增长是否被基本面证据覆盖",
      method: "对照订单、客户、产能与财务兑现。",
    },
  ];
  const inferred = [
    "订单、产量和核心产品收入同向增长，说明收入传导已经发生。",
    "客户采购说明人形机器人需求已经走向量产。",
    "现有产能仍有余量且新项目延期，绝对产能并不紧缺。",
    "利润增长而经营现金流偏弱，后续取决于回款和库存消化。",
  ];

  assert.deepEqual(alignEvidenceTestReasons(tests, inferred), [
    inferred[0],
    inferred[1],
    inferred[3],
    inferred[2],
    null,
  ]);
});

test("standard financial, business and price tests keep their explicit meanings", () => {
  const inferred = ["财务结论", "业务结论", "价格结论"];
  const tests = [
    { test: "财务是否真正兑现" },
    { test: "核心业务是否落到公司" },
    { test: "价格有没有确认" },
    { test: "最重要的反方是什么" },
  ];

  assert.deepEqual(alignEvidenceTestReasons(tests, inferred), [
    "财务结论",
    "业务结论",
    "价格结论",
    null,
  ]);
});
