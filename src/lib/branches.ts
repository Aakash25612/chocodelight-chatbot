import { getActiveCompany } from "./company-context";
import type { CompanyKey } from "./companies";

export type BranchDefinition = {
  code: string;
  name: string;
  aliases: string[];
};

/**
 * Accountability-center / document-prefix codes for Saurabh Food.
 * Invoice document numbers use `{code}_SFP_...`; sales orders carry the same code
 * in accountabilityCenter, locationCode, and dimCode1.
 */
const SAURABHFOOD_BRANCHES: BranchDefinition[] = [
  {
    code: "B",
    name: "Bhairawa Branch",
    aliases: [
      "bhairawa",
      "bhairahawa",
      "bhairowa",
      "bhw",
      "siddharthanagar",
    ],
  },
  {
    code: "S",
    name: "Birgunj Branch",
    aliases: ["birgunj", "birgunj factory", "simara"],
  },
  {
    code: "D",
    name: "Nepalgunj Branch",
    aliases: ["nepalgunj", "npj", "npj depo"],
  },
  {
    code: "K",
    name: "Kathmandu Branch",
    aliases: ["kathmandu", "ktm"],
  },
  {
    code: "W",
    name: "Butwal Branch",
    aliases: ["butwal", "western"],
  },
  {
    code: "H",
    name: "Hetauda Branch",
    aliases: ["hetauda"],
  },
  {
    code: "A",
    name: "Branch A",
    aliases: [],
  },
  {
    code: "C",
    name: "Branch C",
    aliases: [],
  },
  {
    code: "E",
    name: "Branch E",
    aliases: [],
  },
  {
    code: "G",
    name: "Branch G",
    aliases: [],
  },
  {
    code: "I",
    name: "Branch I",
    aliases: [],
  },
  {
    code: "J",
    name: "Branch J",
    aliases: [],
  },
  {
    code: "M",
    name: "Branch M",
    aliases: [],
  },
  {
    code: "F",
    name: "Branch F",
    aliases: [],
  },
];

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

export function listBranchDefinitions(
  company: CompanyKey = getActiveCompany(),
): BranchDefinition[] {
  return BRANCHES[company] ?? [];
}

export function branchCodeFromDocument(documentNo?: string): string | null {
  const match = /^([A-Z])_/.exec(String(documentNo ?? "").trim());
  return match ? match[1] : null;
}

export function branchNameForCode(code: string): string {
  const hit = listBranchDefinitions().find((b) => b.code === code);
  return hit?.name ?? `Branch ${code}`;
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

  if (input?.branchCode?.trim()) {
    const code = input.branchCode.trim().toUpperCase();
    const hit = branches.find((b) => b.code === code);
    if (hit) return hit;
    if (/^[A-Z]$/.test(code)) {
      return { code, name: branchNameForCode(code), aliases: [] };
    }
    return {
      error: `Branch code "${code}" is not in the registry for this company.`,
      branches,
    };
  }

  const query = normalizeTerm(input?.query ?? "");
  if (!query) {
    return { error: "Pass branch name (e.g. Bhairawa) or branchCode (e.g. B).", branches };
  }

  for (const branch of branches) {
    if (normalizeTerm(branch.name).includes(query)) return branch;
    if (normalizeTerm(branch.code) === query) return branch;
    for (const alias of branch.aliases) {
      if (normalizeTerm(alias).includes(query) || query.includes(normalizeTerm(alias))) {
        return branch;
      }
    }
  }

  // Partial alias match (e.g. "bhair" -> Bhairawa)
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
