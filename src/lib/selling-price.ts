import {
  quantityToMetricTons,
  type UomIndex,
} from "./uom-convert";

export type CustomerPriceTotals = {
  amount?: number;
  quantity?: number;
  /**
   * Preferred effective rate (e.g. NPR/MT from unitPrice×UOM).
   * When set, this rate is used instead of amount÷quantity.
   */
  rate?: number | null;
};

type UnitPriceLine = {
  itemNo?: string;
  unitPrice?: number;
  quantity?: number;
};

const COMMON_PACK_FACTORS = [2, 4, 5, 6, 10, 12, 20, 24, 25, 30, 40, 50, 100];

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

/**
 * Build the normal per-sales-UOM price for each item from synced order lines.
 * The median is intentionally robust to a small number of carton-priced lines.
 */
export function buildItemUnitPriceReference(
  lines: Iterable<UnitPriceLine>,
): Map<string, number> {
  const prices = new Map<string, number[]>();
  for (const line of lines) {
    const itemNo = String(line.itemNo ?? "").trim();
    const price = Number(line.unitPrice ?? 0);
    if (!itemNo || !Number.isFinite(price) || price <= 0) continue;
    if (Number(line.quantity ?? 0) <= 0) continue;
    const rows = prices.get(itemNo) ?? [];
    rows.push(price);
    prices.set(itemNo, rows);
  }

  const references = new Map<string, number>();
  for (const [itemNo, rows] of prices) {
    const value = median(rows);
    if (value != null && value > 0) references.set(itemNo, value);
  }
  return references;
}

/**
 * Infer when a missing-UOM order line is priced per carton/pack.
 *
 * Example: normal pouch price ≈108, line price ≈2,150, ratio ≈20, therefore
 * the line represents a 20-pouch pack. The inference is conservative: only
 * known pack sizes within 15% of the item's normal unit price are accepted.
 */
export function inferMissingUomPackFactor(
  unitPrice: number,
  referenceUnitPrice: number | null | undefined,
): number {
  const price = Number(unitPrice);
  const reference = Number(referenceUnitPrice);
  if (
    !Number.isFinite(price) ||
    !Number.isFinite(reference) ||
    price <= 0 ||
    reference <= 0
  ) {
    return 1;
  }

  let bestFactor = 1;
  let bestDeviation = Number.POSITIVE_INFINITY;
  for (const factor of COMMON_PACK_FACTORS) {
    const normalizedPrice = price / factor;
    const deviation = Math.abs(normalizedPrice - reference) / reference;
    if (deviation < bestDeviation) {
      bestDeviation = deviation;
      bestFactor = factor;
    }
  }

  return bestDeviation <= 0.15 ? bestFactor : 1;
}

/**
 * Unweighted mean of each customer's selling rate.
 *
 * Example: customer A @ 300 NPR/MT and B @ 500 NPR/MT → 400.
 * Volume does not matter.
 *
 * Prefer `rate` when provided; otherwise fall back to amount÷quantity.
 */
export function averageCustomerSellingPrice(
  totals: Iterable<CustomerPriceTotals>,
): { average: number | null; customerCount: number } {
  const rates: number[] = [];
  for (const row of totals) {
    if (row.rate != null && Number.isFinite(row.rate) && row.rate > 0) {
      rates.push(row.rate);
      continue;
    }
    const amount = Number(row.amount);
    const quantity = Number(row.quantity);
    if (!Number.isFinite(amount) || !Number.isFinite(quantity)) continue;
    if (quantity <= 0) continue;
    rates.push(amount / quantity);
  }

  return {
    average:
      rates.length > 0
        ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length
        : null,
    customerCount: rates.length,
  };
}

/**
 * Convert a line unit price (per sales UOM) into NPR per metric ton
 * using the same UOM→KG÷1000 path as quantity conversion.
 *
 * Example: unitPrice 108 NPR/pouch with 0.455 KG/pouch → 108 × 1000 / 0.455 NPR/MT.
 * This avoids amount÷MT outliers when quantity MT is wrong but unitPrice is fine.
 */
export function unitPriceToPerMetricTon(
  index: UomIndex,
  itemNo: string,
  unitPrice: number,
  unitOfMeasureCode?: string,
): number | null {
  const price = Number(unitPrice);
  if (!Number.isFinite(price) || price <= 0) return null;

  // Convert a large sample so tiny pouch→MT factors are not lost to 4dp rounding.
  const sampleQty = 1000;
  const mt = quantityToMetricTons(index, itemNo, sampleQty, unitOfMeasureCode);
  if (!mt.convertible || mt.metricTons == null || mt.metricTons <= 0) {
    return null;
  }

  const mtPerUnit = mt.metricTons / sampleQty;
  if (mtPerUnit <= 0) return null;

  return price / mtPerUnit;
}

/** Mean of finite positive rates, or null. */
export function meanPositiveRates(
  rates: Iterable<number | null | undefined>,
): number | null {
  const values: number[] = [];
  for (const rate of rates) {
    if (rate == null || !Number.isFinite(rate) || rate <= 0) continue;
    values.push(rate);
  }
  if (values.length === 0) return null;
  return values.reduce((sum, rate) => sum + rate, 0) / values.length;
}
