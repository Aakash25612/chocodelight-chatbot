/**
 * Convert BC quantities to metric tons using synced item UOM rows.
 * qtyPerUnitofMeasure = how many base units (usually KG) one sales UOM equals.
 * MT = (quantity × qtyPerUnit) / 1000 when base is KG (or already MT/TON).
 */

import { getMirror } from "./bc-mirror";

type ItemRow = {
  number?: string;
  baseUnitOfMeasure?: { code?: string } | string;
  salesUnitOfMeasure?: string;
};

type UomRow = {
  itemNo?: string;
  code?: string;
  qtyPerUnitofMeasure?: number;
};

type MirrorPayload<T> = {
  value?: T[];
  error?: string;
};

export type MetricTonResult = {
  metricTons: number | null;
  baseKg: number | null;
  baseUnit: string;
  salesUnit: string;
  qtyPerUnit: number;
  convertible: boolean;
  reason?: string;
};

function uomCode(value: unknown): string {
  if (!value) return "";
  if (typeof value === "string") return value.trim().toUpperCase();
  if (typeof value === "object" && value && "code" in value) {
    return String((value as { code?: string }).code ?? "")
      .trim()
      .toUpperCase();
  }
  return "";
}

function isWeightBase(code: string): boolean {
  const c = code.toUpperCase();
  return c === "KG" || c === "KGS" || c === "KILOGRAM" || c === "G" || c === "GM" || c === "GRAM";
}

function isAlreadyMetricTon(code: string): boolean {
  const c = code.toUpperCase();
  return c === "MT" || c === "MTS" || c === "TON" || c === "TONS" || c === "TONNE" || c === "TONNES";
}

function baseToKgFactor(baseUnit: string): number | null {
  const c = baseUnit.toUpperCase();
  if (c === "KG" || c === "KGS" || c === "KILOGRAM") return 1;
  if (c === "G" || c === "GM" || c === "GRAM") return 0.001;
  if (isAlreadyMetricTon(c)) return 1000;
  return null;
}

export type UomIndex = {
  /** itemNo → base unit code */
  baseUnit: Map<string, string>;
  /** itemNo → preferred sales unit code */
  salesUnit: Map<string, string>;
  /** itemNo|UOM → qty per unit of measure (in base units) */
  qtyPer: Map<string, number>;
};

export async function loadUomIndex(): Promise<UomIndex> {
  const [itemsPayload, uomsPayload] = await Promise.all([
    getMirror("items") as Promise<MirrorPayload<ItemRow>>,
    getMirror("uoms") as Promise<MirrorPayload<UomRow>>,
  ]);

  const baseUnit = new Map<string, string>();
  const salesUnit = new Map<string, string>();
  const qtyPer = new Map<string, number>();

  for (const item of itemsPayload.value ?? []) {
    const no = String(item.number ?? "").trim();
    if (!no) continue;
    baseUnit.set(no, uomCode(item.baseUnitOfMeasure) || "KG");
    salesUnit.set(no, uomCode(item.salesUnitOfMeasure) || uomCode(item.baseUnitOfMeasure) || "KG");
  }

  for (const row of uomsPayload.value ?? []) {
    const no = String(row.itemNo ?? "").trim();
    const code = uomCode(row.code);
    if (!no || !code) continue;
    const qty = Number(row.qtyPerUnitofMeasure ?? 0);
    if (qty > 0) qtyPer.set(`${no}|${code}`, qty);
  }

  return { baseUnit, salesUnit, qtyPer };
}

/**
 * Convert a quantity in the item's sales (or explicit) UOM to metric tons.
 */
export function quantityToMetricTons(
  index: UomIndex,
  itemNo: string,
  quantity: number,
  unitOfMeasureCode?: string,
): MetricTonResult {
  const no = String(itemNo ?? "").trim();
  const qty = Number(quantity ?? 0);
  const base = index.baseUnit.get(no) || "KG";
  const sales =
    uomCode(unitOfMeasureCode) || index.salesUnit.get(no) || base;
  const qtyPer = index.qtyPer.get(`${no}|${sales}`) ?? (sales === base ? 1 : 0);

  if (!no) {
    return {
      metricTons: null,
      baseKg: null,
      baseUnit: base,
      salesUnit: sales,
      qtyPerUnit: qtyPer,
      convertible: false,
      reason: "Missing item number",
    };
  }

  if (isAlreadyMetricTon(sales) || isAlreadyMetricTon(base)) {
    const mt =
      isAlreadyMetricTon(sales)
        ? qty
        : qty * (qtyPer || 1);
    return {
      metricTons: roundMt(mt),
      baseKg: roundMt(mt * 1000),
      baseUnit: base,
      salesUnit: sales,
      qtyPerUnit: qtyPer || 1,
      convertible: true,
    };
  }

  const kgFactor = baseToKgFactor(base);
  if (kgFactor == null) {
    return {
      metricTons: null,
      baseKg: null,
      baseUnit: base,
      salesUnit: sales,
      qtyPerUnit: qtyPer,
      convertible: false,
      reason: `Base unit ${base} is not weight — cannot convert to MT`,
    };
  }

  if (qtyPer <= 0) {
    return {
      metricTons: null,
      baseKg: null,
      baseUnit: base,
      salesUnit: sales,
      qtyPerUnit: qtyPer,
      convertible: false,
      reason: `No UOM conversion for ${no} / ${sales}`,
    };
  }

  const baseQty = qty * qtyPer;
  const kg = baseQty * kgFactor;
  return {
    metricTons: roundMt(kg / 1000),
    baseKg: roundMt(kg),
    baseUnit: base,
    salesUnit: sales,
    qtyPerUnit: qtyPer,
    convertible: true,
  };
}

function roundMt(value: number): number {
  return Math.round(value * 10000) / 10000;
}

export function formatMetricTons(value: number | null | undefined): string {
  if (value == null || Number.isNaN(value)) return "—";
  return value.toLocaleString("en-IN", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 4,
  });
}
