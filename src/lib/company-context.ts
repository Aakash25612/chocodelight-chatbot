import { AsyncLocalStorage } from "node:async_hooks";
import {
  DEFAULT_COMPANY,
  type CompanyKey,
  normalizeCompanyKey,
} from "./companies";

type CompanyStore = { company: CompanyKey };

const storage = new AsyncLocalStorage<CompanyStore>();

/** Run `fn` with the given company as the request-scoped active company. */
export function runWithCompany<T>(company: unknown, fn: () => T): T {
  return storage.run({ company: normalizeCompanyKey(company) }, fn);
}

/** Active company for the current async context (defaults to Choco Delight). */
export function getActiveCompany(): CompanyKey {
  return storage.getStore()?.company ?? DEFAULT_COMPANY;
}
