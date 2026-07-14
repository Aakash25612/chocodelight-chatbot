import assert from "node:assert/strict";
import test from "node:test";
import { averageCustomerSellingPrice } from "../src/lib/selling-price";

test("average selling price gives every customer equal weight", () => {
  const result = averageCustomerSellingPrice([
    { amount: 10 * 50, quantity: 10 },
    { amount: 1 * 100, quantity: 1 },
  ]);

  assert.equal(result.average, 75);
  assert.equal(result.customerCount, 2);
});

test("average selling price is the mean of customer rates", () => {
  const rates = [100, 105, 110, 115, 120, 125, 130, 140, 150, 160];
  const result = averageCustomerSellingPrice(
    rates.map((rate) => ({ amount: rate, quantity: 1 })),
  );

  assert.equal(
    result.average,
    rates.reduce((sum, rate) => sum + rate, 0) / rates.length,
  );
  assert.equal(result.customerCount, 10);
});
