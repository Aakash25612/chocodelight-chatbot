import type { DatePeriodInput } from "./date-period";
import {
  BS_MONTHS,
  getCurrentFiscalYearStart,
  parseBsMonth,
} from "./nepali-date";

export type CalendarPreference = "bs" | "ad";

const PERIOD_TOOLS = new Set([
  "get_monthly_revenue",
  "get_daily_revenue",
  "get_sales_summary",
  "get_nepali_monthly_sales",
  "get_product_sales",
  "get_top_customers",
  "get_customer_sales",
  "get_payments_summary",
  "get_category_sales",
  "get_sales_orders_summary",
  "get_pending_sauda",
  "search_sales_orders",
  "get_customer_product_sales",
  "get_sales_by_salesperson",
  "get_branch_wise_sales",
  "get_sales_by_branch",
  "get_branch_product_sales",
  "get_vat_report",
  "get_mr_records",
  "get_cheque_in_hand",
  "get_receivables_aging",
  "get_outstanding_receivables",
  "get_customer_statement",
  "get_collection_metrics",
  "get_top_paying_customers",
]);

const ENGLISH_MONTH =
  /\b(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b/i;

export function detectCalendarPreference(message: string): CalendarPreference {
  return /\b(ad|a\.d\.|gregorian|english(?:\s+calendar|\s+date)?)\b/i.test(
    message,
  ) || ENGLISH_MONTH.test(message)
    ? "ad"
    : "bs";
}

export function explicitlyRequestsAllTime(message: string): boolean {
  return /\b(all[\s-]?time|all\s+synced(?:\s+(?:data|history))?|entire\s+history|lifetime|since\s+beginning)\b/i.test(
    message,
  );
}

/** Whether the user explicitly constrained the time window. */
export function explicitlyRequestsPeriod(message: string): boolean {
  if (explicitlyRequestsAllTime(message)) return true;
  if (parseBsMonth(message) != null) return true;
  return /\b(?:this|current|last|previous)\s+(?:fiscal\s+year|fy|year|month|week)|\b(?:fy|fiscal\s+year)\s*(?:208\d|209\d)?|\b(?:208\d|209\d)\s*[/-]\s*(?:\d{2}|20\d{2})|\b(?:20\d{2})\b|\b(?:today|yesterday|ytd|year[\s-]*to[\s-]*date)|\b(?:january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\b|\b(?:baisakh|jestha|ashadh|shrawan|bhadra|ashwin|kartik|mangsir|poush|magh|falgun|chaitra)\b/i.test(
    message,
  );
}

function allTimeArgs(args: Record<string, unknown>): Record<string, unknown> {
  const normalized = { ...args };
  delete normalized.year;
  delete normalized.month;
  delete normalized.week;
  delete normalized.day;
  delete normalized.dateFrom;
  delete normalized.dateTo;
  delete normalized.nepaliMonth;
  delete normalized.fiscalYearStart;
  normalized.allTime = true;
  return normalized;
}

export function extractMessagePeriod(
  message: string,
  referenceDate = new Date(),
): DatePeriodInput {
  if (explicitlyRequestsAllTime(message)) return { allTime: true };

  const calendar = detectCalendarPreference(message);
  if (calendar === "ad") {
    const year = message.match(/\b(20\d{2})\b/)?.[1];
    const monthMatch = ENGLISH_MONTH.exec(message)?.[1];
    const month = monthMatch
      ? [
          "jan",
          "feb",
          "mar",
          "apr",
          "may",
          "jun",
          "jul",
          "aug",
          "sep",
          "oct",
          "nov",
          "dec",
        ].findIndex((value) => monthMatch.toLowerCase().startsWith(value)) + 1
      : undefined;
    return {
      year: year ? Number(year) : undefined,
      month: month && month > 0 ? month : undefined,
    };
  }

  const fyMatch =
    message.match(/\b(?:fy|fiscal\s+year)\s*(208\d|209\d)\b/i) ??
    message.match(/\b(208\d|209\d)\s*[/-]\s*(?:\d{2}|20\d{2})\b/i);
  const fiscalYearStart = fyMatch?.[1]
    ? Number(fyMatch[1])
    : (getCurrentFiscalYearStart(referenceDate) ?? undefined);
  const bsMonthIndex = parseBsMonth(message);

  return {
    fiscalYearStart,
    nepaliMonth:
      bsMonthIndex == null ? undefined : BS_MONTHS[bsMonthIndex],
  };
}

export function normalizeToolArgs(
  toolName: string,
  args: Record<string, unknown>,
  message: string,
  referenceDate = new Date(),
): Record<string, unknown> {
  if (!PERIOD_TOOLS.has(toolName)) return { ...args };

  const normalized = { ...args };
  // Pending Sauda is a current backlog. Older locked, unshipped orders remain
  // pending after fiscal-year rollover, so only apply a period when requested.
  if (
    toolName === "get_pending_sauda" &&
    !explicitlyRequestsPeriod(message)
  ) {
    return allTimeArgs(normalized);
  }
  const messagePeriod = extractMessagePeriod(message, referenceDate);
  const calendar = detectCalendarPreference(message);

  if (messagePeriod.allTime) {
    return allTimeArgs(normalized);
  }

  if (calendar === "ad") {
    delete normalized.fiscalYearStart;
    delete normalized.nepaliMonth;
    return { ...normalized, ...messagePeriod };
  }

  // Gemini sometimes supplies the server's AD year for "this year".
  delete normalized.year;
  delete normalized.month;
  delete normalized.week;
  delete normalized.day;
  delete normalized.dateFrom;
  delete normalized.dateTo;
  delete normalized.allTime;

  return {
    ...normalized,
    fiscalYearStart:
      messagePeriod.fiscalYearStart ??
      (typeof normalized.fiscalYearStart === "number"
        ? normalized.fiscalYearStart
        : getCurrentFiscalYearStart(referenceDate) ?? undefined),
    nepaliMonth: messagePeriod.nepaliMonth ?? normalized.nepaliMonth,
  };
}

export function periodArgsFromRecord(
  args: Record<string, unknown>,
): DatePeriodInput {
  return {
    allTime: args.allTime === true,
    year: typeof args.year === "number" ? args.year : undefined,
    month: typeof args.month === "number" ? args.month : undefined,
    week: typeof args.week === "number" ? args.week : undefined,
    day: typeof args.day === "number" ? args.day : undefined,
    dateFrom: typeof args.dateFrom === "string" ? args.dateFrom : undefined,
    dateTo: typeof args.dateTo === "string" ? args.dateTo : undefined,
    nepaliMonth:
      typeof args.nepaliMonth === "string" ? args.nepaliMonth : undefined,
    fiscalYearStart:
      typeof args.fiscalYearStart === "number"
        ? args.fiscalYearStart
        : undefined,
  };
}
