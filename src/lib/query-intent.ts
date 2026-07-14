import { cleanProductQueryFragment, looksLikeProductQuery } from "./product-query";
import { resolveBranch } from "./branches";
import {
  detectCalendarPreference,
  explicitlyRequestsAllTime,
  normalizeToolArgs,
} from "./tool-policy";

export type QueryIntent =
  | "pending_sauda"
  | "cheque_in_hand"
  | "top_customer_sales"
  | "company_sales"
  | "customer_sales"
  | "product_sales"
  | "product_returns"
  | "receivables"
  | "branch_sales"
  | "branch_wise_sales"
  | "collection_metrics";

export type QueryPlan =
  | {
      path: "deterministic";
      intent: QueryIntent;
      tool: string;
      args: Record<string, unknown>;
    }
  | { path: "gemini"; reason: string };

function isPendingSauda(message: string): boolean {
  return /\b(sauda|unshipped|pending\s+(?:sales\s+)?orders?|locked\s+orders?)\b/i.test(
    message,
  );
}

function isChequeInHand(message: string): boolean {
  return (
    /\b(?:cheque|check)s?\s+in\s+hand\b/i.test(message) ||
    (/\bcheques?\b/i.test(message) &&
      /\b(received|not\s+deposit|undeposited)\b/i.test(message))
  );
}

export function extractBranchCode(message: string): string | null {
  const patterns = [
    /\b(?:code|branch|depo(?:t)?)\s*[:=]?\s*(exp|jb|tn|[a-z]{1,3})\b/i,
    /\b(exp|jb|tn|[a-z]{1,3})\s+branch\b/i,
  ];
  for (const pattern of patterns) {
    const match = message.match(pattern);
    if (match?.[1]) return match[1].toUpperCase();
  }
  const branch = resolveBranch({ query: message });
  return "error" in branch ? null : branch.code;
}

function rankingLimit(message: string): number {
  const value = Number(
    message.match(/\b(?:top|first|highest|largest)\s*(\d{1,2})\b/i)?.[1] ?? 5,
  );
  return Math.max(1, Math.min(value, 50));
}

