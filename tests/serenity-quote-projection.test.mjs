import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSerenityQuoteProjection,
  projectSerenityQuotes,
} from "../scripts/dashboard/serenity-quote-projection.mjs";
import {
  quoteProjectionOf,
  stockRadarForDisplay,
} from "../app/src/domain/serenity/quotes.js";

test("latest market quote is projected without changing the analysis quote", () => {
  const analysisQuote = {
    price: 27.47,
    changePct: 1.1,
    asOf: "20260715161415",
  };
  const output = {
    entityId: "yeeda",
    generatedAt: "2026-07-23T14:50:20+08:00",
    display: {
      stockRadar: {
        quote: analysisQuote,
        ai: { companyScore: 91 },
      },
    },
  };
  const marketRow = {
    entityId: "yeeda",
    price: 25,
    changePct: -0.16,
    turnoverAmount: "102.00万",
    capturedAt: "2026-07-23T09:27:55+08:00",
    quoteTime: "20260723092736",
  };

  const projection = projectSerenityQuotes(output, marketRow, "2026-07-23");
  const dashboardRow = { ...output, ...projection };
  const displayRadar = stockRadarForDisplay(dashboardRow);

  assert.equal(output.display.stockRadar.quote, analysisQuote);
  assert.equal(output.display.stockRadar.quote.price, 27.47);
  assert.equal(projection.analysisQuote.price, 27.47);
  assert.equal(projection.latestQuote.price, 25);
  assert.equal(quoteProjectionOf(dashboardRow).displayQuote.price, 25);
  assert.equal(displayRadar.quote.price, 25);
  assert.equal(displayRadar.ai.companyScore, 91);
  assert.equal(projection.quoteStatus.analysisIsOlder, true);
  assert.doesNotThrow(() => assertSerenityQuoteProjection(dashboardRow, marketRow));
});

test("analysis quote remains the display fallback when the daily market quote is missing", () => {
  const output = {
    entityId: "private_company",
    display: {
      stockRadar: {
        quote: { price: 10, changePct: 0, asOf: "2026-07-22" },
      },
    },
  };

  const projection = projectSerenityQuotes(output, null, "2026-07-23");
  const display = quoteProjectionOf({ ...output, ...projection });

  assert.equal(projection.latestQuote, null);
  assert.equal(projection.quoteStatus.displaySource, "analysis_record");
  assert.equal(display.displayQuote.price, 10);
});

test("unix quote timestamps are compared as real dates", () => {
  const output = {
    entityId: "cambricon",
    display: {
      stockRadar: {
        quote: { price: 1260.01, asOf: 1784776289 },
      },
    },
  };
  const marketRow = {
    entityId: "cambricon",
    price: 1336,
    changePct: 1.98,
    quoteTime: "20260723092736",
  };

  const projection = projectSerenityQuotes(output, marketRow, "2026-07-23");

  assert.equal(projection.quoteStatus.analysisIsOlder, false);
  assert.equal(projection.quoteStatus.analysisAsOf, 1784776289);
});
