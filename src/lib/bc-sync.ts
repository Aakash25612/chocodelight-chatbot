import { bcApi } from "./bc-client";
import { getSupabaseAdmin } from "./supabase";
import type { MirrorEntity } from "./bc-mirror";

const READ_ENTITIES: { type: MirrorEntity; fetch: () => Promise<unknown> }[] = [
  { type: "companies", fetch: () => bcApi.getCompanies() },
  { type: "customers", fetch: () => bcApi.getCustomers() },
  { type: "custLedgEntries", fetch: () => bcApi.getCustomerLedgerEntries() },
  { type: "mr", fetch: () => bcApi.getMr() },
  { type: "salespersons", fetch: () => bcApi.getSalespersons() },
  { type: "items", fetch: () => bcApi.getItems() },
  { type: "uoms", fetch: () => bcApi.getUoms() },
  { type: "api_catalog", fetch: () => bcApi.getApiCatalog() },
];

export async function syncBcToSupabase(): Promise<{
  synced: string[];
  errors: { entity: string; error: string }[];
}> {
  const supabase = getSupabaseAdmin();
  const synced: string[] = [];
  const errors: { entity: string; error: string }[] = [];

  for (const { type, fetch } of READ_ENTITIES) {
    try {
      const payload = await fetch();
      const recordCount = Array.isArray((payload as { value?: unknown[] }).value)
        ? (payload as { value: unknown[] }).value.length
        : 1;

      const { error } = await supabase.from("bc_mirror").upsert({
        entity_type: type,
        payload,
        synced_at: new Date().toISOString(),
      });

      if (error) throw error;

      await supabase.from("bc_sync_meta").upsert({
        key: type,
        last_synced_at: new Date().toISOString(),
        record_count: recordCount,
        status: "ok",
        error: null,
      });

      synced.push(type);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ entity: type, error: message });
      await supabase.from("bc_sync_meta").upsert({
        key: type,
        last_synced_at: new Date().toISOString(),
        record_count: 0,
        status: "error",
        error: message,
      });
    }
  }

  await supabase.from("bc_sync_meta").upsert({
    key: "full_sync",
    last_synced_at: new Date().toISOString(),
    record_count: synced.length,
    status: errors.length ? "partial" : "ok",
    error: errors.length ? JSON.stringify(errors) : null,
  });

  return { synced, errors };
}

async function processQueueItem(
  id: string,
  actionType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const supabase = getSupabaseAdmin();

  await supabase
    .from("bc_write_queue")
    .update({ status: "processing" })
    .eq("id", id);

  try {
    let result: unknown;

    switch (actionType) {
      case "create_sales_order":
        result = await bcApi.createSalesOrder(payload);
        break;
      case "post_sales_document":
        result = await bcApi.postSalesDocument(payload.documentNo as string);
        break;
      case "get_pending_items_to_sell": {
        result = await bcApi.getPendingItemsToSell(
          payload.customerNo as string,
          (payload.fileName as string) ?? "",
        );
        const cacheKey = `pending_items:${payload.customerNo}`;
        await supabase.from("bc_mirror_cache").upsert({
          cache_key: cacheKey,
          payload: result,
          synced_at: new Date().toISOString(),
        });
        break;
      }
      case "lock_sales_order":
        result = await bcApi.lockSalesOrder(payload.documentNo as string);
        break;
      case "create_gen_journal_line":
        result = await bcApi.createGenJournalLine(payload);
        break;
      default:
        throw new Error(`Unknown action: ${actionType}`);
    }

    await supabase
      .from("bc_write_queue")
      .update({
        status: "completed",
        result: result as Record<string, unknown>,
        processed_at: new Date().toISOString(),
      })
      .eq("id", id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await supabase
      .from("bc_write_queue")
      .update({
        status: "failed",
        error: message,
        processed_at: new Date().toISOString(),
      })
      .eq("id", id);
  }
}

export async function processWriteQueue(limit = 20): Promise<{
  processed: number;
  failed: number;
}> {
  const supabase = getSupabaseAdmin();
  const { data: pending, error } = await supabase
    .from("bc_write_queue")
    .select("id, action_type, payload")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;

  let processed = 0;
  let failed = 0;

  for (const item of pending ?? []) {
    await processQueueItem(
      item.id,
      item.action_type,
      item.payload as Record<string, unknown>,
    );
    const { data: updated } = await supabase
      .from("bc_write_queue")
      .select("status")
      .eq("id", item.id)
      .single();
    if (updated?.status === "completed") processed++;
    else failed++;
  }

  return { processed, failed };
}

export async function runFullSync(): Promise<{
  sync: Awaited<ReturnType<typeof syncBcToSupabase>>;
  queue: Awaited<ReturnType<typeof processWriteQueue>>;
}> {
  const sync = await syncBcToSupabase();
  const queue = await processWriteQueue();
  return { sync, queue };
}
