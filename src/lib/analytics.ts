import { getMirror } from "./bc-mirror";
import { loadUomIndex, quantityToMetricTons } from "./uom-convert";
import { matchesProductTerms } from "./product-query";
import { formatAmount } from "./format";
import { loadCustomersPayload } from "./derived-customers";
import { type DatePeriodInput, periodFromInput } from "./date-period";
import { averageCustomerSellingPrice } from "./selling-price";
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
 * Prefers posted sales invoice/credit memo documents when synced (matches ledger).
 */
export async function getSalesSummary(): Promise<unknown> {
  const postedPayload = (await getMirror("postedSalesDocuments")) as MirrorPayload<{
    documentNo?: string;
    postingDate?: string;
    branchCode?: string;
    salesAmount?: number;
    salesAmountIncludingTax?: number;
    documentKind?: "invoice" | "credit_memo";
  }>;

  const usePostedDocuments =
    !postedPayload.error &&
    Array.isArray(postedPayload.value) &&
    postedPayload.value.length > 0;

  if (usePostedDocuments) {
    let grossInvoiceSalesIncl = 0;
    let grossInvoiceSalesExcl = 0;
    let creditMemoSalesIncl = 0;
    let creditMemoSalesExcl = 0;
    let invoiceCount = 0;
    let earliest: Date | null = null;
    let latest: Date | null = null;

    const byAdYear: Record<
      string,
      { salesIncl: number; salesExcl: number; invoices: number }
    > = {};
    const byFiscalYear: Record<
      string,
      { salesIncl: number; salesExcl: number; invoices: number }
    > = {};

    for (const doc of postedPayload.value ?? []) {
      const date = parseDate(doc.postingDate);
      if (!date) continue;
      if (!earliest || date < earliest) earliest = date;
      if (!latest || date > latest) latest = date;

      const amountIncl = Number(
        doc.salesAmountIncludingTax ?? doc.salesAmount ?? 0,
      );
      const amountExcl = Number(doc.salesAmount ?? amountIncl);
      const isInvoice = doc.documentKind === "invoice";

      if (isInvoice) {
        grossInvoiceSalesIncl += amountIncl;
        grossInvoiceSalesExcl += amountExcl;
        invoiceCount += 1;

        const adYear = String(date.getFullYear());
        byAdYear[adYear] ??= { salesIncl: 0, salesExcl: 0, invoices: 0 };
        byAdYear[adYear].salesIncl += amountIncl;
        byAdYear[adYear].salesExcl += amountExcl;
        byAdYear[adYear].invoices += 1;

        const fy = getNepaliFiscalYear(date);
        if (fy) {
          byFiscalYear[fy.label] ??= { salesIncl: 0, salesExcl: 0, invoices: 0 };
          byFiscalYear[fy.label].salesIncl += amountIncl;
          byFiscalYear[fy.label].salesExcl += amountExcl;
          byFiscalYear[fy.label].invoices += 1;
        }
      } else {
        const creditIncl = Math.abs(amountIncl);
        const creditExcl = Math.abs(amountExcl);
        creditMemoSalesIncl += creditIncl;
        creditMemoSalesExcl += creditExcl;

        const adYear = String(date.getFullYear());
        byAdYear[adYear] ??= { salesIncl: 0, salesExcl: 0, invoices: 0 };
        byAdYear[adYear].salesIncl -= creditIncl;
        byAdYear[adYear].salesExcl -= creditExcl;

        const fy = getNepaliFiscalYear(date);
        if (fy) {
          byFiscalYear[fy.label] ??= { salesIncl: 0, salesExcl: 0, invoices: 0 };
          byFiscalYear[fy.label].salesIncl -= creditIncl;
          byFiscalYear[fy.label].salesExcl -= creditExcl;
        }
      }
    }

    const currentFy = getNepaliFiscalYear(new Date());
    const currentFyLabel = currentFy?.label ?? null;
    const netIncl = grossInvoiceSalesIncl - Math.abs(creditMemoSalesIncl);
    const netExcl = grossInvoiceSalesExcl - Math.abs(creditMemoSalesExcl);

    return {
      currency: "NPR",
      displayNote:
        "Present netSalesIncludingTax and salesIncludingTax fields as primary amounts (Incl. VAT).",
      note: "Sales from posted invoices minus credit memos. Incl. VAT uses amountIncludingVAT; excl. VAT uses line.amount (ledger basis). Profit is not included because COGS/cost data is not synced.",
      allTime: {
        grossInvoiceSalesIncludingTax: round(grossInvoiceSalesIncl),
        grossInvoiceSalesExcludingTax: round(grossInvoiceSalesExcl),
        creditMemosIncludingTax: round(creditMemoSalesIncl),
        creditMemosExcludingTax: round(creditMemoSalesExcl),
        netSalesIncludingTax: round(netIncl),
        netSalesExcludingTax: round(netExcl),
        /** @deprecated use netSalesIncludingTax */
        grossInvoiceSales: round(grossInvoiceSalesExcl),
        /** @deprecated use netSalesIncludingTax */
        creditMemos: round(creditMemoSalesExcl),
        /** @deprecated use netSalesIncludingTax */
        netSales: round(netExcl),
        invoiceCount,
        dateRange: {
          from: earliest?.toISOString().slice(0, 10) ?? null,
          to: latest?.toISOString().slice(0, 10) ?? null,
        },
      },
      currentNepaliFiscalYear: currentFyLabel
        ? {
            label: currentFyLabel,
            salesIncludingTax: round(
              byFiscalYear[currentFyLabel]?.salesIncl ?? 0,
            ),
            salesExcludingTax: round(
              byFiscalYear[currentFyLabel]?.salesExcl ?? 0,
            ),
            /** @deprecated use salesIncludingTax */
            sales: round(byFiscalYear[currentFyLabel]?.salesExcl ?? 0),
            invoices: byFiscalYear[currentFyLabel]?.invoices ?? 0,
          }
        : null,
      byAdYear: Object.fromEntries(
        Object.entries(byAdYear)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([year, v]) => [
            year,
            {
              salesIncludingTax: round(v.salesIncl),
              salesExcludingTax: round(v.salesExcl),
              sales: round(v.salesExcl),
              invoices: v.invoices,
            },
          ]),
      ),
      byNepaliFiscalYear: Object.fromEntries(
        Object.entries(byFiscalYear)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([fy, v]) => [
            fy,
            {
              salesIncludingTax: round(v.salesIncl),
              salesExcludingTax: round(v.salesExcl),
              sales: round(v.salesExcl),
              invoices: v.invoices,
            },
          ]),
      ),
      _syncedAt: postedPayload._syncedAt,
      _source: "posted_invoices",
    };
  }

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

  const currentFy = getNepaliFiscalYear(new Date());
  const currentFyLabel = currentFy?.label ?? null;

  return {
    currency: "NPR",
    displayNote:
      "Ledger sync has excl-VAT amounts only; present netSalesExcludingTax and label as Excl. VAT.",
    note: "Sales figures are net of tax (salesLcy) from customer ledger invoice entries. Profit is not included because COGS/cost data is not synced.",
    allTime: {
      grossInvoiceSalesIncludingTax: round(grossInvoiceSales),
      grossInvoiceSalesExcludingTax: round(grossInvoiceSales),
      creditMemosIncludingTax: round(creditMemoSales),
      creditMemosExcludingTax: round(creditMemoSales),
      netSalesIncludingTax: round(grossInvoiceSales - Math.abs(creditMemoSales)),
      netSalesExcludingTax: round(grossInvoiceSales - Math.abs(creditMemoSales)),
      grossInvoiceSales: round(grossInvoiceSales),
      creditMemos: round(creditMemoSales),
      netSales: round(grossInvoiceSales - Math.abs(creditMemoSales)),
      invoiceCount,
      dateRange: {
        from: earliest?.toISOString().slice(0, 10) ?? null,
        to: latest?.toISOString().slice(0, 10) ?? null,
      },
    },
    currentNepaliFiscalYear: currentFyLabel
      ? {
          label: currentFyLabel,
          salesIncludingTax: round(byFiscalYear[currentFyLabel]?.sales ?? 0),
          salesExcludingTax: round(byFiscalYear[currentFyLabel]?.sales ?? 0),
          sales: round(byFiscalYear[currentFyLabel]?.sales ?? 0),
          invoices: byFiscalYear[currentFyLabel]?.invoices ?? 0,
        }
      : null,
    byAdYear: Object.fromEntries(
      Object.entries(byAdYear)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([year, v]) => [
          year,
          {
            salesIncludingTax: round(v.sales),
            salesExcludingTax: round(v.sales),
            sales: round(v.sales),
            invoices: v.invoices,
          },
        ]),
    ),
    byNepaliFiscalYear: Object.fromEntries(
      Object.entries(byFiscalYear)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([fy, v]) => [
          fy,
          {
            salesIncludingTax: round(v.sales),
            salesExcludingTax: round(v.sales),
            sales: round(v.sales),
            invoices: v.invoices,
          },
        ]),
    ),
    _syncedAt: payload._syncedAt,
    _source: "customer_ledger",
  };
}

