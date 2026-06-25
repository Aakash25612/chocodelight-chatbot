export const bcConfig = {
  baseUrl: process.env.BC_BASE_URL ?? "http://10.11.29.42:8848/ChocoDelight",
  apiPath: "/api/biz/customapi/v1.0",
  odataPath: "/ODataV4",
  companyId:
    process.env.BC_COMPANY_ID ?? "058005c0-1940-ef11-aed1-2cea7fe9e541",
  odataCompany: process.env.BC_ODATA_COMPANY ?? "Choco Delight Pvt. Ltd",
  username: process.env.BC_USERNAME ?? "klnav\\mobileapp",
  password: process.env.BC_PASSWORD ?? "",
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
  return `${bcConfig.baseUrl}${bcConfig.apiPath}`;
}

export function getODataBase(): string {
  return `${bcConfig.baseUrl}${bcConfig.odataPath}`;
}

export function getCompanyPath(suffix = ""): string {
  return `${getApiBase()}/companies(${bcConfig.companyId})${suffix}`;
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
