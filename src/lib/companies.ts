export type CompanyKey = "chocodelight" | "saurabhfood";

export type CompanyConfig = {
  key: CompanyKey;
  displayName: string;
  baseUrl: string;
  apiPath: string;
  odataPath: string;
  companyId: string;
  odataCompany: string;
  username: string;
  password: string;
  /** OData codeunit endpoint names (differ per BC deployment). */
  codeunits: {
    salesPost: string;
    getPendingItemToSell: string;
    lockSales: string;
  };
  /** Writes/posting verified against production for this company. */
  writesEnabled: boolean;
};

export const DEFAULT_COMPANY: CompanyKey = "chocodelight";

const COMPANIES: Record<CompanyKey, CompanyConfig> = {
  chocodelight: {
    key: "chocodelight",
    displayName: "Choco Delight Pvt. Ltd",
    baseUrl: process.env.BC_BASE_URL ?? "http://10.11.29.42:8848/ChocoDelight",
    apiPath: "/api/biz/customapi/v1.0",
    odataPath: "/ODataV4",
    companyId:
      process.env.BC_COMPANY_ID ?? "058005c0-1940-ef11-aed1-2cea7fe9e541",
    odataCompany: process.env.BC_ODATA_COMPANY ?? "Choco Delight Pvt. Ltd",
    username: process.env.BC_USERNAME ?? "klnav\\mobileapp",
    password: process.env.BC_PASSWORD ?? "",
    codeunits: {
      salesPost: "codeunitapi_SalesPost",
      getPendingItemToSell: "codeunitapi_GetPendingItemToSell",
      lockSales: "codeunitapi_locksales",
    },
    writesEnabled: true,
  },
  saurabhfood: {
    key: "saurabhfood",
    displayName: "Saurabh Food Products",
    baseUrl:
      process.env.BC_SAURABHFOOD_BASE_URL ??
      "http://10.11.29.42:8248/saurabhfood",
    apiPath: "/api/biz/customapi/v1.0",
    odataPath: "/ODataV4",
    companyId:
      process.env.BC_SAURABHFOOD_COMPANY_ID ??
      "5400b5d1-8b19-ef11-aed1-2cea7fe9e541",
    // Reads use the live company GUID above. Keep writes disabled until the
    // production OData codeunits are confirmed end-to-end.
    odataCompany:
      process.env.BC_SAURABHFOOD_ODATA_COMPANY ?? "SAURABH FOOD LIVE",
    username: process.env.BC_SAURABHFOOD_USERNAME ?? "klnav\\mobileapp",
    password: process.env.BC_SAURABHFOOD_PASSWORD ?? "",
    codeunits: {
      salesPost: "codeunit_SalesPost",
      getPendingItemToSell: "codeunitapi_GetPendingItemToSell",
      lockSales: "codeunitapi_locksales",
    },
    // OData post examples target a test DB; keep writes off until confirmed.
    writesEnabled: process.env.BC_SAURABHFOOD_WRITES_ENABLED === "true",
  },
};

export function isCompanyKey(value: unknown): value is CompanyKey {
  return value === "chocodelight" || value === "saurabhfood";
}

export function normalizeCompanyKey(value: unknown): CompanyKey {
  return isCompanyKey(value) ? value : DEFAULT_COMPANY;
}

export function getCompany(key: CompanyKey): CompanyConfig {
  return COMPANIES[key];
}

export function listCompanies(): CompanyConfig[] {
  return Object.values(COMPANIES);
}
