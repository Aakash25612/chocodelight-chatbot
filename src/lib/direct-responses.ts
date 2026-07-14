import { formatAmount, formatNumber } from "./format";
import {
  getProductSales,
  getReceivablesAging,
  getNepaliMonthlySales,
  searchCustomers,
} from "./analytics";
import { loadCustomersPayload } from "./derived-customers";
import {
  getSalesByBranch,
  getBranchWiseSales,
  getPendingSauda,
  getChequeInHand,
  getCustomerSales,
  getTopCustomers,
  getCollectionMetrics,
  getOutstandingReceivables,
} from "./analytics-queries";
import { formatMetricTons } from "./uom-convert";
import {
  cleanProductQueryFragment,
  looksLikeProductQuery,
} from "./product-query";
import { resolveBranch } from "./branches";
import { getCompany, normalizeCompanyKey } from "./companies";
import { runWithCompany, getActiveCompany } from "./company-context";
import { getMirror } from "./bc-mirror";
import {
  formatBsDate,
  getCurrentFiscalYearStart,
  fiscalYearLabel,
} from "./nepali-date";
import { planQuery } from "./query-intent";
import {
  explicitlyRequestsAllTime,
  extractMessagePeriod,
} from "./tool-policy";
import type { DatePeriodInput } from "./date-period";

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
  const plan = planQuery(message);

  return runWithCompany(normalizeCompanyKey(company), async () => {
    if (isListAllCustomers(normalized)) {
      return listAllCustomers();
    }

    if (plan.path === "deterministic" && plan.intent === "pending_sauda") {
      return formatPendingSauda(message);
    }

    if (plan.path === "deterministic" && plan.intent === "cheque_in_hand") {
      return formatChequeInHand(message);
    }

    if (plan.path === "deterministic" && plan.intent === "top_customer_sales") {
      return formatTopCustomerSales(message);
    }

    if (
      plan.path === "deterministic" &&
      plan.intent === "company_sales" &&
      plan.tool === "get_nepali_monthly_sales"
    ) {
      return formatCompanyFiscalYearSales(message);
    }

    if (plan.path === "deterministic" && plan.intent === "customer_sales") {
      const customerSales = await formatCustomerSalesIfMatched(message);
      if (customerSales) return customerSales;
    }

    if (
      plan.path === "deterministic" &&
      (plan.intent === "product_sales" || plan.intent === "product_returns")
    ) {
      return formatProductSalesList(message);
    }

    if (plan.path === "deterministic" && plan.intent === "receivables") {
      return formatReceivablesResponse(message, normalized);
    }

    if (plan.path === "deterministic" && plan.intent === "collection_metrics") {
      return formatCollectionMetrics(message, plan.args.query as string | undefined);
    }

    if (plan.path === "deterministic" && plan.intent === "branch_sales") {
      const branchCode = String(plan.args.branchCode ?? "");
      return formatBranchSales(branchCode, message);
    }

    if (plan.path === "deterministic" && plan.intent === "branch_wise_sales") {
      return formatBranchWiseSales();
    }

    return null;
  });
}

