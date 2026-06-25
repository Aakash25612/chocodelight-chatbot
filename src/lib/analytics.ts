import { getMirror } from "./bc-mirror";
import {
  BS_MONTHS,
  fiscalYearLabel,
  getNepaliFiscalYear,
  toBs,
} from "./nepali-date";

type LedgerEntry = {
  open?: boolean;
  documentType?: string;
  postingDate?: string;
  dueDate?: string;
  salesLcy?: number;
  amountLcy?: number;
  remainingAmount?: number;
  customerNo?: string;
  sellToCustomerNo?: string;
  documentNo?: string;
  description?: string;
};

type Customer = {
  number?: string;
  displayName?: string;
  phoneNumber?: string;
  balance?: number;
  overdueAmount?: number;
};

type Item = {
  number?: string;
  displayName?: string;
  itemCategory?: string;
  itemType?: string;
  inventory?: number;
  unitCost?: number;
  unitPrice?: number;
  blocked?: boolean;
  baseUnitOfMeasure?: { code?: string } | string;
};

type MirrorPayload<T> = {
  value?: T[];
  _syncedAt?: string;
  error?: string;
};

async function loadLedger(): Promise<MirrorPayload<LedgerEntry>> {
  return (await getMirror("custLedgEntries")) as MirrorPayload<LedgerEntry>;
}

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * All-time and segmented sales summary. Use this for "total sales" questions,
 * since the mirror spans multiple AD years and Nepali fiscal years.
 */
export async function getSalesSummary(): Promise<unknown> {
  const payload = await loadLedger();
  if (payload.error) return { error: payload.error };
  const entries = payload.value ?? [];

  let grossInvoiceSales = 0;
  let creditMemoSales = 0;
  let invoiceCount = 0;
  let earliest: Date | null = null;
  let latest: Date | null = null;

  const byAdYear: Record<string, { sales: number; invoices: number }> = {};
  const byFiscalYear: Record<string, { sales: number; invoices: number }> = {};

  for (const entry of entries) {
    const date = parseDate(entry.postingDate);
    if (!date) continue;
    if (!earliest || date < earliest) earliest = date;
    if (!latest || date > latest) latest = date;

    const sales = Number(entry.salesLcy ?? 0);

    if (entry.documentType === "Invoice") {
      grossInvoiceSales += sales;
      invoiceCount += 1;

      const adYear = String(date.getFullYear());
      byAdYear[adYear] ??= { sales: 0, invoices: 0 };
      byAdYear[adYear].sales += sales;
      byAdYear[adYear].invoices += 1;

      const fy = getNepaliFiscalYear(date);
      if (fy) {
        byFiscalYear[fy.label] ??= { sales: 0, invoices: 0 };
        byFiscalYear[fy.label].sales += sales;
        byFiscalYear[fy.label].invoices += 1;
      }
    } else if (entry.documentType === "Credit Memo") {
      creditMemoSales += sales;
    }
  }

  return {
    currency: "NPR",
    note: "Sales figures are net of tax (salesLcy) from customer ledger invoice entries. Profit is not included because COGS/cost data is not synced.",
    allTime: {
      grossInvoiceSales: round(grossInvoiceSales),
      creditMemos: round(creditMemoSales),
      netSales: round(grossInvoiceSales - Math.abs(creditMemoSales)),
      invoiceCount,
      dateRange: {
        from: earliest?.toISOString().slice(0, 10) ?? null,
        to: latest?.toISOString().slice(0, 10) ?? null,
      },
    },
    byAdYear: Object.fromEntries(
      Object.entries(byAdYear)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([year, v]) => [year, { sales: round(v.sales), invoices: v.invoices }]),
    ),
    byNepaliFiscalYear: Object.fromEntries(
      Object.entries(byFiscalYear)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([fy, v]) => [fy, { sales: round(v.sales), invoices: v.invoices }]),
    ),
    _syncedAt: payload._syncedAt,
  };
}

/**
 * Receivables aging based on open invoice entries and days past due date.
 * Use for overdue / payment-pending questions, e.g. "90 days payment pending".
 */
