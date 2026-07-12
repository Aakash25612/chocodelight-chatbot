import { formatAmount } from "./format";
import { getReceivablesAging } from "./analytics";
import { loadCustomersPayload } from "./derived-customers";
import { getSalesByBranch, getBranchWiseSales, getPendingSauda } from "./analytics-queries";
import { resolveBranch } from "./branches";
import { getCompany, normalizeCompanyKey } from "./companies";
import { runWithCompany, getActiveCompany } from "./company-context";
import { getMirror } from "./bc-mirror";

type Customer = {
  number?: string;
  displayName?: string;
  phoneNumber?: string;
  balance?: number;
  overdueAmount?: number;
  totalSalesExcludingTax?: number;
};

type CustomerLedgerEntry = {
  documentType?: string;
  postingDate?: string;
  salesLcy?: number;
  amountLcy?: number;
  remainingAmount?: number;
  open?: boolean;
  customerNo?: string;
  sellToCustomerNo?: string;
};

type MirrorPayload<T> = {
  value?: T[];
  _syncedAt?: string;
  error?: string;
};

function salesIncl(row: {
  salesIncludingTax?: number;
  salesExcludingTax?: number;
}): number {
  return row.salesIncludingTax ?? row.salesExcludingTax ?? 0;
}

export async function getDirectResponse(
  message: string,
  company?: string,
): Promise<string | null> {
  const normalized = message.trim().toLowerCase();

  return runWithCompany(normalizeCompanyKey(company), async () => {
    if (isListAllCustomers(normalized)) {
      return listAllCustomers();
    }

    if (isPendingSaudaQuery(normalized)) {
      return formatPendingSauda(message);
    }

    if (isReceivablesQuery(normalized)) {
      return formatReceivablesResponse(message, normalized);
    }

    const branchCode = extractBranchFromMessage(message);
    if (branchCode) {
      return formatBranchSales(branchCode, message);
    }

    if (isBranchWiseSalesQuery(normalized)) {
      return formatBranchWiseSales();
    }

    return null;
  });
}

function extractBranchFromMessage(message: string): string | null {
  if (isReceivablesQuery(message.trim().toLowerCase())) return null;

  const code = extractBranchCodeQuery(message);
  if (code) return code;

  if (
    /\b(branch|depo(?:t)?)\b/i.test(message) &&
    /\b(sales|revenue)\b/i.test(message)
  ) {
    const resolved = resolveBranch({ query: message });
    if (!("error" in resolved)) return resolved.code;
  }

  return null;
}

function isPendingSaudaQuery(message: string): boolean {
  return (
    /\bsauda\b/.test(message) ||
    /\bpending\s+sauda\b/.test(message) ||
    /\bsauda\s+pending\b/.test(message) ||
    /\bunshipped\b/.test(message) ||
    /\bpending\s+(sales\s+)?orders?\b/.test(message) ||
    /\blocked\s+orders?\b.*\b(pending|unshipped|not\s+shipped)\b/.test(message) ||
    /\b(quantity|qty)\s*[-–]\s*(quantity\s*)?shipped\b/.test(message)
  );
}

