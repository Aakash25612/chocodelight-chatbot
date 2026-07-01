import { getCompany } from "./companies";
import { getActiveCompany } from "./company-context";

/** Connection settings for the request-scoped active company. */
export function getBcConfig() {
  return getCompany(getActiveCompany());
}

/**
 * Back-compat accessor. Resolves to the active company's settings.
 * Prefer `getBcConfig()` in new code.
 */
export const bcConfig = {
  get baseUrl() {
    return getBcConfig().baseUrl;
  },
  get apiPath() {
    return getBcConfig().apiPath;
  },
  get odataPath() {
    return getBcConfig().odataPath;
  },
  get companyId() {
    return getBcConfig().companyId;
  },
  get odataCompany() {
    return getBcConfig().odataCompany;
  },
  get username() {
    return getBcConfig().username;
  },
  get password() {
    return getBcConfig().password;
  },
};

export const geminiConfig = {
  apiKey: process.env.GEMINI_API_KEY ?? "",
  model: process.env.GEMINI_MODEL ?? "gemini-3.1-flash-lite",
};

/** When true, reads come from Supabase mirror; writes are queued. */
export const useSupabaseMirror =
  process.env.BC_DATA_SOURCE === "supabase" ||
  process.env.NEXT_PUBLIC_BC_DATA_SOURCE === "supabase";

export const syncConfig = {
  secret: process.env.SYNC_SECRET ?? "",
};

export function getApiBase(): string {
  const config = getBcConfig();
  return `${config.baseUrl}${config.apiPath}`;
}

export function getODataBase(): string {
  const config = getBcConfig();
  return `${config.baseUrl}${config.odataPath}`;
}

export function getCompanyPath(suffix = ""): string {
  return `${getApiBase()}/companies(${getBcConfig().companyId})${suffix}`;
}

export function getChatApiUrl(): string {
  if (process.env.NEXT_PUBLIC_CHAT_API_URL) {
    return process.env.NEXT_PUBLIC_CHAT_API_URL;
  }
  if (
    process.env.NEXT_PUBLIC_USE_EDGE_CHAT === "true" &&
    process.env.NEXT_PUBLIC_SUPABASE_URL
  ) {
    return `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/chat`;
  }
  return "/api/chat";
}
