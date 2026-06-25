const AMOUNT_LOCALE = "en-IN";

/** NPR amounts — Indian grouping: 12,34,567.89 */
export function formatAmount(value: unknown): string {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return "0.00";
  return new Intl.NumberFormat(AMOUNT_LOCALE, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(number);
}

/** Whole or decimal numbers without forcing cents — Indian grouping */
export function formatNumber(value: unknown, maxFractionDigits = 2): string {
  const number = Number(value ?? 0);
  if (!Number.isFinite(number)) return "0";
  return new Intl.NumberFormat(AMOUNT_LOCALE, {
    maximumFractionDigits: maxFractionDigits,
  }).format(number);
}

export function formatCompactAmount(value: number): string {
  return new Intl.NumberFormat(AMOUNT_LOCALE, {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}
