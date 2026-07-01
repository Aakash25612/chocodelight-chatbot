import { formatAmount } from "./format";
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

    const branchCode = extractBranchFromMessage(message);
    if (branchCode) {
      return formatBranchSales(branchCode);
    }

    if (isBranchWiseSalesQuery(normalized)) {
      return formatBranchWiseSales();
    }

    return null;
  });
}

function extractBranchFromMessage(message: string): string | null {
  const code = extractBranchCodeQuery(message);
  if (code) return code;

  if (/\b(sales|total|revenue|branch|code|depo|depot)\b/i.test(message)) {
    const resolved = resolveBranch({ query: message });
    if (!("error" in resolved)) return resolved.code;
  }

  return null;
}

function extractBranchCodeQuery(message: string): string | null {
  const normalized = message.trim().toLowerCase();
  const patterns = [
    /\b(?:code|branch|depo(?:t)?)\s*[:=]?\s*([a-z])\b/i,
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

async function formatBranchSales(branchCode: string): Promise<string> {
  const branch = resolveBranch({ branchCode });
  if ("error" in branch) {
    return branch.error;
  }

  const data = (await getSalesByBranch({ branchCode })) as {
    error?: string;
    branchName?: string;
    totalSalesExcludingTax?: number;
    invoiceCount?: number;
    currentNepaliFiscalYear?: {
      label: string;
      salesExcludingTax: number;
      invoices: number;
    };
    _syncedAt?: string;
  };

  if (data.error) return data.error;

  const companyLabel = getCompany(getActiveCompany()).displayName;
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
