import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  projectSerenityOutputIndex,
  projectSerenityOutputSummary,
  serenityDetailFileName,
} from "../scripts/dashboard/serenity-output-projection.mjs";

const sourceRow = {
  id: "serenity_review_yeeda",
  entityId: "yeeda",
  name: "怡合达",
  generatedAt: "2026-07-23T14:50:20+08:00",
  status: "serenity_ai_review",
  provider: {
    externalCall: true,
    rawResponse: "must not enter the index",
  },
  display: {
    summary: "平台型零部件公司",
    view: "继续观察",
    toVerify: ["客户验证"],
    stockRadar: {
      generatedAt: "2026-07-23T14:50:20+08:00",
      symbol: "301029.SZ",
      quote: { price: 27.47, changePct: 1.1 },
      ai: {
        actionGrade: {
          tier: "WAIT_FOR_PRICE",
          label: "公司可看，价格不合适",
          researchRating: "A",
          nextCondition: "等待估值回到更合理区间。",
          metrics: {
            pe: 99,
          },
        },
        actionReadiness: "WAIT_FOR_BUY_POINT",
        currentAction: "等待更合适的买点",
        priorityScore: 88,
        decisionReason: "must stay in the detail",
      },
      movement: {
        confirmed: ["订单增长"],
      },
      evidence: {
        cards: [{ fact: "must stay in the detail" }],
      },
    },
  },
  analysisQuote: { price: 27.47, asOf: "2026-07-15" },
  latestQuote: { price: 25, asOf: "2026-07-23" },
  quoteStatus: { displaySource: "latest_market" },
};

test("Serenity output summary keeps list fields without mutating the full analysis", () => {
  const before = structuredClone(sourceRow);
  const summary = projectSerenityOutputSummary(sourceRow);

  assert.deepEqual(sourceRow, before);
  assert.equal(summary.entityId, "yeeda");
  assert.equal(summary.provider.externalCall, true);
  assert.equal(summary.display.stockRadar.symbol, "301029.SZ");
  assert.equal(summary.display.stockRadar.ai.priorityScore, 88);
  assert.deepEqual(summary.display.stockRadar.ai.actionGrade, {
    tier: "WAIT_FOR_PRICE",
    label: "公司可看，价格不合适",
  });
  assert.equal(summary.latestQuote.price, 25);
  assert.match(summary.searchText, /公司可看，价格不合适/u);
  assert.equal(summary.display.stockRadar.evidence, undefined);
  assert.equal(summary.provider.rawResponse, undefined);
});

test("Serenity output index preserves collection metadata and row order", () => {
  const index = projectSerenityOutputIndex({
    date: "2026-07-23",
    generatedAt: "2026-07-23T15:00:00+08:00",
    contractType: "serenity_output_collection",
    totals: { outputs: 1 },
    rows: [sourceRow],
  });

  assert.equal(index.rows.length, 1);
  assert.equal(index.rows[0].entityId, "yeeda");
  assert.deepEqual(index.totals, { outputs: 1 });
});

test("Serenity detail filenames only accept generated entity ids", () => {
  assert.equal(serenityDetailFileName("yeeda"), "yeeda.json");
  assert.throws(() => serenityDetailFileName("../yeeda"), /Invalid Serenity detail entity id/u);
});

test("generated Serenity details remain identical to the complete dashboard output", async () => {
  const dashboardDir = path.resolve("data/dashboard");
  const completeOutput = JSON.parse(
    await fs.readFile(path.join(dashboardDir, "serenity_outputs.json"), "utf8")
  );
  const index = JSON.parse(
    await fs.readFile(path.join(dashboardDir, "serenity_output_index.json"), "utf8")
  );

  assert.equal(index.rows.length, completeOutput.rows.length);
  for (const row of completeOutput.rows) {
    const detail = JSON.parse(
      await fs.readFile(
        path.join(
          dashboardDir,
          "serenity_output_details",
          serenityDetailFileName(row.entityId)
        ),
        "utf8"
      )
    );
    assert.deepEqual(detail, row);
  }
});
