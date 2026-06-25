import NepaliDate from "nepali-date-converter";

/** Bikram Sambat month names, indexed 0-11 (0 = Baisakh). */
export const BS_MONTHS = [
  "Baisakh",
  "Jestha",
  "Asar",
  "Shrawan",
  "Bhadra",
  "Aswin",
  "Kartik",
  "Mangsir",
  "Poush",
  "Magh",
  "Falgun",
  "Chaitra",
] as const;

/**
 * Common spelling variants users may type, mapped to the canonical month index.
 */
const BS_MONTH_ALIASES: Record<string, number> = {
  baisakh: 0,
  baishakh: 0,
  baisak: 0,
  jestha: 1,
  jeth: 1,
  jeth_: 1,
  asar: 2,
  ashar: 2,
  ashadh: 2,
  ashad: 2,
  shrawan: 3,
  shrawn: 3,
  sawan: 3,
  saun: 3,
  bhadra: 4,
  bhadau: 4,
  bhador: 4,
  aswin: 5,
  ashwin: 5,
  asoj: 5,
  kartik: 6,
  karthik: 6,
  mangsir: 7,
  mangshir: 7,
  marg: 7,
  poush: 8,
  push: 8,
  paush: 8,
  magh: 9,
  falgun: 10,
  phalgun: 10,
  fagun: 10,
  chaitra: 11,
  chait: 11,
};

export type BsParts = {
  year: number;
  /** 0-based month index (0 = Baisakh). */
  month: number;
  monthName: string;
  date: number;
};

/** Convert a JS Date (AD) into Bikram Sambat parts. Returns null if invalid. */
export function toBs(date: Date): BsParts | null {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) return null;
  try {
    const nd = new NepaliDate(date);
    const bs = nd.getBS();
    return {
      year: bs.year,
      month: bs.month,
      monthName: BS_MONTHS[bs.month] ?? String(bs.month + 1),
      date: bs.date,
    };
  } catch {
    return null;
  }
}

export type NepaliFiscalYear = {
  /** BS year in which the fiscal year starts (Shrawan). */
  startYear: number;
  endYear: number;
  /** Human label, e.g. "2082/83". */
  label: string;
};

/**
 * Nepal's fiscal year runs from Shrawan 1 to Ashadh end.
 * Months Baisakh, Jestha, Asar (index 0-2) belong to the fiscal year
 * that started in the previous BS year.
 */
export function getNepaliFiscalYear(date: Date): NepaliFiscalYear | null {
  const bs = toBs(date);
  if (!bs) return null;
  const startYear = bs.month >= 3 ? bs.year : bs.year - 1;
  const endYear = startYear + 1;
  return {
    startYear,
    endYear,
    label: `${startYear}/${String(endYear).slice(-2)}`,
  };
}

/** Format a fiscal-year start year into the standard label, e.g. 2082 -> "2082/83". */
export function fiscalYearLabel(startYear: number): string {
  return `${startYear}/${String(startYear + 1).slice(-2)}`;
}

/**
 * Parse a user-supplied fiscal year reference into the BS start year.
 * Accepts "2082", "2082/83", "2082-83", "2082/2083". Returns null if not found.
 */
export function parseFiscalYearStart(input: string): number | null {
  const match = input.match(/\b(20\d{2})\s*[\/-]?\s*(\d{2,4})?\b/);
  if (!match) return null;
  const start = Number(match[1]);
  if (start >= 2000 && start <= 2100) return start;
  return null;
}

/** Resolve a Nepali month name/alias from free text. Returns 0-based index or null. */
export function parseBsMonth(input: string): number | null {
  const normalized = input.toLowerCase();
  for (const [alias, index] of Object.entries(BS_MONTH_ALIASES)) {
    if (new RegExp(`\\b${alias}\\b`).test(normalized)) return index;
  }
  return null;
}
