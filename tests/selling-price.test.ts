import assert from "node:assert/strict";
import test from "node:test";
import {
  averageCustomerSellingPrice,
  buildItemUnitPriceReference,
  inferMissingUomPackFactor,
  meanPositiveRates,
  unitPriceToPerMetricTon,
} from "../src/lib/selling-price";
import type { UomIndex } from "../src/lib/uom-convert";

test("customer A at 300 and B at 500 averages to 400", () => {
  const result = averageCustomerSellingPrice([
    { rate: 300 },
    { rate: 500 },
  ]);

  assert.equal(result.average, 400);
  assert.equal(result.customerCount, 2);
});

test("average selling price gives every customer equal weight", () => {
  const result = averageCustomerSellingPrice([
    { amount: 10 * 50, quantity: 10 },
    { amount: 1 * 100, quantity: 1 },
  ]);

  assert.equal(result.average, 75);
  assert.equal(result.customerCount, 2);
});

test("preferred rate overrides amount÷quantity fallback", () => {
  const result = averageCustomerSellingPrice([
    { rate: 300, amount: 10_000, quantity: 1 },
    { rate: 500, amount: 1, quantity: 100 },
  ]);

  assert.equal(result.average, 400);
});

test("unitPrice converts to NPR/MT via UOM without depending on line qty", () => {
  const index: UomIndex = {
    baseUnit: new Map([["ITEM1", "KG"]]),
    salesUnit: new Map([["ITEM1", "POUCH"]]),
    // 1 pouch = 0.455 KG → 0.000455 MT
    qtyPer: new Map([["ITEM1|POUCH", 0.455]]),
  };

  const rate = unitPriceToPerMetricTon(index, "ITEM1", 108, "POUCH");
  assert.ok(rate != null);
  assert.ok(Math.abs((rate as number) - 108 / 0.000455) < 0.01);
});

test("meanPositiveRates ignores null and non-positive values", () => {
  assert.equal(meanPositiveRates([300, null, 500, 0, undefined]), 400);
  assert.equal(meanPositiveRates([null, 0]), null);
});

test("infers a 20-pouch pack when a missing-UOM price is carton-based", () => {
  const references = buildItemUnitPriceReference([
    { itemNo: "ITEM1", unitPrice: 106, quantity: 100 },
    { itemNo: "ITEM1", unitPrice: 108, quantity: 200 },
    { itemNo: "ITEM1", unitPrice: 110, quantity: 100 },
    { itemNo: "ITEM1", unitPrice: 2150.442, quantity: 200 },
  ]);

  assert.equal(references.get("ITEM1"), 109);
  assert.equal(
    inferMissingUomPackFactor(2150.442, references.get("ITEM1")),
    20,
  );
});

test("does not infer a pack when normalized price is not close to reference", () => {
  assert.equal(inferMissingUomPackFactor(750, 108), 1);
});
