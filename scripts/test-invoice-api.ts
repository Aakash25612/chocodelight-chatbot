/**
 * Verify Choco Delight posted invoice / credit memo APIs on live BC.
 *   npx tsx scripts/test-invoice-api.ts
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
  const { runWithCompany } = await import("../src/lib/company-context");
  const { bcApi } = await import("../src/lib/bc-client");
  const {
    flattenSalesCrMemoLines,
    flattenSalesInvoiceLines,
  } = await import("../src/lib/invoice-lines");

  await runWithCompany("chocodelight", async () => {
    console.log("Fetching salesInvoiceHeaders…");
    const invoices = await bcApi.getSalesInvoiceHeaders();
    const invoiceLines = flattenSalesInvoiceLines(
      (invoices.value ?? []) as Parameters<typeof flattenSalesInvoiceLines>[0],
    );
    console.log(
      `Invoices: ${invoices.value?.length ?? 0}, item lines: ${invoiceLines.length}`,
    );
    if (invoiceLines[0]) {
      console.log("Sample invoice line:", invoiceLines[0]);
    }

    console.log("Fetching salesCrMemos…");
    const memos = await bcApi.getSalesCrMemos();
    const memoLines = flattenSalesCrMemoLines(
      (memos.value ?? []) as Parameters<typeof flattenSalesCrMemoLines>[0],
    );
    console.log(
      `Credit memos: ${memos.value?.length ?? 0}, item lines: ${memoLines.length}`,
    );
    if (memoLines[0]) {
      console.log("Sample credit memo line:", memoLines[0]);
    }

    const dipLines = invoiceLines.filter((line) =>
      /dip/i.test(`${line.itemNo} ${line.description}`),
    );
    const dipQty = dipLines.reduce((sum, line) => sum + line.quantity, 0);
    console.log(`Dip invoice lines: ${dipLines.length}, total qty: ${dipQty}`);
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
