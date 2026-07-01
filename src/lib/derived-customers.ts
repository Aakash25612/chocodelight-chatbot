import { getMirror } from "./bc-mirror";

type LedgerEntry = {
  open?: boolean;
  documentType?: string;
  postingDate?: string;
  dueDate?: string;
  salesLcy?: number;
  remainingAmount?: number;
  customerNo?: string;
  sellToCustomerNo?: string;
};

type MrRecord = {
  customerNo?: string;
  customerName?: string;
};

export type CustomerRecord = {
  number?: string;
  displayName?: string;
  phoneNumber?: string;
  balance?: number;
  overdueAmount?: number;
  totalSalesExcludingTax?: number;
  blocked?: boolean;
};

type MirrorPayload<T> = {
  value?: T[];
  _syncedAt?: string;
  error?: string;
  source?: string;
  note?: string;
};

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

function entryCustomerNo(entry: LedgerEntry): string {
  return entry.customerNo ?? entry.sellToCustomerNo ?? "";
}

/**
 * Build a customer master substitute from synced MR + ledger when BC
 * customers API is unavailable (e.g. Saurabh permission block).
 */
export async function buildDerivedCustomersPayload(): Promise<
  MirrorPayload<CustomerRecord>
> {
  const [mrPayload, ledgerPayload] = await Promise.all([
    getMirror("mr") as Promise<MirrorPayload<MrRecord>>,
    getMirror("custLedgEntries") as Promise<MirrorPayload<LedgerEntry>>,
  ]);

  if (mrPayload.error && ledgerPayload.error) {
    return { error: mrPayload.error || ledgerPayload.error };
  }

  const names = new Map<string, string>();
  for (const row of mrPayload.value ?? []) {
    const customerNo = row.customerNo?.trim();
    const customerName = row.customerName?.trim();
    if (!customerNo || !customerName) continue;
    const existing = names.get(customerNo);
    if (!existing || customerName.length > existing.length) {
      names.set(customerNo, customerName);
    }
  }

  const stats = new Map<
    string,
    { balance: number; overdue: number; sales: number }
  >();
  const now = new Date();

  for (const entry of ledgerPayload.value ?? []) {
    const customerNo = entryCustomerNo(entry);
    if (!customerNo) continue;

    const agg =
      stats.get(customerNo) ?? { balance: 0, overdue: 0, sales: 0 };

    if (entry.documentType === "Invoice") {
      agg.sales += Number(entry.salesLcy ?? 0);
    }

    const remaining = Number(entry.remainingAmount ?? 0);
    if (entry.open && remaining > 0) {
      agg.balance += remaining;
      const due = entry.dueDate ? new Date(entry.dueDate) : null;
      if (due && !Number.isNaN(due.getTime()) && due < now) {
        agg.overdue += remaining;
      }
    }

    stats.set(customerNo, agg);
  }

  const allNos = new Set<string>([...names.keys(), ...stats.keys()]);
  for (const entry of ledgerPayload.value ?? []) {
    const customerNo = entryCustomerNo(entry);
    if (customerNo) allNos.add(customerNo);
  }

  const value = [...allNos]
    .sort((a, b) => a.localeCompare(b))
    .map((customerNo) => {
      const agg = stats.get(customerNo) ?? { balance: 0, overdue: 0, sales: 0 };
      return {
        number: customerNo,
        displayName: names.get(customerNo) ?? customerNo,
        phoneNumber: "",
        balance: round(agg.balance),
        overdueAmount: round(agg.overdue),
        totalSalesExcludingTax: round(agg.sales),
        blocked: false,
      };
    });

  return {
    source: "derived_mr_ledger",
    note:
      "Customer list built from MR customerName + open ledger balances because BC customers API is unavailable.",
    value,
    _syncedAt: ledgerPayload._syncedAt ?? mrPayload._syncedAt,
  };
}

/** Load customers from mirror, falling back to derived MR+ledger catalog. */
export async function loadCustomersPayload(): Promise<
  MirrorPayload<CustomerRecord>
> {
  const raw = (await getMirror("customers")) as MirrorPayload<CustomerRecord>;
  if (!raw.error && (raw.value?.length ?? 0) > 0) {
    return raw;
  }

  const derived = await buildDerivedCustomersPayload();
  if ((derived.value?.length ?? 0) > 0) {
    return derived;
  }

  return raw.error ? raw : derived;
}
