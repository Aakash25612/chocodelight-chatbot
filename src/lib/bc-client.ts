import { NtlmClient } from "axios-ntlm";
import type { AxiosInstance } from "axios";
import { bcConfig, getApiBase, getCompanyPath, getODataBase } from "./config";

function parseNtlmCredentials(username: string, password: string) {
  const parts = username.split("\\");
  if (parts.length === 2) {
    return { domain: parts[0], username: parts[1], password };
  }
  return { domain: "", username, password };
}

let client: AxiosInstance | null = null;

function getClient(): AxiosInstance {
  if (!client) {
    const creds = parseNtlmCredentials(bcConfig.username, bcConfig.password);
    client = NtlmClient({
      username: creds.username,
      password: creds.password,
      domain: creds.domain,
      workstation: "",
    });
  }
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

export const bcApi = {
  getCompanies: () => request("GET", `${getApiBase()}/companies`),

  getCustomers: () => request("GET", `${getCompanyPath()}/customers`),

  getCustomerLedgerEntries: () =>
    request("GET", `${getCompanyPath()}/custLedgEntries`),

  getMr: () => request("GET", `${getCompanyPath()}/mr`),

  getSalespersons: () => request("GET", `${getCompanyPath()}/salespersons`),

  getItems: () => request("GET", `${getCompanyPath()}/items`),

  getUoms: (filter?: string) => {
    const url = filter
      ? `${getCompanyPath()}/uoms?$filter=${encodeURIComponent(filter)}`
      : `${getCompanyPath()}/uoms`;
    return request("GET", url);
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
    request(
      "POST",
      `${getODataBase()}/codeunitapi_SalesPost?Company=${encodeURIComponent(bcConfig.odataCompany)}`,
      { documentNo },
    ),

  getPendingItemsToSell: (customerNo: string, fileName = "") =>
    request(
      "POST",
      `${getODataBase()}/codeunitapi_GetPendingItemToSell?Company=${encodeURIComponent(bcConfig.odataCompany)}`,
      { customerNo, fileName },
    ),

  lockSalesOrder: (documentNo: string) =>
    request(
      "POST",
      `${getODataBase()}/codeunitapi_locksales?Company=${encodeURIComponent(bcConfig.odataCompany)}`,
      { documentNo },
    ),
};
