import { BS_MONTHS, getNepaliFiscalYear, toBs } from "./nepali-date";

/** Flexible AD / BS date filtering for analytics tools. */
export type DatePeriodInput = {
  year?: number;
  month?: number;
  week?: number;
  day?: number;
  dateFrom?: string;
  dateTo?: string;
  nepaliMonth?: string;
  fiscalYearStart?: number;
};

export type DatePeriodFilter = {
  label: string;
  matches: (postingDate?: string) => boolean;
};

function parseDateKey(value?: string): {
  y: number;
  m: number;
  d: number;
  key: string;
} | null {
  if (!value) return null;
  const key = value.slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!match) return null;
  return {
    y: Number(match[1]),
    m: Number(match[2]),
    d: Number(match[3]),
    key,
  };
}

function parseNepaliMonth(name?: string): number | null {
  if (!name) return null;
  const term = name.trim().toLowerCase();
  const idx = BS_MONTHS.findIndex((m) => m.toLowerCase() === term);
  return idx >= 0 ? idx : null;
}

function getIsoWeekYear(date: { y: number; m: number; d: number }): {
  weekYear: number;
  week: number;
} {
  const utc = new Date(Date.UTC(date.y, date.m - 1, date.d));
  const dayNum = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - dayNum);
  const weekYear = utc.getUTCFullYear();
  const yearStart = new Date(Date.UTC(weekYear, 0, 1));
  const week = Math.ceil(
    ((utc.getTime() - yearStart.getTime()) / 86400000 + 1) / 7,
  );
  return { weekYear, week };
}

function monthName(month: number): string {
  return new Date(2000, month - 1, 1).toLocaleString("en-US", { month: "long" });
}

export function resolveDatePeriod(
  input?: DatePeriodInput,
): DatePeriodFilter | { error: string } {
  const dateFrom = input?.dateFrom?.trim().slice(0, 10);
  const dateTo = input?.dateTo?.trim().slice(0, 10);
  const nepaliMonthIndex = parseNepaliMonth(input?.nepaliMonth);

  if (dateFrom && !parseDateKey(dateFrom)) {
    return { error: "dateFrom must be YYYY-MM-DD." };
  }
  if (dateTo && !parseDateKey(dateTo)) {
    return { error: "dateTo must be YYYY-MM-DD." };
  }
  if (input?.month && (input.month < 1 || input.month > 12)) {
    return { error: "month must be 1-12." };
  }
  if (input?.week && (input.week < 1 || input.week > 53)) {
    return { error: "week must be 1-53 (ISO week)." };
  }
  if (input?.week && !input?.year) {
    return { error: "week filter requires year (ISO week year)." };
  }
  if (input?.day && !input?.year && !dateFrom) {
    return { error: "day filter requires year+month or dateFrom." };
  }
  if (nepaliMonthIndex !== null && !input?.fiscalYearStart) {
    return {
      error:
        "nepaliMonth requires fiscalYearStart (BS year at Shrawan), e.g. 2082.",
    };
  }

  let label = "all synced dates";
  if (dateFrom && dateTo) label = `${dateFrom} to ${dateTo}`;
  else if (dateFrom) label = `from ${dateFrom}`;
  else if (dateTo) label = `through ${dateTo}`;
  else if (nepaliMonthIndex !== null && input?.fiscalYearStart) {
    label = `${BS_MONTHS[nepaliMonthIndex]} FY ${input.fiscalYearStart}/${String(input.fiscalYearStart + 1).slice(-2)}`;
  } else if (input?.year && input?.month && input?.day) {
    label = `${input.year}-${String(input.month).padStart(2, "0")}-${String(input.day).padStart(2, "0")}`;
  } else if (input?.year && input?.week) {
    label = `ISO week ${input.week}, ${input.year}`;
  } else if (input?.year && input?.month) {
    label = `${monthName(input.month)} ${input.year}`;
  } else if (input?.year) {
    label = `AD year ${input.year}`;
  }

  return {
    label,
    matches: (postingDate?: string) => {
      const parsed = parseDateKey(postingDate);
      if (!parsed) return false;

      if (dateFrom && parsed.key < dateFrom) return false;
      if (dateTo && parsed.key > dateTo) return false;

      if (nepaliMonthIndex !== null && input?.fiscalYearStart) {
        const date = new Date(parsed.y, parsed.m - 1, parsed.d);
        const fy = getNepaliFiscalYear(date);
        const bs = toBs(date);
        if (!fy || !bs) return false;
        if (fy.startYear !== input.fiscalYearStart) return false;
        if (bs.month !== nepaliMonthIndex) return false;
      }

      if (input?.year && parsed.y !== input.year) return false;
      if (input?.month && parsed.m !== input.month) return false;
      if (input?.day && parsed.d !== input.day) return false;

      if (input?.week && input?.year) {
        const iso = getIsoWeekYear(parsed);
        if (iso.weekYear !== input.year || iso.week !== input.week) return false;
      }

      return true;
    },
  };
}

export function periodFromInput(input?: DatePeriodInput): {
  period: DatePeriodFilter;
} | { error: string } {
  const hasFilter =
    input?.year ||
    input?.month ||
    input?.week ||
    input?.day ||
    input?.dateFrom ||
    input?.dateTo ||
    input?.nepaliMonth;

  if (!hasFilter) {
    return {
      period: {
        label: "all synced dates",
        matches: () => true,
      },
    };
  }

  const resolved = resolveDatePeriod(input);
  if ("error" in resolved) return resolved;
  return { period: resolved };
}
