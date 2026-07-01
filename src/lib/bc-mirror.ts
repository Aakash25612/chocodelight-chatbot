import { getSupabaseAdmin } from "./supabase";
import { getActiveCompany } from "./company-context";

export type MirrorEntity =
  | "companies"
  | "customers"
  | "custLedgEntries"
  | "salesOrders"
  | "salesOrderLines"
  | "mr"
  | "salespersons"
  | "items"
  | "uoms"
  | "api_catalog";

export async function getMirror(entityType: MirrorEntity): Promise<unknown> {
  const supabase = getSupabaseAdmin();
  const company = getActiveCompany();
  const { data, error } = await supabase
    .from("bc_mirror")
    .select("payload, synced_at")
    .eq("company", company)
    .eq("entity_type", entityType)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    return {
      error: `No synced data for ${entityType} (company: ${company}). Run BC sync from a machine with VPN access.`,
      entityType,
    };
  }

  const payload = data.payload as {
    chunked?: boolean;
    chunks?: number;
    value?: unknown[];
  };

  if (payload.chunked) {
    const { data: chunks, error: chunkError } = await supabase
      .from("bc_mirror_chunks")
      .select("payload")
      .eq("company", company)
      .eq("entity_type", entityType)
      .order("chunk_index", { ascending: true });

    if (chunkError) throw chunkError;

    return {
      value: (chunks ?? []).flatMap(
        (chunk) => ((chunk.payload as { value?: unknown[] }).value ?? []),
      ),
      _syncedAt: data.synced_at,
    };
  }

  return { ...(payload as object), _syncedAt: data.synced_at };
}

export async function getMirrorCache(cacheKey: string): Promise<unknown | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("bc_mirror_cache")
    .select("payload, synced_at")
    .eq("company", getActiveCompany())
    .eq("cache_key", cacheKey)
    .maybeSingle();

  if (error) throw error;
  if (!data) return null;
  return { ...(data.payload as object), _syncedAt: data.synced_at };
}

export async function getUomsFromMirror(filter?: string): Promise<unknown> {
  const raw = (await getMirror("uoms")) as { value?: Record<string, unknown>[]; error?: string };
  if (raw.error) return raw;

  if (!filter) return raw;

  const match = filter.match(/itemNo\s+eq\s+'([^']+)'/i);
  if (!match) return raw;

  const itemNo = match[1];
  const filtered = (raw.value ?? []).filter(
    (row) => String(row.itemNo ?? row.itemno ?? "").toUpperCase() === itemNo.toUpperCase(),
  );
  return {
    value: filtered,
    _syncedAt: (raw as { _syncedAt?: string })._syncedAt,
  };
}

type LedgerEntry = {
  documentType?: string;
  postingDate?: string;
  salesLcy?: number;
  amountLcy?: number;
};

export async function getMonthlyRevenueFromMirror(
  year = new Date().getFullYear(),
): Promise<unknown> {
  const raw = (await getMirror("custLedgEntries")) as {
    value?: LedgerEntry[];
    error?: string;
    _syncedAt?: string;
  };
  if (raw.error) return raw;

  const months = Array.from({ length: 12 }, (_, index) => ({
    month: new Date(year, index, 1).toLocaleString("en-US", { month: "long" }),
    monthNumber: index + 1,
    invoiceEntries: 0,
    revenueExcludingTax: 0,
  }));

  for (const entry of raw.value ?? []) {
    const date = entry.postingDate ? new Date(entry.postingDate) : null;
    if (
      entry.documentType !== "Invoice" ||
      !date ||
      Number.isNaN(date.getTime()) ||
      date.getFullYear() !== year
    ) {
      continue;
    }

    const month = months[date.getMonth()];
    month.invoiceEntries += 1;
    month.revenueExcludingTax += Number(entry.salesLcy ?? entry.amountLcy ?? 0);
  }

  const topMonth = [...months].sort(
    (a, b) => b.revenueExcludingTax - a.revenueExcludingTax,
  )[0];
  const totalRevenue = months.reduce(
    (total, month) => total + month.revenueExcludingTax,
    0,
  );

  return {
    year,
    totalRevenue,
    topMonth,
    months,
    _syncedAt: raw._syncedAt,
  };
}

export async function getSyncStatus(): Promise<{
  entities: Record<string, { syncedAt: string | null; recordCount: number }>;
  pendingWrites: number;
  lastFullSync: string | null;
}> {
  const supabase = getSupabaseAdmin();
  const company = getActiveCompany();

  const [{ data: mirrors }, { data: meta }, { count }] = await Promise.all([
    supabase
      .from("bc_mirror")
      .select("entity_type, synced_at, payload")
      .eq("company", company),
    supabase
      .from("bc_sync_meta")
      .select("*")
      .eq("company", company)
      .eq("key", "full_sync")
      .maybeSingle(),
    supabase
      .from("bc_write_queue")
      .select("*", { count: "exact", head: true })
      .eq("company", company)
      .eq("status", "pending"),
  ]);

  const entities: Record<string, { syncedAt: string | null; recordCount: number }> = {};
  for (const row of mirrors ?? []) {
    const payload = row.payload as { value?: unknown[] };
    entities[row.entity_type] = {
      syncedAt: row.synced_at,
      recordCount: Array.isArray(payload?.value) ? payload.value.length : 1,
    };
  }

  return {
    entities,
    pendingWrites: count ?? 0,
    lastFullSync: meta?.last_synced_at ?? null,
  };
}

export async function queueWrite(
  actionType: string,
  payload: Record<string, unknown>,
): Promise<{ queued: true; id: string; message: string }> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("bc_write_queue")
    .insert({ action_type: actionType, payload, company: getActiveCompany() })
    .select("id")
    .single();

  if (error) throw error;

  return {
    queued: true,
    id: data.id,
    message:
      "Request queued. It will be processed by the BC sync worker (requires VPN-side sync).",
  };
}
