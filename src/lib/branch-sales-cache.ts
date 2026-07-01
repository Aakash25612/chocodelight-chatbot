import { branchCodeFromDocument, branchNameForCode } from "./branches";
import {
  BS_MONTHS,
  getNepaliFiscalYear,
  fiscalYearLabel,
  toBs,
} from "./nepali-date";
import { getMirrorCache } from "./bc-mirror";
import { getSupabaseAdmin } from "./supabase";
import { getActiveCompany } from "./company-context";

const CACHE_KEY = "branch_sales:v2";

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
  salesExcludingTax: number;
  invoices: number;
};

export type BranchMonthRow = {
  bsMonth: string;
  monthIndex: number;
  bsYear: number;
  salesExcludingTax: number;
  invoices: number;
};

export type BranchSalesCache = {
  allTime: {
    totalSales: number;
    branches: BranchSalesRow[];
  };
  byNepaliFiscalYear: Record<
    string,
    { totalSales: number; branches: BranchSalesRow[] }
  >;
  /** branchCode → FY label → BS months in fiscal order */
  byBranchNepaliMonthly: Record<string, Record<string, BranchMonthRow[]>>;
  _builtAt: string;
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
  map: Map<string, { sales: number; invoices: number }>,
): BranchSalesRow[] {
  return [...map.entries()]
    .map(([code, agg]) => ({
      branchCode: code,
      branchName: branchNameForCode(code),
      salesExcludingTax: round(agg.sales),
      invoices: agg.invoices,
    }))
    .sort((a, b) => b.salesExcludingTax - a.salesExcludingTax);
}

function fiscalMonthRows(
  startYear: number,
  monthMap: Map<number, { sales: number; invoices: number; bsYear: number }>,
): BranchMonthRow[] {
  return FISCAL_MONTH_ORDER.map((monthIndex) => {
    const bsYear = monthIndex >= 3 ? startYear : startYear + 1;
    const agg = monthMap.get(monthIndex) ?? { sales: 0, invoices: 0, bsYear };
    return {
      bsMonth: BS_MONTHS[monthIndex],
      monthIndex,
      bsYear,
      salesExcludingTax: round(agg.sales),
      invoices: agg.invoices,
    };
  });
}

/** Build branch sales aggregates from ledger invoice rows (run during sync). */
export function buildBranchSalesCache(
  entries: LedgerEntry[],
): BranchSalesCache {
  const allTime = new Map<string, { sales: number; invoices: number }>();
  const byFy = new Map<
    string,
    Map<string, { sales: number; invoices: number }>
  >();
  const byBranchFyMonth = new Map<
    string,
    Map<string, Map<number, { sales: number; invoices: number; bsYear: number }>>
  >();
  const fyStartYears = new Map<string, number>();

  for (const entry of entries) {
    if (entry.documentType !== "Invoice") continue;
    const code = branchCodeFromDocument(entry.documentNo);
    if (!code) continue;

    const sales = Number(entry.salesLcy ?? 0);

    const allAgg = allTime.get(code) ?? { sales: 0, invoices: 0 };
    allAgg.sales += sales;
    allAgg.invoices += 1;
    allTime.set(code, allAgg);

    const date = parseDate(entry.postingDate);
    const fy = date ? getNepaliFiscalYear(date) : null;
    const bs = date ? toBs(date) : null;
    if (!fy || !bs) continue;

    fyStartYears.set(fy.label, fy.startYear);

    const fyMap = byFy.get(fy.label) ?? new Map();
    const fyAgg = fyMap.get(code) ?? { sales: 0, invoices: 0 };
    fyAgg.sales += sales;
    fyAgg.invoices += 1;
    fyMap.set(code, fyAgg);
    byFy.set(fy.label, fyMap);

    const branchFy =
      byBranchFyMonth.get(code) ??
      new Map<
        string,
        Map<number, { sales: number; invoices: number; bsYear: number }>
      >();
    const monthMap = branchFy.get(fy.label) ?? new Map();
    const monthAgg = monthMap.get(bs.month) ?? {
      sales: 0,
      invoices: 0,
      bsYear: bs.year,
    };
    monthAgg.sales += sales;
    monthAgg.invoices += 1;
    monthMap.set(bs.month, monthAgg);
    branchFy.set(fy.label, monthMap);
    byBranchFyMonth.set(code, branchFy);
  }

  const allRows = rowsFromMap(allTime);

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
      totalSales: round(allRows.reduce((sum, row) => sum + row.salesExcludingTax, 0)),
      branches: allRows,
    },
    byNepaliFiscalYear: Object.fromEntries(
      [...byFy.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, map]) => {
          const branches = rowsFromMap(map);
          return [
            label,
            {
              totalSales: round(
                branches.reduce((sum, row) => sum + row.salesExcludingTax, 0),
              ),
              branches,
            },
          ];
        }),
    ),
    byBranchNepaliMonthly,
    _builtAt: new Date().toISOString(),
  };
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
