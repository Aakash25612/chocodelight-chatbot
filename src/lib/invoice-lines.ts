/** Flatten posted sales invoice / credit memo lines from BC header expand payloads. */

import { branchCodeFromPostedDocument } from "./branches";
import type { CompanyKey } from "./companies";

type InvoiceHeader = {
  no?: string;
  postingDate?: string;
  sellToCustomerNo?: string;
  billToCustomerNo?: string;
  dueDate?: string;
  locationCode?: string;
  shortcutDimension1Code?: string;
  accountabilityCenter?: string;
  orderNo?: string;
  salespersonCode?: string;
  salesInvoiceLines?: InvoiceLine[];
};

type CrMemoHeader = {
  no?: string;
  postingDate?: string;
  sellToCustomerNo?: string;
  billToCustomerNo?: string;
  locationCode?: string;
  shortcutDimension1Code?: string;
  accountabilityCenter?: string;
  salespersonCode?: string;
  salesCrMemoLines?: CrMemoLine[];
};

type InvoiceLine = {
  documentNo?: string;
  lineNo?: number;
  type?: string;
  no?: string;
  description?: string;
  quantity?: number;
  unitOfMeasureCode?: string;
  unitPrice?: number;
  amount?: number;
  amountIncludingVAT?: number;
  lineAmountExclVAT?: number;
  postingDate?: string;
  sellToCustomerNo?: string;
  itemCategoryCode?: string;
  accountabilityCenter?: string;
  orderNo?: string;
};

type CrMemoLine = {
  documentNo?: string;
  lineNo?: number;
  type?: string;
  no?: string;
  description?: string;
  quantity?: number;
  unitOfMeasureCode?: string;
  unitPrice?: number;
  amount?: number;
  amountIncludingVAT?: number;
  lineAmountExclVAT?: number;
  postingDate?: string;
  sellToCustomerNo?: string;
  returnReasonCode?: string;
};

export type FlatInvoiceLine = {
  documentNo: string;
  lineNo: number;
  lineType: string;
  itemNo: string;
  description: string;
  quantity: number;
  unitOfMeasureCode: string;
  unitPrice: number;
  /** BC line.amount — matches customer-ledger salesLcy for revenue totals. */
  lineAmount: number;
  lineAmountExclVAT: number;
  lineAmountInclVAT: number;
  postingDate: string;
  sellToCustomerNo: string;
  itemCategoryCode: string;
  accountabilityCenter: string;
  salespersonCode: string;
  orderNo: string;
};

export type FlatCrMemoLine = {
  documentNo: string;
  lineNo: number;
  lineType: string;
  itemNo: string;
  description: string;
  quantity: number;
  unitOfMeasureCode: string;
  unitPrice: number;
  lineAmount: number;
  lineAmountExclVAT: number;
  lineAmountInclVAT: number;
  postingDate: string;
  sellToCustomerNo: string;
  returnReasonCode: string;
  accountabilityCenter: string;
  salespersonCode: string;
};

export type PostedSalesDocument = {
  documentNo: string;
  postingDate: string;
  branchCode: string;
  /** BC line.amount total (excl VAT / ledger salesLcy basis). */
  salesAmount: number;
  /** BC amountIncludingVAT total (incl VAT — preferred for display). */
  salesAmountIncludingTax: number;
  documentKind: "invoice" | "credit_memo";
};

function documentKey(header: {
  no?: string;
  orderNo?: string;
  postingDate?: string;
}): string {
  const no = String(header.no ?? "").trim();
  if (no && no !== "0.00") return no;
  const orderNo = String(header.orderNo ?? "").trim();
  if (orderNo) return orderNo;
  return `${no || "unknown"}:${header.postingDate ?? ""}`;
}

function sumLineAmounts(lines: Array<{ amount?: number }>): number {
  return lines.reduce((sum, line) => sum + Number(line.amount ?? 0), 0);
}

function sumLineAmountsIncl(
  lines: Array<{ amountIncludingVAT?: number; amount?: number }>,
): number {
  return lines.reduce(
    (sum, line) => sum + Number(line.amountIncludingVAT ?? line.amount ?? 0),
    0,
  );
}