/**
 * Receivables aging on open invoice entries.
 * - due_date: days past payment due date (classic overdue aging)
 * - posting_date: days since invoice posting date ("90 days since now")
 */
export type ReceivablesAgeBy = "due_date" | "posting_date";

export type ReceivablesAgingInput = DatePeriodInput & {
  minDays?: number;
  /** Default due_date for overdue questions; posting_date for "X days since invoice". */
  ageBy?: ReceivablesAgeBy;
  /** Customer name search — partial match OK (e.g. "Bhatbhateni Super Market"). */
  query?: string;
  customerNo?: string;
};

async function resolveCustomerForFilter(input?: {
  query?: string;
  customerNo?: string;
}): Promise<
  | { customerNo: string; name: string }
  | { error: string; candidates?: unknown }
  | null
> {
  if (!input?.customerNo?.trim() && !input?.query?.trim()) return null;

  const customersPayload = await loadCustomersPayload();
  if (customersPayload.error) return { error: customersPayload.error };

  if (input.customerNo?.trim()) {
    const customer = (customersPayload.value ?? []).find(
      (c) => c.number === input.customerNo?.trim(),
    );
    if (!customer?.number) {
      return { error: `Customer number ${input.customerNo} not found.` };
    }
    return { customerNo: customer.number, name: customer.displayName ?? "" };
  }

  const search = (await searchCustomers(input.query!.trim())) as {
    customers?: Array<{
      customerNo?: string;
      name?: string;
      matchScore?: number;
    }>;
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
  return {
    customerNo: top[0].customerNo ?? "",
    name: top[0].name ?? "",
  };
}

export async function getReceivablesAging(
  input?: number | ReceivablesAgingInput,
): Promise<unknown> {
  const options: ReceivablesAgingInput =
    typeof input === "number" ? { minDays: input } : (input ?? {});
  const minDays = options.minDays;
  const ageBy = options.ageBy ?? "due_date";
  const periodResult = periodFromInput(options);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const customerFilter = await resolveCustomerForFilter({
    query: options.query,
    customerNo: options.customerNo,
  });
  if (customerFilter && "error" in customerFilter) return customerFilter;

  const [ledgerPayload, customersPayload] = await Promise.all([
    loadLedger(),
    loadCustomersPayload(),
  ]);
  if (ledgerPayload.error) return { error: ledgerPayload.error };

  const customerNames = new Map<string, string>();
  for (const customer of customersPayload.value ?? []) {
    if (customer.number) {
      customerNames.set(customer.number, customer.displayName ?? "");
    }
  }

  const filterCustomerNo = customerFilter?.customerNo ?? null;
  const filterCustomerName = customerFilter?.name ?? null;

  const now = new Date();
  const bucketDefs =
    ageBy === "posting_date"
      ? ([
          { label: "0-30 days old", min: 0, max: 30 },
          { label: "31-60 days old", min: 31, max: 60 },
          { label: "61-90 days old", min: 61, max: 90 },
          { label: "Over 90 days old", min: 90, max: Infinity },
        ] as const)
      : ([
          { label: "Not due", min: -Infinity, max: 0 },
          { label: "1-30 days", min: 1, max: 30 },
          { label: "31-60 days", min: 31, max: 60 },
          { label: "61-90 days", min: 61, max: 90 },
          { label: "Over 90 days", min: 90, max: Infinity },
        ] as const);

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
    referenceDate: string;
    daysAged: number;
    daysPastDue?: number;
    remaining: number;
  }> = [];

  for (const entry of ledgerPayload.value ?? []) {
    if (!period.matches(entry.postingDate)) continue;
    if (!entry.open) continue;
    const remaining = Number(entry.remainingAmount ?? 0);
    if (remaining <= 0) continue;
    if (entry.documentType !== "Invoice") continue;

    const customerNo = entry.customerNo ?? entry.sellToCustomerNo ?? "";
    if (filterCustomerNo && customerNo !== filterCustomerNo) continue;

    const postingDate = parseDate(entry.postingDate);
    const dueDate = parseDate(entry.dueDate);

    let daysAged: number | null = null;
    let daysPastDue: number | null = null;
    let referenceDate = "";

    if (ageBy === "posting_date") {
      if (!postingDate) continue;
      daysAged = Math.floor(
        (now.getTime() - postingDate.getTime()) / 86400000,
      );
      referenceDate = entry.postingDate ?? "";
      if (dueDate) {
        daysPastDue = Math.floor(
          (now.getTime() - dueDate.getTime()) / 86400000,
        );
      }
    } else {
      if (!dueDate) continue;
      daysAged = Math.floor((now.getTime() - dueDate.getTime()) / 86400000);
      daysPastDue = daysAged;
      referenceDate = entry.dueDate ?? "";
    }

    if (daysAged === null) continue;

    const bucketIndex = bucketDefs.findIndex(
      (def) => daysAged >= def.min && daysAged <= def.max,
    );
    if (bucketIndex >= 0) {
      buckets[bucketIndex].count += 1;
      buckets[bucketIndex].amount += remaining;
    }

    const name = customerNames.get(customerNo) ?? "";
    const matchesMinDays = !minDays || daysAged >= minDays;

    if (ageBy === "due_date" && daysAged > 0) {
      const agg =
        perCustomer.get(customerNo) ??
        { customerNo, name, overdue: 0, entries: 0 };
      agg.overdue += remaining;
      agg.entries += 1;
      perCustomer.set(customerNo, agg);
    }

    if (matchesMinDays) {
      if (ageBy === "posting_date" || daysAged > 0) {
        overdueEntries.push({
          customerNo,
          name,
          documentNo: entry.documentNo ?? "",
          referenceDate,
          daysAged,
          ...(daysPastDue !== null ? { daysPastDue } : {}),
          remaining: round(remaining),
        });
      }
    }
  }

  const totalOutstanding = round(
    buckets.reduce((sum, b) => sum + b.amount, 0),
  );
  const totalOverdue =
    ageBy === "posting_date"
      ? round(
          overdueEntries
            .filter((e) => (e.daysPastDue ?? -1) > 0)
            .reduce((sum, e) => sum + e.remaining, 0),
        )
      : round(
          buckets
            .filter((b) => b.bucket !== "Not due")
            .reduce((sum, b) => sum + b.amount, 0),
        );
  const totalNotYetDue =
    ageBy === "posting_date"
      ? round(Math.max(0, totalOutstanding - totalOverdue))
      : round(
          buckets
            .filter((b) => b.bucket === "Not due")
            .reduce((sum, b) => sum + b.amount, 0),
        );

  overdueEntries.sort((a, b) => b.daysAged - a.daysAged);

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

  const matchingTotal = round(
    overdueEntries.reduce((sum, e) => sum + e.remaining, 0),
  );
  const matchingInvoiceCount = overdueEntries.length;

  const topCustomersByMinDays = minDays
    ? (() => {
        const byCustomer = new Map<
          string,
          {
            customerNo: string;
            name: string;
            outstanding: number;
            invoiceCount: number;
          }
        >();
        for (const entry of overdueEntries) {
          const agg =
            byCustomer.get(entry.customerNo) ??
            {
              customerNo: entry.customerNo,
              name: entry.name,
              outstanding: 0,
              invoiceCount: 0,
            };
          agg.outstanding += entry.remaining;
          agg.invoiceCount += 1;
          byCustomer.set(entry.customerNo, agg);
        }
        return [...byCustomer.values()]
          .map((row) => ({
            ...row,
            outstanding: round(row.outstanding),
          }))
          .sort((a, b) => b.outstanding - a.outstanding)
          .slice(0, 15);
      })()
    : undefined;

  return {
    currency: "NPR",
    period: period.label,
    ageBy,
    basis:
      ageBy === "posting_date"
        ? "Open customer ledger invoices aged by posting date (days since invoice). Includes balances not yet past payment due date."
        : "Open customer ledger invoice entries aged by payment due date (days overdue).",
    ...(filterCustomerNo
      ? {
          customer: {
            customerNo: filterCustomerNo,
            name: filterCustomerName ?? customerNames.get(filterCustomerNo) ?? "",
          },
        }
      : {}),
    totalOutstanding,
    totalOverdue,
    totalNotYetDue,
    buckets: buckets.map((b) => ({ ...b, amount: round(b.amount) })),
    ...(minDays ? { filterMinDays: minDays } : {}),
    matchingOverdueTotal: matchingTotal,
    matchingInvoiceCount,
    overdueEntries: overdueEntries.slice(0, 50),
    ...(topCustomersByMinDays
      ? { topCustomersByMinDays }
      : {}),
    topOverdueCustomers: filterCustomerNo
      ? topOverdueCustomers.filter((c) => c.customerNo === filterCustomerNo)
      : topOverdueCustomers,
    topCustomersByBalance: filterCustomerNo
      ? topCustomersByBalance.filter((c) => c.customerNo === filterCustomerNo)
      : topCustomersByBalance,
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
  const payload = await loadCustomersPayload();
  if (payload.error) return { error: payload.error };

  const term = normalizeSearchText(query);
  if (!term) return { error: "Search query required." };
  const termTokens = term.split(" ").filter((token) => token.length >= 2);

  const matches = (payload.value ?? [])
    .map((customer) => {
      const fields = [
        customer.number ?? "",
        customer.displayName ?? "",
        customer.phoneNumber ?? "",
      ];
      const nameNorm = normalizeSearchText(customer.displayName ?? "");
      const normalized = normalizeSearchText(fields.join(" "));
      let score = 0;
      if (nameNorm === term) score = 100;
      else if (normalizeSearchText(customer.number ?? "") === term) score = 95;
      else if (
        termTokens.length >= 2 &&
        termTokens.every((token) => nameNorm.includes(token))
      )
        score = 88;
      else if (nameNorm.startsWith(term)) score = 80;
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
    ...(payload.source ? { source: payload.source, note: payload.note } : {}),
    _syncedAt: payload._syncedAt,
  };
}

/**
 * Customer payment / invoice statement from ledger entries.
 * Resolve by customerNo, customer name search, or a known document number.
 */
export async function getCustomerStatement(
  input?: {
    customerNo?: string;
    query?: string;
    documentNo?: string;
  } & DatePeriodInput,
): Promise<unknown> {
  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;
  const [ledgerPayload, customersPayload] = await Promise.all([
    loadLedger(),
    loadCustomersPayload(),
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
        (entry.customerNo === customerNo ||
          entry.sellToCustomerNo === customerNo) &&
        period.matches(entry.postingDate),
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
    period: period.label,
    customerNo,
    name: customer.displayName,
    phone: customer.phoneNumber,
    masterBalance: round(openBalance),
    masterOverdue: round(overdueBalance),
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
 * If fiscalYearStart is omitted, uses the current Nepali fiscal year (today's BS calendar).
 */
export async function getNepaliMonthlySales(
  fiscalYearStart?: number,
): Promise<unknown> {
  const startYear =
    fiscalYearStart ??
    getCurrentFiscalYearStart() ??
    toBs(new Date())?.year ??
    new Date().getFullYear();

  const fiscalOrder = NEPALI_FISCAL_MONTH_ORDER;
  const fromInvoices = await aggregateNepaliFiscalYearFromPostedLines(startYear);

  if (fromInvoices.usePostedInvoices) {
    const cleaned = serializeNepaliMonthSlots(fromInvoices.slots);
    const topMonth = [...cleaned].sort(
      (a, b) => b.salesIncludingTax - a.salesIncludingTax,
    )[0];
    const totalSalesIncludingTax = round(
      cleaned.reduce((sum, m) => sum + m.salesIncludingTax, 0),
    );
    const totalVatAmount = round(
      cleaned.reduce((sum, m) => sum + m.vatAmount, 0),
    );

    const todayBs = toBs(new Date());
    const asOfBs = fromInvoices.latestInFy
      ? toBs(fromInvoices.latestInFy)
      : todayBs;
    const isCurrentFiscalYear =
      getCurrentFiscalYearStart() !== null &&
      startYear === getCurrentFiscalYearStart();

    let yearToDateSales = totalSalesIncludingTax;
    let yearToDateInvoices = cleaned.reduce((sum, m) => sum + m.invoices, 0);
    if (isCurrentFiscalYear && asOfBs) {
      const asOfIndex = fiscalOrder.indexOf(asOfBs.month);
      yearToDateSales = round(
        cleaned
          .filter((m) => fiscalOrder.indexOf(m.monthIndex) <= asOfIndex)
          .reduce((sum, m) => sum + m.salesIncludingTax, 0),
      );
      yearToDateInvoices = cleaned
        .filter((m) => fiscalOrder.indexOf(m.monthIndex) <= asOfIndex)
        .reduce((sum, m) => sum + m.invoices, 0);
    }

    return {
      currency: "NPR",
      calendar: "Bikram Sambat",
      fiscalYear: fiscalYearLabel(startYear),
      isCurrentFiscalYear,
      displayNote:
        'Present salesIncludingTax and yearToDate.salesIncludingTax (Incl. VAT). Show salesExcludingTax / vatAmount only when user asks.',
      asOf: {
        bs: asOfBs
          ? `${asOfBs.year}/${String(asOfBs.month + 1).padStart(2, "0")}/${String(asOfBs.date).padStart(2, "0")} (${asOfBs.monthName})`
          : null,
      },
      note: "Nepali fiscal year Shrawan → Ashadh. Sales from posted invoice lines (amountIncludingVAT) minus credit memos.",
      totalSalesIncludingTax,
      totalVatAmount,
      totalSales: totalSalesIncludingTax,
      yearToDate: isCurrentFiscalYear
        ? {
            salesIncludingTax: yearToDateSales,
            sales: yearToDateSales,
            invoices: yearToDateInvoices,
            throughBsMonth: asOfBs?.monthName ?? null,
          }
        : null,
      topMonth,
      months: cleaned,
      _syncedAt: fromInvoices.syncedAt,
      _source: "posted_invoices",
    };
  }

  const payload = await loadLedger();
  if (payload.error) return { error: payload.error };
  const entries = payload.value ?? [];

  let latestInFy: Date | null = null;
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
    if (!latestInFy || date > latestInFy) latestInFy = date;
  }

  const cleaned = months.map((m) => ({
    ...m,
    salesIncludingTax: round(m.sales),
    salesExcludingTax: round(m.sales),
    vatAmount: 0,
  }));
  const topMonth = [...cleaned].sort(
    (a, b) => b.salesIncludingTax - a.salesIncludingTax,
  )[0];
  const totalSales = round(
    cleaned.reduce((sum, m) => sum + m.salesIncludingTax, 0),
  );

  const todayBs = toBs(new Date());
  const asOfBs = latestInFy ? toBs(latestInFy) : todayBs;
  const isCurrentFiscalYear =
    getCurrentFiscalYearStart() !== null &&
    startYear === getCurrentFiscalYearStart();

  let yearToDateSales = totalSales;
  let yearToDateInvoices = cleaned.reduce((sum, m) => sum + m.invoices, 0);
  if (isCurrentFiscalYear && asOfBs) {
    const asOfIndex = fiscalOrder.indexOf(asOfBs.month);
    yearToDateSales = round(
      cleaned
        .filter((m) => fiscalOrder.indexOf(m.monthIndex) <= asOfIndex)
        .reduce((sum, m) => sum + m.salesIncludingTax, 0),
    );
    yearToDateInvoices = cleaned
      .filter((m) => fiscalOrder.indexOf(m.monthIndex) <= asOfIndex)
      .reduce((sum, m) => sum + m.invoices, 0);
  }

  return {
    currency: "NPR",
    calendar: "Bikram Sambat",
    fiscalYear: fiscalYearLabel(startYear),
    isCurrentFiscalYear,
    asOf: {
      bs: asOfBs
        ? `${asOfBs.year}/${String(asOfBs.month + 1).padStart(2, "0")}/${String(asOfBs.date).padStart(2, "0")} (${asOfBs.monthName})`
        : null,
    },
    note: "Ledger fallback (salesLcy). Run sync for posted invoice lines with Incl. VAT.",
    totalSalesIncludingTax: totalSales,
    totalSales: totalSales,
    yearToDate: isCurrentFiscalYear
      ? {
          salesIncludingTax: yearToDateSales,
          sales: yearToDateSales,
          invoices: yearToDateInvoices,
          throughBsMonth: asOfBs?.monthName ?? null,
        }
      : null,
    topMonth,
    months: cleaned,
    _syncedAt: payload._syncedAt,
    _source: "customer_ledger",
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
        matchesProductTerms(
          [
            item.number,
            item.displayName,
            item.itemCategory,
            item.itemType,
          ]
            .filter(Boolean)
            .join(" "),
          term,
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
  customerNumber?: string;
};

type SalesOrderLine = {
  docNo?: string;
  itemNo?: string;
  quantity?: number;
  quantityInvoiced?: number;
  unitPrice?: number;
};

type PostedInvoiceLine = {
  documentNo?: string;
  itemNo?: string;
  quantity?: number;
  unitOfMeasureCode?: string;
  unitPrice?: number;
  lineAmount?: number;
  lineAmountExclVAT?: number;
  lineAmountInclVAT?: number;
  postingDate?: string;
  sellToCustomerNo?: string;
  itemCategoryCode?: string;
  accountabilityCenter?: string;
  salespersonCode?: string;
  description?: string;
};

type PostedCrMemoLine = PostedInvoiceLine & {
  returnReasonCode?: string;
};

/** Posted line amount incl. VAT (amountIncludingVAT). */
export function postedLineSalesIncl(line: {
  lineAmountInclVAT?: number;
  lineAmount?: number;
}): number {
  const incl = Number(line.lineAmountInclVAT ?? 0);
  if (incl !== 0) return incl;
  return Number(line.lineAmount ?? 0);
}

/** Posted net revenue excl. VAT (BC line.amount — after discount, matches ledger). */
export function postedLineSalesExcl(line: {
  lineAmount?: number;
  lineAmountInclVAT?: number;
  lineAmountExclVAT?: number;
}): number {
  const amount = Number(line.lineAmount ?? 0);
  if (amount !== 0) return amount;

  const incl = Number(line.lineAmountInclVAT ?? 0);
  if (incl === 0) return 0;

  const listExcl = Number(line.lineAmountExclVAT ?? 0);
  // Zero-VAT lines: amountIncludingVAT ≈ list lineAmountExclVAT
  if (listExcl > 0 && Math.abs(incl - listExcl) / listExcl < 0.02) {
    return incl;
  }

  // Legacy mirror rows synced before lineAmount was stored — approximate net excl @ 13% VAT
  return Math.round((incl / 1.13) * 100) / 100;
}

/** Bikram Sambat fiscal month order: Shrawan → Ashadh. */
export const NEPALI_FISCAL_MONTH_ORDER = [3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1, 2];

export function postedLineVat(line: {
  lineAmountInclVAT?: number;
  lineAmount?: number;
  lineAmountExclVAT?: number;
}): number {
  const incl = postedLineSalesIncl(line);
  const excl = postedLineSalesExcl(line);
  return Math.max(0, round(incl - excl));
}

export type NepaliFiscalMonthSlot = {
  month: string;
  monthIndex: number;
  bsYear: number;
  invoiceDocs: Set<string>;
  salesIncludingTax: number;
  salesExcludingTax: number;
  vatAmount: number;
};

export function buildNepaliFiscalMonthSlots(startYear: number): NepaliFiscalMonthSlot[] {
  return NEPALI_FISCAL_MONTH_ORDER.map((monthIndex) => ({
    month: BS_MONTHS[monthIndex],
    monthIndex,
    bsYear: monthIndex >= 3 ? startYear : startYear + 1,
    invoiceDocs: new Set<string>(),
    salesIncludingTax: 0,
    salesExcludingTax: 0,
    vatAmount: 0,
  }));
}

export function applyPostedLineToNepaliMonth(
  slots: NepaliFiscalMonthSlot[],
  line: {
    postingDate?: string;
    documentNo?: string;
    lineAmountInclVAT?: number;
    lineAmount?: number;
    lineAmountExclVAT?: number;
  },
  startYear: number,
  sign: 1 | -1 = 1,
): Date | null {
  const date = parseDate(line.postingDate);
  if (!date) return null;
  const fy = getNepaliFiscalYear(date);
  if (!fy || fy.startYear !== startYear) return null;
  const bs = toBs(date);
  if (!bs) return null;
  const slot = slots.find((m) => m.monthIndex === bs.month);
  if (!slot) return null;

  const incl = postedLineSalesIncl(line) * sign;
  const excl = postedLineSalesExcl(line) * sign;
  slot.salesIncludingTax += incl;
  slot.salesExcludingTax += excl;
  slot.vatAmount += postedLineVat(line) * sign;
  if (sign > 0 && line.documentNo) {
    slot.invoiceDocs.add(String(line.documentNo));
  }
  return date;
}

export function serializeNepaliMonthSlots(slots: NepaliFiscalMonthSlot[]) {
  return slots.map((m) => ({
    month: m.month,
    monthIndex: m.monthIndex,
    bsYear: m.bsYear,
    invoices: m.invoiceDocs.size,
    salesIncludingTax: round(m.salesIncludingTax),
    salesExcludingTax: round(m.salesExcludingTax),
    vatAmount: round(m.vatAmount),
    /** @deprecated use salesIncludingTax */
    sales: round(m.salesIncludingTax),
  }));
}

export async function aggregateNepaliFiscalYearFromPostedLines(
  startYear: number,
): Promise<{
  usePostedInvoices: boolean;
  slots: NepaliFiscalMonthSlot[];
  latestInFy: Date | null;
  syncedAt?: string;
}> {
  const posted = await loadPostedInvoiceLinePayloads();
  if (!posted.usePostedInvoices) {
    return { usePostedInvoices: false, slots: [], latestInFy: null };
  }

  const slots = buildNepaliFiscalMonthSlots(startYear);
  let latestInFy: Date | null = null;

  for (const line of posted.invoiceLines) {
    const date = applyPostedLineToNepaliMonth(slots, line, startYear, 1);
    if (date && (!latestInFy || date > latestInFy)) latestInFy = date;
  }
  for (const line of posted.crMemoLines) {
    const date = applyPostedLineToNepaliMonth(slots, line, startYear, -1);
    if (date && (!latestInFy || date > latestInFy)) latestInFy = date;
  }

  return {
    usePostedInvoices: true,
    slots,
    latestInFy,
    syncedAt: posted.syncedAt,
  };
}

export async function loadPostedInvoiceLinePayloads(): Promise<{
  usePostedInvoices: boolean;
  invoiceLines: PostedInvoiceLine[];
  crMemoLines: PostedCrMemoLine[];
  syncedAt?: string;
}> {
  const [invoiceLinesPayload, crMemoLinesPayload] = await Promise.all([
    getMirror("salesInvoiceLines") as Promise<
      MirrorPayload<PostedInvoiceLine>
    >,
    getMirror("salesCrMemoLines") as Promise<MirrorPayload<PostedCrMemoLine>>,
  ]);

  const usePostedInvoices =
    !invoiceLinesPayload.error &&
    Array.isArray(invoiceLinesPayload.value) &&
    invoiceLinesPayload.value.length > 0;

  return {
    usePostedInvoices,
    invoiceLines: invoiceLinesPayload.value ?? [],
    crMemoLines: crMemoLinesPayload.value ?? [],
    syncedAt:
      invoiceLinesPayload._syncedAt ?? crMemoLinesPayload._syncedAt,
  };
}

/**
 * Product-level posted sales from synced invoice lines (both companies), or,
 * as fallback, invoiced sales order lines.
 */
export async function getProductSales(
  input?: {
    query?: string;
    itemNumbers?: string[];
    /** Include only posted sales credit-memo lines and report returned values positively. */
    returnsOnly?: boolean;
  } & DatePeriodInput,
): Promise<unknown> {
  const periodResult = periodFromInput(input);
  if ("error" in periodResult) return periodResult;
  const { period } = periodResult;

  const [invoiceLinesPayload, crMemoLinesPayload, itemsPayload, uomIndex] =
    await Promise.all([
      getMirror("salesInvoiceLines") as Promise<
        MirrorPayload<PostedInvoiceLine>
      >,
      getMirror("salesCrMemoLines") as Promise<MirrorPayload<PostedCrMemoLine>>,
      getMirror("items") as Promise<MirrorPayload<Item>>,
      loadUomIndex(),
    ]);

  const usePostedInvoices =
    !invoiceLinesPayload.error &&
    Array.isArray(invoiceLinesPayload.value) &&
    invoiceLinesPayload.value.length > 0;

  let linesPayload: MirrorPayload<SalesOrderLine> = { value: [] };
  let ordersPayload: MirrorPayload<SalesOrder> = { value: [] };

  if (!usePostedInvoices) {
    [linesPayload, ordersPayload] = await Promise.all([
      getMirror("salesOrderLines") as Promise<MirrorPayload<SalesOrderLine>>,
      getMirror("salesOrders") as Promise<MirrorPayload<SalesOrder>>,
    ]);
    if (linesPayload.error) return { error: linesPayload.error };
    if (ordersPayload.error) return { error: ordersPayload.error };
  }

  const orderDates = new Map<string, string>();
  const orderCustomers = new Map<string, string>();
  for (const order of ordersPayload.value ?? []) {
    if (order.number && order.postingDate) {
      orderDates.set(order.number, order.postingDate);
      orderCustomers.set(order.number, String(order.customerNumber ?? ""));
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
    return matchesProductTerms(haystack, query);
  }

  const byItem = new Map<
    string,
    {
      itemNo: string;
      name: string;
      category: string;
      unitOfMeasureCode: string;
      quantityInvoiced: number;
      quantityInvoicedMT: number;
      salesExcludingTax: number;
      salesIncludingTax: number;
      lineCount: number;
      mtConvertible: boolean;
      customerPrices: Map<
        string,
        {
          quantity: number;
          quantityMT: number;
          salesIncl: number;
          salesExcl: number;
        }
      >;
    }
  >();

  let totalSales = 0;
  let totalSalesIncludingTax = 0;
  let totalQuantity = 0;
  let totalQuantityMT = 0;
  let matchedLines = 0;
  const customerPrices = new Map<
    string,
    {
      quantity: number;
      quantityMT: number;
      salesIncl: number;
      salesExcl: number;
    }
  >();
  let earliest: string | null = null;
  let latest: string | null = null;

  function addLine(inputLine: {
    itemNo: string;
    quantity: number;
    salesExcl: number;
    salesIncl: number;
    postingDate: string;
    customerNo?: string;
    unitOfMeasureCode?: string;
    category?: string;
  }): void {
    if (!inputLine.postingDate || !period.matches(inputLine.postingDate)) return;

    const meta = itemMeta.get(inputLine.itemNo);
    matchedLines += 1;
    totalSales += inputLine.salesExcl;
    totalSalesIncludingTax += inputLine.salesIncl;
    totalQuantity += inputLine.quantity;
    const mt = quantityToMetricTons(
      uomIndex,
      inputLine.itemNo,
      inputLine.quantity,
      inputLine.unitOfMeasureCode,
    );
    if (mt.metricTons != null) totalQuantityMT += mt.metricTons;
    if (!earliest || inputLine.postingDate < earliest) {
      earliest = inputLine.postingDate;
    }
    if (!latest || inputLine.postingDate > latest) {
      latest = inputLine.postingDate;
    }

    const agg =
      byItem.get(inputLine.itemNo) ??
      {
        itemNo: inputLine.itemNo,
        name: meta?.displayName ?? "",
        category: inputLine.category ?? meta?.itemCategory ?? "",
        unitOfMeasureCode:
          inputLine.unitOfMeasureCode ||
          uomIndex.salesUnit.get(inputLine.itemNo) ||
          "",
        quantityInvoiced: 0,
        quantityInvoicedMT: 0,
        salesExcludingTax: 0,
        salesIncludingTax: 0,
        lineCount: 0,
        mtConvertible: mt.convertible,
        customerPrices: new Map(),
      };
    agg.quantityInvoiced += inputLine.quantity;
    if (mt.metricTons != null) agg.quantityInvoicedMT += mt.metricTons;
    else agg.mtConvertible = false;
    agg.salesExcludingTax += inputLine.salesExcl;
    agg.salesIncludingTax += inputLine.salesIncl;
    agg.lineCount += 1;
    const customerKey = inputLine.customerNo?.trim() || "(unknown customer)";
    const customerAgg = agg.customerPrices.get(customerKey) ?? {
      quantity: 0,
      quantityMT: 0,
      salesIncl: 0,
      salesExcl: 0,
    };
    customerAgg.quantity += inputLine.quantity;
    if (mt.metricTons != null) customerAgg.quantityMT += mt.metricTons;
    customerAgg.salesIncl += inputLine.salesIncl;
    customerAgg.salesExcl += inputLine.salesExcl;
    agg.customerPrices.set(customerKey, customerAgg);

    const overallCustomer = customerPrices.get(customerKey) ?? {
      quantity: 0,
      quantityMT: 0,
      salesIncl: 0,
      salesExcl: 0,
    };
    overallCustomer.quantity += inputLine.quantity;
    if (mt.metricTons != null) overallCustomer.quantityMT += mt.metricTons;
    overallCustomer.salesIncl += inputLine.salesIncl;
    overallCustomer.salesExcl += inputLine.salesExcl;
    customerPrices.set(customerKey, overallCustomer);
    byItem.set(inputLine.itemNo, agg);
  }

  if (usePostedInvoices) {
    if (!input?.returnsOnly) for (const line of invoiceLinesPayload.value ?? []) {
      const itemNo = String(line.itemNo ?? "");
      const quantity = Number(line.quantity ?? 0);
      if (!itemNo || quantity <= 0 || !matchesItem(itemNo)) continue;

      const salesIncl = postedLineSalesIncl(line);
      const salesExcl = postedLineSalesExcl(line);

      addLine({
        itemNo,
        quantity,
        salesExcl,
        salesIncl,
        postingDate: String(line.postingDate ?? ""),
        customerNo: String(line.sellToCustomerNo ?? ""),
        unitOfMeasureCode: String(line.unitOfMeasureCode ?? ""),
        category: String(line.itemCategoryCode ?? ""),
      });
    }

    for (const line of crMemoLinesPayload.value ?? []) {
      const itemNo = String(line.itemNo ?? "");
      const quantity = Number(line.quantity ?? 0);
      if (!itemNo || quantity <= 0 || !matchesItem(itemNo)) continue;

      const direction = input?.returnsOnly ? 1 : -1;
      const salesIncl = direction * Math.abs(postedLineSalesIncl(line));
      const salesExcl = direction * Math.abs(postedLineSalesExcl(line));

      addLine({
        itemNo,
        quantity: direction * quantity,
        salesExcl,
        salesIncl,
        postingDate: String(line.postingDate ?? ""),
        customerNo: String(line.sellToCustomerNo ?? ""),
        unitOfMeasureCode: String(line.unitOfMeasureCode ?? ""),
      });
    }
  } else {
    for (const line of linesPayload.value ?? []) {
      const qtyInvoiced = Number(line.quantityInvoiced ?? 0);
      if (qtyInvoiced <= 0) continue;

      const itemNo = String(line.itemNo ?? "");
      if (!itemNo || !matchesItem(itemNo)) continue;

      const salesExcl = qtyInvoiced * Number(line.unitPrice ?? 0);
      addLine({
        itemNo,
        quantity: qtyInvoiced,
        salesExcl,
        salesIncl: salesExcl,
        postingDate: orderDates.get(String(line.docNo ?? "")) ?? "",
        customerNo: orderCustomers.get(String(line.docNo ?? "")) ?? "",
      });
    }
  }

  const items = [...byItem.values()]
    .map((row) => {
      const customerUnitIncl = averageCustomerSellingPrice(
        [...row.customerPrices.values()].map((price) => ({
          amount: price.salesIncl,
          quantity: price.quantity,
        })),
      );
      const customerUnitExcl = averageCustomerSellingPrice(
        [...row.customerPrices.values()].map((price) => ({
          amount: price.salesExcl,
          quantity: price.quantity,
        })),
      );
      const customerMtIncl = averageCustomerSellingPrice(
        [...row.customerPrices.values()].map((price) => ({
          amount: price.salesIncl,
          quantity: price.quantityMT,
        })),
      );
      const customerMtExcl = averageCustomerSellingPrice(
        [...row.customerPrices.values()].map((price) => ({
          amount: price.salesExcl,
          quantity: price.quantityMT,
        })),
      );
      return {
      itemNo: row.itemNo,
      name: row.name,
      category: row.category,
      unitOfMeasureCode: row.unitOfMeasureCode,
      quantityInvoiced: round(row.quantityInvoiced),
      quantityInvoicedMT: row.mtConvertible
        ? round(row.quantityInvoicedMT)
        : null,
      salesIncludingTax: round(row.salesIncludingTax),
      salesExcludingTax: round(row.salesExcludingTax),
      averageUnitPriceInclTax:
        customerUnitIncl.average == null ? 0 : round(customerUnitIncl.average),
      averageUnitPrice:
        customerUnitExcl.average == null ? 0 : round(customerUnitExcl.average),
      averagePricePerMTInclTax:
        customerMtIncl.average == null ? null : round(customerMtIncl.average),
      averagePricePerMT:
        customerMtExcl.average == null ? null : round(customerMtExcl.average),
      averageSellingPriceCustomerCount: customerMtIncl.customerCount,
      weightedAveragePricePerMTInclTax:
        row.mtConvertible && row.quantityInvoicedMT > 0
          ? round(row.salesIncludingTax / row.quantityInvoicedMT)
          : null,
      lineCount: row.lineCount,
      };
    })
    .sort((a, b) => b.salesIncludingTax - a.salesIncludingTax);

  const overallUnitIncl = averageCustomerSellingPrice(
    [...customerPrices.values()].map((price) => ({
      amount: price.salesIncl,
      quantity: price.quantity,
    })),
  );
  const overallUnitExcl = averageCustomerSellingPrice(
    [...customerPrices.values()].map((price) => ({
      amount: price.salesExcl,
      quantity: price.quantity,
    })),
  );
  const overallMtIncl = averageCustomerSellingPrice(
    [...customerPrices.values()].map((price) => ({
      amount: price.salesIncl,
      quantity: price.quantityMT,
    })),
  );
  const overallMtExcl = averageCustomerSellingPrice(
    [...customerPrices.values()].map((price) => ({
      amount: price.salesExcl,
      quantity: price.quantityMT,
    })),
  );

  return {
    currency: "NPR",
    transactionType: input?.returnsOnly ? "sales_returns" : "net_sales",
    query: query || null,
    period: period.label,
    isAllTime: period.label === "all synced history",
    periodWarning:
      period.label === "all synced history"
        ? "Explicit all-time scope: totals include all synced history."
        : null,
    itemNumbers: explicitItems.length ? explicitItems : null,
    quantityUnit: "MT",
    displayNote:
      'List EVERY item in items (full table) — never top 10 only. Primary quantity is metric tons. averagePricePerMTInclTax is the equal-customer mean: calculate each customer’s sales÷MT rate, then average those customer rates so large buyers do not dominate.',
    itemCount: items.length,
    basis: usePostedInvoices
      ? "Posted sales invoice lines: Incl. VAT = amountIncludingVAT; net excl. VAT (on request) = line.amount. Never use lineAmountExclVAT (pre-discount list price)."
      : "Invoiced sales order lines (quantityInvoiced × unitPrice), joined to sales order posting dates. VAT-inclusive amount not available on this fallback.",
    dataCoverage: {
      from: earliest,
      to: latest,
      note: usePostedInvoices
        ? "Uses synced salesInvoiceHeaders/salesCrMemos expand lines from BC custom API."
        : "Sales order line sync typically starts mid-2024. Run sync on Choco Delight for posted invoice lines.",
    },
    totalSalesIncludingTax: round(totalSalesIncludingTax),
    totalSalesExcludingTax: round(totalSales),
    totalQuantityInvoiced: round(totalQuantity),
    totalQuantityInvoicedMT: round(totalQuantityMT),
    averageUnitPriceInclTax:
      overallUnitIncl.average == null ? 0 : round(overallUnitIncl.average),
    averageUnitPrice:
      overallUnitExcl.average == null ? 0 : round(overallUnitExcl.average),
    averagePricePerMTInclTax:
      overallMtIncl.average == null ? null : round(overallMtIncl.average),
    averagePricePerMT:
      overallMtExcl.average == null ? null : round(overallMtExcl.average),
    averageSellingPriceCustomerCount: overallMtIncl.customerCount,
    weightedAveragePricePerMTInclTax:
      totalQuantityMT > 0
        ? round(totalSalesIncludingTax / totalQuantityMT)
        : null,
    matchedLineCount: matchedLines,
    items,
    _syncedAt:
      invoiceLinesPayload._syncedAt ??
      crMemoLinesPayload._syncedAt ??
      linesPayload._syncedAt ??
      ordersPayload._syncedAt ??
      itemsPayload._syncedAt,
  };
}
