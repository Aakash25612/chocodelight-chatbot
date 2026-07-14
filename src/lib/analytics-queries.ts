import { getMirror, getSyncStatus } from "./bc-mirror";
import {
  searchCustomers,
  loadPostedInvoiceLinePayloads,
  postedLineSalesExcl,
  postedLineSalesIncl,
  postedLineVat,
  buildNepaliFiscalMonthSlots,
  applyPostedLineToNepaliMonth,
  serializeNepaliMonthSlots,
} from "./analytics";
import { loadCustomersPayload } from "./derived-customers";
import {
  branchCodeFromDocument,
  listBranchDefinitions,
  resolveBranch,
  branchNameForCode,
  normalizeBranchCode,
} from "./branches";
import {
  loadBranchSalesCache,
  branchMonthlyFromCache,
  FISCAL_MONTH_ORDER,
  type BranchMonthRow,
} from "./branch-sales-cache";
import { type DatePeriodInput, periodFromInput, withDefaultNepaliFiscalYear } from "./date-period";
import {
  loadUomIndex,
  quantityToMetricTons,
} from "./uom-convert";
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
  accountabilityCenter?: string;
  locationCode?: string;
  pricesIncludeTax?: boolean;
};

type SalesOrderLine = {
  docNo?: string;
  itemNo?: string;
  lineNo?: number;
  quantity?: number;
  quantityShipped?: number;
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

type PostedSalesDoc = {
  documentNo?: string;
  postingDate?: string;
  branchCode?: string;
  salesAmount?: number;
  salesAmountIncludingTax?: number;
  documentKind?: "invoice" | "credit_memo";
};

async function loadPostedSalesDocuments(): Promise<
  MirrorPayload<PostedSalesDoc>
> {
  return (await getMirror("postedSalesDocuments")) as MirrorPayload<PostedSalesDoc>;
}

function aggregatePostedDocsByBranch(
  docs: PostedSalesDoc[],
  matches: (postingDate: string) => boolean,
): Map<string, { salesIncl: number; salesExcl: number; invoices: number }> {
  const map = new Map<
    string,
    { salesIncl: number; salesExcl: number; invoices: number }
  >();

  for (const doc of docs) {
    const code = normalizeBranchCode(String(doc.branchCode ?? ""));
    if (!code) continue;
    if (!matches(String(doc.postingDate ?? ""))) continue;

    const incl = Number(doc.salesAmountIncludingTax ?? doc.salesAmount ?? 0);
    const excl = Number(doc.salesAmount ?? incl);
    const isInvoice = doc.documentKind !== "credit_memo";
    const sign = isInvoice ? 1 : -1;
    const agg = map.get(code) ?? { salesIncl: 0, salesExcl: 0, invoices: 0 };
    agg.salesIncl += sign * Math.abs(incl);
    agg.salesExcl += sign * Math.abs(excl);
    if (isInvoice) agg.invoices += 1;
    map.set(code, agg);
  }

  return map;
}

function branchFiscalMonthRowsFromPosted(
  docs: PostedSalesDoc[],
  branchCode: string,
  fyStartYear: number,
): BranchMonthRow[] {
  const monthMap = new Map<
    number,
    { salesIncl: number; salesExcl: number; invoices: number; bsYear: number }
  >();

  for (const doc of docs) {
    if (normalizeBranchCode(String(doc.branchCode ?? "")) !== branchCode) {
      continue;
    }
    const date = parseDate(doc.postingDate);
    if (!date) continue;
    const fy = getNepaliFiscalYear(date);
    if (!fy || fy.startYear !== fyStartYear) continue;
    const bs = toBs(date);
    if (!bs) continue;

    const incl = Number(doc.salesAmountIncludingTax ?? doc.salesAmount ?? 0);
    const excl = Number(doc.salesAmount ?? incl);
    const isInvoice = doc.documentKind !== "credit_memo";
    const sign = isInvoice ? 1 : -1;
    const agg = monthMap.get(bs.month) ?? {
      salesIncl: 0,
      salesExcl: 0,
      invoices: 0,
      bsYear: bs.year,
    };
    agg.salesIncl += sign * Math.abs(incl);
    agg.salesExcl += sign * Math.abs(excl);
    if (isInvoice) agg.invoices += 1;
    monthMap.set(bs.month, agg);
  }

  return FISCAL_MONTH_ORDER.map((monthIndex) => {
    const bsYear = monthIndex >= 3 ? fyStartYear : fyStartYear + 1;
    const agg = monthMap.get(monthIndex) ?? {
      salesIncl: 0,
      salesExcl: 0,
      invoices: 0,
      bsYear,
    };
    return {
      bsMonth: BS_MONTHS[monthIndex],
      monthIndex,
      bsYear,
      salesIncludingTax: round(agg.salesIncl),
      salesExcludingTax: round(agg.salesExcl),
      invoices: agg.invoices,
    };
  });
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

type CustomerInvoiceSalesAgg = {
  customerNo: string;
  name: string;
  salesIncl: number;
  salesExcl: number;
  invoiceDocs: Set<string>;
};

async function aggregateCustomersFromPostedInvoices(options: {
  names: Map<string, string>;
  matches?: (postingDate: string) => boolean;
}): Promise<Map<string, CustomerInvoiceSalesAgg> | null> {
  const posted = await loadPostedInvoiceLinePayloads();
  if (!posted.usePostedInvoices) return null;

  const map = new Map<string, CustomerInvoiceSalesAgg>();

  function upsert(customerNo: string): CustomerInvoiceSalesAgg {
    const existing = map.get(customerNo);
    if (existing) return existing;
    const agg: CustomerInvoiceSalesAgg = {
      customerNo,
      name: options.names.get(customerNo) ?? "",
      salesIncl: 0,
      salesExcl: 0,
      invoiceDocs: new Set<string>(),
    };
    map.set(customerNo, agg);
    return agg;
  }

  for (const line of posted.invoiceLines) {
    const postingDate = String(line.postingDate ?? "");
    if (options.matches && !options.matches(postingDate)) continue;
    const customerNo = String(line.sellToCustomerNo ?? "").trim();
    if (!customerNo) continue;
    const agg = upsert(customerNo);
    agg.salesIncl += postedLineSalesIncl(line);
    agg.salesExcl += postedLineSalesExcl(line);
    const doc = String(line.documentNo ?? "").trim();
    if (doc) agg.invoiceDocs.add(doc);
  }

  for (const line of posted.crMemoLines) {
    const postingDate = String(line.postingDate ?? "");
    if (options.matches && !options.matches(postingDate)) continue;
    const customerNo = String(line.sellToCustomerNo ?? "").trim();
    if (!customerNo) continue;
    const agg = upsert(customerNo);
    agg.salesIncl -= Math.abs(postedLineSalesIncl(line));
    agg.salesExcl -= Math.abs(postedLineSalesExcl(line));
  }

  return map;
}

function rankCustomerInvoiceSales(
  map: Map<string, CustomerInvoiceSalesAgg>,
  limit: number,
) {
  return [...map.values()]
    .map((row) => ({
      customerNo: row.customerNo,
      name: row.name,
      salesIncludingTax: round(row.salesIncl),
      salesExcludingTax: round(row.salesExcl),
      invoiceCount: row.invoiceDocs.size,
    }))
    .sort((a, b) => b.salesIncludingTax - a.salesIncludingTax)
    .slice(0, limit);
}

function postingDateInNepaliFy(postingDate: string, startYear: number): boolean {
  const date = parseDate(postingDate);
  if (!date) return false;
  const fy = getNepaliFiscalYear(date);
  return fy?.startYear === startYear;
}

const CUSTOMER_SALES_DISPLAY_NOTE =
  'Show salesIncludingTax only (label "Incl. VAT"). Show salesExcludingTax only when user asks for excl VAT (BC line.amount net after discount).';

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

  const fromInvoices = await aggregateCustomersFromPostedInvoices({
    names,
    matches: (postingDate) => {
      const date = parseDate(postingDate);
      if (!date) return false;
      return inAdPeriod(date, year, month);
    },
  });

  if (fromInvoices) {
    const ranked = rankCustomerInvoiceSales(fromInvoices, limit);
    const totalMonthSalesIncludingTax = round(
      [...fromInvoices.values()].reduce((sum, row) => sum + row.salesIncl, 0),
    );
    return {
      currency: "NPR",
      period: { calendar: "Gregorian (AD)", year, month, monthName: monthName(month) },
      displayNote: CUSTOMER_SALES_DISPLAY_NOTE,
      basis:
        "Posted sales invoice lines (amountIncludingVAT) minus credit memos, grouped by customer.",
      totalMonthSalesIncludingTax,
      totalMonthSales: totalMonthSalesIncludingTax,
      invoiceCount: ranked.reduce((sum, row) => sum + row.invoiceCount, 0),
      topCustomer: ranked[0] ?? null,
      customers: ranked,
      _syncedAt: (await loadPostedInvoiceLinePayloads()).syncedAt,
    };
  }

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
      salesIncludingTax: round(row.sales),
      salesExcludingTax: round(row.sales),
      invoiceCount: row.invoices,
    }))
    .sort((a, b) => b.salesIncludingTax - a.salesIncludingTax)
    .slice(0, limit);

  return {
    currency: "NPR",
    period: { calendar: "Gregorian (AD)", year, month, monthName: monthName(month) },
    displayNote:
      "Ledger sync — incl and excl VAT are the same (salesLcy). Run sync for posted invoice lines.",
    basis:
      "Customer ledger invoice entries (salesLcy). Authoritative for customer ranking by month.",
    totalMonthSalesIncludingTax: totalMonthSales,
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
  fiscalYearStart?: number;
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

  const byCustomerFromInvoices = await aggregateCustomersFromPostedInvoices({
    names,
    matches: (postingDate) => {
      if (input?.fiscalYearStart) {
        return postingDateInNepaliFy(postingDate, input.fiscalYearStart);
      }
      if (input?.year || input?.month) {
        const date = parseDate(postingDate);
        if (!date) return false;
        return inAdPeriod(date, input.year, input.month);
      }
      return true;
    },
  });

  if (byCustomerFromInvoices) {
    const ranked = rankCustomerInvoiceSales(byCustomerFromInvoices, limit);
    return {
      currency: "NPR",
      rankBy: "invoice_sales",
      displayNote: CUSTOMER_SALES_DISPLAY_NOTE,
      period: {
        fiscalYearStart: input?.fiscalYearStart ?? null,
        fiscalYear: input?.fiscalYearStart
          ? fiscalYearLabel(input.fiscalYearStart)
          : null,
        year: input?.year ?? "all_synced_years",
        month: input?.month ?? null,
        monthName: input?.month ? monthName(input.month) : null,
      },
      basis:
        "Posted sales invoice lines (amountIncludingVAT) minus credit memos, grouped by customer.",
      customers: ranked,
      topCustomer: ranked[0] ?? null,
      _syncedAt: (await loadPostedInvoiceLinePayloads()).syncedAt,
    };
  }

  const byCustomer = aggregateLedgerByCustomer(
    ledgerPayload.value ?? [],
    names,
    (entry, date) => {
      if (entry.documentType !== "Invoice") return false;
      if (input?.fiscalYearStart) {
        const fy = getNepaliFiscalYear(date);
        if (!fy || fy.startYear !== input.fiscalYearStart) return false;
      }
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
      salesIncludingTax: round(row.sales),
      salesExcludingTax: round(row.sales),
      invoiceCount: row.invoices,
    }))
    .sort((a, b) => b.salesIncludingTax - a.salesIncludingTax)
    .slice(0, limit);

  return {
    currency: "NPR",
    rankBy: "invoice_sales",
    displayNote:
      "Ledger sync — incl and excl VAT are the same (salesLcy). Run sync for posted invoice lines.",
    period: {
      fiscalYearStart: input?.fiscalYearStart ?? null,
      year: input?.year ?? "all_synced_years",
      month: input?.month ?? null,
      monthName: input?.month ? monthName(input.month) : null,
    },
    basis: "Customer ledger invoice entries (salesLcy).",
    customers: ranked,
    topCustomer: ranked[0] ?? null,
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

  const names = await buildCustomerNameMap();

  let startYear = input?.fiscalYearStart;
  if (!startYear) {
    const ledgerPayload = await loadLedger();
    if (ledgerPayload.error) return { error: ledgerPayload.error };
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

  const fromInvoices = await aggregateCustomersFromPostedInvoices({
    names,
    matches: (postingDate) => {
      const date = parseDate(postingDate);
      if (!date) return false;
      const fy = getNepaliFiscalYear(date);
      if (!fy || fy.startYear !== startYear) return false;
      const bs = toBs(date);
      return Boolean(bs && bs.month === monthIndex);
    },
  });

  if (fromInvoices) {
    const ranked = rankCustomerInvoiceSales(fromInvoices, limit);
    return {
      currency: "NPR",
      calendar: "Bikram Sambat",
      fiscalYear: fiscalYearLabel(startYear),
      nepaliMonth: BS_MONTHS[monthIndex],
      displayNote: CUSTOMER_SALES_DISPLAY_NOTE,
      basis:
        "Posted sales invoice lines (amountIncludingVAT) minus credit memos, grouped by customer.",
      customers: ranked,
      topCustomer: ranked[0] ?? null,
      _syncedAt: (await loadPostedInvoiceLinePayloads()).syncedAt,
    };
  }

  const ledgerPayload = await loadLedger();
  if (ledgerPayload.error) return { error: ledgerPayload.error };

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
      salesIncludingTax: round(row.sales),
      salesExcludingTax: round(row.sales),
      invoiceCount: row.invoices,
    }))
    .sort((a, b) => b.salesIncludingTax - a.salesIncludingTax)
    .slice(0, limit);

  return {
    currency: "NPR",
    calendar: "Bikram Sambat",
    fiscalYear: fiscalYearLabel(startYear),
    nepaliMonth: BS_MONTHS[monthIndex],
    displayNote:
      "Ledger sync — incl and excl VAT are the same (salesLcy). Run sync for posted invoice lines.",
    basis: "Customer ledger invoice entries (salesLcy).",
    customers: ranked,
    topCustomer: ranked[0] ?? null,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

/** Sales totals and monthly breakdown for one customer (posted invoice lines when synced). */
export async function getCustomerSales(input?: {
  customerNo?: string;
  query?: string;
  year?: number;
  month?: number;
  fiscalYearStart?: number;
}): Promise<unknown> {
  const resolved = await resolveCustomerNo(input);
  if ("error" in resolved) return resolved;

  const posted = await loadPostedInvoiceLinePayloads();
  const customerNo = resolved.customerNo;
  const fiscalYearStart = input?.fiscalYearStart;

  function matchesFilter(postingDate: string): boolean {
    const date = parseDate(postingDate);
    if (!date) return false;
    if (fiscalYearStart) {
      const fy = getNepaliFiscalYear(date);
      return fy?.startYear === fiscalYearStart;
    }
    if (input?.year || input?.month) {
      return inAdPeriod(date, input.year, input.month);
    }
    return true;
  }

  if (posted.usePostedInvoices) {
    let totalIncl = 0;
    let totalExcl = 0;
    const invoiceDocs = new Set<string>();
    const byAdMonth = new Map<
      string,
      { salesIncl: number; invoices: Set<string> }
    >();
    const nepaliSlots = fiscalYearStart
      ? buildNepaliFiscalMonthSlots(fiscalYearStart)
      : null;

    for (const line of posted.invoiceLines) {
      if (String(line.sellToCustomerNo ?? "") !== customerNo) continue;
      const postingDate = String(line.postingDate ?? "");
      if (!matchesFilter(postingDate)) continue;

      const incl = postedLineSalesIncl(line);
      const excl = postedLineSalesExcl(line);
      totalIncl += incl;
      totalExcl += excl;
      const doc = String(line.documentNo ?? "");
      if (doc) invoiceDocs.add(doc);

      const date = parseDate(postingDate);
      if (date) {
        const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
        const agg =
          byAdMonth.get(key) ?? { salesIncl: 0, invoices: new Set<string>() };
        agg.salesIncl += incl;
        if (doc) agg.invoices.add(doc);
        byAdMonth.set(key, agg);
      }
      if (nepaliSlots && fiscalYearStart) {
        applyPostedLineToNepaliMonth(nepaliSlots, line, fiscalYearStart, 1);
      }
    }

    for (const line of posted.crMemoLines) {
      if (String(line.sellToCustomerNo ?? "") !== customerNo) continue;
      const postingDate = String(line.postingDate ?? "");
      if (!matchesFilter(postingDate)) continue;
      totalIncl -= Math.abs(postedLineSalesIncl(line));
      totalExcl -= Math.abs(postedLineSalesExcl(line));
      if (nepaliSlots && fiscalYearStart) {
        applyPostedLineToNepaliMonth(nepaliSlots, line, fiscalYearStart, -1);
      }
    }

    const byMonth = [...byAdMonth.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, value]) => {
        const [year, month] = key.split("-");
        return {
          year: Number(year),
          month: Number(month),
          monthName: monthName(Number(month)),
          salesIncludingTax: round(value.salesIncl),
          invoices: value.invoices.size,
        };
      });

    return {
      currency: "NPR",
      customerNo,
      name: resolved.name,
      period: {
        fiscalYearStart: input?.fiscalYearStart ?? null,
        fiscalYear: input?.fiscalYearStart
          ? fiscalYearLabel(input.fiscalYearStart)
          : null,
        year: input?.year ?? "all_synced_years",
        month: input?.month ?? null,
      },
      displayNote: CUSTOMER_SALES_DISPLAY_NOTE,
      basis:
        "Posted sales invoice lines (amountIncludingVAT) minus credit memos for this customer.",
      totalSalesIncludingTax: round(totalIncl),
      totalSalesExcludingTax: round(totalExcl),
      invoiceCount: invoiceDocs.size,
      byMonth,
      byNepaliMonth: nepaliSlots
        ? serializeNepaliMonthSlots(nepaliSlots)
        : undefined,
      _syncedAt: posted.syncedAt,
    };
  }

  const ledgerPayload = await loadLedger();
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  const entries = (ledgerPayload.value ?? []).filter(
    (entry) =>
      entryCustomerNo(entry) === customerNo &&
      entry.documentType === "Invoice",
  );

  let totalSales = 0;
  let invoiceCount = 0;
  const byMonth: Record<string, { sales: number; invoices: number }> = {};

  for (const entry of entries) {
    const date = parseDate(entry.postingDate);
    if (!date) continue;
    if (input?.fiscalYearStart) {
      const fy = getNepaliFiscalYear(date);
      if (!fy || fy.startYear !== input.fiscalYearStart) continue;
    }
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
        salesIncludingTax: round(value.sales),
        salesExcludingTax: round(value.sales),
        invoices: value.invoices,
      };
    });

  return {
    currency: "NPR",
    customerNo,
    name: resolved.name,
    period: {
      fiscalYearStart: input?.fiscalYearStart ?? null,
      year: input?.year ?? "all_synced_years",
      month: input?.month ?? null,
    },
    basis: "Customer ledger invoice entries (salesLcy). Run sync for Incl. VAT.",
    totalSalesIncludingTax: round(totalSales),
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

/** Product category sales from posted invoice lines or sales order lines. */
export async function getCategorySales(
  input?: DatePeriodInput,
): Promise<unknown> {
  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const posted = await loadPostedInvoiceLinePayloads();
  const itemsPayload = await loadItems();

  const itemMeta = new Map<string, Item>();
  for (const item of itemsPayload.value ?? []) {
    if (item.number) itemMeta.set(item.number, item);
  }

  const byCategory = new Map<
    string,
    {
      category: string;
      salesIncl: number;
      salesExcl: number;
      quantity: number;
      lineCount: number;
    }
  >();
  let totalIncl = 0;
  let totalExcl = 0;

  if (posted.usePostedInvoices) {
    for (const line of posted.invoiceLines) {
      const qty = Number(line.quantity ?? 0);
      const itemNo = String(line.itemNo ?? "");
      if (!itemNo || qty <= 0) continue;
      const postingDate = String(line.postingDate ?? "");
      if (!postingDate || !period.matches(postingDate)) continue;
      const category =
        String(line.itemCategoryCode ?? "") ||
        itemMeta.get(itemNo)?.itemCategory ||
        "(unknown)";
      const salesIncl = postedLineSalesIncl(line);
      const salesExcl = postedLineSalesExcl(line);
      totalIncl += salesIncl;
      totalExcl += salesExcl;
      const agg =
        byCategory.get(category) ??
        { category, salesIncl: 0, salesExcl: 0, quantity: 0, lineCount: 0 };
      agg.salesIncl += salesIncl;
      agg.salesExcl += salesExcl;
      agg.quantity += qty;
      agg.lineCount += 1;
      byCategory.set(category, agg);
    }

    for (const line of posted.crMemoLines) {
      const qty = Number(line.quantity ?? 0);
      const itemNo = String(line.itemNo ?? "");
      if (!itemNo || qty <= 0) continue;
      const postingDate = String(line.postingDate ?? "");
      if (!postingDate || !period.matches(postingDate)) continue;
      const category =
        String(line.itemCategoryCode ?? "") ||
        itemMeta.get(itemNo)?.itemCategory ||
        "(unknown)";
      const salesIncl = -Math.abs(postedLineSalesIncl(line));
      const salesExcl = -Math.abs(postedLineSalesExcl(line));
      totalIncl += salesIncl;
      totalExcl += salesExcl;
      const agg =
        byCategory.get(category) ??
        { category, salesIncl: 0, salesExcl: 0, quantity: 0, lineCount: 0 };
      agg.salesIncl += salesIncl;
      agg.salesExcl += salesExcl;
      agg.quantity -= qty;
      agg.lineCount += 1;
      byCategory.set(category, agg);
    }
  } else {
    const [linesPayload, ordersPayload] = await Promise.all([
      loadSalesOrderLines(),
      loadSalesOrders(),
    ]);
    if (linesPayload.error) return { error: linesPayload.error };
    if (ordersPayload.error) return { error: ordersPayload.error };

    const orderDates = new Map<string, string>();
    for (const order of ordersPayload.value ?? []) {
      if (order.number && order.postingDate) {
        orderDates.set(order.number, order.postingDate);
      }
    }

    for (const line of linesPayload.value ?? []) {
      const qty = Number(line.quantityInvoiced ?? 0);
      if (qty <= 0) continue;
      const postingDate = orderDates.get(String(line.docNo ?? ""));
      if (!postingDate || !period.matches(postingDate)) continue;
      const itemNo = String(line.itemNo ?? "");
      const category = itemMeta.get(itemNo)?.itemCategory ?? "(unknown)";
      const sales = qty * Number(line.unitPrice ?? 0);
      totalIncl += sales;
      totalExcl += sales;
      const agg =
        byCategory.get(category) ??
        { category, salesIncl: 0, salesExcl: 0, quantity: 0, lineCount: 0 };
      agg.salesIncl += sales;
      agg.salesExcl += sales;
      agg.quantity += qty;
      agg.lineCount += 1;
      byCategory.set(category, agg);
    }
  }

  const categories = [...byCategory.values()]
    .map((row) => ({
      category: row.category,
      salesIncludingTax: round(row.salesIncl),
      salesExcludingTax: round(row.salesExcl),
      quantityInvoiced: round(row.quantity),
      lineCount: row.lineCount,
    }))
    .sort((a, b) => b.salesIncludingTax - a.salesIncludingTax);

  return {
    currency: "NPR",
    period: period.label,
    displayNote:
      'Show totalSalesIncludingTax and salesIncludingTax only (Incl. VAT). Show salesExcludingTax only when user asks for excl VAT (BC line.amount net after discount).',
    basis: posted.usePostedInvoices
      ? "Posted sales invoice lines: Incl. VAT = amountIncludingVAT; net excl. VAT (on request) = line.amount."
      : "Sales order lines (quantityInvoiced × unitPrice). Partial history from ~Jul 2024.",
    totalSalesIncludingTax: round(totalIncl),
    totalSalesExcludingTax: round(totalExcl),
    categories,
    _syncedAt: posted.syncedAt ?? itemsPayload._syncedAt,
  };
}

/**
 * Pending Sauda: Locked sales orders with unshipped quantity.
 * Rule: orderStatus = Locked AND (quantity - quantityShipped) > 0.
 */
export async function getPendingSauda(input?: {
  query?: string;
  customerNo?: string;
  branchCode?: string;
  productQuery?: string;
  limit?: number;
}): Promise<unknown> {
  const lineLimit = Math.min(input?.limit ?? 40, 100);
  const productTerm = (input?.productQuery ?? "").trim().toLowerCase();

  let customerNo = input?.customerNo?.trim() || undefined;
  let customerName = "";
  let branchCode: string | null = input?.branchCode?.trim()
    ? normalizeBranchCode(input.branchCode)
    : null;

  if (input?.branchCode?.trim()) {
    const branch = resolveBranch({ branchCode: input.branchCode });
    if ("error" in branch) return branch;
    branchCode = branch.code;
  } else if (input?.query?.trim() && !customerNo) {
    const q = input.query.trim();
    const looksLikeBranchCode = /^[A-Za-z]{1,3}$/.test(q) || /^(?:code|branch)\s+/i.test(q);
    if (looksLikeBranchCode) {
      const branch = resolveBranch({ query: q });
      if (!("error" in branch)) {
        branchCode = branch.code;
      }
    }
    if (!branchCode) {
      const resolved = await resolveCustomerNo({ query: q });
      if ("error" in resolved) {
        // Fallback: allow full branch names like "Bhairahawa Sales Depot"
        const branch = resolveBranch({ query: q });
        if (!("error" in branch)) {
          branchCode = branch.code;
        } else {
          return resolved;
        }
      } else {
        customerNo = resolved.customerNo;
        customerName = resolved.name;
      }
    }
  } else if (customerNo) {
    const resolved = await resolveCustomerNo({ customerNo });
    if ("error" in resolved) return resolved;
    customerName = resolved.name;
  }

  const [ordersPayload, linesPayload, itemsPayload, names, uomIndex] =
    await Promise.all([
      loadSalesOrders(),
      loadSalesOrderLines(),
      loadItems(),
      buildCustomerNameMap(),
      loadUomIndex(),
    ]);
  if (ordersPayload.error) return { error: ordersPayload.error };
  if (linesPayload.error) return { error: linesPayload.error };

  const itemMeta = new Map<string, Item>();
  for (const item of itemsPayload.value ?? []) {
    if (item.number) itemMeta.set(item.number, item);
  }

  const lockedOrders = new Map<string, SalesOrder>();
  for (const order of ordersPayload.value ?? []) {
    if (String(order.orderStatus ?? "").toLowerCase() !== "locked") continue;
    const no = String(order.number ?? "").trim();
    if (!no) continue;
    if (customerNo && order.customerNumber !== customerNo) continue;

    const orderBranch =
      normalizeBranchCode(String(order.accountabilityCenter ?? "")) ||
      normalizeBranchCode(String(order.locationCode ?? "")) ||
      branchCodeFromDocument(order.number) ||
      "";
    if (branchCode && orderBranch !== branchCode) continue;

    lockedOrders.set(no, order);
  }

  type PendingLine = {
    orderNo: string;
    postingDate: string;
    customerNo: string;
    customerName: string;
    branchCode: string;
    branchName: string;
    itemNo: string;
    itemName: string;
    lineNo: number;
    salesUnit: string;
    quantity: number;
    quantityShipped: number;
    pendingQuantity: number;
    quantityMT: number | null;
    quantityShippedMT: number | null;
    pendingQuantityMT: number | null;
    unitPrice: number;
    pendingAmount: number;
  };

  const pendingLines: PendingLine[] = [];
  const byItem = new Map<
    string,
    {
      itemNo: string;
      itemName: string;
      salesUnit: string;
      pendingQuantity: number;
      pendingQuantityMT: number;
      pendingAmount: number;
      lineCount: number;
      orderCount: Set<string>;
      mtConvertible: boolean;
    }
  >();
  const byCustomer = new Map<
    string,
    {
      customerNo: string;
      customerName: string;
      pendingQuantity: number;
      pendingQuantityMT: number;
      pendingAmount: number;
      lineCount: number;
      orderCount: Set<string>;
    }
  >();
  const ordersWithPending = new Set<string>();
  let skippedNonWeightLines = 0;

  function matchesProduct(itemNo: string, name: string): boolean {
    if (!productTerm) return true;
    return `${itemNo} ${name}`.toLowerCase().includes(productTerm);
  }

  for (const line of linesPayload.value ?? []) {
    const orderNo = String(line.docNo ?? "").trim();
    const order = lockedOrders.get(orderNo);
    if (!order) continue;

    const quantity = Number(line.quantity ?? 0);
    const quantityShipped = Number(line.quantityShipped ?? 0);
    const pendingQuantity = quantity - quantityShipped;
    if (pendingQuantity <= 0) continue;

    const itemNo = String(line.itemNo ?? "").trim();
    if (!itemNo) continue;
    const itemName = itemMeta.get(itemNo)?.displayName ?? itemNo;
    if (!matchesProduct(itemNo, itemName)) continue;

    const unitPrice = Number(line.unitPrice ?? 0);
    const pendingAmount = round(pendingQuantity * unitPrice);
    const custNo = String(order.customerNumber ?? "");
    const orderBranch =
      normalizeBranchCode(String(order.accountabilityCenter ?? "")) ||
      normalizeBranchCode(String(order.locationCode ?? "")) ||
      branchCodeFromDocument(order.number) ||
      "";

    const salesUnit = uomIndex.salesUnit.get(itemNo) || "KG";
    const orderedMt = quantityToMetricTons(uomIndex, itemNo, quantity);
    const shippedMt = quantityToMetricTons(uomIndex, itemNo, quantityShipped);
    const pendingMt = quantityToMetricTons(uomIndex, itemNo, pendingQuantity);
    if (!pendingMt.convertible) skippedNonWeightLines += 1;

    ordersWithPending.add(orderNo);
    pendingLines.push({
      orderNo,
      postingDate: String(order.postingDate ?? ""),
      customerNo: custNo,
      customerName: names.get(custNo) ?? "",
      branchCode: orderBranch,
      branchName: orderBranch ? branchNameForCode(orderBranch) : "",
      itemNo,
      itemName,
      lineNo: Number(line.lineNo ?? 0),
      salesUnit,
      quantity: round(quantity),
      quantityShipped: round(quantityShipped),
      pendingQuantity: round(pendingQuantity),
      quantityMT: orderedMt.metricTons,
      quantityShippedMT: shippedMt.metricTons,
      pendingQuantityMT: pendingMt.metricTons,
      unitPrice: round(unitPrice),
      pendingAmount,
    });

    const itemAgg =
      byItem.get(itemNo) ??
      {
        itemNo,
        itemName,
        salesUnit,
        pendingQuantity: 0,
        pendingQuantityMT: 0,
        pendingAmount: 0,
        lineCount: 0,
        orderCount: new Set<string>(),
        mtConvertible: pendingMt.convertible,
      };
    itemAgg.pendingQuantity += pendingQuantity;
    if (pendingMt.metricTons != null) {
      itemAgg.pendingQuantityMT += pendingMt.metricTons;
    } else {
      itemAgg.mtConvertible = false;
    }
    itemAgg.pendingAmount += pendingAmount;
    itemAgg.lineCount += 1;
    itemAgg.orderCount.add(orderNo);
    byItem.set(itemNo, itemAgg);

    const custAgg =
      byCustomer.get(custNo) ??
      {
        customerNo: custNo,
        customerName: names.get(custNo) ?? "",
        pendingQuantity: 0,
        pendingQuantityMT: 0,
        pendingAmount: 0,
        lineCount: 0,
        orderCount: new Set<string>(),
      };
    custAgg.pendingQuantity += pendingQuantity;
    if (pendingMt.metricTons != null) {
      custAgg.pendingQuantityMT += pendingMt.metricTons;
    }
    custAgg.pendingAmount += pendingAmount;
    custAgg.lineCount += 1;
    custAgg.orderCount.add(orderNo);
    byCustomer.set(custNo, custAgg);
  }

  pendingLines.sort((a, b) => b.pendingAmount - a.pendingAmount);

  const totalPendingQuantity = round(
    pendingLines.reduce((sum, row) => sum + row.pendingQuantity, 0),
  );
  const totalPendingQuantityMT = round(
    pendingLines.reduce((sum, row) => sum + (row.pendingQuantityMT ?? 0), 0),
  );
  const totalPendingAmount = round(
    pendingLines.reduce((sum, row) => sum + row.pendingAmount, 0),
  );

  return {
    currency: "NPR",
    quantityUnit: "MT",
    displayNote:
      "Pending Sauda = Locked sales orders with unshipped qty. Primary quantity is metric tons (MT) via item UOM→KG÷1000. Amount = pendingQuantity × unitPrice (order-line UOM). Non-weight items (PCS/SET/MTR) are skipped from MT totals.",
    basis:
      "Synced salesOrders (orderStatus=Locked) joined to salesOrderLines where quantity > quantityShipped. MT from uoms.qtyPerUnitofMeasure against item base KG.",
    filter: {
      customerNo: customerNo ?? null,
      customerName: customerName || null,
      branchCode,
      productQuery: productTerm || null,
    },
    summary: {
      lockedOrdersScanned: lockedOrders.size,
      ordersWithPending: ordersWithPending.size,
      pendingLineCount: pendingLines.length,
      totalPendingQuantityMT,
      totalPendingQuantity,
      totalPendingAmount,
      skippedNonWeightLines,
    },
    topItems: [...byItem.values()]
      .map((row) => ({
        itemNo: row.itemNo,
        itemName: row.itemName,
        salesUnit: row.salesUnit,
        pendingQuantityMT: row.mtConvertible
          ? round(row.pendingQuantityMT)
          : null,
        pendingQuantity: round(row.pendingQuantity),
        pendingAmount: round(row.pendingAmount),
        lineCount: row.lineCount,
        orderCount: row.orderCount.size,
      }))
      .sort((a, b) => b.pendingAmount - a.pendingAmount)
      .slice(0, 20),
    topCustomers: [...byCustomer.values()]
      .map((row) => ({
        customerNo: row.customerNo,
        customerName: row.customerName,
        pendingQuantityMT: round(row.pendingQuantityMT),
        pendingQuantity: round(row.pendingQuantity),
        pendingAmount: round(row.pendingAmount),
        lineCount: row.lineCount,
        orderCount: row.orderCount.size,
      }))
      .sort((a, b) => b.pendingAmount - a.pendingAmount)
      .slice(0, 20),
    lines: pendingLines.slice(0, lineLimit),
    _syncedAt: ordersPayload._syncedAt ?? linesPayload._syncedAt,
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

/** Product sales for one customer from posted invoice lines or sales order lines. */
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

  const productTerm = (input?.productQuery ?? "").trim().toLowerCase();
  const [itemsPayload, posted] = await Promise.all([
    loadItems(),
    loadPostedInvoiceLinePayloads(),
  ]);

  const itemMeta = new Map<string, Item>();
  for (const item of itemsPayload.value ?? []) {
    if (item.number) itemMeta.set(item.number, item);
  }

  const byItem = new Map<
    string,
    {
      itemNo: string;
      name: string;
      salesIncl: number;
      salesExcl: number;
      quantity: number;
      lineCount: number;
    }
  >();
  let totalIncl = 0;
  let totalExcl = 0;
  let totalQuantity = 0;
  let matchedLineCount = 0;
  let orderCount = 0;
  const orderDocs = new Set<string>();

  function matchesProduct(itemNo: string): boolean {
    if (!productTerm) return true;
    const meta = itemMeta.get(itemNo);
    const haystack = [itemNo, meta?.displayName, meta?.itemCategory]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(productTerm);
  }

  if (posted.usePostedInvoices) {
    for (const line of posted.invoiceLines) {
      if (String(line.sellToCustomerNo ?? "") !== resolved.customerNo) continue;
      const postingDate = String(line.postingDate ?? "");
      if (!postingDate || !period.matches(postingDate)) continue;
      const qty = Number(line.quantity ?? 0);
      const itemNo = String(line.itemNo ?? "");
      if (!itemNo || qty <= 0 || !matchesProduct(itemNo)) continue;

      const salesIncl = postedLineSalesIncl(line);
      const salesExcl = postedLineSalesExcl(line);
      totalIncl += salesIncl;
      totalExcl += salesExcl;
      totalQuantity += qty;
      matchedLineCount += 1;
      if (line.documentNo) orderDocs.add(String(line.documentNo));

      const meta = itemMeta.get(itemNo);
      const agg =
        byItem.get(itemNo) ??
        {
          itemNo,
          name: meta?.displayName ?? "",
          salesIncl: 0,
          salesExcl: 0,
          quantity: 0,
          lineCount: 0,
        };
      agg.salesIncl += salesIncl;
      agg.salesExcl += salesExcl;
      agg.quantity += qty;
      agg.lineCount += 1;
      byItem.set(itemNo, agg);
    }

    for (const line of posted.crMemoLines) {
      if (String(line.sellToCustomerNo ?? "") !== resolved.customerNo) continue;
      const postingDate = String(line.postingDate ?? "");
      if (!postingDate || !period.matches(postingDate)) continue;
      const qty = Number(line.quantity ?? 0);
      const itemNo = String(line.itemNo ?? "");
      if (!itemNo || qty <= 0 || !matchesProduct(itemNo)) continue;

      const salesIncl = -Math.abs(postedLineSalesIncl(line));
      const salesExcl = -Math.abs(postedLineSalesExcl(line));
      totalIncl += salesIncl;
      totalExcl += salesExcl;
      totalQuantity -= qty;
      matchedLineCount += 1;
      if (line.documentNo) orderDocs.add(String(line.documentNo));

      const meta = itemMeta.get(itemNo);
      const agg =
        byItem.get(itemNo) ??
        {
          itemNo,
          name: meta?.displayName ?? "",
          salesIncl: 0,
          salesExcl: 0,
          quantity: 0,
          lineCount: 0,
        };
      agg.salesIncl += salesIncl;
      agg.salesExcl += salesExcl;
      agg.quantity -= qty;
      agg.lineCount += 1;
      byItem.set(itemNo, agg);
    }

    orderCount = orderDocs.size;
  } else {
    const [ordersPayload, linesPayload] = await Promise.all([
      loadSalesOrders(),
      loadSalesOrderLines(),
    ]);
    if (ordersPayload.error) return { error: ordersPayload.error };
    if (linesPayload.error) return { error: linesPayload.error };

    const customerOrders = new Map<string, string>();
    for (const order of ordersPayload.value ?? []) {
      if (order.customerNumber !== resolved.customerNo || !order.number) continue;
      if (!order.postingDate || !period.matches(order.postingDate)) continue;
      customerOrders.set(order.number, order.postingDate);
    }

    for (const line of linesPayload.value ?? []) {
      const docNo = String(line.docNo ?? "");
      const postingDate = customerOrders.get(docNo);
      if (!postingDate) continue;

      const qty = Number(line.quantityInvoiced ?? 0);
      if (qty <= 0) continue;
      const itemNo = String(line.itemNo ?? "");
      if (!itemNo || !matchesProduct(itemNo)) continue;

      const sales = qty * Number(line.unitPrice ?? 0);
      totalIncl += sales;
      totalExcl += sales;
      totalQuantity += qty;
      matchedLineCount += 1;

      const meta = itemMeta.get(itemNo);
      const agg =
        byItem.get(itemNo) ??
        {
          itemNo,
          name: meta?.displayName ?? "",
          salesIncl: 0,
          salesExcl: 0,
          quantity: 0,
          lineCount: 0,
        };
      agg.salesIncl += sales;
      agg.salesExcl += sales;
      agg.quantity += qty;
      agg.lineCount += 1;
      byItem.set(itemNo, agg);
    }

    orderCount = customerOrders.size;
  }

  const items = [...byItem.values()]
    .map((row) => ({
      itemNo: row.itemNo,
      name: row.name,
      salesIncludingTax: round(row.salesIncl),
      salesExcludingTax: round(row.salesExcl),
      quantityInvoiced: round(row.quantity),
      lineCount: row.lineCount,
    }))
    .sort((a, b) => b.salesIncludingTax - a.salesIncludingTax)
    .slice(0, limit);

  if (items.length === 0 && matchedLineCount === 0) {
    return {
      currency: "NPR",
      customerNo: resolved.customerNo,
      name: resolved.name,
      period: period.label,
      productQuery: productTerm || null,
      message:
        "No invoiced product lines matched this customer and date filter.",
      orderCount: 0,
      items: [],
      _syncedAt: posted.syncedAt,
    };
  }

  return {
    currency: "NPR",
    customerNo: resolved.customerNo,
    name: resolved.name,
    period: period.label,
    productQuery: productTerm || null,
    displayNote:
      'Show totalSalesIncludingTax and salesIncludingTax only (Incl. VAT). Show salesExcludingTax only when user asks for excl VAT (BC line.amount net after discount).',
    basis: posted.usePostedInvoices
      ? "Posted sales invoice lines for this customer: Incl. VAT = amountIncludingVAT; net excl. VAT (on request) = line.amount."
      : "Customer sales order lines in the filtered posting-date window (quantityInvoiced × unitPrice).",
    orderCount,
    totalSalesIncludingTax: round(totalIncl),
    totalSalesExcludingTax: round(totalExcl),
    totalQuantityInvoiced: round(totalQuantity),
    matchedLineCount,
    items,
    _syncedAt: posted.syncedAt,
  };
}

/** Posted invoice sales grouped by salesperson code. Defaults to current Nepali FY. */
export async function getSalesBySalesperson(
  input?: { limit?: number } & DatePeriodInput,
): Promise<unknown> {
  const limit = Math.min(input?.limit ?? 20, 50);
  const periodInput = withDefaultNepaliFiscalYear(input);
  const periodResult = periodFromInput(periodInput);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const [posted, salespersonsPayload] = await Promise.all([
    loadPostedInvoiceLinePayloads(),
    getMirror("salespersons") as Promise<
      MirrorPayload<{ code?: string; name?: string }>
    >,
  ]);

  const spNames = new Map<string, string>();
  for (const sp of salespersonsPayload.value ?? []) {
    if (sp.code) spNames.set(sp.code, sp.name ?? sp.code);
  }

  if (posted.usePostedInvoices) {
    const bySp = new Map<
      string,
      {
        code: string;
        name: string;
        salesIncl: number;
        salesExcl: number;
        lineCount: number;
      }
    >();
    let totalIncl = 0;

    for (const line of posted.invoiceLines) {
      const postingDate = String(line.postingDate ?? "");
      if (!period.matches(postingDate)) continue;
      const code = String(line.salespersonCode ?? "").trim() || "(none)";
      const incl = postedLineSalesIncl(line);
      const excl = postedLineSalesExcl(line);
      totalIncl += incl;
      const agg =
        bySp.get(code) ??
        { code, name: spNames.get(code) ?? code, salesIncl: 0, salesExcl: 0, lineCount: 0 };
      agg.salesIncl += incl;
      agg.salesExcl += excl;
      agg.lineCount += 1;
      bySp.set(code, agg);
    }

    for (const line of posted.crMemoLines) {
      const postingDate = String(line.postingDate ?? "");
      if (!period.matches(postingDate)) continue;
      const code = String(line.salespersonCode ?? "").trim() || "(none)";
      const incl = -Math.abs(postedLineSalesIncl(line));
      const excl = -Math.abs(postedLineSalesExcl(line));
      totalIncl += incl;
      const agg =
        bySp.get(code) ??
        { code, name: spNames.get(code) ?? code, salesIncl: 0, salesExcl: 0, lineCount: 0 };
      agg.salesIncl += incl;
      agg.salesExcl += excl;
      agg.lineCount += 1;
      bySp.set(code, agg);
    }

    return {
      currency: "NPR",
      calendar: "Bikram Sambat",
      period: period.label,
      fiscalYearStart: periodInput.fiscalYearStart ?? null,
      displayNote:
        'Present period as Nepali FY (e.g. "2082/83"), never as AD year 2026 unless the user asked for AD. Primary: salesIncludingTax (Incl. VAT).',
      basis:
        "Posted sales invoice lines grouped by header salespersonCode (amountIncludingVAT) minus credit memos.",
      totalSalesIncludingTax: round(totalIncl),
      salespersons: [...bySp.values()]
        .map((row) => ({
          code: row.code,
          name: row.name,
          salesIncludingTax: round(row.salesIncl),
          salesExcludingTax: round(row.salesExcl),
          lineCount: row.lineCount,
        }))
        .sort((a, b) => b.salesIncludingTax - a.salesIncludingTax)
        .slice(0, limit),
      _syncedAt: posted.syncedAt,
    };
  }

  const [ordersPayload, linesPayload] = await Promise.all([
    loadSalesOrders(),
    loadSalesOrderLines(),
  ]);
  if (ordersPayload.error) return { error: ordersPayload.error };

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
    basis: "Sales order lines grouped by order.salesperson (fallback). Run sync for posted invoices.",
    totalSalesIncludingTax: round(totalSales),
    salespersons: [...bySp.values()]
      .map((row) => ({
        code: row.code,
        name: row.name,
        salesIncludingTax: round(row.sales),
        salesExcludingTax: round(row.sales),
        lineCount: row.lineCount,
      }))
      .sort((a, b) => b.salesIncludingTax - a.salesIncludingTax)
      .slice(0, limit),
    _syncedAt: linesPayload._syncedAt,
  };
}

/** Product sales for one branch/depot from posted invoice lines. */
export async function getBranchProductSales(
  input?: {
    query?: string;
    branchCode?: string;
    productQuery?: string;
    monthlyBreakdown?: boolean;
  } & DatePeriodInput,
): Promise<unknown> {
  const resolved = resolveBranch({
    query: input?.query,
    branchCode: input?.branchCode,
  });
  if ("error" in resolved) return resolved;

  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const productTerm = (input?.productQuery ?? "").trim().toLowerCase();
  const wantsMonthly = input?.monthlyBreakdown ?? false;
  const currentFyStart = getCurrentFiscalYearStart();
  const fyLabel = currentFyStart ? fiscalYearLabel(currentFyStart) : null;

  const [posted, itemsPayload] = await Promise.all([
    loadPostedInvoiceLinePayloads(),
    loadItems(),
  ]);

  const itemMeta = new Map<string, Item>();
  for (const item of itemsPayload.value ?? []) {
    if (item.number) itemMeta.set(item.number, item);
  }

  function matchesProduct(itemNo: string, description?: string): boolean {
    if (!productTerm) return true;
    const meta = itemMeta.get(itemNo);
    const haystack = [itemNo, meta?.displayName, meta?.itemCategory, description]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return haystack.includes(productTerm);
  }

  if (!posted.usePostedInvoices) {
    return {
      error:
        "Branch product sales requires synced posted invoice lines. Run npm run sync:bc from VPN.",
      branchCode: resolved.code,
      branchName: resolved.name,
    };
  }

  let totalIncl = 0;
  let totalExcl = 0;
  let totalQty = 0;
  let matchedLines = 0;
  const byItem = new Map<
    string,
    {
      itemNo: string;
      name: string;
      quantity: number;
      salesIncl: number;
      salesExcl: number;
      lineCount: number;
    }
  >();
  const nepaliSlots =
    wantsMonthly && currentFyStart
      ? buildNepaliFiscalMonthSlots(currentFyStart)
      : null;

  function lineMatchesPeriod(postingDate: string): boolean {
    const date = parseDate(postingDate);
    if (!date) return false;
    if (wantsMonthly && currentFyStart && !hasCustomPeriod(input)) {
      const fy = getNepaliFiscalYear(date);
      return fy?.startYear === currentFyStart;
    }
    return period.matches(postingDate);
  }

  for (const line of posted.invoiceLines) {
    const branch =
      normalizeBranchCode(String(line.accountabilityCenter ?? "")) ||
      branchCodeFromDocument(line.documentNo) ||
      "";
    if (branch !== resolved.code) continue;
    const postingDate = String(line.postingDate ?? "");
    if (!lineMatchesPeriod(postingDate)) continue;
    const itemNo = String(line.itemNo ?? "");
    if (!itemNo || !matchesProduct(itemNo, line.description)) continue;
    const qty = Number(line.quantity ?? 0);
    if (qty <= 0) continue;

    const incl = postedLineSalesIncl(line);
    const excl = postedLineSalesExcl(line);
    totalIncl += incl;
    totalExcl += excl;
    totalQty += qty;
    matchedLines += 1;

    const meta = itemMeta.get(itemNo);
    const agg =
      byItem.get(itemNo) ??
      {
        itemNo,
        name: meta?.displayName ?? String(line.description ?? ""),
        quantity: 0,
        salesIncl: 0,
        salesExcl: 0,
        lineCount: 0,
      };
    agg.quantity += qty;
    agg.salesIncl += incl;
    agg.salesExcl += excl;
    agg.lineCount += 1;
    byItem.set(itemNo, agg);

    if (nepaliSlots && currentFyStart) {
      applyPostedLineToNepaliMonth(nepaliSlots, line, currentFyStart, 1);
    }
  }

  for (const line of posted.crMemoLines) {
    const branch =
      normalizeBranchCode(String(line.accountabilityCenter ?? "")) ||
      branchCodeFromDocument(line.documentNo) ||
      "";
    if (branch !== resolved.code) continue;
    const postingDate = String(line.postingDate ?? "");
    if (!lineMatchesPeriod(postingDate)) continue;
    const itemNo = String(line.itemNo ?? "");
    if (!itemNo || !matchesProduct(itemNo, line.description)) continue;
    const qty = Number(line.quantity ?? 0);
    if (qty <= 0) continue;

    totalIncl -= Math.abs(postedLineSalesIncl(line));
    totalExcl -= Math.abs(postedLineSalesExcl(line));
    totalQty -= qty;
    matchedLines += 1;

    const meta = itemMeta.get(itemNo);
    const agg =
      byItem.get(itemNo) ??
      {
        itemNo,
        name: meta?.displayName ?? "",
        quantity: 0,
        salesIncl: 0,
        salesExcl: 0,
        lineCount: 0,
      };
    agg.quantity -= qty;
    agg.salesIncl -= Math.abs(postedLineSalesIncl(line));
    agg.salesExcl -= Math.abs(postedLineSalesExcl(line));
    agg.lineCount += 1;
    byItem.set(itemNo, agg);

    if (nepaliSlots && currentFyStart) {
      applyPostedLineToNepaliMonth(nepaliSlots, line, currentFyStart, -1);
    }
  }

  const items = [...byItem.values()]
    .map((row) => ({
      itemNo: row.itemNo,
      name: row.name,
      quantityInvoiced: round(row.quantity),
      salesIncludingTax: round(row.salesIncl),
      salesExcludingTax: round(row.salesExcl),
      lineCount: row.lineCount,
    }))
    .sort((a, b) => b.salesIncludingTax - a.salesIncludingTax);

  return {
    currency: "NPR",
    branchCode: resolved.code,
    branchName: resolved.name,
    productQuery: productTerm || null,
    period: period.label,
    fiscalYear: wantsMonthly ? fyLabel : null,
    displayNote: CUSTOMER_SALES_DISPLAY_NOTE,
    basis:
      "Posted invoice lines filtered by branch accountabilityCenter and product keyword.",
    totalSalesIncludingTax: round(totalIncl),
    totalSalesExcludingTax: round(totalExcl),
    totalQuantityInvoiced: round(totalQty),
    matchedLineCount: matchedLines,
    items,
    byNepaliMonth:
      wantsMonthly && nepaliSlots
        ? serializeNepaliMonthSlots(nepaliSlots)
        : undefined,
    _syncedAt: posted.syncedAt,
  };
}

/** VAT collected (incl − net excl) by Nepali fiscal year and branch. */
export async function getVatReport(
  input?: {
    branchCode?: string;
    fiscalYearStart?: number;
  } & DatePeriodInput,
): Promise<unknown> {
  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const posted = await loadPostedInvoiceLinePayloads();
  if (!posted.usePostedInvoices) {
    return {
      error:
        "VAT report requires synced posted invoice lines. Run npm run sync:bc from VPN.",
    };
  }

  const startYear =
    input?.fiscalYearStart ??
    getCurrentFiscalYearStart() ??
    toBs(new Date())?.year ??
    new Date().getFullYear();

  const branchFilter = input?.branchCode?.trim()
    ? normalizeBranchCode(input.branchCode.trim())
    : null;

  let totalIncl = 0;
  let totalExcl = 0;
  let totalVat = 0;
  const byBranch = new Map<
    string,
    { salesIncl: number; salesExcl: number; vat: number; lineCount: number }
  >();
  const byMonth = buildNepaliFiscalMonthSlots(startYear);

  function addLine(
    line: {
      postingDate?: string;
      accountabilityCenter?: string;
      documentNo?: string;
      lineAmountInclVAT?: number;
      lineAmount?: number;
      lineAmountExclVAT?: number;
    },
    sign: 1 | -1,
  ): void {
    const postingDate = String(line.postingDate ?? "");
    const date = parseDate(postingDate);
    if (!date || !period.matches(postingDate)) return;
    if (!hasCustomPeriod(input)) {
      const fy = getNepaliFiscalYear(date);
      if (!fy || fy.startYear !== startYear) return;
    }
    const branch =
      normalizeBranchCode(String(line.accountabilityCenter ?? "")) ||
      branchCodeFromDocument(line.documentNo) ||
      "";
    if (branchFilter && branch !== branchFilter) return;

    const incl = postedLineSalesIncl(line) * sign;
    const excl = postedLineSalesExcl(line) * sign;
    const vat = postedLineVat(line) * sign;
    totalIncl += incl;
    totalExcl += excl;
    totalVat += vat;

    const code = branch || "(none)";
    const agg =
      byBranch.get(code) ??
      { salesIncl: 0, salesExcl: 0, vat: 0, lineCount: 0 };
    agg.salesIncl += incl;
    agg.salesExcl += excl;
    agg.vat += vat;
    agg.lineCount += 1;
    byBranch.set(code, agg);

    applyPostedLineToNepaliMonth(byMonth, line, startYear, sign);
  }

  for (const line of posted.invoiceLines) addLine(line, 1);
  for (const line of posted.crMemoLines) addLine(line, -1);

  const branches = [...byBranch.entries()]
    .map(([code, agg]) => ({
      branchCode: code,
      branchName: code === "(none)" ? "(none)" : branchNameForCode(code),
      salesIncludingTax: round(agg.salesIncl),
      salesExcludingTax: round(agg.salesExcl),
      vatAmount: round(agg.vat),
      lineCount: agg.lineCount,
    }))
    .sort((a, b) => b.vatAmount - a.vatAmount);

  return {
    currency: "NPR",
    period: period.label,
    fiscalYear: fiscalYearLabel(startYear),
    branchFilter,
    displayNote:
      "vatAmount = amountIncludingVAT − line.amount (net). salesIncludingTax is gross incl VAT.",
    basis:
      "Posted sales invoice lines minus credit memos. VAT = incl VAT minus net excl VAT per line.",
    totalSalesIncludingTax: round(totalIncl),
    totalSalesExcludingTax: round(totalExcl),
    totalVatCollected: round(totalVat),
    byBranch: branches,
    byNepaliMonth: serializeNepaliMonthSlots(byMonth),
    _syncedAt: posted.syncedAt,
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
        allTimeInvoiceSalesIncludingTax:
          byCode.get(branch.code)?.salesIncludingTax ??
          byCode.get(branch.code)?.salesExcludingTax ??
          0,
        allTimeInvoiceSalesExcludingTax:
          byCode.get(branch.code)?.salesExcludingTax ?? 0,
        /** @deprecated use allTimeInvoiceSalesIncludingTax */
        allTimeInvoiceSales:
          byCode.get(branch.code)?.salesIncludingTax ??
          byCode.get(branch.code)?.salesExcludingTax ??
          0,
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
      displayNote:
        "ALWAYS present branchName as the primary label (human-readable depot/factory name). Never list only branch codes. Code may appear in parentheses. Present totalSalesIncludingTax and salesIncludingTax as primary amounts (Incl. VAT).",
      basis:
        "Posted sales invoices (amountIncludingVAT) minus credit memos. Branch = accountability center / document prefix.",
      totalSalesIncludingTax:
        cached.allTime.totalSalesIncludingTax ?? cached.allTime.totalSales,
      totalSalesExcludingTax:
        cached.allTime.totalSalesExcludingTax ?? cached.allTime.totalSales,
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

  const postedPayload = await loadPostedSalesDocuments();
  const usePosted =
    !postedPayload.error &&
    Array.isArray(postedPayload.value) &&
    postedPayload.value.length > 0;

  if (usePosted) {
    const totals = aggregatePostedDocsByBranch(
      postedPayload.value ?? [],
      period.matches,
    );
    const rows = [...totals.entries()]
      .map(([code, agg]) => ({
        branchCode: code,
        branchName: branchNameForCode(code),
        salesIncludingTax: round(agg.salesIncl),
        salesExcludingTax: round(agg.salesExcl),
        invoices: agg.invoices,
      }))
      .sort((a, b) => b.salesIncludingTax - a.salesIncludingTax);

    const totalIncl = round(
      rows.reduce((sum, row) => sum + row.salesIncludingTax, 0),
    );
    const totalExcl = round(
      rows.reduce((sum, row) => sum + row.salesExcludingTax, 0),
    );

    const currentFyStart = getCurrentFiscalYearStart();
    let currentFiscalYear: {
      label: string;
      branches: typeof rows;
      totalSalesIncludingTax: number;
      totalSalesExcludingTax: number;
      totalSales: number;
    } | null = null;

    if (currentFyStart && !hasCustomPeriod(input)) {
      const fyTotals = aggregatePostedDocsByBranch(
        postedPayload.value ?? [],
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
          salesIncludingTax: round(agg.salesIncl),
          salesExcludingTax: round(agg.salesExcl),
          invoices: agg.invoices,
        }))
        .sort((a, b) => b.salesIncludingTax - a.salesIncludingTax);
      const fyIncl = round(
        fyRows.reduce((sum, row) => sum + row.salesIncludingTax, 0),
      );
      const fyExcl = round(
        fyRows.reduce((sum, row) => sum + row.salesExcludingTax, 0),
      );
      currentFiscalYear = {
        label: fiscalYearLabel(currentFyStart),
        branches: fyRows,
        totalSalesIncludingTax: fyIncl,
        totalSalesExcludingTax: fyExcl,
        totalSales: fyExcl,
      };
    }

    return {
      currency: "NPR",
      period: period.label,
      displayNote:
        "ALWAYS present branchName as the primary label. Present totalSalesIncludingTax and salesIncludingTax (Incl. VAT).",
      basis:
        "Posted sales invoices (amountIncludingVAT) minus credit memos. Branch = accountability center / document prefix.",
      totalSalesIncludingTax: totalIncl,
      totalSalesExcludingTax: totalExcl,
      branchCount: rows.length,
      branches: rows,
      currentNepaliFiscalYear: currentFiscalYear,
      _syncedAt: postedPayload._syncedAt,
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

  return {
    currency: "NPR",
    period: period.label,
    calendar: input?.year || input?.month ? "AD" : "all_synced_periods",
    basis:
      "Ledger fallback (salesLcy). Run sync for posted sales invoices. Branch = document prefix before underscore.",
    totalSalesExcludingTax: totalSales,
    branchCount: rows.length,
    branches: rows,
    currentNepaliFiscalYear: null,
    _syncedAt: ledgerPayload._syncedAt,
  };
}

function branchFiscalMonthRows(
  entries: LedgerEntry[],
  branchCode: string,
  fyStartYear: number,
): BranchMonthRow[] {
  const monthMap = new Map<
    number,
    { sales: number; invoices: number; bsYear: number }
  >();

  for (const entry of entries) {
    if (entry.documentType !== "Invoice") continue;
    if (branchCodeFromDocument(entry.documentNo) !== branchCode) continue;
    const date = parseDate(entry.postingDate);
    if (!date) continue;
    const fy = getNepaliFiscalYear(date);
    if (!fy || fy.startYear !== fyStartYear) continue;
    const bs = toBs(date);
    if (!bs) continue;

    const agg = monthMap.get(bs.month) ?? {
      sales: 0,
      invoices: 0,
      bsYear: bs.year,
    };
    agg.sales += Number(entry.salesLcy ?? 0);
    agg.invoices += 1;
    monthMap.set(bs.month, agg);
  }

  return FISCAL_MONTH_ORDER.map((monthIndex) => {
    const bsYear = monthIndex >= 3 ? fyStartYear : fyStartYear + 1;
    const agg = monthMap.get(monthIndex) ?? { sales: 0, invoices: 0, bsYear };
    return {
      bsMonth: BS_MONTHS[monthIndex],
      monthIndex,
      bsYear,
      salesIncludingTax: round(agg.sales),
      salesExcludingTax: round(agg.sales),
      invoices: agg.invoices,
    };
  });
}

/** Posted invoice sales for one branch (by name, alias, or code). */
export async function getSalesByBranch(
  input?: {
    query?: string;
    branchCode?: string;
    monthlyBreakdown?: boolean;
  } & DatePeriodInput,
): Promise<unknown> {
  const resolved = resolveBranch({
    query: input?.query,
    branchCode: input?.branchCode,
  });
  if ("error" in resolved) return resolved;

  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const wantsMonthly = input?.monthlyBreakdown ?? false;
  const currentFyStart = getCurrentFiscalYearStart();
  const fyLabel = currentFyStart ? fiscalYearLabel(currentFyStart) : null;

  const cached = !hasCustomPeriod(input) ? await loadBranchSalesCache() : null;
  if (cached && period.label === "all synced dates") {
    const row = cached.allTime.branches.find(
      (entry) => entry.branchCode === resolved.code,
    );
    const fyRow = fyLabel
      ? cached.byNepaliFiscalYear[fyLabel]?.branches.find(
          (entry) => entry.branchCode === resolved.code,
        )
      : null;

    if (wantsMonthly && fyLabel) {
      const months = branchMonthlyFromCache(cached, resolved.code, fyLabel);
      const fySalesIncl = round(
        months.reduce(
          (sum, m) => sum + (m.salesIncludingTax ?? m.salesExcludingTax),
          0,
        ),
      );
      const fySalesExcl = round(
        months.reduce((sum, m) => sum + m.salesExcludingTax, 0),
      );
      const fyInvoices = months.reduce((sum, m) => sum + m.invoices, 0);

      return {
        currency: "NPR",
        branchCode: resolved.code,
        branchName: resolved.name,
        calendar: "Bikram Sambat",
        fiscalYear: fyLabel,
        period: `Nepali FY ${fyLabel}`,
        displayNote:
          "Present totalSalesIncludingTax and byNepaliMonth.salesIncludingTax (Incl. VAT).",
        basis:
          "Posted sales invoices (amountIncludingVAT) by branch. Months in fiscal order (Shrawan → Ashadh).",
        totalSalesIncludingTax: fySalesIncl,
        totalSalesExcludingTax: fySalesExcl,
        invoiceCount: fyInvoices,
        byNepaliMonth: months,
        allTimeSalesIncludingTax:
          row?.salesIncludingTax ?? row?.salesExcludingTax ?? 0,
        allTimeSalesExcludingTax: row?.salesExcludingTax ?? 0,
        allTimeInvoices: row?.invoices ?? 0,
        _syncedAt: cached._builtAt,
      };
    }

    return {
      currency: "NPR",
      branchCode: resolved.code,
      branchName: resolved.name,
      period: period.label,
      displayNote:
        "Present totalSalesIncludingTax and salesIncludingTax (Incl. VAT).",
      basis:
        "Posted sales invoices (amountIncludingVAT) by branch accountability center / document prefix.",
      totalSalesIncludingTax:
        row?.salesIncludingTax ?? row?.salesExcludingTax ?? 0,
      totalSalesExcludingTax: row?.salesExcludingTax ?? 0,
      invoiceCount: row?.invoices ?? 0,
      currentNepaliFiscalYear: fyLabel
        ? {
            label: fyLabel,
            salesIncludingTax:
              fyRow?.salesIncludingTax ?? fyRow?.salesExcludingTax ?? 0,
            salesExcludingTax: fyRow?.salesExcludingTax ?? 0,
            invoices: fyRow?.invoices ?? 0,
          }
        : null,
      _syncedAt: cached._builtAt,
    };
  }

  const postedPayload = await loadPostedSalesDocuments();
  const usePosted =
    !postedPayload.error &&
    Array.isArray(postedPayload.value) &&
    postedPayload.value.length > 0;

  if (usePosted) {
    const docs = postedPayload.value ?? [];
    const monthlyFyStart =
      typeof input?.fiscalYearStart === "number"
        ? input.fiscalYearStart
        : wantsMonthly
          ? currentFyStart
          : null;

    if (wantsMonthly && monthlyFyStart) {
      const months = branchFiscalMonthRowsFromPosted(
        docs,
        resolved.code,
        monthlyFyStart,
      );
      const fySalesIncl = round(
        months.reduce((sum, m) => sum + m.salesIncludingTax, 0),
      );
      const fySalesExcl = round(
        months.reduce((sum, m) => sum + m.salesExcludingTax, 0),
      );
      const fyInvoices = months.reduce((sum, m) => sum + m.invoices, 0);

      return {
        currency: "NPR",
        branchCode: resolved.code,
        branchName: resolved.name,
        calendar: "Bikram Sambat",
        fiscalYear: fiscalYearLabel(monthlyFyStart),
        period: `Nepali FY ${fiscalYearLabel(monthlyFyStart)}`,
        displayNote:
          "Present totalSalesIncludingTax and byNepaliMonth.salesIncludingTax (Incl. VAT).",
        basis:
          "Posted sales invoices (amountIncludingVAT) by branch. Months in fiscal order (Shrawan → Ashadh).",
        totalSalesIncludingTax: fySalesIncl,
        totalSalesExcludingTax: fySalesExcl,
        invoiceCount: fyInvoices,
        byNepaliMonth: months,
        _syncedAt: postedPayload._syncedAt,
      };
    }

    let totalIncl = 0;
    let totalExcl = 0;
    let invoiceCount = 0;
    const byBsMonth = new Map<
      string,
      {
        bsMonth: string;
        bsYear: number;
        salesIncl: number;
        salesExcl: number;
        invoices: number;
      }
    >();

    for (const doc of docs) {
      if (normalizeBranchCode(String(doc.branchCode ?? "")) !== resolved.code) {
        continue;
      }
      if (!period.matches(String(doc.postingDate ?? ""))) continue;

      const incl = Number(doc.salesAmountIncludingTax ?? doc.salesAmount ?? 0);
      const excl = Number(doc.salesAmount ?? incl);
      const isInvoice = doc.documentKind !== "credit_memo";
      const sign = isInvoice ? 1 : -1;
      totalIncl += sign * Math.abs(incl);
      totalExcl += sign * Math.abs(excl);
      if (isInvoice) invoiceCount += 1;

      const date = parseDate(doc.postingDate);
      const bs = date ? toBs(date) : null;
      if (bs) {
        const key = `${bs.year}-${bs.month}`;
        const agg =
          byBsMonth.get(key) ??
          {
            bsMonth: BS_MONTHS[bs.month] ?? String(bs.month + 1),
            bsYear: bs.year,
            salesIncl: 0,
            salesExcl: 0,
            invoices: 0,
          };
        agg.salesIncl += sign * Math.abs(incl);
        agg.salesExcl += sign * Math.abs(excl);
        if (isInvoice) agg.invoices += 1;
        byBsMonth.set(key, agg);
      }
    }

    const monthly = [...byBsMonth.values()]
      .map((row) => ({
        bsMonth: row.bsMonth,
        bsYear: row.bsYear,
        salesIncludingTax: round(row.salesIncl),
        salesExcludingTax: round(row.salesExcl),
        invoices: row.invoices,
      }))
      .sort((a, b) =>
        a.bsYear === b.bsYear
          ? a.bsMonth.localeCompare(b.bsMonth)
          : a.bsYear - b.bsYear,
      );

    return {
      currency: "NPR",
      branchCode: resolved.code,
      branchName: resolved.name,
      period: period.label,
      displayNote:
        "Present totalSalesIncludingTax and salesIncludingTax (Incl. VAT).",
      basis:
        "Posted sales invoices (amountIncludingVAT) by branch accountability center / document prefix.",
      totalSalesIncludingTax: round(totalIncl),
      totalSalesExcludingTax: round(totalExcl),
      invoiceCount,
      byNepaliMonth: monthly,
      _syncedAt: postedPayload._syncedAt,
    };
  }

  const ledgerPayload = await loadLedger();
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  if (wantsMonthly && currentFyStart && !hasCustomPeriod(input)) {
    const months = branchFiscalMonthRows(
      ledgerPayload.value ?? [],
      resolved.code,
      currentFyStart,
    );
    const fySales = round(
      months.reduce((sum, m) => sum + m.salesExcludingTax, 0),
    );
    const fyInvoices = months.reduce((sum, m) => sum + m.invoices, 0);

    return {
      currency: "NPR",
      branchCode: resolved.code,
      branchName: resolved.name,
      calendar: "Bikram Sambat",
      fiscalYear: fyLabel,
      period: fyLabel ? `Nepali FY ${fyLabel}` : period.label,
      basis:
        "Ledger fallback (salesLcy). Run sync for posted sales invoices.",
      totalSalesExcludingTax: fySales,
      invoiceCount: fyInvoices,
      byNepaliMonth: months,
      _syncedAt: ledgerPayload._syncedAt,
    };
  }

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
      "Ledger fallback (salesLcy). Run sync for posted sales invoices.",
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
