import { NtlmClient } from "axios-ntlm";
import type { AxiosInstance } from "axios";
import { getApiBase, getBcConfig, getCompanyPath, getODataBase } from "./config";
import { getActiveCompany } from "./company-context";
import type { CompanyKey } from "./companies";

function parseNtlmCredentials(username: string, password: string) {
  const parts = username.split("\\");
  if (parts.length === 2) {
    return { domain: parts[0], username: parts[1], password };
  }
  return { domain: "", username, password };
}

const clients = new Map<CompanyKey, AxiosInstance>();

function getClient(): AxiosInstance {
  const company = getActiveCompany();
  const existing = clients.get(company);
  if (existing) return existing;

  const config = getBcConfig();
  const creds = parseNtlmCredentials(config.username, config.password);
  const client = NtlmClient({
    username: creds.username,
    password: creds.password,
    domain: creds.domain,
    workstation: "",
  });
  clients.set(company, client);
  return client;
}

async function request<T>(
  method: "GET" | "POST",
  url: string,
  data?: unknown,
): Promise<T> {
  const http = getClient();
  const response = await http.request<T>({
    method,
    url,
    data,
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    timeout: 60000,
  });
  return response.data;
}

async function requestAll(url: string): Promise<{ value: unknown[] }> {
  const rows: unknown[] = [];
  let nextUrl: string | undefined = url;

  while (nextUrl) {
    const page = (await request("GET", nextUrl)) as {
      value?: unknown[];
      "@odata.nextLink"?: string;
    };
    if (Array.isArray(page.value)) rows.push(...page.value);
    nextUrl = page["@odata.nextLink"];
  }

  return { value: rows };
}

function odataUrl(codeunit: string): string {
  const config = getBcConfig();
  return `${getODataBase()}/${codeunit}?Company=${encodeURIComponent(config.odataCompany)}`;
}

export const bcApi = {
  getCompanies: () => request("GET", `${getApiBase()}/companies`),

  getCustomers: () => requestAll(`${getCompanyPath()}/customers`),

  getCustomerLedgerEntries: () =>
    requestAll(`${getCompanyPath()}/custLedgEntries`),

  getMr: () => requestAll(`${getCompanyPath()}/mr`),

  getSalespersons: () => requestAll(`${getCompanyPath()}/salespersons`),

  getItems: () => requestAll(`${getCompanyPath()}/items`),

  getSalesOrders: () =>
    requestAll(`${getCompanyPath()}/salesOrders`),

  getSalesOrderLines: () =>
    requestAll(`${getCompanyPath()}/salesOrderLines`),

  /** Posted sales invoices with lines (Choco Delight custom API). */
  getSalesInvoiceHeaders: () =>
    requestAll(
      `${getCompanyPath()}/salesInvoiceHeaders?$expand=salesInvoiceLines`,
    ),

  /** Posted sales credit memos with lines (Choco Delight custom API). */
  getSalesCrMemos: () =>
    requestAll(`${getCompanyPath()}/salesCrMemos?$expand=salesCrMemoLines`),

  getUoms: (filter?: string) => {
    const url = filter
      ? `${getCompanyPath()}/uoms?$filter=${encodeURIComponent(filter)}`
      : `${getCompanyPath()}/uoms`;
    return requestAll(url);
  },

  getApiCatalog: () => request("GET", `${getApiBase()}/`),

  createSalesOrder: (order: Record<string, unknown>) =>
    request(
      "POST",
      `${getCompanyPath()}/salesOrders?$expand=salesOrderLines`,
      order,
    ),

  createGenJournalLine: (line: Record<string, unknown>) =>
    request("POST", `${getCompanyPath()}/genJournalLines`, line),

  postSalesDocument: (documentNo: string) =>
    request("POST", odataUrl(getBcConfig().codeunits.salesPost), {
      documentNo,
    }),

  getPendingItemsToSell: (customerNo: string, fileName = "") =>
    request("POST", odataUrl(getBcConfig().codeunits.getPendingItemToSell), {
      customerNo,
      fileName,
    }),

  lockSalesOrder: (documentNo: string) =>
    request("POST", odataUrl(getBcConfig().codeunits.lockSales), {
      documentNo,
    }),
};
