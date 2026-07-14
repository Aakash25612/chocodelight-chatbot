/**
 * Run on a machine with VPN access (cron every 5–15 min):
 *   npm run sync:bc
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";

function loadEnvFile(path: string) {
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvFile(resolve(process.cwd(), ".env.local"));

async function main() {
  const { isCompanyKey } = await import("../src/lib/companies");
  const { runFullSync } = await import("../src/lib/bc-sync");
  const arg = process.argv[2];
  const companyFilter = isCompanyKey(arg) ? arg : undefined;
  console.log(
    companyFilter
      ? `Starting BC → Supabase sync for ${companyFilter}…`
      : "Starting BC → Supabase sync for all companies…",
  );
  const result = await runFullSync(companyFilter);
  console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
