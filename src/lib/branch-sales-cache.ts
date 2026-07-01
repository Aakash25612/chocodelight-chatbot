import { branchCodeFromDocument, branchNameForCode } from "./branches";
import { getNepaliFiscalYear, fiscalYearLabel } from "./nepali-date";
import { getMirrorCache } from "./bc-mirror";
import { getSupabaseAdmin } from "./supabase";
import { getActiveCompany } from "./company-context";

const CACHE_KEY = "branch_sales:v1";

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

export type BranchSalesCache = {
  allTime: {
    totalSales: number;
    branches: BranchSalesRow[];
  };
  byNepaliFiscalYear: Record<
    string,
    { totalSales: number; branches: BranchSalesRow[] }
  >;
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

/** Build branch sales aggregates from ledger invoice rows (run during sync). */
export function buildBranchSalesCache(
  entries: LedgerEntry[],
): BranchSalesCache {
  const allTime = new Map<string, { sales: number; invoices: number }>();
  const byFy = new Map<
    string,
    Map<string, { sales: number; invoices: number }>
  >();

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
    if (fy) {
      const fyMap = byFy.get(fy.label) ?? new Map();
      const fyAgg = fyMap.get(code) ?? { sales: 0, invoices: 0 };
      fyAgg.sales += sales;
      fyAgg.invoices += 1;
      fyMap.set(code, fyAgg);
      byFy.set(fy.label, fyMap);
    }
  }

  const allRows = rowsFromMap(allTime);
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

export function branchRowFromCache(
  cache: BranchSalesCache,
  branchCode: string,
  fiscalYearLabel?: string,
): BranchSalesRow | null {
  const code = branchCode.toUpperCase();
  if (fiscalYearLabel) {
    const fy = cache.byNepaliFiscalYear[fiscalYearLabel];
    return fy?.branches.find((row) => row.branchCode === code) ?? null;
  }
  return cache.allTime.branches.find((row) => row.branchCode === code) ?? null;
}

export { fiscalYearLabel };
