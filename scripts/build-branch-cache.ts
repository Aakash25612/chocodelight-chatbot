import { readFileSync, existsSync } from "node:fs";

function loadEnv(file: string) {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const index = trimmed.indexOf("=");
    if (index < 0) continue;
    process.env[trimmed.slice(0, index)] = trimmed
      .slice(index + 1)
      .replace(/^"|"$/g, "");
  }
}

loadEnv(".env.local");

type LedgerEntry = {
  documentType?: string;
  postingDate?: string;
  salesLcy?: number;
  documentNo?: string;
};

async function main() {
  const { runWithCompany } = await import("../src/lib/company-context");
  const { getMirror } = await import("../src/lib/bc-mirror");
  const { buildBranchSalesCache, saveBranchSalesCache } = await import(
    "../src/lib/branch-sales-cache"
  );
  const { listCompanies } = await import("../src/lib/companies");

  for (const config of listCompanies()) {
    await runWithCompany(config.key, async () => {
      const raw = (await getMirror("custLedgEntries")) as {
        value?: LedgerEntry[];
        error?: string;
      };
      if (raw.error || !raw.value?.length) {
        console.log(config.key, "skip:", raw.error ?? "no ledger rows");
        return;
      }
      const cache = buildBranchSalesCache(raw.value);
      await saveBranchSalesCache(cache);
      console.log(
        config.key,
        "branch cache:",
        cache.allTime.branches.length,
        "branches, total",
        cache.allTime.totalSales,
      );
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
