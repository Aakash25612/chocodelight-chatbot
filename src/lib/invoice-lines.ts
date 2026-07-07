/** Flatten posted sales invoice / credit memo lines from BC header expand payloads. */

type InvoiceHeader = {
  no?: string;
  postingDate?: string;
  sellToCustomerNo?: string;
  billToCustomerNo?: string;
  dueDate?: string;
  locationCode?: string;
  salespersonCode?: string;
  salesInvoiceLines?: InvoiceLine[];
};

type CrMemoHeader = {
  no?: string;
  postingDate?: string;
  sellToCustomerNo?: string;
  billToCustomerNo?: string;
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
  lineAmountExclVAT: number;
  postingDate: string;
  sellToCustomerNo: string;
  itemCategoryCode: string;
  accountabilityCenter: string;
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
  lineAmountExclVAT: number;
  postingDate: string;
  sellToCustomerNo: string;
  returnReasonCode: string;
};

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
        lineAmountExclVAT: Number(
          line.lineAmountExclVAT ?? line.amount ?? quantity * Number(line.unitPrice ?? 0),
        ),
        postingDate: String(line.postingDate ?? header.postingDate ?? ""),
        sellToCustomerNo: String(
          line.sellToCustomerNo ?? header.sellToCustomerNo ?? "",
        ),
        itemCategoryCode: String(line.itemCategoryCode ?? ""),
        accountabilityCenter: String(line.accountabilityCenter ?? ""),
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
        lineAmountExclVAT: Number(
          line.lineAmountExclVAT ?? line.amount ?? quantity * Number(line.unitPrice ?? 0),
        ),
        postingDate: String(line.postingDate ?? header.postingDate ?? ""),
        sellToCustomerNo: String(
          line.sellToCustomerNo ?? header.sellToCustomerNo ?? "",
        ),
        returnReasonCode: String(line.returnReasonCode ?? ""),
      });
    }
  }

  return rows;
}
