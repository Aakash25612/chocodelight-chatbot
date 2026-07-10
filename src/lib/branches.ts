import { getActiveCompany } from "./company-context";
import type { CompanyKey } from "./companies";

export type BranchDefinition = {
  code: string;
  name: string;
  aliases: string[];
};

/**
 * Official accountability-center codes for Saurabh Food (invoice document prefix
 * and accountabilityCenter on posted sales documents).
 */
const SAURABHFOOD_BRANCHES: BranchDefinition[] = [
  {
    code: "A",
    name: "Jadibuti-32, Kathmandu",
    aliases: ["jadibuti", "jadibuti 32", "kathmandu"],
  },
  {
    code: "B",
    name: "Biratnagar Office",
    aliases: ["biratnagar office", "biratnagar"],
  },
  {
    code: "C",
    name: "Birgunj Office",
    aliases: ["birgunj office"],
  },
  {
    code: "D",
    name: "Nepalgunj Sales Depot",
    aliases: ["nepalgunj", "npj"],
  },
  {
    code: "E",
    name: "Birtamode Sales Depot",
    aliases: ["birtamode"],
  },
  {
    code: "EXP",
    name: "Biratnagar Factory Exp",
    aliases: ["biratnagar factory exp", "factory exp"],
  },
  {
    code: "F",
    name: "Dhulabari Sales Depot",
    aliases: ["dhulabari"],
  },
  {
    code: "G",
    name: "Janakpur Sales Depot",
    aliases: ["janakpur"],
  },
  {
    code: "H",
    name: "Narayanghat Sales Depot",
    aliases: ["narayanghat", "hetauda"],
  },
  {
    code: "I",
    name: "Butwal Sales Depot",
    aliases: ["butwal"],
  },
  {
    code: "J",
    name: "Bhairahawa Sales Depot",
    aliases: ["bhairahawa", "bhairawa", "bhairowa", "siddharthanagar"],
  },
  {
    code: "JB",
    name: "Jar & Bottle Division",
    aliases: ["jar bottle", "jar & bottle"],
  },
  {
    code: "K",
    name: "Pokhara Sales Depot",
    aliases: ["pokhara"],
  },
  {
    code: "L",
    name: "Chanaouta Sales Depot",
    aliases: ["chanaouta"],
  },
  {
    code: "M",
    name: "Dhangadhi Sales Depot",
    aliases: ["dhangadhi"],
  },
  {
    code: "N",
    name: "Satti Purchase Depot",
    aliases: ["satti"],
  },
  {
    code: "O",
    name: "Biratnagar Sales Depot",
    aliases: ["biratnagar sales", "biratnagar depot"],
  },
  {
    code: "P",
    name: "Manhara Sales Depot",
    aliases: ["manhara"],
  },
  {
    code: "Q",
    name: "Jadibuti Sales Depot",
    aliases: ["jadibuti sales", "jadibuti depot"],
  },
  {
    code: "R",
    name: "Biratnagar Factory",
    aliases: ["biratnagar factory"],
  },
  {
    code: "S",
    name: "Birgunj Factory",
    aliases: ["birgunj factory", "birgunj"],
  },
  {
    code: "T",
    name: "Nepalgunj Factory",
    aliases: ["nepalgunj factory"],
  },
  {
    code: "TN",
    name: "Tina Division",
    aliases: ["tina"],
  },
  {
    code: "U",
    name: "Jamal Sales Depot",
    aliases: ["jamal"],
  },
  {
    code: "V",
    name: "JutePress Godown",
    aliases: ["jute press", "jutepress"],
  },
  {
    code: "W",
    name: "Balkot",
    aliases: ["balkot", "balkot depot"],
  },
];

/** Historical BC document prefixes still present on older invoices (kept for lookup only). */
const SAURABHFOOD_LEGACY_CODES: BranchDefinition[] = [];

const CHOCODELIGHT_BRANCHES: BranchDefinition[] = [
  {
    code: "W",
    name: "Main Branch (W)",
    aliases: ["main", "western", "warehouse"],
  },
  {
    code: "A",
    name: "Branch A",
    aliases: [],
  },
];

const BRANCHES: Record<CompanyKey, BranchDefinition[]> = {
  chocodelight: CHOCODELIGHT_BRANCHES,
  saurabhfood: SAURABHFOOD_BRANCHES,
};

/** Map legacy document prefixes to current accountability codes (if any). */
const LEGACY_BRANCH_CODE_MAP: Partial<Record<CompanyKey, Record<string, string>>> =
  {
    saurabhfood: {},
  };

export function listBranchDefinitions(
  company: CompanyKey = getActiveCompany(),
): BranchDefinition[] {
  return BRANCHES[company] ?? [];
}

