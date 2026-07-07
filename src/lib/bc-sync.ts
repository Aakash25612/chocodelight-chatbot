import { bcApi } from "./bc-client";
import { getSupabaseAdmin } from "./supabase";
import type { MirrorEntity } from "./bc-mirror";
import { listCompanies, type CompanyKey } from "./companies";
import { getActiveCompany, runWithCompany } from "./company-context";
import { buildDerivedCustomersPayload } from "./derived-customers";
import {
  buildBranchSalesCache,
  saveBranchSalesCache,
} from "./branch-sales-cache";

import {
  flattenSalesCrMemoLines,
  flattenSalesInvoiceLines,
} from "./invoice-lines";

const BASE_READ_ENTITIES: {
  type: MirrorEntity;
  fetch: () => Promise<unknown>;
}[] = [
  { type: "companies", fetch: () => bcApi.getCompanies() },
  { type: "customers", fetch: () => bcApi.getCustomers() },
  { type: "custLedgEntries", fetch: () => bcApi.getCustomerLedgerEntries() },
  { type: "salesOrders", fetch: () => bcApi.getSalesOrders() },
  { type: "salesOrderLines", fetch: () => bcApi.getSalesOrderLines() },
  { type: "mr", fetch: () => bcApi.getMr() },
  { type: "salespersons", fetch: () => bcApi.getSalespersons() },
  { type: "items", fetch: () => bcApi.getItems() },
  { type: "uoms", fetch: () => bcApi.getUoms() },
  { type: "api_catalog", fetch: () => bcApi.getApiCatalog() },
];

const CHOCODELIGHT_EXTRA_ENTITIES: {
  type: MirrorEntity;
  fetch: () => Promise<unknown>;
}[] = [
  {
    type: "salesInvoiceLines",
    fetch: async () => {
      const payload = await bcApi.getSalesInvoiceHeaders();
      const headers = (payload.value ?? []) as Parameters<
        typeof flattenSalesInvoiceLines
      >[0];
      return { value: flattenSalesInvoiceLines(headers) };
    },
  },
  {
    type: "salesCrMemoLines",
    fetch: async () => {
      const payload = await bcApi.getSalesCrMemos();
      const headers = (payload.value ?? []) as Parameters<
        typeof flattenSalesCrMemoLines
      >[0];
      return { value: flattenSalesCrMemoLines(headers) };
    },
  },
];

function readEntitiesForCompany(company: CompanyKey): {
  type: MirrorEntity;
  fetch: () => Promise<unknown>;
}[] {
  if (company === "chocodelight") {
    return [...BASE_READ_ENTITIES, ...CHOCODELIGHT_EXTRA_ENTITIES];
  }
  return BASE_READ_ENTITIES;
}

const MAX_INLINE_PAYLOAD_BYTES = 8 * 1024 * 1024;
const MIRROR_CHUNK_SIZE = 5000;

type LedgerEntry = {
  documentType?: string;
  postingDate?: string;
  salesLcy?: number;
  documentNo?: string;
};

function compactMirrorPayload(type: MirrorEntity, payload: unknown): unknown {
  if (
    type === "salesInvoiceLines" &&
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { value?: unknown[] }).value)
  ) {
    return {
      value: (payload as { value: Record<string, unknown>[] }).value.map(
        (line) => ({
          documentNo: line.documentNo,
          lineNo: line.lineNo,
          itemNo: line.itemNo,
          description: line.description,
          quantity: line.quantity,
          unitOfMeasureCode: line.unitOfMeasureCode,
          unitPrice: line.unitPrice,
          lineAmountExclVAT: line.lineAmountExclVAT,
          lineAmountInclVAT: line.lineAmountInclVAT,
          postingDate: line.postingDate,
          sellToCustomerNo: line.sellToCustomerNo,
          itemCategoryCode: line.itemCategoryCode,
          accountabilityCenter: line.accountabilityCenter,
          orderNo: line.orderNo,
        }),
      ),
    };
  }

  if (
    type === "salesCrMemoLines" &&
    payload &&
    typeof payload === "object" &&
    Array.isArray((payload as { value?: unknown[] }).value)
  ) {
    return {
      value: (payload as { value: Record<string, unknown>[] }).value.map(
        (line) => ({
          documentNo: line.documentNo,
          lineNo: line.lineNo,
          itemNo: line.itemNo,
          description: line.description,
          quantity: line.quantity,
          unitOfMeasureCode: line.unitOfMeasureCode,
          unitPrice: line.unitPrice,
          lineAmountExclVAT: line.lineAmountExclVAT,
          lineAmountInclVAT: line.lineAmountInclVAT,
          postingDate: line.postingDate,
          sellToCustomerNo: line.sellToCustomerNo,
          returnReasonCode: line.returnReasonCode,
        }),
      ),
    };
  }

  if (
    type !== "custLedgEntries" ||
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as { value?: unknown[] }).value)
  ) {
    return payload;
  }

  return {
    value: (payload as { value: Record<string, unknown>[] }).value.map((entry) => ({
      open: entry.open,
      documentType: entry.documentType,
      postingDate: entry.postingDate,
      dueDate: entry.dueDate,
      salesLcy: entry.salesLcy,
      amountLcy: entry.amountLcy,
      remainingAmount: entry.remainingAmount,
      customerNo: entry.customerNo,
      sellToCustomerNo: entry.sellToCustomerNo,
      documentNo: entry.documentNo,
      description: entry.description,
    })),
  };
}

function payloadBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload));
}