export async function getReceivablesAging(
  minDaysOverdue?: number,
): Promise<unknown> {
  const [ledgerPayload, customersPayload] = await Promise.all([
    loadLedger(),
    getMirror("customers") as Promise<MirrorPayload<Customer>>,
  ]);
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  const customerNames = new Map<string, string>();
  for (const customer of customersPayload.value ?? []) {
    if (customer.number) {
      customerNames.set(customer.number, customer.displayName ?? "");
    }
  }

  const now = new Date();
  const bucketDefs = [
    { key: "current", label: "Not due", min: -Infinity, max: 0 },
    { key: "1-30", label: "1-30 days", min: 1, max: 30 },
    { key: "31-60", label: "31-60 days", min: 31, max: 60 },
    { key: "61-90", label: "61-90 days", min: 61, max: 90 },
    { key: "90+", label: "Over 90 days", min: 91, max: Infinity },
  ] as const;

  const buckets = bucketDefs.map((def) => ({
    bucket: def.label,
    count: 0,
    amount: 0,
  }));

  const perCustomer = new Map<
    string,
    { customerNo: string; name: string; overdue: number; entries: number }
  >();
  const overdueEntries: Array<{
    customerNo: string;
    name: string;
    documentNo: string;
    dueDate: string;
    daysOverdue: number;
    remaining: number;
  }> = [];

  for (const entry of ledgerPayload.value ?? []) {
    if (!entry.open) continue;
    const remaining = Number(entry.remainingAmount ?? 0);
    if (remaining <= 0) continue;
    if (entry.documentType !== "Invoice") continue;

    const due = parseDate(entry.dueDate);
    if (!due) continue;
    const daysOverdue = Math.floor((now.getTime() - due.getTime()) / 86400000);

    const bucketIndex = bucketDefs.findIndex(
      (def) => daysOverdue >= def.min && daysOverdue <= def.max,
    );
    if (bucketIndex >= 0) {
      buckets[bucketIndex].count += 1;
      buckets[bucketIndex].amount += remaining;
    }

    if (daysOverdue > 0) {
      const customerNo = entry.customerNo ?? entry.sellToCustomerNo ?? "";
      const name = customerNames.get(customerNo) ?? "";
      const agg =
        perCustomer.get(customerNo) ??
        { customerNo, name, overdue: 0, entries: 0 };
      agg.overdue += remaining;
      agg.entries += 1;
      perCustomer.set(customerNo, agg);

      if (!minDaysOverdue || daysOverdue >= minDaysOverdue) {
        overdueEntries.push({
          customerNo,
          name,
          documentNo: entry.documentNo ?? "",
          dueDate: entry.dueDate ?? "",
          daysOverdue,
          remaining: round(remaining),
        });
      }
    }
  }

  const totalOutstanding = buckets.reduce((sum, b) => sum + b.amount, 0);
  const totalOverdue = buckets
    .filter((b) => b.bucket !== "Not due")
    .reduce((sum, b) => sum + b.amount, 0);

  overdueEntries.sort((a, b) => b.daysOverdue - a.daysOverdue);

  const topOverdueCustomers = [...perCustomer.values()]
    .sort((a, b) => b.overdue - a.overdue)
    .slice(0, 15)
    .map((c) => ({ ...c, overdue: round(c.overdue) }));

  return {
    currency: "NPR",
    asOf: now.toISOString().slice(0, 10),
    basis: "Open customer ledger invoice entries, aged by due date.",
    totalOutstanding: round(totalOutstanding),
    totalOverdue: round(totalOverdue),
    buckets: buckets.map((b) => ({ ...b, amount: round(b.amount) })),
    ...(minDaysOverdue
      ? { filterDaysOverdue: minDaysOverdue }
      : {}),
    matchingOverdueTotal: round(
      overdueEntries.reduce((sum, e) => sum + e.remaining, 0),
    ),
    overdueEntries: overdueEntries.slice(0, 50),
    topOverdueCustomers,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/**
 * Sales aggregated by Bikram Sambat month for a Nepali fiscal year (Shrawan -> Ashadh).
 * If fiscalYearStart is omitted, uses the fiscal year of the latest posting date.
 */
export async function getNepaliMonthlySales(
  fiscalYearStart?: number,
): Promise<unknown> {
  const payload = await loadLedger();
  if (payload.error) return { error: payload.error };
  const entries = payload.value ?? [];

  let latest: Date | null = null;
  for (const entry of entries) {
    if (entry.documentType !== "Invoice") continue;
    const date = parseDate(entry.postingDate);
    if (date && (!latest || date > latest)) latest = date;
  }

  let startYear = fiscalYearStart;
  if (!startYear) {
    const fy = latest ? getNepaliFiscalYear(latest) : null;
    startYear = fy?.startYear ?? toBs(new Date())?.year ?? new Date().getFullYear();
  }

  // Fiscal order: Shrawan(3) .. Chaitra(11) of startYear, then Baisakh(0) .. Asar(2) of startYear+1.
  const fiscalOrder = [3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1, 2];
  const months = fiscalOrder.map((monthIndex) => ({
    month: BS_MONTHS[monthIndex],
    monthIndex,
    bsYear: monthIndex >= 3 ? startYear : startYear + 1,
    invoices: 0,
    sales: 0,
  }));

  for (const entry of entries) {
    if (entry.documentType !== "Invoice") continue;
    const date = parseDate(entry.postingDate);
    if (!date) continue;
    const fy = getNepaliFiscalYear(date);
    if (!fy || fy.startYear !== startYear) continue;
    const bs = toBs(date);
    if (!bs) continue;
    const slot = months.find((m) => m.monthIndex === bs.month);
    if (!slot) continue;
    slot.invoices += 1;
    slot.sales += Number(entry.salesLcy ?? 0);
  }

  const cleaned = months.map((m) => ({ ...m, sales: round(m.sales) }));
  const topMonth = [...cleaned].sort((a, b) => b.sales - a.sales)[0];
  const totalSales = round(cleaned.reduce((sum, m) => sum + m.sales, 0));

  return {
    currency: "NPR",
    calendar: "Bikram Sambat",
    fiscalYear: fiscalYearLabel(startYear),
    note: "Fiscal year runs Shrawan to Ashadh. Sales are net of tax (salesLcy).",
    totalSales,
    topMonth,
    months: cleaned,
    _syncedAt: payload._syncedAt,
  };
}

/**
 * Search items/products by keyword across number, name, category, and type.
 * Use for product-group style questions like "dip", "chocolate", "syrup".
 * For SALES AMOUNTS by product keyword, use getProductSales instead.
 */
export async function searchItems(query?: string): Promise<unknown> {
  const payload = (await getMirror("items")) as MirrorPayload<Item>;
  if (payload.error) return { error: payload.error };
  const items = payload.value ?? [];

  const categories = new Map<string, number>();
  for (const item of items) {
    const cat = item.itemCategory ?? "(none)";
    categories.set(cat, (categories.get(cat) ?? 0) + 1);
  }

  const term = (query ?? "").trim().toLowerCase();
  const matches = term
    ? items.filter((item) =>
        [item.number, item.displayName, item.itemCategory, item.itemType].some(
          (field) => String(field ?? "").toLowerCase().includes(term),
        ),
      )
    : items;

  const mapped = matches.slice(0, 60).map((item) => ({
    number: item.number,
    name: item.displayName,
    category: item.itemCategory,
    type: item.itemType,
    inventory: item.inventory,
    unitPrice: item.unitPrice,
    unitOfMeasure:
      typeof item.baseUnitOfMeasure === "object"
        ? item.baseUnitOfMeasure?.code
        : item.baseUnitOfMeasure,
    blocked: item.blocked,
  }));

  return {
    query: query ?? null,
    matchCount: matches.length,
    availableCategories: Object.fromEntries(
      [...categories.entries()].sort((a, b) => b[1] - a[1]),
    ),
    items: mapped,
    _syncedAt: payload._syncedAt,
  };
}

type SalesOrder = {
  number?: string;
  postingDate?: string;
};

type SalesOrderLine = {
  docNo?: string;
  itemNo?: string;
  quantity?: number;
  quantityInvoiced?: number;
  unitPrice?: number;
};

/**
 * Product-level invoiced sales from synced sales order lines.
 * BC does not expose posted invoice lines in this API; invoiced quantities on
 * sales order lines are the best available source (from ~Jul 2024 onward).
 */
export async function getProductSales(input?: {
  query?: string;
  year?: number;
  itemNumbers?: string[];
}): Promise<unknown> {
  const [linesPayload, ordersPayload, itemsPayload] = await Promise.all([
    getMirror("salesOrderLines") as Promise<MirrorPayload<SalesOrderLine>>,
    getMirror("salesOrders") as Promise<MirrorPayload<SalesOrder>>,
    getMirror("items") as Promise<MirrorPayload<Item>>,
  ]);

  if (linesPayload.error) return { error: linesPayload.error };
  if (ordersPayload.error) return { error: ordersPayload.error };

  const orderDates = new Map<string, string>();
  for (const order of ordersPayload.value ?? []) {
    if (order.number && order.postingDate) {
      orderDates.set(order.number, order.postingDate);
    }
  }

  const itemMeta = new Map<string, Item>();
  for (const item of itemsPayload.value ?? []) {
    if (item.number) itemMeta.set(item.number, item);
  }

  const query = (input?.query ?? "").trim().toLowerCase();
  const explicitItems = (input?.itemNumbers ?? []).map((n) => n.toUpperCase());
  const year = input?.year;

  function matchesItem(itemNo: string): boolean {
    if (explicitItems.length > 0) {
      return explicitItems.includes(itemNo.toUpperCase());
    }
    if (!query) return true;
    const meta = itemMeta.get(itemNo);
    const haystack = [
      itemNo,
      meta?.displayName,
      meta?.itemCategory,
      meta?.itemType,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(query);
  }

  const byItem = new Map<
    string,
    {
      itemNo: string;
      name: string;
      category: string;
      quantityInvoiced: number;
      salesExcludingTax: number;
      lineCount: number;
    }
  >();

  let totalSales = 0;
  let totalQuantity = 0;
  let matchedLines = 0;
  let earliest: string | null = null;
  let latest: string | null = null;

  for (const line of linesPayload.value ?? []) {
    const qtyInvoiced = Number(line.quantityInvoiced ?? 0);
    if (qtyInvoiced <= 0) continue;

    const itemNo = String(line.itemNo ?? "");
    if (!itemNo || !matchesItem(itemNo)) continue;

    const postingDate = orderDates.get(String(line.docNo ?? ""));
    if (year && postingDate) {
      const lineYear = new Date(postingDate).getFullYear();
      if (lineYear !== year) continue;
    }

    const unitPrice = Number(line.unitPrice ?? 0);
    const lineSales = qtyInvoiced * unitPrice;
    const meta = itemMeta.get(itemNo);

    matchedLines += 1;
    totalSales += lineSales;
    totalQuantity += qtyInvoiced;
    if (postingDate) {
      if (!earliest || postingDate < earliest) earliest = postingDate;
      if (!latest || postingDate > latest) latest = postingDate;
    }

    const agg =
      byItem.get(itemNo) ??
      {
        itemNo,
        name: meta?.displayName ?? "",
        category: meta?.itemCategory ?? "",
        quantityInvoiced: 0,
        salesExcludingTax: 0,
        lineCount: 0,
      };
    agg.quantityInvoiced += qtyInvoiced;
    agg.salesExcludingTax += lineSales;
    agg.lineCount += 1;
    byItem.set(itemNo, agg);
  }

  const items = [...byItem.values()]
    .map((row) => ({
      ...row,
      quantityInvoiced: round(row.quantityInvoiced),
      salesExcludingTax: round(row.salesExcludingTax),
    }))
    .sort((a, b) => b.salesExcludingTax - a.salesExcludingTax);

  return {
    currency: "NPR",
    query: query || null,
    year: year ?? null,
    itemNumbers: explicitItems.length ? explicitItems : null,
    basis:
      "Invoiced sales order lines (quantityInvoiced × unitPrice), joined to sales order posting dates. Posted invoice line API is not exposed; this covers synced sales orders only.",
    dataCoverage: {
      from: earliest,
      to: latest,
      note: "Sales order line sync typically starts mid-2024. Older product sales may be missing even if customer ledger totals exist.",
    },
    totalSalesExcludingTax: round(totalSales),
    totalQuantityInvoiced: round(totalQuantity),
    matchedLineCount: matchedLines,
    items,
    _syncedAt:
      linesPayload._syncedAt ??
      ordersPayload._syncedAt ??
      itemsPayload._syncedAt,
  };
}
