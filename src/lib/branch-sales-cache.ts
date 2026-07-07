import { branchCodeFromDocument, branchNameForCode } from "./branches";
import type { PostedSalesDocument } from "./invoice-lines";
import {
  BS_MONTHS,
  getNepaliFiscalYear,
  fiscalYearLabel,
  toBs,
} from "./nepali-date";
import { getMirrorCache } from "./bc-mirror";
import { getSupabaseAdmin } from "./supabase";
import { getActiveCompany } from "./company-context";

const CACHE_KEY = "branch_sales:v4";

/** Bikram Sambat fiscal month order: Shrawan → Ashadh. */
const FISCAL_MONTH_ORDER = [3, 4, 5, 6, 7, 8, 9, 10, 11, 0, 1, 2];

type LedgerEntry = {
  documentType?: string;
  postingDate?: string;
  salesLcy?: number;
  documentNo?: string;
};

export type BranchSalesRow = {
  branchCode: string;
  branchName: string;
  salesIncludingTax: number;
  salesExcludingTax: number;
  invoices: number;
};

export type BranchMonthRow = {
  bsMonth: string;
  monthIndex: number;
  bsYear: number;
  salesIncludingTax: number;
  salesExcludingTax: number;
  invoices: number;
};

export type BranchSalesCache = {
  allTime: {
    totalSalesIncludingTax: number;
    totalSalesExcludingTax: number;
    /** @deprecated use totalSalesIncludingTax */
    totalSales: number;
    branches: BranchSalesRow[];
  };
  byNepaliFiscalYear: Record<
    string,
    {
      totalSalesIncludingTax: number;
      totalSalesExcludingTax: number;
      /** @deprecated use totalSalesIncludingTax */
      totalSales: number;
      branches: BranchSalesRow[];
    }
  >;
  /** branchCode → FY label → BS months in fiscal order */
  byBranchNepaliMonthly: Record<string, Record<string, BranchMonthRow[]>>;
  _builtAt: string;
  _source?: "posted_invoices" | "customer_ledger";
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function parseDate(value?: string): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function rowsFromMap(
  map: Map<string, { salesIncl: number; salesExcl: number; invoices: number }>,
): BranchSalesRow[] {
  return [...map.entries()]
    .map(([code, agg]) => ({
      branchCode: code,
      branchName: branchNameForCode(code),
      salesIncludingTax: round(agg.salesIncl),
      salesExcludingTax: round(agg.salesExcl),
      invoices: agg.invoices,
    }))
    .sort((a, b) => b.salesIncludingTax - a.salesIncludingTax);
}

function fiscalMonthRows(
  startYear: number,
  monthMap: Map<
    number,
    { salesIncl: number; salesExcl: number; invoices: number; bsYear: number }
  >,
): BranchMonthRow[] {
  return FISCAL_MONTH_ORDER.map((monthIndex) => {
    const bsYear = monthIndex >= 3 ? startYear : startYear + 1;
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

function buildBranchSalesCacheInternal(
  entries: Array<{
    branchCode: string;
    postingDate?: string;
    salesIncl: number;
    salesExcl: number;
    isInvoice: boolean;
  }>,
  source: BranchSalesCache["_source"],
): BranchSalesCache {
  const allTime = new Map<
    string,
    { salesIncl: number; salesExcl: number; invoices: number }
  >();
  const byFy = new Map<
    string,
    Map<string, { salesIncl: number; salesExcl: number; invoices: number }>
  >();
  const byBranchFyMonth = new Map<
    string,
    Map<
      string,
      Map<
        number,
        { salesIncl: number; salesExcl: number; invoices: number; bsYear: number }
      >
    >
  >();
  const fyStartYears = new Map<string, number>();

  for (const entry of entries) {
    const code = entry.branchCode;

    const allAgg = allTime.get(code) ?? { salesIncl: 0, salesExcl: 0, invoices: 0 };
    allAgg.salesIncl += entry.salesIncl;
    allAgg.salesExcl += entry.salesExcl;
    if (entry.isInvoice) allAgg.invoices += 1;
    allTime.set(code, allAgg);

    const date = parseDate(entry.postingDate);
    const fy = date ? getNepaliFiscalYear(date) : null;
    const bs = date ? toBs(date) : null;
    if (!fy || !bs) continue;

    fyStartYears.set(fy.label, fy.startYear);

    const fyMap = byFy.get(fy.label) ?? new Map();
    const fyAgg = fyMap.get(code) ?? { salesIncl: 0, salesExcl: 0, invoices: 0 };
    fyAgg.salesIncl += entry.salesIncl;
    fyAgg.salesExcl += entry.salesExcl;
    if (entry.isInvoice) fyAgg.invoices += 1;
    fyMap.set(code, fyAgg);
    byFy.set(fy.label, fyMap);

    const branchFy =
      byBranchFyMonth.get(code) ??
      new Map<
        string,
        Map<
          number,
          { salesIncl: number; salesExcl: number; invoices: number; bsYear: number }
        >
      >();
    const monthMap = branchFy.get(fy.label) ?? new Map();
    const monthAgg = monthMap.get(bs.month) ?? {
      salesIncl: 0,
      salesExcl: 0,
      invoices: 0,
      bsYear: bs.year,
    };
    monthAgg.salesIncl += entry.salesIncl;
    monthAgg.salesExcl += entry.salesExcl;
    if (entry.isInvoice) monthAgg.invoices += 1;
    monthMap.set(bs.month, monthAgg);
    branchFy.set(fy.label, monthMap);
    byBranchFyMonth.set(code, branchFy);
  }

  const allRows = rowsFromMap(allTime);
  const totalIncl = round(
    allRows.reduce((sum, row) => sum + row.salesIncludingTax, 0),
  );
  const totalExcl = round(
    allRows.reduce((sum, row) => sum + row.salesExcludingTax, 0),
  );

  const byBranchNepaliMonthly: Record<string, Record<string, BranchMonthRow[]>> =
    {};
  for (const [branchCode, fyMaps] of byBranchFyMonth) {
    byBranchNepaliMonthly[branchCode] = {};
    for (const [fyLabel, monthMap] of fyMaps) {
      const startYear = fyStartYears.get(fyLabel) ?? 0;
      byBranchNepaliMonthly[branchCode][fyLabel] = fiscalMonthRows(
        startYear,
        monthMap,
      );
    }
  }

  return {
    allTime: {
      totalSalesIncludingTax: totalIncl,
      totalSalesExcludingTax: totalExcl,
      totalSales: totalIncl,
      branches: allRows,
    },
    byNepaliFiscalYear: Object.fromEntries(
      [...byFy.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, map]) => {
          const branches = rowsFromMap(map);
          const fyIncl = round(
            branches.reduce((sum, row) => sum + row.salesIncludingTax, 0),
          );
          const fyExcl = round(
            branches.reduce((sum, row) => sum + row.salesExcludingTax, 0),
          );
          return [
            label,
            {
              totalSalesIncludingTax: fyIncl,
              totalSalesExcludingTax: fyExcl,
              totalSales: fyIncl,
              branches,
            },
          ];
        }),
    ),
    byBranchNepaliMonthly,
    _builtAt: new Date().toISOString(),
    _source: source,
  };
}

/** Build branch sales from posted invoice/credit memo headers (preferred). */
export function buildBranchSalesCacheFromDocuments(
  documents: PostedSalesDocument[],
): BranchSalesCache {
  const entries = documents.map((doc) => {
    const incl =
      doc.documentKind === "credit_memo"
        ? -Math.abs(doc.salesAmountIncludingTax)
        : doc.salesAmountIncludingTax;
    const excl =
      doc.documentKind === "credit_memo"
        ? -Math.abs(doc.salesAmount)
        : doc.salesAmount;
    return {
      branchCode: doc.branchCode,
      postingDate: doc.postingDate,
      salesIncl: incl,
      salesExcl: excl,
      isInvoice: doc.documentKind === "invoice",
    };
  });
  return buildBranchSalesCacheInternal(entries, "posted_invoices");
}

/** Build branch sales aggregates from ledger invoice rows (fallback). */
export function buildBranchSalesCache(
  entries: LedgerEntry[],
): BranchSalesCache {
  const normalized = entries
    .filter((entry) => entry.documentType === "Invoice")
    .flatMap((entry) => {
      const code = branchCodeFromDocument(entry.documentNo);
      if (!code) return [];
      const sales = Number(entry.salesLcy ?? 0);
      return [
        {
          branchCode: code,
          postingDate: entry.postingDate,
          salesIncl: sales,
          salesExcl: sales,
          isInvoice: true,
        },
      ];
    });
  return buildBranchSalesCacheInternal(normalized, "customer_ledger");
}

export async function saveBranchSalesCache(
  cache: BranchSalesCache,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase.from("bc_mirror_cache").upsert({
    company: getActiveCompany(),
    cache_key: CACHE_KEY,
    payload: cache,
    synced_at: cache._builtAt,
  });
  if (error) throw error;
}

export async function loadBranchSalesCache(): Promise<BranchSalesCache | null> {
  const raw = (await getMirrorCache(CACHE_KEY)) as BranchSalesCache | null;
  if (!raw?.allTime?.branches) return null;
  return raw;
}

export function branchMonthlyFromCache(
  cache: BranchSalesCache,
  branchCode: string,
  fyLabel: string,
): BranchMonthRow[] {
  return cache.byBranchNepaliMonthly?.[branchCode.toUpperCase()]?.[fyLabel] ?? [];
}

export { fiscalYearLabel, FISCAL_MONTH_ORDER };
