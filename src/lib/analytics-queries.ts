import { getMirror, getSyncStatus } from "./bc-mirror";
import { searchCustomers } from "./analytics";
import { loadCustomersPayload } from "./derived-customers";
import {
  branchCodeFromDocument,
  listBranchDefinitions,
  resolveBranch,
  branchNameForCode,
} from "./branches";
import {
  loadBranchSalesCache,
} from "./branch-sales-cache";
import { type DatePeriodInput, periodFromInput } from "./date-period";
import {
  BS_MONTHS,
  fiscalYearLabel,
  getCurrentFiscalYearStart,
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
  blocked?: boolean;
  totalSalesExcludingTax?: number;
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
};

type SalesOrder = {
  number?: string;
  postingDate?: string;
  customerNumber?: string;
  orderStatus?: string;
  salesperson?: string;
  completelyInvoicedOrder?: boolean;
};

type SalesOrderLine = {
  docNo?: string;
  itemNo?: string;
  quantity?: number;
  quantityInvoiced?: number;
  unitPrice?: number;
};

type MrRecord = {
  mRNo?: number;
  amount?: number;
  status?: string;
  customerNo?: string;
  customerName?: string;
  paymentMode?: string;
  receivedEnglishiDate?: string;
  clearedEnglishiDate?: string;
};

type MirrorPayload<T> = {
  value?: T[];
  _syncedAt?: string;
  error?: string;
};

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function monthName(month: number): string {
  return new Date(2000, month - 1, 1).toLocaleString("en-US", { month: "long" });
}

function parseNepaliMonth(name?: string): number | null {
  if (!name) return null;
  const term = name.trim().toLowerCase();
  const idx = BS_MONTHS.findIndex((m) => m.toLowerCase() === term);
  return idx >= 0 ? idx : null;
}

async function loadLedger(): Promise<MirrorPayload<LedgerEntry>> {
  return (await getMirror("custLedgEntries")) as MirrorPayload<LedgerEntry>;
}

async function loadCustomers(): Promise<MirrorPayload<Customer>> {
  return (await loadCustomersPayload()) as MirrorPayload<Customer>;
}

async function loadItems(): Promise<MirrorPayload<Item>> {
  return (await getMirror("items")) as MirrorPayload<Item>;
}

async function loadSalesOrders(): Promise<MirrorPayload<SalesOrder>> {
  return (await getMirror("salesOrders")) as MirrorPayload<SalesOrder>;
}

async function loadSalesOrderLines(): Promise<MirrorPayload<SalesOrderLine>> {
  return (await getMirror("salesOrderLines")) as MirrorPayload<SalesOrderLine>;
}

async function loadMr(): Promise<MirrorPayload<MrRecord>> {
  return (await getMirror("mr")) as MirrorPayload<MrRecord>;
}

function aggregateInvoiceSalesByBranch(
  entries: LedgerEntry[],
  matches?: (postingDate?: string) => boolean,
): Map<string, { sales: number; invoices: number }> {
  const totals = new Map<string, { sales: number; invoices: number }>();
  for (const entry of entries) {
    if (entry.documentType !== "Invoice") continue;
    if (matches && !matches(entry.postingDate)) continue;
    const code = branchCodeFromDocument(entry.documentNo);
    if (!code) continue;
    const agg = totals.get(code) ?? { sales: 0, invoices: 0 };
    agg.sales += Number(entry.salesLcy ?? 0);
    agg.invoices += 1;
    totals.set(code, agg);
  }
  return totals;
}

function hasCustomPeriod(input?: DatePeriodInput): boolean {
  return Boolean(
    input?.year ||
      input?.month ||
      input?.week ||
      input?.day ||
      input?.nepaliMonth ||
      input?.fiscalYearStart ||
      input?.dateFrom ||
      input?.dateTo,
  );
}

async function buildCustomerNameMap(): Promise<Map<string, string>> {
  const payload = await loadCustomers();
  const map = new Map<string, string>();
  for (const customer of payload.value ?? []) {
    if (customer.number) map.set(customer.number, customer.displayName ?? "");
  }
  return map;
}

async function resolveCustomerNo(input?: {
  customerNo?: string;
  query?: string;
}): Promise<{ customerNo: string; name: string } | { error: string; candidates?: unknown }> {
  if (input?.customerNo?.trim()) {
    const payload = await loadCustomers();
    const customer = (payload.value ?? []).find(
      (c) => c.number === input.customerNo?.trim(),
    );
    if (!customer?.number) {
      return { error: `Customer number ${input.customerNo} not found.` };
    }
    return { customerNo: customer.number, name: customer.displayName ?? "" };
  }

  if (input?.query?.trim()) {
    const search = (await searchCustomers(input.query)) as {
      customers?: Array<{ customerNo?: string; name?: string; matchScore?: number }>;
    };
    const top = search.customers ?? [];
    if (top.length === 0) {
      return { error: `No customer found matching "${input.query}".` };
    }
    if (top.length > 1 && top[0].matchScore === top[1].matchScore) {
      return {
        error: "Multiple customers matched. Pass customerNo.",
        candidates: top.slice(0, 5),
      };
    }
    return {
      customerNo: top[0].customerNo ?? "",
      name: top[0].name ?? "",
    };
  }

  return { error: "Pass customerNo or query (customer name)." };
}

function entryCustomerNo(entry: LedgerEntry): string {
  return entry.customerNo ?? entry.sellToCustomerNo ?? "";
}

function inAdPeriod(
  date: Date,
  year?: number,
  month?: number,
): boolean {
  if (year && date.getFullYear() !== year) return false;
  if (month && date.getMonth() + 1 !== month) return false;
  return true;
}

type CustomerAgg = {
  customerNo: string;
  name: string;
  sales: number;
  invoices: number;
  payments: number;
  creditMemos: number;
};

function aggregateLedgerByCustomer(
  entries: LedgerEntry[],
  names: Map<string, string>,
  filter?: (entry: LedgerEntry, date: Date) => boolean,
): Map<string, CustomerAgg> {
  const map = new Map<string, CustomerAgg>();

  for (const entry of entries) {
    const date = parseDate(entry.postingDate);
    if (!date) continue;
    if (filter && !filter(entry, date)) continue;

    const customerNo = entryCustomerNo(entry);
    if (!customerNo) continue;

    const agg =
      map.get(customerNo) ??
      {
        customerNo,
        name: names.get(customerNo) ?? "",
        sales: 0,
        invoices: 0,
        payments: 0,
        creditMemos: 0,
      };

    if (entry.documentType === "Invoice") {
      agg.sales += Number(entry.salesLcy ?? 0);
      agg.invoices += 1;
    } else if (entry.documentType === "Payment") {
      agg.payments += Math.abs(Number(entry.amountLcy ?? entry.salesLcy ?? 0));
    } else if (entry.documentType === "Credit Memo") {
      agg.creditMemos += Math.abs(Number(entry.amountLcy ?? entry.salesLcy ?? 0));
    }

    map.set(customerNo, agg);
  }

  return map;
}

