import { getMirror } from "./bc-mirror";
import { formatAmount } from "./format";
import { type DatePeriodInput, periodFromInput } from "./date-period";
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
  const totalNotYetDue = buckets
    .filter((b) => b.bucket === "Not due")
    .reduce((sum, b) => sum + b.amount, 0);

  overdueEntries.sort((a, b) => b.daysOverdue - a.daysOverdue);

  const topOverdueCustomers = [...perCustomer.values()]
    .sort((a, b) => b.overdue - a.overdue)
    .slice(0, 15)
    .map((c) => ({ ...c, overdue: round(c.overdue) }));

  const topCustomersByBalance = (customersPayload.value ?? [])
    .map((customer) => {
      const balance = round(Number(customer.balance ?? 0));
      const overdueAmount = round(Number(customer.overdueAmount ?? 0));
      return {
        customerNo: customer.number,
        name: customer.displayName,
        balance,
        overdueAmount,
        notYetDueAmount: round(Math.max(0, balance - overdueAmount)),
      };
    })
    .filter((row) => row.balance > 0)
    .sort((a, b) => b.balance - a.balance)
    .slice(0, 15);

  return {
    currency: "NPR",
    asOf: now.toISOString().slice(0, 10),
    basis:
      "Open customer ledger invoice entries, aged by due date. For who owes the most by total balance, use topCustomersByBalance (overdue vs not yet due split).",
    totalOutstanding: round(totalOutstanding),
    totalOverdue: round(totalOverdue),
    totalNotYetDue: round(totalNotYetDue),
    buckets: buckets.map((b) => ({ ...b, amount: round(b.amount) })),
    ...(minDaysOverdue
      ? { filterDaysOverdue: minDaysOverdue }
      : {}),
    matchingOverdueTotal: round(
      overdueEntries.reduce((sum, e) => sum + e.remaining, 0),
    ),
    overdueEntries: overdueEntries.slice(0, 50),
    topOverdueCustomers,
    topCustomersByBalance,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

function normalizeSearchText(value: string): string {
  return value.toLowerCase().replace(/\./g, "").replace(/\s+/g, " ").trim();
}

/**
 * Find customers by name, number, or phone. Use instead of dumping all customers.
 */
export async function searchCustomers(query: string): Promise<unknown> {
  const payload = (await getMirror("customers")) as MirrorPayload<Customer>;
  if (payload.error) return { error: payload.error };

  const term = normalizeSearchText(query);
  if (!term) return { error: "Search query required." };

  const matches = (payload.value ?? [])
    .map((customer) => {
      const fields = [
        customer.number ?? "",
        customer.displayName ?? "",
        customer.phoneNumber ?? "",
      ];
      const normalized = normalizeSearchText(fields.join(" "));
      let score = 0;
      if (normalizeSearchText(customer.displayName ?? "") === term) score = 100;
      else if (normalizeSearchText(customer.number ?? "") === term) score = 95;
      else if (normalized.startsWith(term)) score = 80;
      else if (fields.some((field) => normalizeSearchText(field).includes(term)))
        score = 60;
      else if (normalized.includes(term)) score = 40;
      return { customer, score };
    })
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score);

  const results = matches.slice(0, 15).map(({ customer, score }) => ({
    customerNo: customer.number,
    name: customer.displayName,
    phone: customer.phoneNumber,
    balance: round(Number(customer.balance ?? 0)),
    overdueAmount: round(Number(customer.overdueAmount ?? 0)),
    matchScore: score,
  }));

  return {
    query,
    matchCount: matches.length,
    customers: results,
    _syncedAt: payload._syncedAt,
  };
}

/**
 * Customer payment / invoice statement from ledger entries.
 * Resolve by customerNo, customer name search, or a known document number.
 */
