import { formatAmount } from "./format";
import { loadCustomersPayload } from "./derived-customers";

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
): Promise<string | null> {
  const normalized = message.trim().toLowerCase();

  if (isListAllCustomers(normalized)) {
    return listAllCustomers();
  }

  return null;
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