export function extractProductSalesQuery(message: string): string | null {
  const text = message
    .replace(
      /\b(tell|show|give|get|list|check|what(?:'s| is)?|the|total|please|pls)\b/gi,
      " ",
    )
    .replace(/\b(sales?\s+returns?|returns?|credit\s+memos?)\b/gi, " ")
    .replace(/\b(all\s+items?|every\s+item|item[- ]?wise|by\s+item)\b/gi, " ")
    .replace(
      /\b(sale|sales|sold|invoiced|amount|value|revenue|products?|items?)\b/gi,
      " ",
    )
    .replace(
      /\b(in\s+)?(metric\s+tons?|metric\s+tonnes?|mts?|tonnes?|tons?|kgs?|kilograms?)\b/gi,
      " ",
    )
    .replace(
      /\b(of|for|from|about|including|incl\.?|excl\.?|tax|vat|npr)\b/gi,
      " ",
    )
    .replace(
      /\b(this\s+year|current\s+year|this\s+fiscal\s+year|current\s+fiscal\s+year|current\s+fy|fiscal\s+year|ytd|year\s+to\s+date|all[\s-]?time|all\s+synced(?:\s+history)?)\b/gi,
      " ",
    )
    .replace(/\bfy\s*\d{4}(?:\s*\/\s*\d{2,4})?\b/gi, " ")
    .replace(/\b(?:20|208|209)\d{2}\b/g, " ")
    .replace(/[?!.,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length >= 2 ? text : null;
}

function extractCustomerSalesQuery(message: string): string | null {
  const match =
    message.match(
      /\b(?:total\s+)?(?:sale|sales|revenue|turnover)\s+(?:of|for|from)\s+(.+)$/i,
    ) ??
    message.match(
      /^(.+?)\s+(?:total\s+)?(?:sale|sales|revenue|turnover)(?:\s+.*)?$/i,
    );
  if (!match?.[1]) return null;
  const cleaned = match[1]
    .replace(
      /\b(this\s+fiscal\s+year|current\s+fiscal\s+year|this\s+year|current\s+year|ytd|year\s+to\s+date|all[\s-]?time)\b/gi,
      " ",
    )
    .replace(/[?!.,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || null;
}

function normalizedPlan(
  intent: QueryIntent,
  tool: string,
  args: Record<string, unknown>,
  message: string,
  referenceDate: Date,
): QueryPlan {
  return {
    path: "deterministic",
    intent,
    tool,
    args: normalizeToolArgs(tool, args, message, referenceDate),
  };
}

export function planQuery(
  message: string,
  referenceDate = new Date(),
): QueryPlan {
  const normalized = message.trim().toLowerCase();

  if (isPendingSauda(normalized)) {
    const cleaned = cleanProductQueryFragment(message);
    const productQuery =
      cleaned &&
      (looksLikeProductQuery(cleaned) ||
        /\b(?:average|avg)\s+(?:unit\s+)?price\b/i.test(message))
        ? cleaned
        : undefined;
    const branchCode = productQuery ? null : extractBranchCode(message);
    return normalizedPlan(
      "pending_sauda",
      "get_pending_sauda",
      {
        productQuery,
        branchCode: branchCode ?? undefined,
        query: !productQuery && !branchCode && cleaned ? cleaned : undefined,
      },
      message,
      referenceDate,
    );
  }

  if (isChequeInHand(normalized)) {
    const branchCode = extractBranchCode(message);
    const query = branchCode
      ? undefined
      : message
          .replace(
            /\b(show|tell|give|get|list|check|what(?:'s| is)?|the|total|please|pls|cheques?|checks?|in\s+hand|received|not\s+deposited|undeposited|status|value|amount|of|for|from)\b/gi,
            " ",
          )
          .replace(/\s+/g, " ")
          .trim() || undefined;
    return normalizedPlan(
      "cheque_in_hand",
      "get_cheque_in_hand",
      { branchCode: branchCode ?? undefined, query },
      message,
      referenceDate,
    );
  }

  if (
    /\b(customer|customers|party|parties)\b/.test(normalized) &&
    /\b(sale|sales|revenue|turnover)\b/.test(normalized) &&
    /\b(top|first|highest|largest|most|amount[\s-]*wise|rank)\b/.test(normalized)
  ) {
    return normalizedPlan(
      "top_customer_sales",
      "get_top_customers",
      { limit: rankingLimit(message), rankBy: "invoice_sales" },
      message,
      referenceDate,
    );
  }

  if (
    /\b(?:average|avg)\s+collection\s+days?\b/i.test(message) ||
    /\bdso\b/i.test(message)
  ) {
    const query = message
      .replace(
        /\b(what|is|are|the|average|avg|collection|days?|dso|of|for)\b/gi,
        " ",
      )
      .replace(/\s+/g, " ")
      .trim();
    return normalizedPlan(
      "collection_metrics",
      "get_collection_metrics",
      { query: query || undefined },
      message,
      referenceDate,
    );
  }

  if (/\b(outstanding|receivables?|overdue|aging|past due|dues)\b/.test(normalized)) {
    const minDays = Number(
      normalized.match(
        /\b(?:above|over|more than|beyond|older than)\s*(\d+)\s*days?\b/,
      )?.[1],
    );
    return normalizedPlan(
      "receivables",
      Number.isFinite(minDays)
        ? "get_receivables_aging"
        : "get_outstanding_receivables",
      Number.isFinite(minDays)
        ? { minDaysOverdue: minDays, ageBy: "posting_date" }
        : {},
      message,
      referenceDate,
    );
  }

  if (
    /\b(branch[\s-]*wise|area[\s-]*wise|region[\s-]*wise|depot[\s-]*wise|sales\s+by\s+(?:area|region|branch|depot))\b/.test(
      normalized,
    )
  ) {
    return normalizedPlan(
      "branch_wise_sales",
      "get_branch_wise_sales",
      {},
      message,
      referenceDate,
    );
  }

  const branchCode = extractBranchCode(message);
  if (
    branchCode &&
    /\b(sale|sales|revenue|turnover)\b/.test(normalized)
  ) {
    return normalizedPlan(
      "branch_sales",
      "get_sales_by_branch",
      {
        branchCode,
        monthlyBreakdown:
          /\b(month\s*(?:by|wise)|by\s+month|monthly|monthwise)\b/i.test(message),
      },
      message,
      referenceDate,
    );
  }

  if (
    /\b(sales?\s+returns?|returns?|credit\s+memos?)\b/i.test(message) &&
    /\b(sale|sales|return|returns)\b/i.test(message)
  ) {
    const query = extractProductSalesQuery(message);
    if (query) {
      return normalizedPlan(
        "product_returns",
        "get_product_sales",
        { query, returnsOnly: true },
        message,
        referenceDate,
      );
    }
  }

  if (/\b(sale|sales|revenue|turnover)\b/.test(normalized)) {
    const productQuery = extractProductSalesQuery(message);
    const customerQuery = extractCustomerSalesQuery(message);

    if (
      detectCalendarPreference(message) === "ad" &&
      /\b(?:total\s+)?(?:sale|sales|revenue|turnover)\s+(?:for|in)\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|\d{4})\b/i.test(
        message,
      )
    ) {
      return normalizedPlan(
        "company_sales",
        "get_monthly_revenue",
        {},
        message,
        referenceDate,
      );
    }

    if (productQuery && looksLikeProductQuery(productQuery)) {
      return normalizedPlan(
        "product_sales",
        "get_product_sales",
        { query: productQuery },
        message,
        referenceDate,
      );
    }

    if (customerQuery) {
      return normalizedPlan(
        "customer_sales",
        "get_customer_sales",
        { query: customerQuery },
        message,
        referenceDate,
      );
    }

    if (
      /\b(total|this|current|fiscal|ytd|year\s+to\s+date)\b/.test(normalized)
    ) {
      return normalizedPlan(
        "company_sales",
        explicitlyRequestsAllTime(message)
          ? "get_sales_summary"
          : detectCalendarPreference(message) === "ad"
            ? "get_monthly_revenue"
            : "get_nepali_monthly_sales",
        {},
        message,
        referenceDate,
      );
    }
  }

  return { path: "gemini", reason: "No high-confidence business intent" };
}
