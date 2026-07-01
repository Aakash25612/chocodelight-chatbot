import { AsyncLocalStorage } from "node:async_hooks";
import type { MirrorEntity } from "./bc-mirror";
import { getActiveCompany } from "./company-context";

const storage = new AsyncLocalStorage<Map<string, unknown>>();

/** Dedupe Supabase mirror reads within one API request (e.g. multiple Gemini tool calls). */
export function runWithMirrorCache<T>(fn: () => T): T {
  return storage.run(new Map(), fn);
}

export function getMirrorCacheStore(): Map<string, unknown> | undefined {
  return storage.getStore();
}

export function mirrorCacheKey(entityType: MirrorEntity): string {
  return `${getActiveCompany()}:${entityType}`;
}