/** Top customers by invoiced sales for one AD calendar month (ledger basis). */
export async function getTopCustomersByMonth(input?: {
  year?: number;
  month?: number;
  limit?: number;
}): Promise<unknown> {
  const year = input?.year ?? new Date().getFullYear();
  const month = input?.month ?? new Date().getMonth() + 1;
  const limit = Math.min(input?.limit ?? 15, 50);

  const [ledgerPayload, names] = await Promise.all([loadLedger(), buildCustomerNameMap()]);
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  const byCustomer = aggregateLedgerByCustomer(
    ledgerPayload.value ?? [],
    names,
    (entry, date) =>
      entry.documentType === "Invoice" && inAdPeriod(date, year, month),
  );

  const totalMonthSales = round(
    [...byCustomer.values()].reduce((sum, row) => sum + row.sales, 0),
  );
  const ranked = [...byCustomer.values()]
    .map((row) => ({
      customerNo: row.customerNo,
      name: row.name,
      salesExcludingTax: round(row.sales),
      invoiceCount: row.invoices,
    }))
    .sort((a, b) => b.salesExcludingTax - a.salesExcludingTax)
    .slice(0, limit);

  return {
    currency: "NPR",
    period: { calendar: "Gregorian (AD)", year, month, monthName: monthName(month) },
    basis:
      "Customer ledger invoice entries (salesLcy). Authoritative for customer ranking by month.",
    totalMonthSales,
    invoiceCount: ranked.reduce((sum, row) => sum + row.invoiceCount, 0),
    topCustomer: ranked[0] ?? null,
    customers: ranked,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/** Outstanding receivables ranked by total balance with overdue vs not-yet-due split. */
export async function getOutstandingReceivables(input?: {
  limit?: number;
}): Promise<unknown> {
  const limit = Math.min(input?.limit ?? 15, 50);
  const customersPayload = await loadCustomers();
  if (customersPayload.error) return { error: customersPayload.error };
  const customerSource = (customersPayload as { source?: string }).source;

  const ranked = (customersPayload.value ?? [])
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
    .sort((a, b) => b.balance - a.balance);

  const totalOutstanding = round(
    ranked.reduce((sum, row) => sum + row.balance, 0),
  );
  const totalOverdue = round(
    ranked.reduce((sum, row) => sum + row.overdueAmount, 0),
  );
  const totalNotYetDue = round(
    ranked.reduce((sum, row) => sum + row.notYetDueAmount, 0),
  );

  return {
    currency: "NPR",
    asOf: new Date().toISOString().slice(0, 10),
    rankBy: "balance",
    basis:
      customerSource === "derived_mr_ledger"
        ? "Derived customer balances from open ledger remaining amounts; names from MR records. overdueAmount = open entries past due date."
        : "Customer master balance (matches ERP/Power BI outstanding report). overdueAmount = past due; notYetDueAmount = owed but payment deadline not reached.",
    totals: { totalOutstanding, totalOverdue, totalNotYetDue },
    customerCount: ranked.length,
    customers: ranked.slice(0, limit).map((row, index) => ({
      rank: index + 1,
      ...row,
      percentOfTotal:
        totalOutstanding > 0
          ? Math.round((row.balance / totalOutstanding) * 1000) / 10
          : 0,
    })),
    _syncedAt: customersPayload._syncedAt,
  };
}

/** Top customers with flexible period and ranking. */
export async function getTopCustomers(input?: {
  year?: number;
  month?: number;
  limit?: number;
  rankBy?: "invoice_sales" | "balance" | "overdue" | "lifetime_master";
}): Promise<unknown> {
  const limit = Math.min(input?.limit ?? 15, 50);
  const rankBy = input?.rankBy ?? "invoice_sales";

  const [ledgerPayload, customersPayload] = await Promise.all([
    loadLedger(),
    loadCustomers(),
  ]);
  if (ledgerPayload.error) return { error: ledgerPayload.error };
  if (customersPayload.error) return { error: customersPayload.error };

  const names = new Map<string, string>();
  for (const customer of customersPayload.value ?? []) {
    if (customer.number) names.set(customer.number, customer.displayName ?? "");
  }

  if (rankBy === "balance" || rankBy === "overdue" || rankBy === "lifetime_master") {
    const rows = (customersPayload.value ?? [])
      .map((customer) => {
        const balance = round(Number(customer.balance ?? 0));
        const overdueAmount = round(Number(customer.overdueAmount ?? 0));
        return {
          customerNo: customer.number,
          name: customer.displayName,
          balance,
          overdueAmount,
          notYetDueAmount: round(Math.max(0, balance - overdueAmount)),
          lifetimeSalesExcludingTax: round(
            Number(customer.totalSalesExcludingTax ?? 0),
          ),
        };
      })
      .sort((a, b) => {
        if (rankBy === "balance") return b.balance - a.balance;
        if (rankBy === "overdue") return b.overdueAmount - a.overdueAmount;
        return b.lifetimeSalesExcludingTax - a.lifetimeSalesExcludingTax;
      })
      .slice(0, limit);

    const withBalance = (customersPayload.value ?? []).filter(
      (c) => Number(c.balance ?? 0) > 0,
    );
    const totals =
      rankBy === "balance" || rankBy === "overdue"
        ? {
            totalOutstanding: round(
              withBalance.reduce((s, c) => s + Number(c.balance ?? 0), 0),
            ),
            totalOverdue: round(
              withBalance.reduce((s, c) => s + Number(c.overdueAmount ?? 0), 0),
            ),
            totalNotYetDue: round(
              withBalance.reduce(
                (s, c) =>
                  s +
                  Math.max(
                    0,
                    Number(c.balance ?? 0) - Number(c.overdueAmount ?? 0),
                  ),
                0,
              ),
            ),
          }
        : undefined;

    return {
      currency: "NPR",
      rankBy,
      basis:
        rankBy === "lifetime_master"
          ? "Customer master totalSalesExcludingTax (all-time BC field)."
          : rankBy === "balance"
            ? "Customer master balance (total outstanding). overdueAmount = past due; notYetDueAmount = still within payment terms."
            : "Customer master balance / overdueAmount as of last sync.",
      ...(totals ? { totals } : {}),
      customers: rows,
      _syncedAt: customersPayload._syncedAt,
    };
  }

  const byCustomer = aggregateLedgerByCustomer(
    ledgerPayload.value ?? [],
    names,
    (entry, date) => {
      if (entry.documentType !== "Invoice") return false;
      if (input?.year || input?.month) {
        return inAdPeriod(date, input.year, input.month);
      }
      return true;
    },
  );

  const ranked = [...byCustomer.values()]
    .map((row) => ({
      customerNo: row.customerNo,
      name: row.name,
      salesExcludingTax: round(row.sales),
      invoiceCount: row.invoices,
    }))
    .sort((a, b) => b.salesExcludingTax - a.salesExcludingTax)
    .slice(0, limit);

  return {
    currency: "NPR",
    rankBy: "invoice_sales",
    period: {
      year: input?.year ?? "all_synced_years",
      month: input?.month ?? null,
      monthName: input?.month ? monthName(input.month) : null,
    },
    basis: "Customer ledger invoice entries (salesLcy).",
    customers: ranked,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/** Top customers for one Nepali (BS) month within a fiscal year. */
export async function getTopCustomersByNepaliMonth(input?: {
  fiscalYearStart?: number;
  nepaliMonth?: string;
  limit?: number;
}): Promise<unknown> {
  const limit = Math.min(input?.limit ?? 15, 50);
  const monthIndex = parseNepaliMonth(input?.nepaliMonth);
  if (monthIndex === null) {
    return {
      error: `nepaliMonth required. Use one of: ${BS_MONTHS.join(", ")}.`,
    };
  }

  const ledgerPayload = await loadLedger();
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  const names = await buildCustomerNameMap();
  let startYear = input?.fiscalYearStart;
  if (!startYear) {
    let latest: Date | null = null;
    for (const entry of ledgerPayload.value ?? []) {
      const date = parseDate(entry.postingDate);
      if (date && (!latest || date > latest)) latest = date;
    }
    startYear =
      (latest ? getNepaliFiscalYear(latest)?.startYear : null) ??
      toBs(new Date())?.year ??
      new Date().getFullYear();
  }

  const byCustomer = new Map<string, CustomerAgg>();

  for (const entry of ledgerPayload.value ?? []) {
    if (entry.documentType !== "Invoice") continue;
    const date = parseDate(entry.postingDate);
    if (!date) continue;
    const fy = getNepaliFiscalYear(date);
    if (!fy || fy.startYear !== startYear) continue;
    const bs = toBs(date);
    if (!bs || bs.month !== monthIndex) continue;

    const customerNo = entryCustomerNo(entry);
    if (!customerNo) continue;
    const agg =
      byCustomer.get(customerNo) ??
      {
        customerNo,
        name: names.get(customerNo) ?? "",
        sales: 0,
        invoices: 0,
        payments: 0,
        creditMemos: 0,
      };
    agg.sales += Number(entry.salesLcy ?? 0);
    agg.invoices += 1;
    byCustomer.set(customerNo, agg);
  }

  const ranked = [...byCustomer.values()]
    .map((row) => ({
      customerNo: row.customerNo,
      name: row.name,
      salesExcludingTax: round(row.sales),
      invoiceCount: row.invoices,
    }))
    .sort((a, b) => b.salesExcludingTax - a.salesExcludingTax)
    .slice(0, limit);

  return {
    currency: "NPR",
    calendar: "Bikram Sambat",
    fiscalYear: fiscalYearLabel(startYear),
    nepaliMonth: BS_MONTHS[monthIndex],
    basis: "Customer ledger invoice entries (salesLcy).",
    customers: ranked,
    topCustomer: ranked[0] ?? null,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/** Sales totals and optional monthly breakdown for one customer. */
export async function getCustomerSales(input?: {
  customerNo?: string;
  query?: string;
  year?: number;
  month?: number;
}): Promise<unknown> {
  const resolved = await resolveCustomerNo(input);
  if ("error" in resolved) return resolved;

  const ledgerPayload = await loadLedger();
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  const entries = (ledgerPayload.value ?? []).filter(
    (entry) =>
      entryCustomerNo(entry) === resolved.customerNo &&
      entry.documentType === "Invoice",
  );

  let totalSales = 0;
  let invoiceCount = 0;
  const byMonth: Record<string, { sales: number; invoices: number }> = {};

  for (const entry of entries) {
    const date = parseDate(entry.postingDate);
    if (!date) continue;
    if (input?.year || input?.month) {
      if (!inAdPeriod(date, input.year, input.month)) continue;
    }

    const sales = Number(entry.salesLcy ?? 0);
    totalSales += sales;
    invoiceCount += 1;

    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
    byMonth[key] ??= { sales: 0, invoices: 0 };
    byMonth[key].sales += sales;
    byMonth[key].invoices += 1;
  }

  const monthly = Object.entries(byMonth)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => {
      const [year, month] = key.split("-");
      return {
        year: Number(year),
        month: Number(month),
        monthName: monthName(Number(month)),
        salesExcludingTax: round(value.sales),
        invoices: value.invoices,
      };
    });

  return {
    currency: "NPR",
    customerNo: resolved.customerNo,
    name: resolved.name,
    period: {
      year: input?.year ?? "all_synced_years",
      month: input?.month ?? null,
    },
    basis: "Customer ledger invoice entries (salesLcy).",
    totalSalesExcludingTax: round(totalSales),
    invoiceCount,
    byMonth: monthly,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/** Day-by-day invoice revenue for one AD month. */
export async function getDailyRevenue(input?: {
  year?: number;
  month?: number;
}): Promise<unknown> {
  const year = input?.year ?? new Date().getFullYear();
  const month = input?.month ?? new Date().getMonth() + 1;

  const ledgerPayload = await loadLedger();
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  const daysInMonth = new Date(year, month, 0).getDate();
  const days = Array.from({ length: daysInMonth }, (_, index) => ({
    day: index + 1,
    date: `${year}-${String(month).padStart(2, "0")}-${String(index + 1).padStart(2, "0")}`,
    sales: 0,
    invoices: 0,
  }));

  for (const entry of ledgerPayload.value ?? []) {
    if (entry.documentType !== "Invoice") continue;
    const date = parseDate(entry.postingDate);
    if (!date || !inAdPeriod(date, year, month)) continue;
    const slot = days[date.getDate() - 1];
    slot.sales += Number(entry.salesLcy ?? 0);
    slot.invoices += 1;
  }

  const cleaned = days.map((d) => ({
    ...d,
    salesExcludingTax: round(d.sales),
  }));
  const topDay = [...cleaned].sort(
    (a, b) => b.salesExcludingTax - a.salesExcludingTax,
  )[0];

  return {
    currency: "NPR",
    year,
    month,
    monthName: monthName(month),
    totalSales: round(cleaned.reduce((sum, d) => sum + d.salesExcludingTax, 0)),
    topDay,
    days: cleaned,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/** Compare invoice revenue between two AD months or two full years. */
export async function compareRevenuePeriods(input?: {
  year1: number;
  month1?: number;
  year2: number;
  month2?: number;
}): Promise<unknown> {
  if (!input?.year1 || !input?.year2) {
    return { error: "year1 and year2 are required." };
  }

  const ledgerPayload = await loadLedger();
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  function sumPeriod(year: number, month?: number): {
    sales: number;
    invoices: number;
  } {
    let sales = 0;
    let invoices = 0;
    for (const entry of ledgerPayload.value ?? []) {
      if (entry.documentType !== "Invoice") continue;
      const date = parseDate(entry.postingDate);
      if (!date || !inAdPeriod(date, year, month)) continue;
      sales += Number(entry.salesLcy ?? 0);
      invoices += 1;
    }
    return { sales: round(sales), invoices };
  }

  const period1 = sumPeriod(input.year1, input.month1);
  const period2 = sumPeriod(input.year2, input.month2);
  const change = round(period2.sales - period1.sales);
  const changePct =
    period1.sales === 0
      ? null
      : round(((period2.sales - period1.sales) / period1.sales) * 100);

  return {
    currency: "NPR",
    basis: "Customer ledger invoice entries (salesLcy).",
    period1: {
      year: input.year1,
      month: input.month1 ?? null,
      ...period1,
    },
    period2: {
      year: input.year2,
      month: input.month2 ?? null,
      ...period2,
    },
    change,
    changePercent: changePct,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/** Payments and credit memos aggregated by period and optionally one customer. */
export async function getPaymentsSummary(
  input?: {
    customerNo?: string;
    query?: string;
  } & DatePeriodInput,
): Promise<unknown> {
  let customerNo = input?.customerNo;
  let customerName: string | undefined;
  if (!customerNo && input?.query) {
    const resolved = await resolveCustomerNo({ query: input.query });
    if ("error" in resolved) return resolved;
    customerNo = resolved.customerNo;
    customerName = resolved.name;
  }

  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const ledgerPayload = await loadLedger();
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  let totalPayments = 0;
  let totalCreditMemos = 0;
  let paymentCount = 0;
  let creditMemoCount = 0;
  const byCustomer = new Map<
    string,
    { customerNo: string; payments: number; creditMemos: number }
  >();

  for (const entry of ledgerPayload.value ?? []) {
    if (!entry.postingDate || !period.matches(entry.postingDate)) continue;

    const entryCust = entryCustomerNo(entry);
    if (customerNo && entryCust !== customerNo) continue;

    const amount = Math.abs(Number(entry.amountLcy ?? entry.salesLcy ?? 0));
    const agg =
      byCustomer.get(entryCust) ??
      { customerNo: entryCust, payments: 0, creditMemos: 0 };

    if (entry.documentType === "Payment") {
      totalPayments += amount;
      paymentCount += 1;
      agg.payments += amount;
    } else if (entry.documentType === "Credit Memo") {
      totalCreditMemos += amount;
      creditMemoCount += 1;
      agg.creditMemos += amount;
    } else {
      continue;
    }

    byCustomer.set(entryCust, agg);
  }

  const names = await buildCustomerNameMap();
  const topPayers = [...byCustomer.values()]
    .map((row) => ({
      customerNo: row.customerNo,
      name: names.get(row.customerNo) ?? "",
      payments: round(row.payments),
      creditMemos: round(row.creditMemos),
    }))
    .sort((a, b) => b.payments - a.payments)
    .slice(0, 15);

  return {
    currency: "NPR",
    period: period.label,
    customerNo: customerNo ?? null,
    customerName: customerName ?? (customerNo ? names.get(customerNo) : null),
    totalPayments: round(totalPayments),
    totalCreditMemos: round(totalCreditMemos),
    paymentCount,
    creditMemoCount,
    topPayers,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/** Inventory totals, categories, and top items by stock value. */
export async function getInventorySummary(input?: {
  limit?: number;
}): Promise<unknown> {
  const limit = Math.min(input?.limit ?? 15, 50);
  const payload = await loadItems();
  if (payload.error) return { error: payload.error };

  const items = payload.value ?? [];
  let totalUnits = 0;
  let totalValueAtCost = 0;
  let totalValueAtPrice = 0;
  let blockedCount = 0;
  let zeroStockCount = 0;
  const byCategory = new Map<
    string,
    { category: string; items: number; inventory: number; valueAtCost: number }
  >();

  for (const item of items) {
    const inventory = Number(item.inventory ?? 0);
    const unitCost = Number(item.unitCost ?? 0);
    const unitPrice = Number(item.unitPrice ?? 0);
    const valueAtCost = inventory * unitCost;
    const category = item.itemCategory ?? "(none)";

    totalUnits += inventory;
    totalValueAtCost += valueAtCost;
    totalValueAtPrice += inventory * unitPrice;
    if (item.blocked) blockedCount += 1;
    if (inventory <= 0) zeroStockCount += 1;

    const agg =
      byCategory.get(category) ??
      { category, items: 0, inventory: 0, valueAtCost: 0 };
    agg.items += 1;
    agg.inventory += inventory;
    agg.valueAtCost += valueAtCost;
    byCategory.set(category, agg);
  }

  const topByValue = items
    .map((item) => ({
      itemNo: item.number,
      name: item.displayName,
      category: item.itemCategory,
      inventory: Number(item.inventory ?? 0),
      unitCost: Number(item.unitCost ?? 0),
      stockValueAtCost: round(
        Number(item.inventory ?? 0) * Number(item.unitCost ?? 0),
      ),
    }))
    .sort((a, b) => b.stockValueAtCost - a.stockValueAtCost)
    .slice(0, limit);

  return {
    currency: "NPR",
    itemCount: items.length,
    totalInventoryUnits: round(totalUnits),
    totalStockValueAtCost: round(totalValueAtCost),
    totalStockValueAtPrice: round(totalValueAtPrice),
    blockedItemCount: blockedCount,
    zeroStockItemCount: zeroStockCount,
    categories: [...byCategory.values()]
      .map((row) => ({
        ...row,
        inventory: round(row.inventory),
        valueAtCost: round(row.valueAtCost),
      }))
      .sort((a, b) => b.valueAtCost - a.valueAtCost),
    topItemsByStockValue: topByValue,
    note: "Stock value uses inventory × unitCost from item master.",
    _syncedAt: payload._syncedAt,
  };
}

/** Items at or below an inventory quantity threshold. */
export async function getLowStockItems(input?: {
  threshold?: number;
  limit?: number;
}): Promise<unknown> {
  const threshold = input?.threshold ?? 10;
  const limit = Math.min(input?.limit ?? 30, 100);
  const payload = await loadItems();
  if (payload.error) return { error: payload.error };

  const items = (payload.value ?? [])
    .filter((item) => !item.blocked)
    .map((item) => ({
      itemNo: item.number,
      name: item.displayName,
      category: item.itemCategory,
      inventory: Number(item.inventory ?? 0),
      unitCost: Number(item.unitCost ?? 0),
      unitPrice: Number(item.unitPrice ?? 0),
    }))
    .filter((item) => item.inventory <= threshold)
    .sort((a, b) => a.inventory - b.inventory)
    .slice(0, limit);

  return {
    threshold,
    matchCount: items.length,
    items,
    _syncedAt: payload._syncedAt,
  };
}

/** Product category sales from synced sales order lines. */
export async function getCategorySales(
  input?: DatePeriodInput,
): Promise<unknown> {
  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const [linesPayload, ordersPayload, itemsPayload] = await Promise.all([
    loadSalesOrderLines(),
    loadSalesOrders(),
    loadItems(),
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

  const byCategory = new Map<
    string,
    { category: string; sales: number; quantity: number; lineCount: number }
  >();
  let totalSales = 0;

  for (const line of linesPayload.value ?? []) {
    const qty = Number(line.quantityInvoiced ?? 0);
    if (qty <= 0) continue;
    const postingDate = orderDates.get(String(line.docNo ?? ""));
    if (!postingDate || !period.matches(postingDate)) continue;
    const itemNo = String(line.itemNo ?? "");
    const category = itemMeta.get(itemNo)?.itemCategory ?? "(unknown)";
    const sales = qty * Number(line.unitPrice ?? 0);
    totalSales += sales;
    const agg =
      byCategory.get(category) ??
      { category, sales: 0, quantity: 0, lineCount: 0 };
    agg.sales += sales;
    agg.quantity += qty;
    agg.lineCount += 1;
    byCategory.set(category, agg);
  }

  const categories = [...byCategory.values()]
    .map((row) => ({
      ...row,
      salesExcludingTax: round(row.sales),
      quantityInvoiced: round(row.quantity),
    }))
    .sort((a, b) => b.salesExcludingTax - a.salesExcludingTax);

  return {
    currency: "NPR",
    period: period.label,
    basis:
      "Sales order lines (quantityInvoiced × unitPrice). Partial history from ~Jul 2024.",
    totalSalesExcludingTax: round(totalSales),
    categories,
    _syncedAt: linesPayload._syncedAt,
  };
}

/** Sales orders summary — counts, status, top customers by order value. */
export async function getSalesOrdersSummary(
  input?: {
    customerNo?: string;
    query?: string;
    status?: string;
  } & DatePeriodInput,
): Promise<unknown> {
  let customerNo = input?.customerNo;
  if (!customerNo && input?.query) {
    const resolved = await resolveCustomerNo({ query: input.query });
    if ("error" in resolved) return resolved;
    customerNo = resolved.customerNo;
  }

  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const [ordersPayload, linesPayload, names] = await Promise.all([
    loadSalesOrders(),
    loadSalesOrderLines(),
    buildCustomerNameMap(),
  ]);
  if (ordersPayload.error) return { error: ordersPayload.error };

  const linesByOrder = new Map<string, number>();
  for (const line of linesPayload.value ?? []) {
    const docNo = String(line.docNo ?? "");
    if (!docNo) continue;
    const value =
      Number(line.quantityInvoiced ?? line.quantity ?? 0) *
      Number(line.unitPrice ?? 0);
    linesByOrder.set(docNo, (linesByOrder.get(docNo) ?? 0) + value);
  }

  const byStatus = new Map<string, number>();
  const byCustomer = new Map<
    string,
    { customerNo: string; name: string; orders: number; value: number }
  >();
  let matchedOrders = 0;
  let totalValue = 0;

  for (const order of ordersPayload.value ?? []) {
    if (!order.postingDate || !period.matches(order.postingDate)) continue;
    if (customerNo && order.customerNumber !== customerNo) continue;
    if (
      input?.status &&
      String(order.orderStatus ?? "").toLowerCase() !==
        input.status.toLowerCase()
    ) {
      continue;
    }

    matchedOrders += 1;
    const status = order.orderStatus ?? "(unknown)";
    byStatus.set(status, (byStatus.get(status) ?? 0) + 1);

    const orderValue = linesByOrder.get(String(order.number ?? "")) ?? 0;
    totalValue += orderValue;

    const cust = order.customerNumber ?? "";
    const agg =
      byCustomer.get(cust) ??
      { customerNo: cust, name: names.get(cust) ?? "", orders: 0, value: 0 };
    agg.orders += 1;
    agg.value += orderValue;
    byCustomer.set(cust, agg);
  }

  return {
    currency: "NPR",
    period: period.label,
    matchedOrders,
    totalOrderLineValue: round(totalValue),
    byStatus: Object.fromEntries(byStatus),
    topCustomersByOrderValue: [...byCustomer.values()]
      .map((row) => ({ ...row, value: round(row.value) }))
      .sort((a, b) => b.value - a.value)
      .slice(0, 15),
    note: "Order value from synced sales order lines; not the same as posted ledger invoices.",
    _syncedAt: ordersPayload._syncedAt,
  };
}

/** Search/list sales orders by customer, year, or status. */
export async function searchSalesOrders(
  input?: {
    query?: string;
    customerNo?: string;
    status?: string;
    limit?: number;
  } & DatePeriodInput,
): Promise<unknown> {
  const limit = Math.min(input?.limit ?? 20, 50);
  let customerNo = input?.customerNo;
  if (!customerNo && input?.query) {
    const resolved = await resolveCustomerNo({ query: input.query });
    if ("error" in resolved) return resolved;
    customerNo = resolved.customerNo;
  }

  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const [ordersPayload, names] = await Promise.all([
    loadSalesOrders(),
    buildCustomerNameMap(),
  ]);
  if (ordersPayload.error) return { error: ordersPayload.error };

  const matches = (ordersPayload.value ?? [])
    .filter((order) => {
      if (!order.postingDate || !period.matches(order.postingDate)) return false;
      if (customerNo && order.customerNumber !== customerNo) return false;
      if (
        input?.status &&
        String(order.orderStatus ?? "").toLowerCase() !==
          input.status.toLowerCase()
      ) {
        return false;
      }
      return true;
    })
    .slice(0, limit)
    .map((order) => ({
      orderNo: order.number,
      postingDate: order.postingDate,
      customerNo: order.customerNumber,
      customerName: names.get(order.customerNumber ?? "") ?? "",
      status: order.orderStatus,
      salesperson: order.salesperson,
      completelyInvoiced: order.completelyInvoicedOrder,
    }));

  return {
    matchCount: matches.length,
    period: period.label,
    orders: matches,
    _syncedAt: ordersPayload._syncedAt,
  };
}

/** Product sales for one customer from sales order lines. */
export async function getCustomerProductSales(
  input?: {
    customerNo?: string;
    query?: string;
    productQuery?: string;
    limit?: number;
  } & DatePeriodInput,
): Promise<unknown> {
  const limit = Math.min(input?.limit ?? 30, 100);
  const resolved = await resolveCustomerNo(input);
  if ("error" in resolved) return resolved;

  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const [ordersPayload, linesPayload, itemsPayload] = await Promise.all([
    loadSalesOrders(),
    loadSalesOrderLines(),
    loadItems(),
  ]);
  if (ordersPayload.error) return { error: ordersPayload.error };
  if (linesPayload.error) return { error: linesPayload.error };

  const customerOrders = new Map<string, string>();
  for (const order of ordersPayload.value ?? []) {
    if (order.customerNumber !== resolved.customerNo || !order.number) continue;
    if (!order.postingDate || !period.matches(order.postingDate)) continue;
    customerOrders.set(order.number, order.postingDate);
  }

  const productTerm = (input?.productQuery ?? "").trim().toLowerCase();
  const itemMeta = new Map<string, Item>();
  for (const item of itemsPayload.value ?? []) {
    if (item.number) itemMeta.set(item.number, item);
  }

  const byItem = new Map<
    string,
    {
      itemNo: string;
      name: string;
      sales: number;
      quantity: number;
      orderCount: number;
      orders: Set<string>;
    }
  >();
  let totalSales = 0;
  let totalQuantity = 0;
  let matchedLineCount = 0;

  for (const line of linesPayload.value ?? []) {
    const docNo = String(line.docNo ?? "");
    const postingDate = customerOrders.get(docNo);
    if (!postingDate) continue;

    const qty = Number(line.quantityInvoiced ?? 0);
    if (qty <= 0) continue;
    const itemNo = String(line.itemNo ?? "");
    const meta = itemMeta.get(itemNo);
    if (productTerm) {
      const haystack = [itemNo, meta?.displayName, meta?.itemCategory]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(productTerm)) continue;
    }

    const sales = qty * Number(line.unitPrice ?? 0);
    totalSales += sales;
    totalQuantity += qty;
    matchedLineCount += 1;

    const agg =
      byItem.get(itemNo) ??
      {
        itemNo,
        name: meta?.displayName ?? "",
        sales: 0,
        quantity: 0,
        orderCount: 0,
        orders: new Set<string>(),
      };
    if (!agg.orders.has(docNo)) {
      agg.orders.add(docNo);
      agg.orderCount = agg.orders.size;
    }
    agg.sales += sales;
    agg.quantity += qty;
    byItem.set(itemNo, agg);
  }

  const items = [...byItem.values()]
    .map((row) => ({
      itemNo: row.itemNo,
      name: row.name,
      salesExcludingTax: round(row.sales),
      quantityInvoiced: round(row.quantity),
      orderCount: row.orderCount,
    }))
    .sort((a, b) => b.salesExcludingTax - a.salesExcludingTax)
    .slice(0, limit);

  const orderList = [...customerOrders.entries()]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([orderNo, postingDate]) => ({ orderNo, postingDate }));

  if (items.length === 0 && customerOrders.size === 0) {
    return {
      currency: "NPR",
      customerNo: resolved.customerNo,
      name: resolved.name,
      period: period.label,
      productQuery: productTerm || null,
      message:
        "No invoiced sales order lines matched this customer and date filter.",
      ordersInPeriod: [],
      items: [],
      _syncedAt: linesPayload._syncedAt,
    };
  }

  return {
    currency: "NPR",
    customerNo: resolved.customerNo,
    name: resolved.name,
    period: period.label,
    productQuery: productTerm || null,
    basis:
      "Customer sales order lines in the filtered posting-date window (quantityInvoiced × unitPrice).",
    orderCount: customerOrders.size,
    ordersInPeriod: orderList.slice(0, 30),
    totalSalesExcludingTax: round(totalSales),
    totalQuantityInvoiced: round(totalQuantity),
    matchedLineCount,
    items,
    _syncedAt: linesPayload._syncedAt,
  };
}

/** Invoiced product sales grouped by salesperson code on sales orders. */
export async function getSalesBySalesperson(
  input?: { limit?: number } & DatePeriodInput,
): Promise<unknown> {
  const limit = Math.min(input?.limit ?? 20, 50);
  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const [ordersPayload, linesPayload, salespersonsPayload] = await Promise.all([
    loadSalesOrders(),
    loadSalesOrderLines(),
    getMirror("salespersons") as Promise<
      MirrorPayload<{ code?: string; name?: string }>
    >,
  ]);
  if (ordersPayload.error) return { error: ordersPayload.error };

  const spNames = new Map<string, string>();
  for (const sp of salespersonsPayload.value ?? []) {
    if (sp.code) spNames.set(sp.code, sp.name ?? sp.code);
  }

  const orderMeta = new Map<string, { postingDate?: string; salesperson?: string }>();
  for (const order of ordersPayload.value ?? []) {
    if (order.number) {
      orderMeta.set(order.number, {
        postingDate: order.postingDate,
        salesperson: order.salesperson,
      });
    }
  }

  const bySp = new Map<
    string,
    { code: string; name: string; sales: number; lineCount: number }
  >();
  let totalSales = 0;

  for (const line of linesPayload.value ?? []) {
    const qty = Number(line.quantityInvoiced ?? 0);
    if (qty <= 0) continue;
    const meta = orderMeta.get(String(line.docNo ?? ""));
    if (!meta?.postingDate || !period.matches(meta.postingDate)) continue;
    const code = meta.salesperson ?? "(none)";
    const sales = qty * Number(line.unitPrice ?? 0);
    totalSales += sales;
    const agg =
      bySp.get(code) ??
      { code, name: spNames.get(code) ?? code, sales: 0, lineCount: 0 };
    agg.sales += sales;
    agg.lineCount += 1;
    bySp.set(code, agg);
  }

  return {
    currency: "NPR",
    period: period.label,
    basis: "Sales order lines grouped by order.salesperson.",
    totalSalesExcludingTax: round(totalSales),
    salespersons: [...bySp.values()]
      .map((row) => ({ ...row, salesExcludingTax: round(row.sales) }))
      .sort((a, b) => b.salesExcludingTax - a.salesExcludingTax)
      .slice(0, limit),
    _syncedAt: linesPayload._syncedAt,
  };
}

/** List accountability-center branches for the active company. */
export async function listBranches(): Promise<unknown> {
  const branches = listBranchDefinitions();
  const cached = await loadBranchSalesCache();

  if (cached) {
    const byCode = new Map(
      cached.allTime.branches.map((row) => [row.branchCode, row]),
    );
    return {
      note:
        "Branches map to BC accountability-center codes on invoice document numbers (e.g. B_SFP_... = code B).",
      branches: branches.map((branch) => ({
        code: branch.code,
        name: branch.name,
        aliases: branch.aliases,
        allTimeInvoiceSales: byCode.get(branch.code)?.salesExcludingTax ?? 0,
        allTimeInvoices: byCode.get(branch.code)?.invoices ?? 0,
      })),
      _syncedAt: cached._builtAt,
    };
  }

  const ledgerPayload = await loadLedger();
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  const totals = aggregateInvoiceSalesByBranch(ledgerPayload.value ?? []);

  return {
    note:
      "Branches map to BC accountability-center codes on invoice document numbers (e.g. B_SFP_... = code B). Names are configured in branches.ts.",
    branches: branches.map((branch) => ({
      code: branch.code,
      name: branch.name,
      aliases: branch.aliases,
      allTimeInvoiceSales: round(totals.get(branch.code)?.sales ?? 0),
      allTimeInvoices: totals.get(branch.code)?.invoices ?? 0,
    })),
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/** All branches ranked by posted invoice sales — use for "branch wise sales". */
export async function getBranchWiseSales(
  input?: DatePeriodInput,
): Promise<unknown> {
  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const cached = !hasCustomPeriod(input) ? await loadBranchSalesCache() : null;
  if (cached && period.label === "all synced dates") {
    const currentFyStart = getCurrentFiscalYearStart();
    const fyLabel = currentFyStart ? fiscalYearLabel(currentFyStart) : null;
    return {
      currency: "NPR",
      period: period.label,
      basis:
        "Posted customer-ledger invoices (salesLcy). Branch = document prefix before underscore.",
      totalSalesExcludingTax: cached.allTime.totalSales,
      branchCount: cached.allTime.branches.length,
      branches: cached.allTime.branches,
      currentNepaliFiscalYear: fyLabel
        ? {
            label: fyLabel,
            ...cached.byNepaliFiscalYear[fyLabel],
          }
        : null,
      _syncedAt: cached._builtAt,
    };
  }

  const ledgerPayload = await loadLedger();
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  const totals = aggregateInvoiceSalesByBranch(
    ledgerPayload.value ?? [],
    period.matches,
  );

  const rows = [...totals.entries()]
    .map(([code, agg]) => ({
      branchCode: code,
      branchName: branchNameForCode(code),
      salesExcludingTax: round(agg.sales),
      invoices: agg.invoices,
    }))
    .sort((a, b) => b.salesExcludingTax - a.salesExcludingTax);

  const totalSales = round(rows.reduce((sum, row) => sum + row.salesExcludingTax, 0));

  const currentFyStart = getCurrentFiscalYearStart();
  let currentFiscalYear: {
    label: string;
    branches: typeof rows;
    totalSales: number;
  } | null = null;

  if (currentFyStart && !hasCustomPeriod(input)) {
    const fyTotals = aggregateInvoiceSalesByBranch(
      ledgerPayload.value ?? [],
      (postingDate) => {
        const date = parseDate(postingDate);
        if (!date) return false;
        const fy = getNepaliFiscalYear(date);
        return fy?.startYear === currentFyStart;
      },
    );
    const fyRows = [...fyTotals.entries()]
      .map(([code, agg]) => ({
        branchCode: code,
        branchName: branchNameForCode(code),
        salesExcludingTax: round(agg.sales),
        invoices: agg.invoices,
      }))
      .sort((a, b) => b.salesExcludingTax - a.salesExcludingTax);
    currentFiscalYear = {
      label: fiscalYearLabel(currentFyStart),
      branches: fyRows,
      totalSales: round(fyRows.reduce((sum, row) => sum + row.salesExcludingTax, 0)),
    };
  }

  return {
    currency: "NPR",
    period: period.label,
    calendar: input?.year || input?.month ? "AD" : "all_synced_periods",
    basis:
      "Posted customer-ledger invoices (salesLcy). Branch = first letter of documentNo before underscore (e.g. B_SFP_...).",
    totalSalesExcludingTax: totalSales,
    branchCount: rows.length,
    branches: rows,
    currentNepaliFiscalYear: currentFiscalYear,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/** Posted invoice sales for one branch (by name, alias, or code). */
export async function getSalesByBranch(
  input?: { query?: string; branchCode?: string } & DatePeriodInput,
): Promise<unknown> {
  const resolved = resolveBranch({
    query: input?.query,
    branchCode: input?.branchCode,
  });
  if ("error" in resolved) return resolved;

  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const cached = !hasCustomPeriod(input) ? await loadBranchSalesCache() : null;
  if (cached && period.label === "all synced dates") {
    const row = cached.allTime.branches.find(
      (entry) => entry.branchCode === resolved.code,
    );
    const currentFyStart = getCurrentFiscalYearStart();
    const fyLabel = currentFyStart ? fiscalYearLabel(currentFyStart) : null;
    const fyRow = fyLabel
      ? cached.byNepaliFiscalYear[fyLabel]?.branches.find(
          (entry) => entry.branchCode === resolved.code,
        )
      : null;

    return {
      currency: "NPR",
      branchCode: resolved.code,
      branchName: resolved.name,
      period: period.label,
      basis:
        "Posted customer-ledger invoices (salesLcy) where document number starts with the branch code.",
      totalSalesExcludingTax: row?.salesExcludingTax ?? 0,
      invoiceCount: row?.invoices ?? 0,
      currentNepaliFiscalYear: fyLabel
        ? {
            label: fyLabel,
            salesExcludingTax: fyRow?.salesExcludingTax ?? 0,
            invoices: fyRow?.invoices ?? 0,
          }
        : null,
      _syncedAt: cached._builtAt,
    };
  }

  const ledgerPayload = await loadLedger();
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  let totalSales = 0;
  let invoiceCount = 0;
  const byBsMonth = new Map<
    string,
    { bsMonth: string; bsYear: number; sales: number; invoices: number }
  >();

  for (const entry of ledgerPayload.value ?? []) {
    if (entry.documentType !== "Invoice") continue;
    if (branchCodeFromDocument(entry.documentNo) !== resolved.code) continue;
    if (!period.matches(entry.postingDate)) continue;

    const sales = Number(entry.salesLcy ?? 0);
    totalSales += sales;
    invoiceCount += 1;

    const date = parseDate(entry.postingDate);
    const bs = date ? toBs(date) : null;
    if (bs) {
      const key = `${bs.year}-${bs.month}`;
      const agg =
        byBsMonth.get(key) ??
        {
          bsMonth: BS_MONTHS[bs.month] ?? String(bs.month + 1),
          bsYear: bs.year,
          sales: 0,
          invoices: 0,
        };
      agg.sales += sales;
      agg.invoices += 1;
      byBsMonth.set(key, agg);
    }
  }

  const monthly = [...byBsMonth.values()]
    .map((row) => ({
      ...row,
      salesExcludingTax: round(row.sales),
    }))
    .sort((a, b) =>
      a.bsYear === b.bsYear ? a.bsMonth.localeCompare(b.bsMonth) : a.bsYear - b.bsYear,
    );

  return {
    currency: "NPR",
    branchCode: resolved.code,
    branchName: resolved.name,
    period: period.label,
    basis:
      "Posted customer-ledger invoices (salesLcy) where document number starts with the branch code, e.g. B_SFP_...",
    totalSalesExcludingTax: round(totalSales),
    invoiceCount,
    byNepaliMonth: monthly,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/** MR (money receipt) records — search or period summary. */
export async function getMrRecords(input?: {
  query?: string;
  customerNo?: string;
  year?: number;
  status?: string;
  limit?: number;
}): Promise<unknown> {
  const limit = Math.min(input?.limit ?? 20, 50);
  let customerNo = input?.customerNo;
  if (!customerNo && input?.query) {
    const resolved = await resolveCustomerNo({ query: input.query });
    if ("error" in resolved) return resolved;
    customerNo = resolved.customerNo;
  }

  const payload = await loadMr();
  if (payload.error) return { error: payload.error };

  const records = (payload.value ?? [])
    .filter((row) => {
      if (customerNo && row.customerNo !== customerNo) return false;
      if (input?.status && row.status !== input.status) return false;
      const date = parseDate(row.receivedEnglishiDate ?? row.clearedEnglishiDate);
      if (input?.year && date && date.getFullYear() !== input.year) return false;
      if (input?.query && !customerNo) {
        const term = input.query.toLowerCase();
        const haystack = [row.customerNo, row.customerName, String(row.mRNo)]
          .filter(Boolean)
          .join(" ")
          .toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    })
    .slice(0, limit)
    .map((row) => ({
      mrNo: row.mRNo,
      customerNo: row.customerNo,
      customerName: row.customerName,
      amount: round(Number(row.amount ?? 0)),
      status: row.status,
      paymentMode: row.paymentMode,
      receivedDate: row.receivedEnglishiDate,
      clearedDate: row.clearedEnglishiDate,
    }));

  const totalAmount = round(
    records.reduce((sum, row) => sum + row.amount, 0),
  );

  return {
    currency: "NPR",
    matchCount: records.length,
    totalAmount,
    records,
    _syncedAt: payload._syncedAt,
  };
}

/** Lookup one item by number or name fragment. */
export async function getItemDetail(input?: {
  query: string;
}): Promise<unknown> {
  const term = (input?.query ?? "").trim().toLowerCase();
  if (!term) return { error: "query required (item number or name)." };

  const payload = await loadItems();
  if (payload.error) return { error: payload.error };

  const matches = (payload.value ?? [])
    .filter((item) =>
      [item.number, item.displayName, item.itemCategory].some((field) =>
        String(field ?? "").toLowerCase().includes(term),
      ),
    )
    .slice(0, 10)
    .map((item) => ({
      itemNo: item.number,
      name: item.displayName,
      category: item.itemCategory,
      type: item.itemType,
      inventory: Number(item.inventory ?? 0),
      unitCost: Number(item.unitCost ?? 0),
      unitPrice: Number(item.unitPrice ?? 0),
      stockValueAtCost: round(
        Number(item.inventory ?? 0) * Number(item.unitCost ?? 0),
      ),
      blocked: item.blocked,
    }));

  return {
    query: input?.query ?? term,
    matchCount: matches.length,
    items: matches,
    _syncedAt: payload._syncedAt,
  };
}

/** Customers with blocked flag or high overdue balance. */
export async function getCustomerAlerts(input?: {
  type?: "blocked" | "overdue" | "both";
  minOverdue?: number;
  limit?: number;
}): Promise<unknown> {
  const type = input?.type ?? "both";
  const minOverdue = input?.minOverdue ?? 1;
  const limit = Math.min(input?.limit ?? 30, 100);
  const payload = await loadCustomers();
  if (payload.error) return { error: payload.error };

  const rows = (payload.value ?? [])
    .filter((customer) => {
      const blocked = !!customer.blocked;
      const overdue = Number(customer.overdueAmount ?? 0) >= minOverdue;
      if (type === "blocked") return blocked;
      if (type === "overdue") return overdue;
      return blocked || overdue;
    })
    .map((customer) => ({
      customerNo: customer.number,
      name: customer.displayName,
      blocked: !!customer.blocked,
      balance: round(Number(customer.balance ?? 0)),
      overdueAmount: round(Number(customer.overdueAmount ?? 0)),
    }))
    .sort((a, b) => b.overdueAmount - a.overdueAmount)
    .slice(0, limit);

  return {
    type,
    matchCount: rows.length,
    customers: rows,
    _syncedAt: payload._syncedAt,
  };
}

/** Search ledger entries by document number, customer, or date range. */
export async function searchLedgerEntries(input?: {
  documentNo?: string;
  customerNo?: string;
  query?: string;
  year?: number;
  month?: number;
  documentType?: string;
  limit?: number;
}): Promise<unknown> {
  const limit = Math.min(input?.limit ?? 25, 50);
  let customerNo = input?.customerNo;
  if (!customerNo && input?.query) {
    const resolved = await resolveCustomerNo({ query: input.query });
    if ("error" in resolved) return resolved;
    customerNo = resolved.customerNo;
  }

  const [ledgerPayload, names] = await Promise.all([
    loadLedger(),
    buildCustomerNameMap(),
  ]);
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  const docFilter = input?.documentNo?.trim();
  const typeFilter = input?.documentType?.trim();

  const matches = (ledgerPayload.value ?? [])
    .filter((entry) => {
      if (docFilter && entry.documentNo !== docFilter) return false;
      if (customerNo && entryCustomerNo(entry) !== customerNo) return false;
      if (typeFilter && entry.documentType !== typeFilter) return false;
      const date = parseDate(entry.postingDate);
      if (input?.year || input?.month) {
        if (!date || !inAdPeriod(date, input.year, input.month)) return false;
      }
      return true;
    })
    .sort((a, b) =>
      String(b.postingDate ?? "").localeCompare(String(a.postingDate ?? "")),
    )
    .slice(0, limit)
    .map((entry) => ({
      customerNo: entryCustomerNo(entry),
      customerName: names.get(entryCustomerNo(entry)) ?? "",
      documentNo: entry.documentNo,
      documentType: entry.documentType,
      postingDate: entry.postingDate,
      dueDate: entry.dueDate,
      salesLcy: round(Number(entry.salesLcy ?? 0)),
      amountLcy: round(Number(entry.amountLcy ?? 0)),
      remainingAmount: round(Number(entry.remainingAmount ?? 0)),
      open: !!entry.open,
      description: entry.description ?? "",
    }));

  return {
    matchCount: matches.length,
    entries: matches,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/** Year-over-year invoice sales for one customer (ledger). */
export async function compareCustomerYearlySales(input?: {
  customerNo?: string;
  query?: string;
  years?: number[];
}): Promise<unknown> {
  const resolved = await resolveCustomerNo(input);
  if ("error" in resolved) return resolved;

  const ledgerPayload = await loadLedger();
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  const currentYear = new Date().getFullYear();
  const years =
    input?.years && input.years.length > 0
      ? [...input.years].sort((a, b) => a - b)
      : [currentYear - 2, currentYear - 1, currentYear];

  const byYear = years.map((year) => ({
    year,
    salesExcludingTax: 0,
    invoiceCount: 0,
  }));

  for (const entry of ledgerPayload.value ?? []) {
    if (entry.documentType !== "Invoice") continue;
    if (entryCustomerNo(entry) !== resolved.customerNo) continue;
    const date = parseDate(entry.postingDate);
    if (!date) continue;
    const slot = byYear.find((row) => row.year === date.getFullYear());
    if (!slot) continue;
    slot.salesExcludingTax += Number(entry.salesLcy ?? 0);
    slot.invoiceCount += 1;
  }

  const cleaned = byYear.map((row) => ({
    ...row,
    salesExcludingTax: round(row.salesExcludingTax),
  }));

  const first = cleaned[0]?.salesExcludingTax ?? 0;
  const last = cleaned[cleaned.length - 1]?.salesExcludingTax ?? 0;

  return {
    currency: "NPR",
    customerNo: resolved.customerNo,
    name: resolved.name,
    basis: "Customer ledger invoice entries (salesLcy) by AD year.",
    years: cleaned,
    changeFirstToLast: round(last - first),
    changePercentFirstToLast:
      first > 0 ? round(((last - first) / first) * 100) : null,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/** Top customers by invoice sales for each of several AD years (side-by-side). */
export async function compareTopCustomersYearly(input?: {
  years?: number[];
  limit?: number;
}): Promise<unknown> {
  const limit = Math.min(input?.limit ?? 10, 25);
  const currentYear = new Date().getFullYear();
  const years =
    input?.years && input.years.length > 0
      ? [...input.years].sort((a, b) => a - b)
      : [currentYear - 2, currentYear - 1, currentYear];

  const ledgerPayload = await loadLedger();
  if (ledgerPayload.error) return { error: ledgerPayload.error };
  const names = await buildCustomerNameMap();

  const byYear = new Map<
    number,
    Map<string, { customerNo: string; name: string; sales: number; invoices: number }>
  >();

  for (const year of years) {
    byYear.set(year, new Map());
  }

  for (const entry of ledgerPayload.value ?? []) {
    if (entry.documentType !== "Invoice") continue;
    const date = parseDate(entry.postingDate);
    if (!date) continue;
    const year = date.getFullYear();
    const yearMap = byYear.get(year);
    if (!yearMap) continue;

    const customerNo = entryCustomerNo(entry);
    if (!customerNo) continue;
    const agg =
      yearMap.get(customerNo) ??
      { customerNo, name: names.get(customerNo) ?? "", sales: 0, invoices: 0 };
    agg.sales += Number(entry.salesLcy ?? 0);
    agg.invoices += 1;
    yearMap.set(customerNo, agg);
  }

  const result = years.map((year) => {
    const ranked = [...(byYear.get(year)?.values() ?? [])]
      .map((row) => ({
        customerNo: row.customerNo,
        name: row.name,
        salesExcludingTax: round(row.sales),
        invoiceCount: row.invoices,
      }))
      .sort((a, b) => b.salesExcludingTax - a.salesExcludingTax)
      .slice(0, limit);

    return { year, topCustomers: ranked, topCustomer: ranked[0] ?? null };
  });

  return {
    currency: "NPR",
    basis: "Customer ledger invoice sales (salesLcy) ranked per AD year.",
    years: result,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/** Collection / DSO-style metrics from open invoices and recent sales. */
export async function getCollectionMetrics(input?: {
  customerNo?: string;
  query?: string;
  lookbackDays?: number;
}): Promise<unknown> {
  const lookbackDays = input?.lookbackDays ?? 90;
  let customerNo = input?.customerNo;
  let customerName: string | undefined;

  if (!customerNo && input?.query) {
    const resolved = await resolveCustomerNo({ query: input.query });
    if ("error" in resolved) return resolved;
    customerNo = resolved.customerNo;
    customerName = resolved.name;
  }

  const ledgerPayload = await loadLedger();
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  const now = new Date();
  const lookbackStart = new Date(now);
  lookbackStart.setDate(lookbackStart.getDate() - lookbackDays);
  const lookbackKey = lookbackStart.toISOString().slice(0, 10);

  let totalOutstanding = 0;
  let weightedDaysPastDue = 0;
  let weightedInvoiceAge = 0;
  let openInvoiceCount = 0;
  let salesInLookback = 0;
  let invoiceCountInLookback = 0;

  for (const entry of ledgerPayload.value ?? []) {
    const entryCust = entryCustomerNo(entry);
    if (customerNo && entryCust !== customerNo) continue;

    const postingDate = parseDate(entry.postingDate);
    if (!postingDate) continue;

    if (entry.documentType === "Invoice") {
      const sales = Number(entry.salesLcy ?? 0);
      if (entry.postingDate && entry.postingDate.slice(0, 10) >= lookbackKey) {
        salesInLookback += sales;
        invoiceCountInLookback += 1;
      }

      const remaining = Number(entry.remainingAmount ?? 0);
      if (entry.open && remaining > 0) {
        openInvoiceCount += 1;
        totalOutstanding += remaining;

        const due = parseDate(entry.dueDate) ?? postingDate;
        const daysPastDue = Math.max(
          0,
          Math.floor((now.getTime() - due.getTime()) / 86400000),
        );
        const invoiceAge = Math.max(
          0,
          Math.floor((now.getTime() - postingDate.getTime()) / 86400000),
        );
        weightedDaysPastDue += remaining * daysPastDue;
        weightedInvoiceAge += remaining * invoiceAge;
      }
    }
  }

  const avgDaysPastDue =
    totalOutstanding > 0 ? round(weightedDaysPastDue / totalOutstanding) : 0;
  const avgOpenInvoiceAgeDays =
    totalOutstanding > 0 ? round(weightedInvoiceAge / totalOutstanding) : 0;
  const estimatedDsoDays =
    salesInLookback > 0
      ? round((totalOutstanding / salesInLookback) * lookbackDays)
      : null;

  if (customerNo && !customerName) {
    const names = await buildCustomerNameMap();
    customerName = names.get(customerNo);
  }

  return {
    currency: "NPR",
    asOf: now.toISOString().slice(0, 10),
    customerNo: customerNo ?? null,
    customerName: customerName ?? null,
    scope: customerNo ? "single_customer" : "company_wide",
    lookbackDays,
    basis:
      "Open invoice remaining amounts aged by due date; DSO estimate = (outstanding / invoice sales in lookback window) × lookback days.",
    totalOutstanding: round(totalOutstanding),
    openInvoiceCount,
    averageDaysPastDueOnOpenInvoices: avgDaysPastDue,
    averageOpenInvoiceAgeDays: avgOpenInvoiceAgeDays,
    salesInLookbackPeriod: round(salesInLookback),
    invoicesInLookbackPeriod: invoiceCountInLookback,
    estimatedCollectionDaysDso: estimatedDsoDays,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/** Top customers ranked by payments received (ledger Payment entries). */
export async function getTopPayingCustomers(
  input?: { limit?: number } & DatePeriodInput,
): Promise<unknown> {
  const limit = Math.min(input?.limit ?? 10, 50);
  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const summary = (await getPaymentsSummary({
    ...input,
  })) as {
    error?: string;
    totalPayments?: number;
    paymentCount?: number;
    topPayers?: Array<{
      customerNo: string;
      name: string;
      payments: number;
      creditMemos: number;
    }>;
    period?: unknown;
    _syncedAt?: string;
  };

  if (summary.error) return summary;

  const customers = (summary.topPayers ?? [])
    .sort((a, b) => b.payments - a.payments)
    .slice(0, limit);

  return {
    currency: "NPR",
    period: period.label,
    basis: "Customer ledger Payment entries (absolute amountLcy).",
    totalPayments: summary.totalPayments,
    paymentCount: summary.paymentCount,
    customers,
    _syncedAt: summary._syncedAt,
  };
}

/** Inventory list filtered by item type (Raw Materials, Finished Goods, etc.). */
export async function getInventoryByItemType(input?: {
  itemType?: string;
  limit?: number;
}): Promise<unknown> {
  const limit = Math.min(input?.limit ?? 50, 200);
  const payload = await loadItems();
  if (payload.error) return { error: payload.error };

  const typeFilter = (input?.itemType ?? "").trim().toLowerCase();
  const availableTypes = [
    ...new Set(
      (payload.value ?? [])
        .map((item) => item.itemType)
        .filter(Boolean) as string[],
    ),
  ].sort();

  let items = payload.value ?? [];
  if (typeFilter) {
    items = items.filter((item) =>
      String(item.itemType ?? "")
        .toLowerCase()
        .includes(typeFilter),
    );
  }

  const mapped = items
    .map((item) => ({
      itemNo: item.number,
      name: item.displayName,
      itemType: item.itemType,
      category: item.itemCategory,
      inventory: Number(item.inventory ?? 0),
      unitCost: Number(item.unitCost ?? 0),
      unitPrice: Number(item.unitPrice ?? 0),
      stockValueAtCost: round(
        Number(item.inventory ?? 0) * Number(item.unitCost ?? 0),
      ),
      blocked: !!item.blocked,
    }))
    .sort((a, b) => b.stockValueAtCost - a.stockValueAtCost)
    .slice(0, limit);

  const totals = mapped.reduce(
    (acc, item) => {
      acc.units += item.inventory;
      acc.valueAtCost += item.stockValueAtCost;
      return acc;
    },
    { units: 0, valueAtCost: 0 },
  );

  return {
    currency: "NPR",
    itemTypeFilter: input?.itemType ?? null,
    availableItemTypes: availableTypes,
    matchCount: items.length,
    listedCount: mapped.length,
    totalInventoryUnits: round(totals.units),
    totalStockValueAtCost: round(totals.valueAtCost),
    items: mapped,
    note: "Current inventory snapshot from item master — not movement since X days.",
    _syncedAt: payload._syncedAt,
  };
}

export { getSyncStatus };