export async function getCustomerStatement(input?: {
  customerNo?: string;
  query?: string;
  documentNo?: string;
}): Promise<unknown> {
  const [ledgerPayload, customersPayload] = await Promise.all([
    loadLedger(),
    getMirror("customers") as Promise<MirrorPayload<Customer>>,
  ]);
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  const customers = customersPayload.value ?? [];
  const customerByNo = new Map(
    customers.filter((c) => c.number).map((c) => [c.number!, c]),
  );

  let customerNo = input?.customerNo?.trim();
  let customer = customerNo ? customerByNo.get(customerNo) : undefined;

  if (!customer && input?.documentNo) {
    const doc = input.documentNo.trim();
    const docEntry = (ledgerPayload.value ?? []).find(
      (entry) => entry.documentNo === doc,
    );
    customerNo = docEntry?.customerNo ?? docEntry?.sellToCustomerNo;
    customer = customerNo ? customerByNo.get(customerNo) : undefined;
  }

  if (!customer && input?.query) {
    const search = (await searchCustomers(input.query)) as {
      customers?: Array<{
        customerNo?: string;
        name?: string;
        matchScore?: number;
      }>;
      matchCount?: number;
    };
    const top = search.customers ?? [];
    if (top.length === 0) {
      return {
        error: `No customer found matching "${input.query}". Try a shorter name or customer number.`,
      };
    }
    if (top.length > 1 && top[0].matchScore === top[1].matchScore) {
      return {
        error: "Multiple customers matched. Please specify customer number.",
        candidates: top.slice(0, 5),
      };
    }
    customerNo = top[0].customerNo;
    customer = customerNo ? customerByNo.get(customerNo) : undefined;
  }

  if (!customerNo || !customer) {
    return {
      error:
        "Customer not found. Pass customerNo, query (name), or documentNo from an invoice.",
    };
  }

  const entries = (ledgerPayload.value ?? [])
    .filter(
      (entry) =>
        entry.customerNo === customerNo || entry.sellToCustomerNo === customerNo,
    )
    .sort((a, b) =>
      String(b.postingDate ?? "").localeCompare(String(a.postingDate ?? "")),
    );

  let totalInvoiced = 0;
  let totalPaid = 0;
  let totalCreditMemos = 0;
  let openBalance = 0;
  let overdueBalance = 0;
  const now = new Date();

  const invoices: Array<Record<string, unknown>> = [];
  const payments: Array<Record<string, unknown>> = [];
  const openInvoices: Array<Record<string, unknown>> = [];

  for (const entry of entries) {
    const amount = Number(entry.amountLcy ?? entry.salesLcy ?? 0);
    const remaining = Number(entry.remainingAmount ?? 0);

    if (entry.documentType === "Invoice") {
      totalInvoiced += Number(entry.salesLcy ?? Math.max(amount, 0));
      invoices.push({
        documentNo: entry.documentNo,
        postingDate: entry.postingDate,
        dueDate: entry.dueDate,
        amount: round(Number(entry.salesLcy ?? amount)),
        remaining: round(remaining),
        open: !!entry.open,
      });
      if (entry.open && remaining > 0) {
        const due = parseDate(entry.dueDate);
        const daysOverdue = due
          ? Math.floor((now.getTime() - due.getTime()) / 86400000)
          : 0;
        openBalance += remaining;
        if (daysOverdue > 0) overdueBalance += remaining;
        openInvoices.push({
          documentNo: entry.documentNo,
          dueDate: entry.dueDate,
          daysOverdue: Math.max(daysOverdue, 0),
          remaining: round(remaining),
        });
      }
    } else if (entry.documentType === "Payment") {
      totalPaid += Math.abs(amount);
      payments.push({
        documentNo: entry.documentNo,
        postingDate: entry.postingDate,
        amount: round(Math.abs(amount)),
        description: entry.description ?? "",
      });
    } else if (entry.documentType === "Credit Memo") {
      totalCreditMemos += Math.abs(amount);
      payments.push({
        documentNo: entry.documentNo,
        postingDate: entry.postingDate,
        amount: round(Math.abs(amount)),
        description: entry.description ?? "Credit Memo",
        type: "Credit Memo",
      });
    }
  }

  openInvoices.sort((a, b) => Number(b.daysOverdue) - Number(a.daysOverdue));

  return {
    currency: "NPR",
    customerNo,
    name: customer.displayName,
    phone: customer.phoneNumber,
    masterBalance: round(Number(customer.balance ?? 0)),
    masterOverdue: round(Number(customer.overdueAmount ?? 0)),
    summary: {
      totalInvoiced: round(totalInvoiced),
      totalPaid: round(totalPaid),
      totalCreditMemos: round(totalCreditMemos),
      netCollected: round(totalPaid + totalCreditMemos),
      openBalance: round(openBalance),
      overdueBalance: round(overdueBalance),
      invoiceCount: invoices.length,
      paymentCount: payments.filter((p) => p.type !== "Credit Memo").length,
    },
    summaryFormatted: {
      totalInvoiced: formatAmount(totalInvoiced),
      totalPaid: formatAmount(totalPaid),
      totalCreditMemos: formatAmount(totalCreditMemos),
      netCollected: formatAmount(totalPaid + totalCreditMemos),
      openBalance: formatAmount(openBalance),
      overdueBalance: formatAmount(overdueBalance),
    },
    openInvoices: openInvoices.slice(0, 20),
    recentPayments: payments.slice(0, 20),
    recentInvoices: invoices.slice(0, 20),
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
export async function getProductSales(
  input?: {
    query?: string;
    itemNumbers?: string[];
  } & DatePeriodInput,
): Promise<unknown> {
  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

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
    if (!postingDate || !period.matches(postingDate)) continue;

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
      averageUnitPrice:
        row.quantityInvoiced > 0
          ? round(row.salesExcludingTax / row.quantityInvoiced)
          : 0,
    }))
    .sort((a, b) => b.salesExcludingTax - a.salesExcludingTax);

  return {
    currency: "NPR",
    query: query || null,
    period: period.label,
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
    averageUnitPrice:
      totalQuantity > 0 ? round(totalSales / totalQuantity) : 0,
    matchedLineCount: matchedLines,
    items,
    _syncedAt:
      linesPayload._syncedAt ??
      ordersPayload._syncedAt ??
      itemsPayload._syncedAt,
  };
}