export function normalizeBranchCode(
  code: string,
  company: CompanyKey = getActiveCompany(),
): string {
  const upper = code.trim().toUpperCase();
  return LEGACY_BRANCH_CODE_MAP[company]?.[upper] ?? upper;
}

/** Document-prefix codes sorted longest-first (EXP, JB, TN before single letters). */
export function knownBranchCodePrefixes(
  company: CompanyKey = getActiveCompany(),
): string[] {
  const codes = [
    ...listBranchDefinitions(company).map((branch) => branch.code),
    ...(company === "saurabhfood"
      ? SAURABHFOOD_LEGACY_CODES.map((branch) => branch.code)
      : []),
  ];
  return [...new Set(codes.map((code) => code.toUpperCase()))].sort(
    (a, b) => b.length - a.length,
  );
}

export function branchCodeFromDocument(
  documentNo?: string,
  company: CompanyKey = getActiveCompany(),
): string | null {
  const doc = String(documentNo ?? "").trim();
  if (!doc) return null;

  for (const prefix of knownBranchCodePrefixes(company)) {
    if (doc.startsWith(`${prefix}_`)) {
      return normalizeBranchCode(prefix, company);
    }
  }

  return null;
}

export function branchCodeFromPostedDocument(input?: {
  documentNo?: string;
  accountabilityCenter?: string;
  locationCode?: string;
  shortcutDimension1Code?: string;
  company?: CompanyKey;
}): string | null {
  const company = input?.company ?? getActiveCompany();
  const candidates = [
    input?.accountabilityCenter,
    input?.locationCode,
    input?.shortcutDimension1Code,
  ]
    .map((value) => String(value ?? "").trim().toUpperCase())
    .filter(Boolean);

  for (const candidate of candidates) {
    if (knownBranchCodePrefixes(company).includes(candidate)) {
      return normalizeBranchCode(candidate, company);
    }
  }

  return branchCodeFromDocument(input?.documentNo, company);
}

export function branchNameForCode(code: string): string {
  const normalized = normalizeBranchCode(code);
  const branches = listBranchDefinitions();
  const hit = branches.find((branch) => branch.code === normalized);
  if (hit) return hit.name;

  if (getActiveCompany() === "saurabhfood") {
    const legacy = SAURABHFOOD_LEGACY_CODES.find(
      (branch) => branch.code === code.trim().toUpperCase(),
    );
    if (legacy) return legacy.name;
  }

  return `Branch ${normalized}`;
}

function normalizeTerm(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function termMatchesQuery(term: string, query: string): boolean {
  if (!term) return false;
  if (term.length <= 2) {
    return new RegExp(
      `\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`,
      "i",
    ).test(query);
  }
  return term.includes(query) || query.includes(term);
}

export function resolveBranch(input?: {
  query?: string;
  branchCode?: string;
  company?: CompanyKey;
}):
  | BranchDefinition
  | { error: string; branches?: BranchDefinition[] } {
  const company = input?.company ?? getActiveCompany();
  const branches = listBranchDefinitions(company);
  const knownPrefixes = knownBranchCodePrefixes(company);

  if (input?.branchCode?.trim()) {
    const raw = input.branchCode.trim().toUpperCase();
    const code = normalizeBranchCode(raw, company);
    const hit = branches.find((branch) => branch.code === code);
    if (hit) return hit;
    if (knownPrefixes.includes(raw)) {
      return { code, name: branchNameForCode(code), aliases: [] };
    }
    return {
      error: `Branch code "${raw}" is not in the registry for this company.`,
      branches,
    };
  }

  const query = normalizeTerm(input?.query ?? "");
  if (!query) {
    return {
      error: "Pass branch name (e.g. Bhairahawa) or branchCode (e.g. J).",
      branches,
    };
  }

  for (const branch of branches) {
    if (normalizeTerm(branch.name).includes(query)) return branch;
    if (normalizeTerm(branch.code) === query) return branch;
    for (const alias of branch.aliases) {
      if (
        normalizeTerm(alias).includes(query) ||
        query.includes(normalizeTerm(alias))
      ) {
        return branch;
      }
    }
  }

  const partial = branches.filter((branch) => {
    const terms = [branch.name, branch.code, ...branch.aliases].map(normalizeTerm);
    return terms.some((term) => termMatchesQuery(term, query));
  });

  if (partial.length === 1) return partial[0];
  if (partial.length > 1) {
    return {
      error: `Multiple branches match "${input?.query}". Pass branchCode.`,
      branches: partial,
    };
  }

  return {
    error: `No branch matching "${input?.query}". Use list_branches to see codes.`,
    branches,
  };
}
