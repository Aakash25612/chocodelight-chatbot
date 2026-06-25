import { getSupabaseAdmin } from "./supabase";

export type MirrorEntity =
  | "companies"
  | "customers"
  | "custLedgEntries"
  | "mr"
  | "salespersons"
  | "items"
  | "uoms"
  | "api_catalog";

export async function getMirror(entityType: MirrorEntity): Promise<unknown> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("bc_mirror")
    .select("payload, synced_at")
    .eq("entity_type", entityType)
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    return {
      error: `No synced data for ${entityType}. Run BC sync from a machine with VPN access.`,
      entityType,
    };
  }

  return { ...(data.payload as object), _syncedAt: data.synced_at };
}

export async function getMirrorCache(cacheKey: string): Promise<unknown | null> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("bc_mirror_cache")
    .select("payload, synced_at")
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

export async function getSyncStatus(): Promise<{
  entities: Record<string, { syncedAt: string | null; recordCount: number }>;
  pendingWrites: number;
  lastFullSync: string | null;
}> {
  const supabase = getSupabaseAdmin();

  const [{ data: mirrors }, { data: meta }, { count }] = await Promise.all([
    supabase.from("bc_mirror").select("entity_type, synced_at, payload"),
    supabase.from("bc_sync_meta").select("*").eq("key", "full_sync").maybeSingle(),
    supabase
      .from("bc_write_queue")
      .select("*", { count: "exact", head: true })
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
    .insert({ action_type: actionType, payload })
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
