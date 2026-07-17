import assert from "node:assert/strict";
import test from "node:test";
import { planQuery } from "../src/lib/query-intent";
import { runWithCompany } from "../src/lib/company-context";
import {
  detectCalendarPreference,
  normalizeToolArgs,
} from "../src/lib/tool-policy";
import { replaceAdDatesWithBs } from "../src/lib/nepali-date";
import { REFERENCE_DATE, REGRESSION_CASES } from "./regression-cases";

for (const regression of REGRESSION_CASES) {
  test(regression.id, () => {
    const plan = planQuery(regression.question, REFERENCE_DATE);
    assert.equal(plan.path, "deterministic");
    if (plan.path !== "deterministic") return;

    assert.equal(plan.intent, regression.intent);
    assert.equal(plan.tool, regression.tool);
    for (const [key, value] of Object.entries(regression.args)) {
      assert.deepEqual(plan.args[key], value, `unexpected ${key}`);
    }

    if (regression.id === "pending-sauda-product") {
      assert.match(String(plan.args.productQuery), /mustard cake 50 kgs/i);
      assert.equal(plan.args.query, undefined);
    }

    if (
      regression.id !== "explicit-ad" &&
      regression.id !== "pending-sauda-product"
    ) {
      assert.equal(plan.args.year, undefined);
      assert.equal(plan.args.fiscalYearStart, 2082);
    }
    if (regression.id === "pending-sauda-product") {
      assert.equal(plan.args.fiscalYearStart, undefined);
      assert.equal(plan.args.allTime, true);
    }
  });
}

test("explicit all-time overrides the default fiscal year", () => {
  const args = normalizeToolArgs(
    "get_product_sales",
    { year: 2026 },
    "mustard sales all synced history",
    REFERENCE_DATE,
  );
  assert.deepEqual(args, { allTime: true });
});

test("pending sauda defaults to all locked orders but honors explicit FY", () => {
  assert.deepEqual(
    normalizeToolArgs(
      "get_pending_sauda",
      { fiscalYearStart: 2083 },
      "show pending sauda of mustard cake",
      REFERENCE_DATE,
    ),
    { allTime: true },
  );
  assert.deepEqual(
    normalizeToolArgs(
      "get_pending_sauda",
      {},
      "show pending sauda of mustard cake for fiscal year 2082/83",
      REFERENCE_DATE,
    ),
    { fiscalYearStart: 2082, nepaliMonth: undefined },
  );
});

test('"show me" is not included in pending-sauda product filter', () => {
  const plan = planQuery(
    "show me pending sauda of mustard cake",
    REFERENCE_DATE,
  );
  assert.equal(plan.path, "deterministic");
  if (plan.path === "deterministic") {
    assert.equal(plan.tool, "get_pending_sauda");
    assert.equal(plan.args.productQuery, "mustard cake");
    assert.equal(plan.args.allTime, true);
  }
});

test("default output date policy converts AD dates to BS", () => {
  assert.equal(detectCalendarPreference("sales this year"), "bs");
  const converted = replaceAdDatesWithBs(
    "Synced 2026-07-14 and due July 20, 2026.",
  );
  assert.doesNotMatch(converted, /2026-07-14|July 20, 2026/);
  assert.match(converted, /2083\s+Asar/);
});

test("explicit AD request keeps the AD calendar preference", () => {
  assert.equal(detectCalendarPreference("sales for June 2026 AD"), "ad");
});

test("outstanding customer rankings are not customer-name lookups", () => {
  const topOne = planQuery("top customer outstanding ?", REFERENCE_DATE);
  assert.equal(topOne.path, "deterministic");
  if (topOne.path === "deterministic") {
    assert.equal(topOne.tool, "get_outstanding_receivables");
    assert.equal(topOne.args.limit, 1);
  }

  const topFive = planQuery(
    "top 5 customers outstanding",
    REFERENCE_DATE,
  );
  assert.equal(topFive.path, "deterministic");
  if (topFive.path === "deterministic") {
    assert.equal(topFive.tool, "get_outstanding_receivables");
    assert.equal(topFive.args.limit, 5);
    assert.equal(topFive.args.query, undefined);
  }
});

test("average selling price wording is removed from product filters", () => {
  const plan = planQuery(
    "mustard cake sales average selling price",
    REFERENCE_DATE,
  );
  assert.equal(plan.path, "deterministic");
  if (plan.path === "deterministic") {
    assert.equal(plan.tool, "get_product_sales");
    assert.equal(plan.args.query, "mustard cake");
  }
});

test("top customers in a named branch routes to branch-filtered sales", () => {
  const plan = runWithCompany("saurabhfood", () =>
    planQuery("top 10 customer in Biratnagar branch", REFERENCE_DATE),
  );
  assert.equal(plan.path, "deterministic");
  if (plan.path === "deterministic") {
    assert.equal(plan.tool, "get_top_customers");
    assert.equal(plan.args.limit, 10);
    assert.equal(plan.args.branchCode, "B");
    assert.equal(plan.args.fiscalYearStart, 2082);
  }
});