/** Pull customer / party name from "X pending sauda" style questions. */
function extractCustomerQueryFromSaudaMessage(message: string): string | null {
  let text = message
    .replace(/\b(tell|show|give|get|list|check|what(?:'s| is)?|his|her|their|the)\b/gi, " ")
    .replace(/\b(pending\s+sauda|sauda\s+pending|pending\s+(sales\s+)?orders?|unshipped)\b/gi, " ")
    .replace(/\bsauda\b/gi, " ")
    .replace(/\b(of|for|from|about)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || text.length < 3) return null;
  if (/^(all|every|total|company|customers?)$/i.test(text)) return null;
  return text;
}

async function formatPendingSauda(message: string): Promise<string> {
  const customerQuery = extractCustomerQueryFromSaudaMessage(message);
  const branch = !customerQuery
    ? resolveBranch({ query: message })
    : resolveBranch({ query: customerQuery });
  const branchCode =
    !customerQuery && !("error" in branch) ? branch.code : undefined;
  // Prefer customer name when present; only use branch if no customer fragment.
  const useBranch =
    !customerQuery && branchCode
      ? { branchCode }
      : customerQuery
        ? { query: customerQuery }
        : branchCode
          ? { branchCode }
          : {};

  const data = (await getPendingSauda({
    ...useBranch,
    limit: 40,
  })) as {
    error?: string;
    candidates?: Array<{ customerNo?: string; name?: string }>;
    filter?: {
      customerNo?: string | null;
      customerName?: string | null;
      branchCode?: string | null;
    };
    summary?: {
      ordersWithPending?: number;
      pendingLineCount?: number;
      totalPendingQuantity?: number;
      totalPendingAmount?: number;
    };
    topItems?: Array<{
      itemNo: string;
      itemName: string;
      pendingQuantity: number;
      pendingAmount: number;
    }>;
    topCustomers?: Array<{
      customerNo: string;
      customerName: string;
      pendingQuantity: number;
      pendingAmount: number;
      orderCount: number;
    }>;
    lines?: Array<{
      orderNo: string;
      postingDate?: string;
      customerName: string;
      itemName: string;
      itemNo: string;
      pendingQuantity: number;
      quantity: number;
      quantityShipped: number;
      unitPrice?: number;
      pendingAmount: number;
      branchName?: string;
    }>;
    _syncedAt?: string;
  };

  if (data.error) {
    if (data.candidates?.length) {
      return [
        data.error,
        "",
        "| Customer No. | Name |",
        "|---|---|",
        ...data.candidates.map(
          (c) => `| ${c.customerNo ?? ""} | ${escapeCell(c.name ?? "")} |`,
        ),
      ].join("\n");
    }
    return data.error;
  }

  const companyLabel = getCompany(getActiveCompany()).displayName;
  const s = data.summary ?? {};
  const who =
    data.filter?.customerName ||
    data.filter?.customerNo ||
    (data.filter?.branchCode ? `branch ${data.filter.branchCode}` : null);
  const title = who
    ? `**Pending Sauda — ${who}**`
    : `**Pending Sauda (Locked orders, unshipped qty)**`;

  if ((s.ordersWithPending ?? 0) === 0) {
    return [
      `${title} — ${companyLabel}${formatSync(data._syncedAt)}`,
      "",
      "No Locked sales orders with unshipped quantity (`quantity − quantityShipped > 0`) found for this filter.",
      "",
      "Pending Sauda is **not** outstanding receivables / open invoice balance.",
    ].join("\n");
  }

  const lines = [
    `${title} — ${companyLabel}${formatSync(data._syncedAt)}`,
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Orders with pending qty | ${s.ordersWithPending ?? 0} |`,
    `| Pending lines | ${s.pendingLineCount ?? 0} |`,
    `| Total pending quantity | ${formatAmount(s.totalPendingQuantity ?? 0)} |`,
    `| Total pending amount | **${formatAmount(s.totalPendingAmount ?? 0)}** |`,
    "",
    "Rule: `orderStatus = Locked` and `quantity − quantityShipped > 0`. Amount = pending qty × unit price.",
    "This is **not** customer outstanding / receivable balance.",
  ];

  if (data.topItems?.length) {
    lines.push(
      "",
      "### Top items",
      "",
      "| Item | Pending qty | Amount (NPR) |",
      "|---|---:|---:|",
      ...data.topItems.slice(0, 10).map(
        (row) =>
          `| ${escapeCell(row.itemName || row.itemNo)} | ${formatAmount(row.pendingQuantity)} | ${formatAmount(row.pendingAmount)} |`,
      ),
    );
  }

  if (!data.filter?.customerNo && data.topCustomers?.length) {
    lines.push(
      "",
      "### Top customers",
      "",
      "| Customer | Orders | Pending qty | Amount (NPR) |",
      "|---|---:|---:|---:|",
      ...data.topCustomers.slice(0, 10).map(
        (row) =>
          `| ${escapeCell(row.customerName || row.customerNo)} | ${row.orderCount} | ${formatAmount(row.pendingQuantity)} | ${formatAmount(row.pendingAmount)} |`,
      ),
    );
  }

  if (data.lines?.length) {
    lines.push(
      "",
      "### Detail lines",
      "",
      "| Order | Date | Customer | Item | Ordered | Shipped | Pending | Amount |",
      "|---|---|---|---|---:|---:|---:|---:|",
      ...data.lines.slice(0, 25).map(
        (row) =>
          `| ${escapeCell(row.orderNo)} | ${row.postingDate ?? ""} | ${escapeCell(row.customerName)} | ${escapeCell(row.itemName || row.itemNo)} | ${formatAmount(row.quantity)} | ${formatAmount(row.quantityShipped)} | ${formatAmount(row.pendingQuantity)} | ${formatAmount(row.pendingAmount)} |`,
      ),
    );
  }

  return lines.join("\n");
}

function isReceivablesQuery(message: string): boolean {
  // "sauda" = unshipped locked sales orders, never receivables.
  if (isPendingSaudaQuery(message)) return false;

  return (
    /\b(outstanding|receivable|receivables|overdue|aging|past due|payment pending|dues)\b/.test(
      message,
    ) ||
    /\b(above|over|more than)\s+\d+\s*days?\b/.test(message) ||
    /\b\d+\s*days?\s+(overdue|pending|due)\b/.test(message)
  );
}

function parseMinDaysOverdue(message: string): number | undefined {
  const explicit = message.match(
    /\b(?:above|over|more than|beyond|after|older than|>=?)\s*(\d+)\s*days?\b/i,
  );
  if (explicit) return Number(explicit[1]);
  if (/\b90\b/.test(message) && /\b(day|days)\b/i.test(message)) return 90;
  return undefined;
}

/** Questions asking who owes the most — not a single-customer lookup. */
function isCustomerRankingReceivablesQuery(message: string): boolean {
  const n = message.toLowerCase();
  return (
    /\b(which|what|who)\s+(customer|party|dealer|client|buyer)\b/.test(n) ||
    /\b(customer|party|dealer)\s+(most|highest|top|maximum|max)\b/.test(n) ||
    /\b(top|highest|maximum|biggest)\s+(customer|party|dealer|debtor)\b/.test(n) ||
    /\bwho\s+owes?\s+(the\s+)?most\b/.test(n) ||
    /\bmost\s+outstanding\b/.test(n)
  );
}

/** Pull a customer name fragment from receivables questions (partial names OK). */
function extractCustomerQueryFromReceivablesMessage(
  message: string,
): string | null {
  if (isCustomerRankingReceivablesQuery(message)) return null;

  let text = message
    .replace(
      /\b(pending amount|outstanding amount|open balance|total outstanding)\b/gi,
      " ",
    )
    .replace(
      /\b(receivable|receivables|overdue|aging|past due|payment pending|dues)\b/gi,
      " ",
    )
    .replace(
      /\b(above|over|more than|beyond|after|older than|>=?)\s*\d+\s*days?\b/gi,
      " ",
    )
    .replace(/\b\d+\s*days?\s+(overdue|pending|due|old)\b/gi, " ")
    .replace(
      /\b(which|what|who)\s+(customer|party|dealer|client|buyer)\b.*$/gi,
      " ",
    )
    .replace(/\b(customer|party)\s+(most|highest|top|maximum)\b.*$/gi, " ")
    .replace(/\b(top|highest)\s+(customer|party)\b.*$/gi, " ")
    .replace(/\bwho\s+owes?\s+(the\s+)?most\b.*$/gi, " ")
    .replace(/\b(of|for|from)\b/gi, " ")
    .replace(/\b(amount|balance|total|pending)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || text.length < 3) return null;
  if (/^(all|every|total|company|customers?)$/i.test(text)) return null;
  return text;
}

function resolveReceivablesAgeBy(message: string): "due_date" | "posting_date" {
  if (
    /\b(overdue|past due|late payment|payment pending|due date|after due|days overdue)\b/.test(
      message,
    )
  ) {
    return "due_date";
  }
  return "posting_date";
}

async function getSignedOutstandingSummary(): Promise<
  | {
      totalOutstandingSigned: number;
      byDocumentType: Array<{ documentType: string; amount: number }>;
      _syncedAt?: string;
    }
  | { error: string }
> {
  const payload = (await getMirror("custLedgEntries")) as MirrorPayload<CustomerLedgerEntry>;
  if (payload.error) return { error: payload.error };
  const entries = payload.value ?? [];

  const byType = new Map<string, number>();
  let total = 0;
  for (const entry of entries) {
    const amount = Number(entry.amountLcy ?? 0);
    total += amount;
    const key = String(entry.documentType ?? "(blank)");
    byType.set(key, (byType.get(key) ?? 0) + amount);
  }

  return {
    totalOutstandingSigned: total,
    byDocumentType: [...byType.entries()]
      .map(([documentType, amount]) => ({ documentType, amount }))
      .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount))
      .slice(0, 6),
    _syncedAt: payload._syncedAt,
  };
}

async function formatReceivablesResponse(
  message: string,
  normalized: string,
): Promise<string> {
  const minDays = parseMinDaysOverdue(normalized);
  const ageBy = resolveReceivablesAgeBy(normalized);
  const customerQuery = extractCustomerQueryFromReceivablesMessage(message);
  const asksTotalOutstandingOnly =
    !minDays &&
    !customerQuery &&
    /\btotal\s+outstanding\b/.test(normalized);

  if (asksTotalOutstandingOnly) {
    const signed = await getSignedOutstandingSummary();
    if ("error" in signed) return signed.error;
    const companyLabel = getCompany(getActiveCompany()).displayName;
    return [
      `**Outstanding receivables (signed amountLcy)** — ${companyLabel}${formatSync(signed._syncedAt)}`,
      "",
      `| Metric | Amount (NPR) |`,
      `|---|---:|`,
      `| Total outstanding (sum of amountLcy with + and -) | **${formatAmount(signed.totalOutstandingSigned)}** |`,
      "",
      "### By document type (signed)",
      "",
      "| Document Type | Amount (NPR) |",
      "|---|---:|",
      ...signed.byDocumentType.map((row) =>
        `| ${escapeCell(row.documentType)} | ${formatAmount(row.amount)} |`,
      ),
    ].join("\n");
  }

  const data = (await getReceivablesAging({
    minDays,
    ageBy,
    ...(customerQuery ? { query: customerQuery } : {}),
  })) as {
    error?: string;
    candidates?: Array<{ customerNo?: string; name?: string }>;
    customer?: { customerNo: string; name: string };
    asOf?: string;
    ageBy?: "due_date" | "posting_date";
    basis?: string;
    totalOutstanding?: number;
    totalOverdue?: number;
    totalNotYetDue?: number;
    matchingOverdueTotal?: number;
    matchingInvoiceCount?: number;
    filterMinDays?: number;
    overdueEntries?: Array<{
      customerNo: string;
      name: string;
      documentNo: string;
      referenceDate: string;
      daysAged: number;
      daysPastDue?: number;
      remaining: number;
    }>;
    topCustomersByMinDays?: Array<{
      customerNo: string;
      name: string;
      outstanding: number;
      invoiceCount: number;
    }>;
    buckets?: Array<{ bucket: string; count: number; amount: number }>;
    _syncedAt?: string;
  };

  if (data.error) {
    if (data.candidates?.length) {
      return [
        data.error,
        "",
        "| Customer No. | Name |",
        "|---|---|",
        ...data.candidates.map(
          (c) => `| ${c.customerNo ?? ""} | ${escapeCell(c.name ?? "")} |`,
        ),
      ].join("\n");
    }
    return data.error;
  }

  const companyLabel = getCompany(getActiveCompany()).displayName;
  const customerLabel = data.customer?.name
    ? ` — ${data.customer.name}`
    : "";
  const ageLabel =
    ageBy === "posting_date"
      ? "invoice age (days since posting)"
      : "days past due date";

  if (minDays) {
    const entryCount = data.matchingInvoiceCount ?? data.overdueEntries?.length ?? 0;
    const lines = [
      `**Outstanding above ${minDays} days${customerLabel}** — ${companyLabel}${formatSync(data._syncedAt)}`,
      "",
      `| Metric | Amount (NPR) | Invoices |`,
      `|---|---:|---:|`,
      `| Open balance (${ageLabel} ≥ ${minDays} days) | **${formatAmount(data.matchingOverdueTotal)}** | ${entryCount} |`,
      "",
      data.basis ?? "",
      `As of: ${data.asOf ?? "latest sync"}.`,
    ];

    if (ageBy === "posting_date") {
      const dueDateTotal = (
        (await getReceivablesAging({
          minDays,
          ageBy: "due_date",
          ...(data.customer?.customerNo
            ? { customerNo: data.customer.customerNo }
            : {}),
        })) as { matchingOverdueTotal?: number }
      ).matchingOverdueTotal;
      lines.push(
        "",
        `Note: By **payment due date** (overdue only), the same filter is **${formatAmount(dueDateTotal)}** — lower because many old invoices are still within payment terms.`,
      );
    }

    const showCustomerRanking =
      isCustomerRankingReceivablesQuery(message) || !customerQuery;
    const topCustomers = data.topCustomersByMinDays ?? [];
    if (showCustomerRanking && topCustomers.length > 0 && !data.customer) {
      lines.push(
        "",
        `### Top customers (outstanding ≥ ${minDays} days)`,
        "",
        "| Rank | Customer | Outstanding (NPR) | Invoices |",
        "|---:|---|---:|---:|",
        ...topCustomers.slice(0, 10).map((row, index) =>
          `| ${index + 1} | ${escapeCell(row.name || row.customerNo)} | **${formatAmount(row.outstanding)}** | ${row.invoiceCount} |`,
        ),
      );
    }

    const topEntries = [...(data.overdueEntries ?? [])]
      .sort((a, b) => b.remaining - a.remaining)
      .slice(0, 10);
    if (topEntries.length > 0) {
      const dateCol = ageBy === "posting_date" ? "Invoice date" : "Due date";
      lines.push(
        "",
        "### Top open invoices",
        "",
        `| Customer | Invoice | ${dateCol} | Days | Amount (NPR) |`,
        "|---|---|---|---:|---:|",
        ...topEntries.map((row) =>
          ageBy === "posting_date"
            ? `| ${escapeCell(row.name || row.customerNo)} | ${row.documentNo} | ${row.referenceDate} | ${row.daysAged} since invoice${row.daysPastDue != null && row.daysPastDue > 0 ? ` (${row.daysPastDue} overdue)` : ""} | ${formatAmount(row.remaining)} |`
            : `| ${escapeCell(row.name || row.customerNo)} | ${row.documentNo} | ${row.referenceDate} | ${row.daysAged} overdue | ${formatAmount(row.remaining)} |`,
        ),
      );
    }

    return lines.join("\n");
  }

  const lines = [
    `**Outstanding receivables${customerLabel}** — ${companyLabel}${formatSync(data._syncedAt)}`,
    "",
    `| Metric | Amount (NPR) |`,
    `|---|---:|`,
    `| Total outstanding | ${formatAmount(data.totalOutstanding)} |`,
    `| Overdue (past due) | ${formatAmount(data.totalOverdue)} |`,
    `| Not yet due | ${formatAmount(data.totalNotYetDue)} |`,
    "",
    "### Aging buckets",
    "",
    "| Bucket | Invoices | Amount (NPR) |",
    "|---|---:|---:|",
    ...(data.buckets ?? []).map(
      (row) =>
        `| ${row.bucket} | ${row.count} | ${formatAmount(row.amount)} |`,
    ),
  ];

  const over90 = data.buckets?.find((row) =>
    /over 90/i.test(row.bucket),
  );
  if (over90 && !/\b90\b/.test(normalized)) {
    lines.push(
      "",
      `Over 90 days alone: **${formatAmount(over90.amount)}** (${over90.count} invoices).`,
    );
  }

  return lines.join("\n");
}

function extractBranchCodeQuery(message: string): string | null {
  const branchToken = "(exp|jb|tn|[a-z]{1,3})";
  const normalized = message.trim().toLowerCase();
  const patterns = [
    new RegExp(`\\b(?:code|branch|depo(?:t)?)\\s*[:=]?\\s*(${branchToken})\\b`, "i"),
    new RegExp(`\\b(?:code|branch|depo(?:t)?)\\s+(${branchToken})\\s+by\\s+month`, "i"),
    new RegExp(`\\b(?:sales|total|revenue)\\s+(?:of|for)?\\s*(?:code|branch|depo(?:t)?)\\s*(${branchToken})\\b`, "i"),
    new RegExp(`\\b(?:code|branch|depo(?:t)?)\\s+(${branchToken})\\s+(?:sales|total|revenue)\\b`, "i"),
    new RegExp(`\\b(${branchToken})\\s+branch\\s+(?:sales|total|revenue)?\\b`, "i"),
    new RegExp(`\\bbranch\\s+(${branchToken})\\b`, "i"),
    new RegExp(`\\bfor\\s+code\\s+(${branchToken})\\b`, "i"),
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return null;
}

function isBranchWiseSalesQuery(message: string): boolean {
  return (
    /\bbranch\s*wise\b/.test(message) ||
    /\bbranch-wise\b/.test(message) ||
    /\barea\s*wise\b/.test(message) ||
    /\barea-wise\b/.test(message) ||
    /\bregion\s*wise\b/.test(message) ||
    /\bregion-wise\b/.test(message) ||
    /\bdepot\s*wise\b/.test(message) ||
    /\bdepot-wise\b/.test(message) ||
    /\bsales\s+by\s+(area|region|branch|depot)\b/.test(message)
  );
}

function wantsMonthlyBreakdown(message: string): boolean {
  return /\b(month\s*(by|wise|-wise)|by\s+month|monthly|month[- ]by[- ]month|monthwise|per\s+month|each\s+month|mahina)\b/i.test(
    message,
  );
}

async function formatBranchSales(
  branchCode: string,
  message: string,
): Promise<string> {
  const branch = resolveBranch({ branchCode });
  if ("error" in branch) {
    return branch.error;
  }

  const monthly = wantsMonthlyBreakdown(message);
  const data = (await getSalesByBranch({
    branchCode,
    monthlyBreakdown: monthly,
  })) as {
    error?: string;
    branchName?: string;
    fiscalYear?: string;
    totalSalesIncludingTax?: number;
    totalSalesExcludingTax?: number;
    invoiceCount?: number;
    byNepaliMonth?: Array<{
      bsMonth: string;
      bsYear: number;
      salesIncludingTax?: number;
      salesExcludingTax: number;
      invoices: number;
    }>;
    allTimeSalesIncludingTax?: number;
    allTimeSalesExcludingTax?: number;
    allTimeInvoices?: number;
    currentNepaliFiscalYear?: {
      label: string;
      salesIncludingTax?: number;
      salesExcludingTax: number;
      invoices: number;
    };
    _syncedAt?: string;
  };

  if (data.error) return data.error;

  const companyLabel = getCompany(getActiveCompany()).displayName;

  if (monthly && data.byNepaliMonth) {
    const lines = [
      `**${data.branchName} (code ${branchCode})** — ${companyLabel}${formatSync(data._syncedAt)}`,
      "",
      `### Nepali FY ${data.fiscalYear} — month-wise (Bikram Sambat)`,
      "",
      `| Month | BS Year | Sales Incl. VAT (NPR) | Invoices |`,
      `|---|---:|---:|---:|`,
      ...data.byNepaliMonth.map(
        (row) =>
          `| ${row.bsMonth} | ${row.bsYear} | ${formatAmount(salesIncl(row))} | ${row.invoices} |`,
      ),
      `| **FY total** | | **${formatAmount(salesIncl({ salesIncludingTax: data.totalSalesIncludingTax, salesExcludingTax: data.totalSalesExcludingTax }))}** | **${data.invoiceCount ?? 0}** |`,
    ];

    if (data.allTimeSalesIncludingTax != null || data.allTimeSalesExcludingTax != null) {
      lines.push(
        "",
        `All-time synced sales (Incl. VAT): **${formatAmount(salesIncl({ salesIncludingTax: data.allTimeSalesIncludingTax, salesExcludingTax: data.allTimeSalesExcludingTax }))}** (${data.allTimeInvoices ?? 0} invoices).`,
      );
    }

    return lines.join("\n");
  }

  const lines = [
    `**${data.branchName} (code ${branchCode})** — ${companyLabel}${formatSync(data._syncedAt)}`,
    "",
    `| Period | Sales Incl. VAT (NPR) | Invoices |`,
    `|---|---:|---:|`,
    `| All synced data | ${formatAmount(salesIncl({ salesIncludingTax: data.totalSalesIncludingTax, salesExcludingTax: data.totalSalesExcludingTax }))} | ${data.invoiceCount ?? 0} |`,
  ];

  if (data.currentNepaliFiscalYear) {
    lines.push(
      `| Nepali FY ${data.currentNepaliFiscalYear.label} | ${formatAmount(salesIncl(data.currentNepaliFiscalYear))} | ${data.currentNepaliFiscalYear.invoices} |`,
    );
  }

  return lines.join("\n");
}

async function formatBranchWiseSales(): Promise<string> {
  const data = (await getBranchWiseSales()) as {
    error?: string;
    branches?: Array<{
      branchCode: string;
      branchName: string;
      salesIncludingTax?: number;
      salesExcludingTax: number;
      invoices: number;
    }>;
    totalSalesIncludingTax?: number;
    totalSalesExcludingTax?: number;
    currentNepaliFiscalYear?: {
      label: string;
      totalSalesIncludingTax?: number;
      totalSales?: number;
      branches: Array<{
        branchCode: string;
        branchName: string;
        salesIncludingTax?: number;
        salesExcludingTax: number;
        invoices: number;
      }>;
    };
    _syncedAt?: string;
  };

  if (data.error) return data.error;

  const companyLabel = getCompany(getActiveCompany()).displayName;
  const lines = [
    `**Branch / area-wise sales** — ${companyLabel}${formatSync(data._syncedAt)}`,
    "",
    "### All synced invoice sales",
    "",
    "| Branch | Code | Sales Incl. VAT (NPR) | Invoices |",
    "|---|---|---:|---:|",
    ...(data.branches ?? []).map(
      (row) =>
        `| ${escapeCell(row.branchName || row.branchCode)} | ${row.branchCode} | ${formatAmount(salesIncl(row))} | ${row.invoices} |`,
    ),
    `| **Total** | | **${formatAmount(salesIncl({ salesIncludingTax: data.totalSalesIncludingTax, salesExcludingTax: data.totalSalesExcludingTax }))}** | |`,
  ];

  if (data.currentNepaliFiscalYear) {
    lines.push(
      "",
      `### Current Nepali FY ${data.currentNepaliFiscalYear.label}`,
      "",
      "| Branch | Code | Sales Incl. VAT (NPR) | Invoices |",
      "|---|---|---:|---:|",
      ...data.currentNepaliFiscalYear.branches.map(
        (row) =>
          `| ${escapeCell(row.branchName || row.branchCode)} | ${row.branchCode} | ${formatAmount(salesIncl(row))} | ${row.invoices} |`,
      ),
      `| **Total** | | **${formatAmount(salesIncl({ salesIncludingTax: data.currentNepaliFiscalYear.totalSalesIncludingTax, salesExcludingTax: data.currentNepaliFiscalYear.totalSales }))}** | |`,
    );
  }

  return lines.join("\n");
}

function isListAllCustomers(message: string): boolean {
  return (
    /\b(list|show|get)\b/.test(message) &&
    /\ball\b/.test(message) &&
    /\bcustomers?\b/.test(message)
  );
}

async function listAllCustomers(): Promise<string> {
  const data = await loadCustomersPayload();

  if (data.error) return data.error;

  const customers = [...(data.value ?? [])].sort((a, b) =>
    String(a.displayName ?? "").localeCompare(String(b.displayName ?? "")),
  );

  const rows = customers.map((customer) =>
    [
      customer.number ?? "",
      customer.displayName ?? "",
      customer.phoneNumber ?? "",
      formatAmount(customer.balance),
      formatAmount(customer.overdueAmount),
      formatAmount(customer.totalSalesExcludingTax),
    ].map(escapeCell),
  );

  return [
    `Found **${customers.length} customers** in the latest Supabase sync${formatSync(data._syncedAt)}.`,
    "",
    "| Customer No. | Name | Phone | Balance (NPR) | Overdue (NPR) | Total Sales Excl. Tax (NPR) |",
    "|---|---|---|---:|---:|---:|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function formatSync(syncedAt?: string): string {
  if (!syncedAt) return "";
  return ` (${new Date(syncedAt).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  })})`;
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