function extractBranchFromMessage(message: string): string | null {
  const normalized = message.trim().toLowerCase();
  if (isReceivablesQuery(normalized)) return null;
  if (isChequeInHandQuery(normalized)) return null;
  if (isPendingSaudaQuery(normalized)) return null;

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

function isChequeInHandQuery(message: string): boolean {
  return (
    /\bcheque\s+in\s+hand\b/.test(message) ||
    /\bcheck\s+in\s+hand\b/.test(message) ||
    /\bcheques?\s+in\s+hand\b/.test(message) ||
    (/\bcheques?\b/.test(message) &&
      /\b(received|not\s+deposit|undeposited|in\s+hand)\b/.test(message)) ||
    /\bcheque\s+received\b/.test(message)
  );
}

async function formatChequeInHand(message: string): Promise<string> {
  const branchFromCode = extractBranchCodeQuery(message);
  const branchResolved = branchFromCode
    ? resolveBranch({ branchCode: branchFromCode })
    : resolveBranch({ query: message });
  const branchCode =
    !("error" in branchResolved) &&
    (branchFromCode ||
      /\b(branch|depo(?:t)?|balkot|bhairahawa|butwal|pokhara|nepalgunj|birgunj)\b/i.test(
        message,
      ))
      ? branchResolved.code
      : undefined;

  let customerQuery: string | undefined;
  if (!branchCode) {
    customerQuery =
      message
        .replace(/\b(show|tell|give|get|list|check|what(?:'s| is)?|the|total|please|pls)\b/gi, " ")
        .replace(
          /\b(cheque|check|cheques|in\s+hand|received|not\s+deposited|undeposited|status|value|amount|of|for|from)\b/gi,
          " ",
        )
        .replace(/\s+/g, " ")
        .trim() || undefined;
    if (customerQuery && customerQuery.length < 2) customerQuery = undefined;
  }

  const data = (await getChequeInHand({
    branchCode,
    query: customerQuery,
    limit: 50,
    ...periodArgsFromProductSalesMessage(message),
  })) as {
    error?: string;
    candidates?: Array<{ customerNo?: string; name?: string }>;
    filter?: {
      customerNo?: string | null;
      customerName?: string | null;
      branchCode?: string | null;
      branchName?: string | null;
      status?: string | null;
      period?: string;
    };
    matchCount?: number;
    totalAmount?: number;
    topCustomers?: Array<{
      customerNo: string;
      customerName: string;
      amount: number;
      count: number;
    }>;
    records?: Array<{
      mrNo?: number;
      customerName?: string;
      amount: number;
      chequeNo?: string;
      drawnBank?: string;
      receivedDate?: string;
      dueDate?: string;
      status?: string;
    }>;
    displayNote?: string;
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
  const who =
    data.filter?.branchName ||
    data.filter?.branchCode ||
    data.filter?.customerName ||
    data.filter?.customerNo ||
    "all";
  const title = `**Cheque in hand — ${who}**`;

  if ((data.matchCount ?? 0) === 0) {
    return [
      `${title} — ${companyLabel}${formatSync(data._syncedAt)}`,
      "",
      'No MR rows with status **Cheque Received** (received, not deposited) for this filter.',
    ].join("\n");
  }

  const lines = [
    `${title} — ${companyLabel}${formatSync(data._syncedAt)}`,
    "",
    `Period: **${data.filter?.period ?? `Nepali FY ${fiscalYearLabel(getCurrentFiscalYearStart() ?? 0)}`}**`,
    `Status: **Cheque Received** (not deposited / not cleared)`,
    `**Total cheque in hand: ${formatAmount(data.totalAmount ?? 0)}** · **${data.matchCount ?? 0} cheque(s)**`,
    "",
  ];

  if (data.filter?.branchCode) {
    lines.push(
      `_Branch filter uses each customer's primary sales depot from posted invoices (MR has no depot field)._`,
      "",
    );
  }

  if (data.topCustomers?.length && !data.filter?.customerNo) {
    lines.push(
      "### By customer",
      "",
      "| Customer | Cheques | Amount (NPR) |",
      "|---|---:|---:|",
      ...data.topCustomers.slice(0, 15).map(
        (row) =>
          `| ${escapeCell(row.customerName || row.customerNo)} | ${row.count} | ${formatAmount(row.amount)} |`,
      ),
      "",
    );
  }

  if (data.records?.length) {
    lines.push(
      "### Cheques",
      "",
      "| MR | Customer | Received | Due | Cheque No | Bank | Amount |",
      "|---|---|---|---|---|---|---:|",
      ...data.records.slice(0, 40).map(
        (row) =>
          `| ${row.mrNo ?? ""} | ${escapeCell(row.customerName ?? "")} | ${formatBsDate(row.receivedDate)} | ${formatBsDate(row.dueDate)} | ${escapeCell(row.chequeNo ?? "")} | ${escapeCell(row.drawnBank ?? "")} | ${formatAmount(row.amount)} |`,
      ),
    );
  }

  return lines.join("\n");
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

/** Pull customer / product filters from pending-sauda questions. */
function parseSaudaMessage(message: string): {
  customerQuery: string | null;
  productQuery: string | null;
  wantsAveragePrice: boolean;
} {
  const wantsAveragePrice =
    /\b(average|avg)\s+(unit\s+)?price\b/i.test(message) ||
    /\bprice\s+(in|for|of)\b/i.test(message);

  const cleaned = cleanProductQueryFragment(message);
  if (!cleaned || cleaned.length < 2) {
    return { customerQuery: null, productQuery: null, wantsAveragePrice };
  }
  if (/^(all|every|total|company|customers?)$/i.test(cleaned)) {
    return { customerQuery: null, productQuery: null, wantsAveragePrice };
  }

  if (looksLikeProductQuery(cleaned) || wantsAveragePrice) {
    return {
      customerQuery: null,
      productQuery: cleaned,
      wantsAveragePrice,
    };
  }

  return {
    customerQuery: cleaned,
    productQuery: null,
    wantsAveragePrice,
  };
}

async function formatPendingSauda(message: string): Promise<string> {
  const { customerQuery, productQuery, wantsAveragePrice } =
    parseSaudaMessage(message);
  const branch = !customerQuery
    ? resolveBranch({ query: message })
    : resolveBranch({ query: customerQuery });
  const branchCode =
    !customerQuery && !("error" in branch) ? branch.code : undefined;
  const useBranch =
    !customerQuery && !productQuery && branchCode
      ? { branchCode }
      : customerQuery
        ? { query: customerQuery }
        : branchCode && !productQuery
          ? { branchCode }
          : {};

  const data = (await getPendingSauda({
    ...useBranch,
    productQuery: productQuery || undefined,
    limit: 40,
    ...periodArgsFromProductSalesMessage(message),
  })) as {
    error?: string;
    period?: string;
    candidates?: Array<{ customerNo?: string; name?: string }>;
    filter?: {
      customerNo?: string | null;
      customerName?: string | null;
      branchCode?: string | null;
      productQuery?: string | null;
    };
    summary?: {
      ordersWithPending?: number;
      pendingLineCount?: number;
      totalPendingQuantity?: number;
      totalPendingQuantityMT?: number;
      totalPendingAmount?: number;
      skippedNonWeightLines?: number;
      averageUnitPrice?: number | null;
      averagePricePerMT?: number | null;
      averageSellingPriceCustomerCount?: number;
    };
    topItems?: Array<{
      itemNo: string;
      itemName: string;
      pendingQuantity: number;
      pendingQuantityMT?: number | null;
      pendingAmount: number;
      averageUnitPrice?: number | null;
      averagePricePerMT?: number | null;
      averageSellingPriceCustomerCount?: number;
    }>;
    topCustomers?: Array<{
      customerNo: string;
      customerName: string;
      pendingQuantity: number;
      pendingQuantityMT?: number;
      pendingAmount: number;
      orderCount: number;
    }>;
    lines?: Array<{
      orderNo: string;
      postingDate?: string;
      customerName: string;
      itemName: string;
      itemNo: string;
      salesUnit?: string;
      pendingQuantity: number;
      pendingQuantityMT?: number | null;
      quantity: number;
      quantityMT?: number | null;
      quantityShipped: number;
      quantityShippedMT?: number | null;
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
    const activeCompany = getCompany(getActiveCompany()).displayName;
    return [
      data.error,
      "",
      `Active company: **${activeCompany}**. Pending Sauda only searches Locked sales orders here — switch company in the dropdown if this party is under the other company.`,
    ].join("\n");
  }

  const companyLabel = getCompany(getActiveCompany()).displayName;
  const s = data.summary ?? {};
  const who =
    data.filter?.productQuery
      ? `product "${data.filter.productQuery}"`
      : data.filter?.customerName ||
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
    `Period: **${data.period ?? `Nepali FY ${fiscalYearLabel(getCurrentFiscalYearStart() ?? 0)}`}**`,
  ];

  if (wantsAveragePrice || productQuery) {
    lines.push(
      `**Equal-customer average price: ${formatAmount(s.averageUnitPrice ?? 0)} / order UOM** · **${formatAmount(s.averagePricePerMT ?? 0)} / MT**`,
      `_Each of ${s.averageSellingPriceCustomerCount ?? 0} customer(s) receives equal weight, regardless of quantity purchased._`,
      `**Pending qty: ${formatMetricTons(s.totalPendingQuantityMT)} MT** · **Pending amount: ${formatAmount(s.totalPendingAmount ?? 0)}**`,
      "",
    );
  } else {
    lines.push(
      `**Pending quantity: ${formatMetricTons(s.totalPendingQuantityMT)} MT** · **Pending amount: ${formatAmount(s.totalPendingAmount ?? 0)}**`,
      "",
    );
  }

  lines.push(
    "| Metric | Value |",
    "|---|---:|",
    `| Orders with pending qty | ${s.ordersWithPending ?? 0} |`,
    `| Pending lines | ${s.pendingLineCount ?? 0} |`,
    `| Total pending quantity | **${formatMetricTons(s.totalPendingQuantityMT)} MT** |`,
    `| Total pending amount | **${formatAmount(s.totalPendingAmount ?? 0)}** |`,
  );

  if (s.averageUnitPrice != null || s.averagePricePerMT != null) {
    lines.push(
      `| Equal-customer avg unit price (order UOM) | **${formatAmount(s.averageUnitPrice ?? 0)}** |`,
      `| Equal-customer avg price per MT | **${formatAmount(s.averagePricePerMT ?? 0)}** |`,
    );
  }

  lines.push(
    "",
    "Quantities are in **metric tons (MT)** — converted from item UOM → KG ÷ 1,000 (e.g. BAG/PKT/POUCH/QNT).",
    "Rule: `orderStatus = Locked` and `quantity − quantityShipped > 0`. Amount = pending qty × unit price.",
    "This is **not** customer outstanding / receivable balance.",
  );

  if (s.skippedNonWeightLines) {
    lines.push(
      "",
      `_Note: ${s.skippedNonWeightLines} non-weight line(s) (PCS/SET/MTR etc.) could not be converted to MT and are excluded from the MT total._`,
    );
  }

  if (data.topItems?.length) {
    lines.push(
      "",
      "### Top items",
      "",
      "| Item | Pending (MT) | Amount (NPR) | Equal-customer avg / MT |",
      "|---|---:|---:|---:|",
      ...data.topItems.slice(0, 20).map(
        (row) =>
          `| ${escapeCell(row.itemName || row.itemNo)} | ${formatMetricTons(row.pendingQuantityMT)} | ${formatAmount(row.pendingAmount)} | ${formatAmount(row.averagePricePerMT ?? 0)} |`,
      ),
    );
  }

  if (!data.filter?.customerNo && !productQuery && data.topCustomers?.length) {
    lines.push(
      "",
      "### Top customers",
      "",
      "| Customer | Orders | Pending (MT) | Amount (NPR) |",
      "|---|---:|---:|---:|",
      ...data.topCustomers.slice(0, 10).map(
        (row) =>
          `| ${escapeCell(row.customerName || row.customerNo)} | ${row.orderCount} | ${formatMetricTons(row.pendingQuantityMT)} | ${formatAmount(row.pendingAmount)} |`,
      ),
    );
  }

  if (data.lines?.length) {
    lines.push(
      "",
      "### Detail lines",
      "",
      "| Order | Date | Customer | Item | Ordered (MT) | Shipped (MT) | Pending (MT) | Unit price | Amount |",
      "|---|---|---|---|---:|---:|---:|---:|---:|",
      ...data.lines.slice(0, 25).map(
        (row) =>
          `| ${escapeCell(row.orderNo)} | ${formatBsDate(row.postingDate)} | ${escapeCell(row.customerName)} | ${escapeCell(row.itemName || row.itemNo)} | ${formatMetricTons(row.quantityMT)} | ${formatMetricTons(row.quantityShippedMT)} | ${formatMetricTons(row.pendingQuantityMT)} | ${formatAmount(row.unitPrice ?? 0)} | ${formatAmount(row.pendingAmount)} |`,
      ),
    );
  }

  return lines.join("\n");
}

function isTopCustomerSalesQuery(message: string): boolean {
  return (
    /\b(customer|customers|party|parties)\b/.test(message) &&
    /\b(sale|sales|revenue|turnover)\b/.test(message) &&
    /\b(top|first|highest|largest|most|amount\s*wise|amount-wise|rank)\b/.test(
      message,
    )
  );
}

function extractRankingLimit(message: string, fallback = 5): number {
  const match = message.match(
    /\b(?:top|first|highest|largest)\s*(\d{1,2})\b/i,
  );
  const limit = match ? Number(match[1]) : fallback;
  return Math.max(1, Math.min(Number.isFinite(limit) ? limit : fallback, 50));
}

async function formatTopCustomerSales(message: string): Promise<string> {
  const limit = extractRankingLimit(message);
  const periodArgs = periodArgsFromProductSalesMessage(message);
  const data = (await getTopCustomers({
    limit,
    rankBy: "invoice_sales",
    ...periodArgs,
  })) as {
    error?: string;
    period?: {
      label?: string;
      fiscalYear?: string | null;
      year?: number | string;
      month?: number | null;
      monthName?: string | null;
    };
    customers?: Array<{
      customerNo: string;
      name: string;
      salesIncludingTax: number;
      invoiceCount: number;
    }>;
    _syncedAt?: string;
  };

  if (data.error) return data.error;

  const companyLabel = getCompany(getActiveCompany()).displayName;
  const period = data.period?.label
    ? data.period.label
    : data.period?.fiscalYear
    ? `Nepali FY ${data.period.fiscalYear}`
    : data.period?.monthName && data.period?.year
      ? `${data.period.monthName} ${data.period.year}`
      : explicitlyRequestsAllTime(message)
        ? "all synced history"
        : `Nepali FY ${fiscalYearLabel(getCurrentFiscalYearStart() ?? 0)}`;
  const customers = data.customers ?? [];

  if (customers.length === 0) {
    return `No posted customer invoice sales found for ${period}.`;
  }

  return [
    `**Top ${customers.length} customers by total sales** — ${companyLabel}${formatSync(data._syncedAt)}`,
    "",
    `Period: **${period}** · Amount basis: **Incl. VAT**`,
    "",
    "| Rank | Customer | Sales (NPR) | Invoices |",
    "|---:|---|---:|---:|",
    ...customers.map(
      (row, index) =>
        `| ${index + 1} | ${escapeCell(row.name || row.customerNo)} | ${formatAmount(row.salesIncludingTax)} | ${row.invoiceCount} |`,
    ),
  ].join("\n");
}

/** Company-wide FY / YTD / this year sales — not a product keyword. */
function isCompanyFiscalYearSalesQuery(message: string): boolean {
  if (!/\b(sale|sales|revenue|turnover)\b/.test(message)) return false;
  if (isPendingSaudaQuery(message) || isReceivablesQuery(message)) return false;
  if (isChequeInHandQuery(message)) return false;
  if (extractBranchCodeQuery(message)) return false;
  if (
    /\b(branch|depot|area\s*wise|region\s*wise|salesperson|salesman)\b/.test(
      message,
    )
  ) {
    return false;
  }
  // Has a real product keyword → product sales, not company FY total
  const productish = extractProductQueryFromSalesMessage(message);
  if (productish && looksLikeProductQuery(productish)) return false;
  if (productish && !isFiscalYearOnlyFragment(productish)) return false;

  return (
    /\b(this|current)\s+(fiscal\s+)?year\b/.test(message) ||
    /\bfiscal\s+year\b/.test(message) ||
    /\bytd\b/.test(message) ||
    /\byear\s+to\s+date\b/.test(message) ||
    /\btotal\s+(sale|sales|revenue)\b/.test(message) ||
    /\b(sale|sales|revenue)\s+(so\s+far|till\s+date|to\s+date)\b/.test(message)
  );
}

function isFiscalYearOnlyFragment(text: string): boolean {
  const t = text.trim().toLowerCase();
  return (
    !t ||
    /^(this|current|fiscal|year|fy|ytd|total)?(\s+(this|current|fiscal|year|fy|ytd|total))*$/i.test(
      t,
    ) ||
    /^(fy\s*)?\d{4}(\s*\/\s*\d{2,4})?$/.test(t)
  );
}

async function formatCompanyFiscalYearSales(message: string): Promise<string> {
  const periodArgs = periodArgsFromProductSalesMessage(message);
  const fyStart =
    periodArgs.fiscalYearStart ?? getCurrentFiscalYearStart() ?? undefined;
  const data = (await getNepaliMonthlySales(fyStart)) as {
    error?: string;
    fiscalYear?: string;
    isCurrentFiscalYear?: boolean;
    totalSalesIncludingTax?: number;
    yearToDate?: {
      salesIncludingTax?: number;
      invoices?: number;
      throughBsMonth?: string | null;
    } | null;
    months?: Array<{
      month: string;
      bsYear: number;
      salesIncludingTax: number;
      invoices: number;
    }>;
    asOf?: { ad?: string; bs?: string | null };
    note?: string;
    _syncedAt?: string;
  };

  if (data.error) return data.error;

  const companyLabel = getCompany(getActiveCompany()).displayName;
  const fyLabel = data.fiscalYear ?? fiscalYearLabel(fyStart ?? 0);
  const ytd = data.yearToDate;
  const showYtd = Boolean(data.isCurrentFiscalYear && ytd);
  const headline = showYtd
    ? ytd?.salesIncludingTax
    : data.totalSalesIncludingTax;

  const lines = [
    `**Total sales — Nepali FY ${fyLabel}** — ${companyLabel}${formatSync(data._syncedAt)}`,
    "",
    showYtd
      ? `**Year to date (Incl. VAT): ${formatAmount(headline ?? 0)}**${ytd?.throughBsMonth ? ` · through ${ytd.throughBsMonth}` : ""} · **${ytd?.invoices ?? 0} invoices**`
      : `**FY total (Incl. VAT): ${formatAmount(headline ?? 0)}**`,
    "",
  ];

  if (showYtd && data.totalSalesIncludingTax != null) {
    lines.push(
      `Full FY synced so far (Incl. VAT): **${formatAmount(data.totalSalesIncludingTax)}**`,
      "",
    );
  }

  if (data.asOf?.bs || data.asOf?.ad) {
    lines.push(
      `As of: ${data.asOf.bs ?? formatBsDate(data.asOf.ad)}`,
      "",
    );
  }

  if (data.months?.length) {
    lines.push(
      "### Month-wise (Bikram Sambat)",
      "",
      "| Month | BS Year | Sales Incl. VAT (NPR) | Invoices |",
      "|---|---:|---:|---:|",
      ...data.months.map(
        (row) =>
          `| ${row.month} | ${row.bsYear} | ${formatAmount(row.salesIncludingTax)} | ${row.invoices} |`,
      ),
    );
  }

  if (data.note) {
    lines.push("", `_${data.note}_`);
  }

  return lines.join("\n");
}

function extractCustomerFromSalesMessage(message: string): string | null {
  if (!/\b(sale|sales|revenue|turnover)\b/i.test(message)) return null;
  if (
    /\b(branch|depot|area\s*wise|region\s*wise|salesperson|salesman)\b/i.test(
      message,
    ) ||
    extractBranchCodeQuery(message)
  ) {
    return null;
  }

  const match =
    message.match(
      /\b(?:total\s+)?(?:sale|sales|revenue|turnover)\s+(?:of|for|from)\s+(.+)$/i,
    ) ??
    message.match(
      /^(.+?)\s+(?:total\s+)?(?:sale|sales|revenue|turnover)(?:\s+this\s+(?:fiscal\s+)?year)?$/i,
    );
  if (!match?.[1]) return null;

  const cleaned = match[1]
    .replace(
      /\b(this\s+fiscal\s+year|current\s+fiscal\s+year|this\s+year|current\s+year|ytd|year\s+to\s+date)\b/gi,
      " ",
    )
    .replace(/[?!.,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!cleaned || isFiscalYearOnlyFragment(cleaned)) return null;
  return cleaned;
}

async function formatCustomerSalesIfMatched(
  message: string,
): Promise<string | null> {
  const query = extractCustomerFromSalesMessage(message);
  if (!query) return null;

  const search = (await searchCustomers(query)) as {
    matchCount?: number;
    customers?: Array<{
      customerNo: string;
      name: string;
      matchScore?: number;
    }>;
  };
  const matches = search.customers ?? [];
  if (matches.length !== 1) return null;

  const customer = matches[0];
  const periodArgs = periodArgsFromProductSalesMessage(message);
  const data = (await getCustomerSales({
    customerNo: customer.customerNo,
    ...periodArgs,
  })) as {
    error?: string;
    name?: string;
    customerNo?: string;
    period?: {
      label?: string;
      fiscalYear?: string | null;
      year?: number | string;
      month?: number | null;
    };
    totalSalesIncludingTax?: number;
    invoiceCount?: number;
    byNepaliMonth?: Array<{
      bsMonth: string;
      bsYear: number;
      salesIncludingTax?: number;
      invoices: number;
    }>;
    _syncedAt?: string;
  };

  if (data.error) return data.error;

  const companyLabel = getCompany(getActiveCompany()).displayName;
  const period =
    data.period?.label ??
    (data.period?.fiscalYear
      ? `Nepali FY ${data.period.fiscalYear}`
      : explicitlyRequestsAllTime(message)
        ? "all synced history"
        : `Nepali FY ${fiscalYearLabel(getCurrentFiscalYearStart() ?? 0)}`);
  const lines = [
    `**${data.name ?? customer.name} — total sales** — ${companyLabel}${formatSync(data._syncedAt)}`,
    "",
    `Period: **${period}**`,
    `**Sales (Incl. VAT): ${formatAmount(data.totalSalesIncludingTax ?? 0)}** · **${data.invoiceCount ?? 0} invoices**`,
  ];

  if (data.byNepaliMonth?.length) {
    lines.push(
      "",
      "### Month-wise (Bikram Sambat)",
      "",
      "| Month | BS Year | Sales Incl. VAT (NPR) | Invoices |",
      "|---|---:|---:|---:|",
      ...data.byNepaliMonth.map(
        (row) =>
          `| ${row.bsMonth} | ${row.bsYear} | ${formatAmount(row.salesIncludingTax ?? 0)} | ${row.invoices} |`,
      ),
    );
  }

  return lines.join("\n");
}

/** Product keyword sales listing — e.g. "mustard sale all items", "dip sales". */
function isProductSalesListQuery(message: string): boolean {
  if (!/\b(sale|sales)\b/.test(message)) return false;
  if (isPendingSaudaQuery(message) || isReceivablesQuery(message)) return false;
  if (isChequeInHandQuery(message)) return false;
  if (isCompanyFiscalYearSalesQuery(message)) return false;
  if (
    /\b(branch|depot|area\s*wise|region\s*wise|salesperson|salesman|customer\s+sales)\b/.test(
      message,
    )
  ) {
    return false;
  }
  if (/\b(month\s*wise|month-by-month|by\s+month)\b/.test(message)) return false;
  if (extractBranchCodeQuery(message)) return false;

  const wantsItemList =
    /\ball\s+items?\b/.test(message) ||
    /\bevery\s+item\b/.test(message) ||
    /\bitem[- ]?wise\b/.test(message) ||
    /\bby\s+item\b/.test(message) ||
    /\b(sale|sales)\s+of\s+\w+/.test(message) ||
    /\b\w[\w\s/-]{1,40}\s+(sale|sales)\b/.test(message);

  const productQuery = extractProductQueryFromSalesMessage(message);
  if (!productQuery || isFiscalYearOnlyFragment(productQuery)) return false;

  return wantsItemList;
}

function extractProductQueryFromSalesMessage(message: string): string | null {
  const text = message
    .replace(
      /\b(tell|show|give|get|list|check|what(?:'s| is)?|the|total|please|pls)\b/gi,
      " ",
    )
    .replace(/\b(?:average|avg)\s+(?:selling\s+|unit\s+)?price\b/gi, " ")
    .replace(/\b(?:selling\s+|unit\s+)?price\b/gi, " ")
    .replace(/\ball\s+items?\b/gi, " ")
    .replace(/\bevery\s+item\b/gi, " ")
    .replace(/\bitem[- ]?wise\b/gi, " ")
    .replace(/\bby\s+item\b/gi, " ")
    .replace(/\b(sales?\s+returns?|returns?|credit\s+memos?)\b/gi, " ")
    .replace(
      /\b(sale|sales|sold|invoiced|amount|value|revenue|products?|items?)\b/gi,
      " ",
    )
    .replace(
      /\b(in\s+)?(metric\s+tons?|metric\s+tonnes?|mts?|tonnes?|tons?|kgs?|kilograms?)\b/gi,
      " ",
    )
    .replace(/\b(of|for|from|about|including|incl\.?|excl\.?|tax|vat|npr)\b/gi, " ")
    .replace(
      /\b(this\s+year|last\s+year|this\s+fiscal\s+year|current\s+fiscal\s+year|current\s+fy|fiscal\s+year|ytd|year\s+to\s+date|all\s+time|all\s+synced)\b/gi,
      " ",
    )
    .replace(/\bfy\s*\d{4}(?:\s*\/\s*\d{2,4})?\b/gi, " ")
    .replace(/\b20\d{2}\b/g, " ")
    .replace(/\b208\d\b/g, " ")
    .replace(/[?!.,:;]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!text || text.length < 2) return null;
  if (/^(all|every|company|total)$/i.test(text)) return null;
  return text;
}

function periodArgsFromProductSalesMessage(
  message: string,
): DatePeriodInput {
  return extractMessagePeriod(message);
}

async function formatProductSalesList(message: string): Promise<string> {
  const productQuery = extractProductQueryFromSalesMessage(message);
  if (!productQuery) {
    return "Please name a product keyword (e.g. mustard, dip, chocolate) to list sales by item.";
  }

  const periodArgs = periodArgsFromProductSalesMessage(message);
  const returnsOnly =
    /\b(sales?\s+returns?|returns?|credit\s+memos?)\b/i.test(message);
  const data = (await getProductSales({
    query: productQuery,
    returnsOnly,
    ...periodArgs,
  })) as {
    error?: string;
    query?: string | null;
    period?: string;
    isAllTime?: boolean;
    periodWarning?: string | null;
    totalSalesIncludingTax?: number;
    totalQuantityInvoiced?: number;
    totalQuantityInvoicedMT?: number;
    averagePricePerMTInclTax?: number | null;
    averageSellingPriceCustomerCount?: number;
    items?: Array<{
      itemNo: string;
      name: string;
      quantityInvoiced: number;
      quantityInvoicedMT?: number | null;
      salesIncludingTax: number;
      averageUnitPriceInclTax?: number;
      averagePricePerMTInclTax?: number | null;
      averageSellingPriceCustomerCount?: number;
    }>;
    _syncedAt?: string;
  };

  if (data.error) return data.error;

  const companyLabel = getCompany(getActiveCompany()).displayName;
  const items = data.items ?? [];
  const title = `**${productQuery} ${returnsOnly ? "sales returns" : "sales"} — all ${items.length} item(s)**`;

  if (items.length === 0) {
    return [
      `${title} — ${companyLabel}${formatSync(data._syncedAt)}`,
      "",
      `Period: ${data.period ?? "all synced dates"}`,
      "",
      `No ${returnsOnly ? "credit-memo" : "invoiced"} lines matched **${productQuery}**.`,
    ].join("\n");
  }

  const lines = [
    `${title} — ${companyLabel}${formatSync(data._syncedAt)}`,
    "",
    `Period: **${data.period ?? "all synced dates"}**`,
    `**Total ${returnsOnly ? "returns" : "sales"} (Incl. VAT): ${formatAmount(data.totalSalesIncludingTax ?? 0)}** · **Qty: ${formatMetricTons(data.totalQuantityInvoicedMT)} MT** · **Equal-customer avg: ${formatAmount(data.averagePricePerMTInclTax ?? 0)} / MT**`,
    `_Average gives each of ${data.averageSellingPriceCustomerCount ?? 0} customer(s) equal weight; it is not total sales ÷ total MT._`,
    "",
    `| # | Item | Qty (MT) | ${returnsOnly ? "Returns" : "Sales"} (Incl. VAT) | Equal-customer avg NPR/MT |`,
    "|---:|---|---:|---:|---:|",
    ...items.map(
      (row, index) =>
        `| ${index + 1} | ${escapeCell(row.name || row.itemNo)} | ${formatMetricTons(row.quantityInvoicedMT)} | ${formatAmount(row.salesIncludingTax)} | ${formatAmount(row.averagePricePerMTInclTax ?? 0)} |`,
    ),
    "",
    `_Listed all ${items.length} matching item(s) in metric tons — not top 10 only._`,
  ];

  if (data.periodWarning) {
    lines.push("", `_${data.periodWarning}_`);
  }

  return lines.join("\n");
}

async function formatCollectionMetrics(
  message: string,
  query?: string,
): Promise<string> {
  const data = (await getCollectionMetrics({
    query,
    ...periodArgsFromProductSalesMessage(message),
  })) as {
    error?: string;
    customerName?: string | null;
    period?: string;
    totalOutstanding?: number;
    openInvoiceCount?: number;
    averageDaysPastDueOnOpenInvoices?: number;
    averageOpenInvoiceAgeDays?: number;
    estimatedCollectionDaysDso?: number | null;
    salesInLookbackPeriod?: number;
    _syncedAt?: string;
  };
  if (data.error) return data.error;

  const companyLabel = getCompany(getActiveCompany()).displayName;
  const subject = data.customerName || "Company";
  return [
    `**Average collection days — ${escapeCell(subject)}** — ${companyLabel}${formatSync(data._syncedAt)}`,
    "",
    `Period: **${data.period ?? `Nepali FY ${fiscalYearLabel(getCurrentFiscalYearStart() ?? 0)}`}**`,
    `Estimated DSO: **${formatNumber(data.estimatedCollectionDaysDso ?? 0)} days**`,
    `Average open-invoice age: **${formatNumber(data.averageOpenInvoiceAgeDays ?? 0)} days**`,
    `Average days past due: **${formatNumber(data.averageDaysPastDueOnOpenInvoices ?? 0)} days**`,
    `Open invoices: **${data.openInvoiceCount ?? 0}** · Outstanding: **NPR ${formatAmount(data.totalOutstanding ?? 0)}**`,
  ].join("\n");
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
    /\b(which|what|who)\s+(customers?|part(?:y|ies)|dealers?|clients?|buyers?)\b/.test(n) ||
    /\b(customers?|part(?:y|ies)|dealers?)\s+(most|highest|top|maximum|max)\b/.test(n) ||
    /\b(top|highest|maximum|biggest)\s*(?:\d{1,2}\s*)?(customers?|part(?:y|ies)|dealers?|debtors?)\b/.test(n) ||
    /\bwho\s+owes?\s+(the\s+)?most\b/.test(n) ||
    /\bmost\s+outstanding\b/.test(n)
  );
}

/** Pull a customer name fragment from receivables questions (partial names OK). */
function extractCustomerQueryFromReceivablesMessage(
  message: string,
): string | null {
  if (isCustomerRankingReceivablesQuery(message)) return null;

  const text = message
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
  const asksCustomerRanking = isCustomerRankingReceivablesQuery(message);
  if (!minDays && asksCustomerRanking && !customerQuery) {
    const numberedLimit = message.match(
      /\b(?:top|first|highest|largest)\s*(\d{1,2})\b/i,
    )?.[1];
    const limit = numberedLimit
      ? Math.max(1, Math.min(Number(numberedLimit), 50))
      : /\btop\s+customer\b/i.test(message)
        ? 1
        : 5;
    const ranking = (await getOutstandingReceivables({
      limit,
      ...periodArgsFromProductSalesMessage(message),
    })) as {
      error?: string;
      period?: string;
      totals?: {
        totalOutstanding?: number;
        totalOverdue?: number;
        totalNotYetDue?: number;
      };
      customers?: Array<{
        rank: number;
        customerNo: string;
        name: string;
        balance: number;
        overdueAmount: number;
        notYetDueAmount: number;
      }>;
      _syncedAt?: string;
    };
    if (ranking.error) return ranking.error;
    const customers = ranking.customers ?? [];
    const companyLabel = getCompany(getActiveCompany()).displayName;
    return [
      `**Top ${customers.length} ${customers.length === 1 ? "customer" : "customers"} by outstanding** — ${companyLabel}${formatSync(ranking._syncedAt)}`,
      "",
      `Period: **${ranking.period ?? `Nepali FY ${fiscalYearLabel(getCurrentFiscalYearStart() ?? 0)}`}**`,
      `Total outstanding: **NPR ${formatAmount(ranking.totals?.totalOutstanding)}**`,
      "",
      "| Rank | Customer | Outstanding (NPR) | Overdue (NPR) | Not yet due (NPR) |",
      "|---:|---|---:|---:|---:|",
      ...customers.map(
        (row) =>
          `| ${row.rank} | ${escapeCell(row.name || row.customerNo)} | **${formatAmount(row.balance)}** | ${formatAmount(row.overdueAmount)} | ${formatAmount(row.notYetDueAmount)} |`,
      ),
    ].join("\n");
  }
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
    ].map(escapeCell),
  );

  return [
    `Found **${customers.length} customers** in the current customer-master snapshot${formatSync(data._syncedAt)}.`,
    "_Customer masters are an undated snapshot; fiscal-year sales must be requested through customer sales analytics._",
    "",
    "| Customer No. | Name | Phone | Balance (NPR) | Overdue (NPR) |",
    "|---|---|---|---:|---:|",
    ...rows.map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function formatSync(syncedAt?: string): string {
  if (!syncedAt) return "";
  const bsDate = formatBsDate(syncedAt);
  return bsDate ? ` (synced ${bsDate})` : "";
}

function escapeCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
