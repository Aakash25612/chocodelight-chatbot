export type CustomerPriceTotals = {
  amount: number;
  quantity: number;
};

/**
 * Equal-customer average selling price.
 *
 * Each customer's effective rate (their amount ÷ their quantity) receives one
 * vote, regardless of how much that customer bought.
 */
export function averageCustomerSellingPrice(
  totals: Iterable<CustomerPriceTotals>,
): { average: number | null; customerCount: number } {
  const rates: number[] = [];
  for (const row of totals) {
    if (!Number.isFinite(row.amount) || !Number.isFinite(row.quantity)) continue;
    if (row.quantity <= 0) continue;
    rates.push(row.amount / row.quantity);
  }

  return {
    average:
      rates.length > 0
        ? rates.reduce((sum, rate) => sum + rate, 0) / rates.length
        : null,
    customerCount: rates.length,
  };
}
