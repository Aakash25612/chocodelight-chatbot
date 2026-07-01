import { formatAmount } from "./format";
import { getReceivablesAging } from "./analytics";
import { loadCustomersPayload } from "./derived-customers";
import { getSalesByBranch, getBranchWiseSales } from "./analytics-queries";
import { resolveBranch } from "./branches";
import { getCompany, normalizeCompanyKey } from "./companies";
import { runWithCompany, getActiveCompany } from "./company-context";

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
};

type MirrorPayload<T> = {
  value?: T[];
  _syncedAt?: string;
  error?: string;
};

export async function getDirectResponse(
  message: string,
  company?: string,
): Promise<string | null> {
  const normalized = message.trim().toLowerCase();

  return runWithCompany(normalizeCompanyKey(company), async () => {
    if (isListAllCustomers(normalized)) {
      return listAllCustomers();
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

function isReceivablesQuery(message: string): boolean {
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
    /\b(?:above|over|more than|>=?)\s*(\d+)\s*days?\b/,
  );
  if (explicit) {
    const days = Number(explicit[1]);
    return days >= 90 ? 91 : days;
  }
  if (/\b90\+?\s*days?\b|\babove\s+90\b|\bover\s+90\b/.test(message)) {
    return 91;
  }
  return undefined;
}

async function formatReceivablesResponse(
  message: string,
  normalized: string,
): Promise<string> {
  const minDays = parseMinDaysOverdue(normalized);
  const data = (await getReceivablesAging(minDays)) as {
    error?: string;
    asOf?: string;
    totalOutstanding?: number;
    totalOverdue?: number;
    totalNotYetDue?: number;
    matchingOverdueTotal?: number;
    filterDaysOverdue?: number;
    buckets?: Array<{ bucket: string; count: number; amount: number }>;
    overdueEntries?: Array<{
      customerNo: string;
      name: string;
      documentNo: string;
      dueDate: string;
      daysOverdue: number;
      remaining: number;
    }>;
    topOverdueCustomers?: Array<{
      customerNo: string;
      name: string;
      overdue: number;
      entries: number;
    }>;
    _syncedAt?: string;
  };

  if (data.error) return data.error;

  const companyLabel = getCompany(getActiveCompany()).displayName;

  if (minDays) {
    const lines = [
      `**Outstanding above ${minDays === 91 ? 90 : minDays} days** — ${companyLabel}${formatSync(data._syncedAt)}`,
      "",
      `| Metric | Amount (NPR) |`,
      `|---|---:|`,
      `| Open invoices past due threshold | **${formatAmount(data.matchingOverdueTotal)}** |`,
      "",
      `Basis: Open customer ledger invoices aged by **due date** (not invoice date).`,
      `As of: ${data.asOf ?? "latest sync"}.`,
    ];

    const topEntries = data.overdueEntries?.slice(0, 10) ?? [];
    if (topEntries.length > 0) {
      lines.push(
        "",
        "### Top open invoices",
        "",
        "| Customer | Invoice | Due date | Days overdue | Amount (NPR) |",
        "|---|---|---|---:|---:|",
        ...topEntries.map(
          (row) =>
            `| ${escapeCell(row.name || row.customerNo)} | ${row.documentNo} | ${row.dueDate} | ${row.daysOverdue} | ${formatAmount(row.remaining)} |`,
        ),
      );
    }

    return lines.join("\n");
  }

  const lines = [
    `**Outstanding receivables** — ${companyLabel}${formatSync(data._syncedAt)}`,
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

  const over90 = data.buckets?.find((row) => row.bucket === "Over 90 days");
  if (over90 && !/\b90\b/.test(normalized)) {
    lines.push(
      "",
      `Over 90 days alone: **${formatAmount(over90.amount)}** (${over90.count} invoices).`,
    );
  }

  return lines.join("\n");
}

function extractBranchCodeQuery(message: string): string | null {
  const normalized = message.trim().toLowerCase();
  const patterns = [
    /\b(?:code|branch|depo(?:t)?)\s*[:=]?\s*([a-z])\b/i,
    /\b(?:code|branch|depo(?:t)?)\s+([a-z])\s+by\s+month/i,
    /\b(?:sales|total|revenue)\s+(?:of|for)?\s*(?:code|branch|depo(?:t)?)\s*([a-z])\b/i,
    /\b(?:code|branch|depo(?:t)?)\s+([a-z])\s+(?:sales|total|revenue)\b/i,
    /\b([a-z])\s+branch\s+(?:sales|total|revenue)?\b/i,
    /\bbranch\s+([a-z])\b/i,
    /\bfor\s+code\s+([a-z])\b/i,
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match?.[1]) return match[1].toUpperCase();
  }
  return null;
}

function isBranchWiseSalesQuery(message: string): boolean {
  return /\bbranch\s*wise\b/.test(message) || /\bbranch-wise\b/.test(message);
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
    totalSalesExcludingTax?: number;
    invoiceCount?: number;
    byNepaliMonth?: Array<{
      bsMonth: string;
      bsYear: number;
      salesExcludingTax: number;
      invoices: number;
    }>;
    allTimeSalesExcludingTax?: number;
    allTimeInvoices?: number;
    currentNepaliFiscalYear?: {
      label: string;
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
      `| Month | BS Year | Sales (NPR) | Invoices |`,
      `|---|---:|---:|---:|`,
      ...data.byNepaliMonth.map(
        (row) =>
          `| ${row.bsMonth} | ${row.bsYear} | ${formatAmount(row.salesExcludingTax)} | ${row.invoices} |`,
      ),
      `| **FY total** | | **${formatAmount(data.totalSalesExcludingTax)}** | **${data.invoiceCount ?? 0}** |`,
    ];

    if (data.allTimeSalesExcludingTax != null) {
      lines.push(
        "",
        `All-time synced sales: **${formatAmount(data.allTimeSalesExcludingTax)}** (${data.allTimeInvoices ?? 0} invoices).`,
      );
    }

    return lines.join("\n");
  }

  const lines = [
    `**${data.branchName} (code ${branchCode})** — ${companyLabel}${formatSync(data._syncedAt)}`,
    "",
    `| Period | Sales (NPR) | Invoices |`,
    `|---|---:|---:|`,
    `| All synced data | ${formatAmount(data.totalSalesExcludingTax)} | ${data.invoiceCount ?? 0} |`,
  ];

  if (data.currentNepaliFiscalYear) {
    lines.push(
      `| Nepali FY ${data.currentNepaliFiscalYear.label} | ${formatAmount(data.currentNepaliFiscalYear.salesExcludingTax)} | ${data.currentNepaliFiscalYear.invoices} |`,
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
      salesExcludingTax: number;
      invoices: number;
    }>;
    totalSalesExcludingTax?: number;
    currentNepaliFiscalYear?: {
      label: string;
      totalSales: number;
      branches: Array<{
        branchCode: string;
        branchName: string;
        salesExcludingTax: number;
        invoices: number;
      }>;
    };
    _syncedAt?: string;
  };

  if (data.error) return data.error;

  const companyLabel = getCompany(getActiveCompany()).displayName;
  const lines = [
    `**Branch-wise sales** — ${companyLabel}${formatSync(data._syncedAt)}`,
    "",
    "### All synced invoice sales",
    "",
    "| Code | Branch | Sales (NPR) | Invoices |",
    "|---|---|---:|---:|",
    ...(data.branches ?? []).map(
      (row) =>
        `| ${row.branchCode} | ${row.branchName} | ${formatAmount(row.salesExcludingTax)} | ${row.invoices} |`,
    ),
    `| **Total** | | **${formatAmount(data.totalSalesExcludingTax)}** | |`,
  ];

  if (data.currentNepaliFiscalYear) {
    lines.push(
      "",
      `### Current Nepali FY ${data.currentNepaliFiscalYear.label}`,
      "",
      "| Code | Branch | Sales (NPR) | Invoices |",
      "|---|---|---:|---:|",
      ...data.currentNepaliFiscalYear.branches.map(
        (row) =>
          `| ${row.branchCode} | ${row.branchName} | ${formatAmount(row.salesExcludingTax)} | ${row.invoices} |`,
      ),
      `| **Total** | | **${formatAmount(data.currentNepaliFiscalYear.totalSales)}** | |`,
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