export function flattenPostedSalesDocuments(
  invoices: InvoiceHeader[],
  creditMemos: CrMemoHeader[],
  company?: CompanyKey,
): PostedSalesDocument[] {
  const rows: PostedSalesDocument[] = [];

  for (const header of invoices) {
    const documentNo = documentKey(header);
    const branchCode = branchCodeFromPostedDocument({
      documentNo,
      accountabilityCenter: header.accountabilityCenter,
      locationCode: header.locationCode,
      shortcutDimension1Code: header.shortcutDimension1Code,
      company,
    });
    if (!branchCode) continue;

    rows.push({
      documentNo,
      postingDate: String(header.postingDate ?? ""),
      branchCode,
      salesAmount: sumLineAmounts(header.salesInvoiceLines ?? []),
      salesAmountIncludingTax: sumLineAmountsIncl(
        header.salesInvoiceLines ?? [],
      ),
      documentKind: "invoice",
    });
  }

  for (const header of creditMemos) {
    const documentNo = documentKey(header);
    const branchCode = branchCodeFromPostedDocument({
      documentNo,
      accountabilityCenter: header.accountabilityCenter,
      locationCode: header.locationCode,
      shortcutDimension1Code: header.shortcutDimension1Code,
      company,
    });
    if (!branchCode) continue;

    rows.push({
      documentNo,
      postingDate: String(header.postingDate ?? ""),
      branchCode,
      salesAmount: sumLineAmounts(header.salesCrMemoLines ?? []),
      salesAmountIncludingTax: sumLineAmountsIncl(header.salesCrMemoLines ?? []),
      documentKind: "credit_memo",
    });
  }

  return rows;
}

function isItemLine(type?: string, itemNo?: string): boolean {
  const normalized = String(type ?? "").trim().toLowerCase();
  if (normalized === "item") return Boolean(itemNo?.trim());
  return Boolean(itemNo?.trim());
}

export function flattenSalesInvoiceLines(
  headers: InvoiceHeader[],
): FlatInvoiceLine[] {
  const rows: FlatInvoiceLine[] = [];

  for (const header of headers) {
    for (const line of header.salesInvoiceLines ?? []) {
      const itemNo = String(line.no ?? "").trim();
      if (!isItemLine(line.type, itemNo)) continue;

      const quantity = Number(line.quantity ?? 0);
      if (quantity === 0) continue;

      rows.push({
        documentNo: String(line.documentNo ?? header.no ?? ""),
        lineNo: Number(line.lineNo ?? 0),
        lineType: String(line.type ?? "Item"),
        itemNo,
        description: String(line.description ?? ""),
        quantity,
        unitOfMeasureCode: String(line.unitOfMeasureCode ?? ""),
        unitPrice: Number(line.unitPrice ?? 0),
        lineAmount: Number(
          line.amount ?? quantity * Number(line.unitPrice ?? 0),
        ),
        lineAmountExclVAT: Number(
          line.lineAmountExclVAT ?? line.amount ?? quantity * Number(line.unitPrice ?? 0),
        ),
        lineAmountInclVAT: Number(
          line.amountIncludingVAT ??
            line.amount ??
            quantity * Number(line.unitPrice ?? 0),
        ),
        postingDate: String(line.postingDate ?? header.postingDate ?? ""),
        sellToCustomerNo: String(
          line.sellToCustomerNo ?? header.sellToCustomerNo ?? "",
        ),
        itemCategoryCode: String(line.itemCategoryCode ?? ""),
        accountabilityCenter: String(
          line.accountabilityCenter ?? header.accountabilityCenter ?? "",
        ),
        salespersonCode: String(header.salespersonCode ?? ""),
        orderNo: String(line.orderNo ?? ""),
      });
    }
  }

  return rows;
}

export function flattenSalesCrMemoLines(headers: CrMemoHeader[]): FlatCrMemoLine[] {
  const rows: FlatCrMemoLine[] = [];

  for (const header of headers) {
    for (const line of header.salesCrMemoLines ?? []) {
      const itemNo = String(line.no ?? "").trim();
      if (!isItemLine(line.type, itemNo)) continue;

      const quantity = Number(line.quantity ?? 0);
      if (quantity === 0) continue;

      rows.push({
        documentNo: String(line.documentNo ?? header.no ?? ""),
        lineNo: Number(line.lineNo ?? 0),
        lineType: String(line.type ?? "Item"),
        itemNo,
        description: String(line.description ?? ""),
        quantity,
        unitOfMeasureCode: String(line.unitOfMeasureCode ?? ""),
        unitPrice: Number(line.unitPrice ?? 0),
        lineAmount: Number(
          line.amount ?? quantity * Number(line.unitPrice ?? 0),
        ),
        lineAmountExclVAT: Number(
          line.lineAmountExclVAT ?? line.amount ?? quantity * Number(line.unitPrice ?? 0),
        ),
        lineAmountInclVAT: Number(
          line.amountIncludingVAT ??
            line.amount ??
            quantity * Number(line.unitPrice ?? 0),
        ),
        postingDate: String(line.postingDate ?? header.postingDate ?? ""),
        sellToCustomerNo: String(
          line.sellToCustomerNo ?? header.sellToCustomerNo ?? "",
        ),
        returnReasonCode: String(line.returnReasonCode ?? ""),
        accountabilityCenter: String(header.accountabilityCenter ?? ""),
        salespersonCode: String(header.salespersonCode ?? ""),
      });
    }
  }

  return rows;
}
