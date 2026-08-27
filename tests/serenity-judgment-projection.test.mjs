import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  judgmentBaselineOf,
  projectSerenityJudgmentIndex,
  serenityJudgmentDetailFileName,
} from "../scripts/dashboard/serenity-judgment-projection.mjs";

test("judgment baseline uses the earliest valid snapshot without mutating history", () => {
  const history = {
    entityId: "yeeda",
    latest: { date: "2026-07-23", price: 25, market: "SZSE" },
    snapshots: [
      { date: "2026-07-20", price: 26, market: "SZSE" },
      { date: "2026-07-15", price: 27.47, market: "SZSE" },
    ],
  };
  const before = structuredClone(history);

  assert.deepEqual(judgmentBaselineOf(history), {
    date: "2026-07-15",
    market: "SZSE",
    price: 27.47,
  });
  assert.deepEqual(history, before);
});

test("judgment baseline falls back to latest when snapshots are missing", () => {
  assert.deepEqual(
    judgmentBaselineOf({
      latest: { date: "2026-07-23", price: 25, market: "SZSE" },
      snapshots: [],
    }),
    { date: "2026-07-23", market: "SZSE", price: 25 }
  );
});

test("judgment index keeps only comparison baselines", () => {
  const index = projectSerenityJudgmentIndex({
    date: "2026-07-23",
    generatedAt: "2026-07-23T11:30:00+08:00",
    contractType: "serenity_judgment_history_index_v0",
    rows: [
      {
        entityId: "yeeda",
        latest: { date: "2026-07-23", price: 25, market: "SZSE" },
        snapshots: [{ date: "2026-07-15", price: 27.47, market: "SZSE" }],
      },
    ],
  });

  assert.deepEqual(index.rows, [
    {
      entityId: "yeeda",
      baseline: { date: "2026-07-15", market: "SZSE", price: 27.47 },
    },
  ]);
});

test("generated judgment details remain identical to the complete dashboard history", async () => {
  const dashboardDir = path.resolve("data/dashboard");
  const completeHistory = JSON.parse(
    await fs.readFile(path.join(dashboardDir, "serenity_judgments.json"), "utf8")
  );
  const index = JSON.parse(
    await fs.readFile(path.join(dashboardDir, "serenity_judgment_index.json"), "utf8")
  );

  assert.equal(index.rows.length, completeHistory.rows.length);
  for (const history of completeHistory.rows) {
    const detail = JSON.parse(
      await fs.readFile(
        path.join(
          dashboardDir,
          "serenity_judgment_details",
          serenityJudgmentDetailFileName(history.entityId)
        ),
        "utf8"
      )
    );
    assert.deepEqual(detail, history);
  }
});
