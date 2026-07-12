/**
 * Verify posted invoice / credit memo APIs on live BC for both companies.
 *   npx tsx scripts/test-invoice-api.ts
 *   npx tsx scripts/test-invoice-api.ts chocodelight
 *   npx tsx scripts/test-invoice-api.ts saurabhfood
 */
import { readFileSync, existsSync } from "fs";
import { resolve } from "path";
import type { CompanyKey } from "../src/lib/companies";

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

async function probeCompany(company: CompanyKey) {
  const { runWithCompany } = await import("../src/lib/company-context");
  const { bcApi } = await import("../src/lib/bc-client");
  const {
    flattenSalesCrMemoLines,
    flattenSalesInvoiceLines,
  } = await import("../src/lib/invoice-lines");

  await runWithCompany(company, async () => {
    console.log(`\n=== ${company} ===`);
    console.log("Fetching salesInvoiceHeaders?$expand=salesInvoiceLines…");
    const invoices = await bcApi.getSalesInvoiceHeaders();
    const invoiceLines = flattenSalesInvoiceLines(
      (invoices.value ?? []) as Parameters<typeof flattenSalesInvoiceLines>[0],
    );
    console.log(
      `Invoices: ${invoices.value?.length ?? 0}, item lines: ${invoiceLines.length}`,
    );
    if (invoiceLines[0]) {
      console.log("Sample invoice line:", {
        documentNo: invoiceLines[0].documentNo,
        itemNo: invoiceLines[0].itemNo,
        lineAmount: invoiceLines[0].lineAmount,
        lineAmountInclVAT: invoiceLines[0].lineAmountInclVAT,
        salespersonCode: invoiceLines[0].salespersonCode,
        accountabilityCenter: invoiceLines[0].accountabilityCenter,
      });
    }

    console.log("Fetching salesCrMemos?$expand=salesCrMemoLines…");
    const memos = await bcApi.getSalesCrMemos();
    const memoLines = flattenSalesCrMemoLines(
      (memos.value ?? []) as Parameters<typeof flattenSalesCrMemoLines>[0],
    );
    console.log(
      `Credit memos: ${memos.value?.length ?? 0}, item lines: ${memoLines.length}`,
    );
  });
}

async function main() {
  const arg = process.argv[2] as CompanyKey | undefined;
  const companies: CompanyKey[] =
    arg === "chocodelight" || arg === "saurabhfood"
      ? [arg]
      : ["chocodelight", "saurabhfood"];

  for (const company of companies) {
    await probeCompany(company);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