async function upsertMirrorPayload(input: {
  company: CompanyKey;
  type: MirrorEntity;
  payload: unknown;
  syncedAt: string;
}): Promise<void> {
  const supabase = getSupabaseAdmin();
  const payload = input.payload as { value?: unknown[] };

  if (
    Array.isArray(payload.value) &&
    payload.value.length > MIRROR_CHUNK_SIZE &&
    payloadBytes(payload) > MAX_INLINE_PAYLOAD_BYTES
  ) {
    const chunks: Array<{ value: unknown[] }> = [];
    for (let i = 0; i < payload.value.length; i += MIRROR_CHUNK_SIZE) {
      chunks.push({ value: payload.value.slice(i, i + MIRROR_CHUNK_SIZE) });
    }

    const { error: markerError } = await supabase.from("bc_mirror").upsert({
      company: input.company,
      entity_type: input.type,
      payload: {
        chunked: true,
        chunks: chunks.length,
        totalCount: payload.value.length,
      },
      synced_at: input.syncedAt,
    });
    if (markerError) throw markerError;

    const { error: deleteError } = await supabase
      .from("bc_mirror_chunks")
      .delete()
      .eq("company", input.company)
      .eq("entity_type", input.type);
    if (deleteError) throw deleteError;

    const rows = chunks.map((chunk, index) => ({
      company: input.company,
      entity_type: input.type,
      chunk_index: index,
      payload: chunk,
      synced_at: input.syncedAt,
    }));

    for (let i = 0; i < rows.length; i += 25) {
      const { error } = await supabase
        .from("bc_mirror_chunks")
        .upsert(rows.slice(i, i + 25));
      if (error) throw error;
    }

    return;
  }

  const { error } = await supabase.from("bc_mirror").upsert({
    company: input.company,
    entity_type: input.type,
    payload: input.payload,
    synced_at: input.syncedAt,
  });
  if (error) throw error;
}

type CompanySyncResult = {
  company: CompanyKey;
  synced: string[];
  errors: { entity: string; error: string }[];
};

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (error && typeof error === "object") return JSON.stringify(error);
  return String(error);
}

async function syncCompany(): Promise<CompanySyncResult> {
  const supabase = getSupabaseAdmin();
  const company = getActiveCompany();
  const synced: string[] = [];
  const errors: { entity: string; error: string }[] = [];

  for (const { type, fetch } of readEntitiesForCompany(company)) {
    try {
      const payload = compactMirrorPayload(type, await fetch());
      const recordCount = Array.isArray((payload as { value?: unknown[] }).value)
        ? (payload as { value: unknown[] }).value.length
        : 1;

      const syncedAt = new Date().toISOString();
      await upsertMirrorPayload({
        company,
        type,
        payload,
        syncedAt,
      });

      if (
        type === "custLedgEntries" &&
        Array.isArray((payload as { value?: unknown[] }).value)
      ) {
        const branchCache = buildBranchSalesCache(
          (payload as { value: LedgerEntry[] }).value,
        );
        await saveBranchSalesCache(branchCache);
      }

      await supabase.from("bc_sync_meta").upsert({
        company,
        key: type,
        last_synced_at: syncedAt,
        record_count: recordCount,
        status: "ok",
        error: null,
      });

      synced.push(type);
    } catch (error) {
      const message = errorMessage(error);
      errors.push({ entity: type, error: message });
      await supabase.from("bc_sync_meta").upsert({
        company,
        key: type,
        last_synced_at: new Date().toISOString(),
        record_count: 0,
        status: "error",
        error: message,
      });
    }
  }

  if (!synced.includes("customers")) {
    try {
      const derived = await buildDerivedCustomersPayload();
      const recordCount = derived.value?.length ?? 0;
      if (recordCount > 0) {
        const syncedAt = new Date().toISOString();
        await upsertMirrorPayload({
          company,
          type: "customers",
          payload: derived,
          syncedAt,
        });
        await supabase.from("bc_sync_meta").upsert({
          company,
          key: "customers",
          last_synced_at: syncedAt,
          record_count: recordCount,
          status: "ok",
          error: "derived_from_mr_and_ledger",
        });
        synced.push("customers");
        errors.splice(
          errors.findIndex((row) => row.entity === "customers"),
          1,
        );
      }
    } catch (error) {
      const message = errorMessage(error);
      if (!errors.some((row) => row.entity === "customers")) {
        errors.push({ entity: "customers", error: message });
      }
    }
  }

  await supabase.from("bc_sync_meta").upsert({
    company,
    key: "full_sync",
    last_synced_at: new Date().toISOString(),
    record_count: synced.length,
    status: errors.length ? "partial" : "ok",
    error: errors.length ? JSON.stringify(errors) : null,
  });

  return { company, synced, errors };
}

export async function syncBcToSupabase(): Promise<{
  companies: CompanySyncResult[];
  synced: string[];
  errors: { company: CompanyKey; entity: string; error: string }[];
}> {
  const companies: CompanySyncResult[] = [];

  for (const config of listCompanies()) {
    const result = await runWithCompany(config.key, () => syncCompany());
    companies.push(result);
  }

  const synced = companies.flatMap((c) =>
    c.synced.map((entity) => `${c.company}:${entity}`),
  );
  const errors = companies.flatMap((c) =>
    c.errors.map((e) => ({ company: c.company, ...e })),
  );

  return { companies, synced, errors };
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
          company: getActiveCompany(),
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
    const message = errorMessage(error);
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
    .select("id, action_type, payload, company")
    .eq("status", "pending")
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;

  let processed = 0;
  let failed = 0;

  for (const item of pending ?? []) {
    await runWithCompany(item.company, () =>
      processQueueItem(
        item.id,
        item.action_type,
        item.payload as Record<string, unknown>,
      ),
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
