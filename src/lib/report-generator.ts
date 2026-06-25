import { getMirror } from "./bc-mirror";
import { formatAmount, formatCompactAmount, formatNumber } from "./format";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { geminiConfig } from "./config";
import { getGeminiModelChain } from "./gemini-chat";

type MirrorPayload<T> = {
  value?: T[];
  _syncedAt?: string;
  error?: string;
};

type Customer = {
  number?: string;
  displayName?: string;
  phoneNumber?: string;
  balance?: number;
  overdueAmount?: number;
  totalSalesExcludingTax?: number;
};

type LedgerEntry = {
  documentType?: string;
  postingDate?: string;
  salesLcy?: number;
  amountLcy?: number;
  customerNo?: string;
  description?: string;
};

type Item = {
  number?: string;
  displayName?: string;
  inventory?: number;
  unitCost?: number;
  unitPrice?: number;
  itemCategory?: string;
};

type ReportSection = {
  heading: string;
  bullets: string[];
};

type ReportNarrative = {
  opening: string;
  keyTakeaways: string[];
  sections: ReportSection[];
  limitations: string[];
};

type ReportData = {
  customers: Customer[];
  ledgerEntries: LedgerEntry[];
  items: Item[];
  syncedAt?: string;
};

export async function generateBusinessReport(
  prompt: string,
): Promise<{ title: string; html: string }> {
  const data = await loadReportData();
  const year = extractYear(prompt) ?? new Date().getFullYear();
  const revenue = calculateRevenueByMonth(data.ledgerEntries, year);
  const totalRevenue = revenue.reduce((sum, month) => sum + month.value, 0);
  const topRevenueMonth = [...revenue].sort((a, b) => b.value - a.value)[0];
  const totalBalance = sum(data.customers, "balance");
  const totalOverdue = sum(data.customers, "overdueAmount");
  const totalCustomerSales = sum(data.customers, "totalSalesExcludingTax");
  const inventoryValue = data.items.reduce(
    (total, item) => total + Number(item.inventory ?? 0) * Number(item.unitCost ?? 0),
    0,
  );
  const title = createReportTitle(prompt);

  const topCustomersBySales = [...data.customers]
    .sort(
      (a, b) =>
        Number(b.totalSalesExcludingTax ?? 0) -
        Number(a.totalSalesExcludingTax ?? 0),
    )
    .slice(0, 10);
  const topCustomersByBalance = [...data.customers]
    .sort((a, b) => Number(b.balance ?? 0) - Number(a.balance ?? 0))
    .slice(0, 10);
  const topInventoryItems = [...data.items]
    .sort(
      (a, b) =>
        Number(b.inventory ?? 0) * Number(b.unitCost ?? 0) -
        Number(a.inventory ?? 0) * Number(a.unitCost ?? 0),
    )
    .slice(0, 10);
  const aiNarrative = await generateAiNarrative({
    prompt,
    year,
    totalRevenue,
    totalBalance,
    totalOverdue,
    totalCustomerSales,
    inventoryValue,
    customers: data.customers,
    items: data.items,
    topCustomersBySales,
    topCustomersByBalance,
    topInventoryItems,
    revenueByMonth: revenue,
    topRevenueMonth,
  });

  const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    @page { size: A4; margin: 16mm 14mm 18mm; }
    body {
      margin: 0;
      background: #eef0f4;
      color: #111827;
      font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      line-height: 1.55;
      -webkit-print-color-adjust: exact;
      print-color-adjust: exact;
    }
    .toolbar {
      position: sticky;
      top: 0;
      z-index: 10;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      padding: 12px 18px;
      background: rgba(255,255,255,.86);
      border-bottom: 1px solid #e4e4e7;
      backdrop-filter: blur(16px);
    }
    .toolbar button {
      border: 0;
      border-radius: 999px;
      background: #18181b;
      color: white;
      padding: 10px 16px;
      font-weight: 600;
      cursor: pointer;
    }
    .page {
      width: min(1060px, calc(100% - 28px));
      margin: 24px auto 48px;
      background: #fff;
      border: 1px solid #d9dee8;
      border-radius: 30px;
      overflow: hidden;
      box-shadow: 0 24px 80px rgba(15,23,42,.10);
    }
    .cover {
      padding: 42px;
      color: white;
      background:
        radial-gradient(circle at 85% 15%, rgba(255,255,255,.24), transparent 30%),
        linear-gradient(135deg, #111827 0%, #312e81 55%, #7c2d12 100%);
    }
    .brand-row { display: flex; justify-content: space-between; gap: 24px; align-items: flex-start; }
    .brand { font-weight: 800; letter-spacing: -.03em; font-size: 22px; }
    .meta { color: rgba(255,255,255,.78); font-size: 12px; text-align: right; }
    .cover h1 { max-width: 760px; margin: 70px 0 18px; font-size: clamp(34px, 6vw, 64px); line-height: .96; letter-spacing: -.055em; }
    .prompt { max-width: 820px; color: rgba(255,255,255,.82); font-size: 15px; }
    .content { padding: 34px 42px 44px; }
    .eyebrow { color: #6b7280; font-size: 12px; font-weight: 800; text-transform: uppercase; letter-spacing: .12em; }
    h2 { margin: 0 0 16px; font-size: 24px; letter-spacing: -.03em; color: #111827; }
    h3 { margin: 0 0 10px; font-size: 16px; letter-spacing: -.015em; color: #1f2937; }
    p { color: #4b5563; margin: 0 0 12px; orphans: 3; widows: 3; }
    .section { margin-top: 34px; break-inside: avoid; }
    .section-header { display: flex; justify-content: space-between; gap: 16px; align-items: end; margin-bottom: 14px; }
    .section-kicker { color: #6b7280; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: .1em; }
    .grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 14px; margin: 26px 0 4px; }
    .card { border: 1px solid #e5e7eb; border-radius: 20px; padding: 18px; background: linear-gradient(180deg,#fff,#f8fafc); break-inside: avoid; }
    .label { color: #6b7280; font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .08em; }
    .value { margin-top: 10px; font-size: 24px; font-weight: 800; letter-spacing: -.035em; color: #111827; }
    .note { padding: 16px 18px; border: 1px solid #f5d565; border-radius: 18px; background: #fffbeb; color: #713f12; break-inside: avoid; }
    .analysis-card { border: 1px solid #dbe3ef; border-radius: 24px; background: linear-gradient(180deg,#ffffff,#f8fafc); overflow: hidden; break-inside: avoid; }
    .analysis-opening { padding: 22px 24px; border-bottom: 1px solid #e5e7eb; color: #374151; font-size: 16px; }
    .takeaways { display: grid; grid-template-columns: repeat(2, 1fr); gap: 12px; padding: 20px 24px; border-bottom: 1px solid #e5e7eb; }
    .takeaway { padding: 14px; border-radius: 16px; background: #eef2ff; color: #312e81; font-weight: 650; }
    .analysis-section { padding: 20px 24px; border-bottom: 1px solid #e5e7eb; }
    .analysis-section:last-child { border-bottom: 0; }
    ul { margin: 0; padding-left: 18px; color: #4b5563; }
    li { margin: 6px 0; }
    .chart { border: 1px solid #e5e7eb; border-radius: 24px; padding: 18px; overflow-x: auto; background: #fff; break-inside: avoid; }
    svg { max-width: 100%; height: auto; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; background: white; break-inside: auto; }
    thead { display: table-header-group; }
    th, td { padding: 10px 8px; border-bottom: 1px solid #e5e7eb; text-align: left; vertical-align: top; }
    th { color: #6b7280; font-size: 11px; text-transform: uppercase; letter-spacing: .07em; background: #f8fafc; }
    tr { break-inside: avoid; }
    td.num, th.num { text-align: right; font-variant-numeric: tabular-nums; }
    .two-col { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
    .footer { margin-top: 36px; padding-top: 18px; border-top: 1px solid #e5e7eb; color: #6b7280; font-size: 12px; }
    .page-break { break-before: page; }
    @media (max-width: 820px) {
      .cover, .content { padding: 24px; }
      .brand-row { flex-direction: column; }
      .meta { text-align: left; }
      .grid, .two-col, .takeaways { grid-template-columns: 1fr; }
      table { font-size: 12px; }
    }
    @media print {
      body { background: white; }
      .toolbar { display: none; }
      .page { width: auto; margin: 0; border: 0; border-radius: 0; box-shadow: none; }
      .cover { min-height: 92mm; padding: 18mm 16mm; }
      .cover h1 { margin-top: 34mm; }
      .content { padding: 14mm 0 0; }
      h2, h3 { break-after: avoid; }
      .card, .chart, .analysis-card, .note { break-inside: avoid; }
    }
  </style>
</head>
<body>
  <div class="toolbar">
    <strong>ChocoDelight Report</strong>
    <button onclick="window.print()">Print / Save PDF</button>
  </div>
  <main class="page">
    <section class="cover">
      <div class="brand-row">
        <div>
          <div class="brand">ChocoDelight</div>
          <div class="eyebrow">Business Central Report</div>
        </div>
        <div class="meta">
          <div>Generated ${formatDate(new Date().toISOString())}</div>
          ${data.syncedAt ? `<div>Data sync ${formatDate(data.syncedAt)}</div>` : ""}
          <div>Source: Supabase mirror</div>
        </div>
      </div>
      <h1>${escapeHtml(title)}</h1>
      <p class="prompt">Prepared from the request: “${escapeHtml(prompt)}”</p>
    </section>

    <div class="content">
      <section class="grid">
        ${statCard("Customers", formatNumber(data.customers.length))}
        ${statCard(`${year} Revenue`, money(totalRevenue))}
        ${statCard("Top Revenue Month", `${topRevenueMonth.label} · ${money(topRevenueMonth.value)}`)}
        ${statCard("Inventory Value", money(inventoryValue))}
      </section>

      <section class="section">
        <div class="section-header">
          <div>
            <div class="section-kicker">AI Analysis</div>
            <h2>Executive Brief</h2>
          </div>
        </div>
        ${renderNarrative(aiNarrative)}
      </section>

      <section class="section note">
        <strong>Profit note:</strong> Revenue can be calculated from customer ledger invoice entries. True profit requires COGS/cost data such as posted sales invoice lines with costs, value entries, or G/L expense accounts. Those are not synced yet, so this report does not invent profit.
      </section>

      <section class="section page-break">
        <div class="section-header">
          <div>
            <div class="section-kicker">Revenue</div>
            <h2>Monthly Revenue Trend (${year})</h2>
          </div>
        </div>
        <div class="chart">${barChart(revenue)}</div>
      </section>

      <section class="section">
        <h2>Month-wise Revenue</h2>
        ${revenueTable(revenue)}
      </section>

      <section class="section two-col page-break">
      <div>
        <h2>Top Customers by Sales</h2>
        ${customerTable(topCustomersBySales, "sales")}
      </div>
      <div>
        <h2>Top Outstanding Balances</h2>
        ${customerTable(topCustomersByBalance, "balance")}
      </div>
      </section>

      <section class="section">
        <h2>Inventory Value Snapshot</h2>
        ${itemTable(topInventoryItems)}
      </section>

      <section class="section">
        <h2>Data Summary</h2>
        <p>${escapeHtml(summaryText({ year, totalRevenue, totalBalance, totalOverdue, totalCustomerSales, customerCount: data.customers.length, itemCount: data.items.length }))}</p>
      </section>

      <div class="footer">Generated by ChocoDelight BC Assistant. Figures are management reporting snapshots based on the latest synced mirror, not audited financial statements.</div>
    </div>
  </main>
</body>
</html>`;

  return { title, html };
}

async function loadReportData(): Promise<ReportData> {
  const [customersPayload, ledgerPayload, itemsPayload] = await Promise.all([
    getMirror("customers") as Promise<MirrorPayload<Customer>>,
    getMirror("custLedgEntries") as Promise<MirrorPayload<LedgerEntry>>,
    getMirror("items") as Promise<MirrorPayload<Item>>,
  ]);

  return {
    customers: customersPayload.value ?? [],
    ledgerEntries: ledgerPayload.value ?? [],
    items: itemsPayload.value ?? [],
    syncedAt: customersPayload._syncedAt ?? ledgerPayload._syncedAt ?? itemsPayload._syncedAt,
  };
}

function calculateRevenueByMonth(entries: LedgerEntry[], year: number) {
  const months = Array.from({ length: 12 }, (_, index) => ({
    label: new Date(year, index, 1).toLocaleString("en-US", { month: "short" }),
    value: 0,
  }));

  for (const entry of entries) {
    const date = entry.postingDate ? new Date(entry.postingDate) : null;
    if (
      entry.documentType !== "Invoice" ||
      !date ||
      Number.isNaN(date.getTime()) ||
      date.getFullYear() !== year
    ) {
      continue;
    }
    months[date.getMonth()].value += Number(entry.salesLcy ?? entry.amountLcy ?? 0);
  }

  return months;
}

function statCard(label: string, value: string) {
  return `<div class="card"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(value)}</div></div>`;
}

function customerTable(customers: Customer[], metric: "sales" | "balance") {
  const metricHeader =
    metric === "sales" ? "Sales Excl. Tax (NPR)" : "Balance (NPR)";
  const rows = customers
    .map(
      (customer) => `<tr>
        <td>${escapeHtml(customer.number ?? "")}</td>
        <td>${escapeHtml(customer.displayName ?? "")}</td>
        <td>${escapeHtml(customer.phoneNumber ?? "")}</td>
        <td class="num">${money(metric === "sales" ? customer.totalSalesExcludingTax : customer.balance)}</td>
      </tr>`,
    )
    .join("");
  return `<table><thead><tr><th>No.</th><th>Name</th><th>Phone</th><th class="num">${metricHeader}</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function revenueTable(points: { label: string; value: number }[]) {
  const rows = points
    .map(
      (point) => `<tr>
        <td>${escapeHtml(point.label)}</td>
        <td class="num">${money(point.value)}</td>
      </tr>`,
    )
    .join("");
  return `<table><thead><tr><th>Month</th><th class="num">Revenue Excl. Tax (NPR)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function itemTable(items: Item[]) {
  const rows = items
    .map((item) => {
      const value = Number(item.inventory ?? 0) * Number(item.unitCost ?? 0);
      return `<tr>
        <td>${escapeHtml(item.number ?? "")}</td>
        <td>${escapeHtml(item.displayName ?? "")}</td>
        <td>${escapeHtml(item.itemCategory ?? "")}</td>
        <td class="num">${formatNumber(item.inventory ?? 0)}</td>
        <td class="num">${money(value)}</td>
      </tr>`;
    })
    .join("");
  return `<table><thead><tr><th>Item No.</th><th>Name</th><th>Category</th><th class="num">Qty</th><th class="num">Est. Value (NPR)</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function renderNarrative(narrative: ReportNarrative) {
  const takeaways = narrative.keyTakeaways
    .slice(0, 4)
    .map((item) => `<div class="takeaway">${escapeHtml(cleanAiText(item))}</div>`)
    .join("");
  const sections = narrative.sections
    .map(
      (section) => `<div class="analysis-section">
        <h3>${escapeHtml(cleanAiText(section.heading))}</h3>
        ${bulletList(section.bullets)}
      </div>`,
    )
    .join("");
  const limitations = narrative.limitations.length
    ? `<div class="analysis-section">
        <h3>Data Limitations</h3>
        ${bulletList(narrative.limitations)}
      </div>`
    : "";

  return `<div class="analysis-card">
    <div class="analysis-opening">${escapeHtml(cleanAiText(narrative.opening))}</div>
    ${takeaways ? `<div class="takeaways">${takeaways}</div>` : ""}
    ${sections}
    ${limitations}
  </div>`;
}

function bulletList(items: string[]) {
  const cleaned = items
    .filter(Boolean)
    .map((item) => `<li>${escapeHtml(cleanAiText(item))}</li>`)
    .join("");
  return cleaned ? `<ul>${cleaned}</ul>` : "";
}

function barChart(points: { label: string; value: number }[]) {
  const width = 920;
  const height = 320;
  const pad = 44;
  const max = Math.max(...points.map((point) => point.value), 1);
  const barWidth = (width - pad * 2) / points.length - 10;

  const bars = points
    .map((point, index) => {
      const barHeight = (point.value / max) * (height - pad * 2);
      const x = pad + index * ((width - pad * 2) / points.length) + 5;
      const y = height - pad - barHeight;
      return `<g>
        <rect x="${x}" y="${y}" width="${barWidth}" height="${barHeight}" rx="8" fill="#18181b"></rect>
        <text x="${x + barWidth / 2}" y="${height - 18}" text-anchor="middle" font-size="12" fill="#71717a">${point.label}</text>
        <text x="${x + barWidth / 2}" y="${Math.max(18, y - 8)}" text-anchor="middle" font-size="11" fill="#52525b">${compactMoney(point.value)}</text>
      </g>`;
    })
    .join("");

  return `<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Monthly revenue bar chart">
    <line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="#e4e4e7" />
    ${bars}
  </svg>`;
}

function createReportTitle(prompt: string) {
  const lower = prompt.toLowerCase();
  if (lower.includes("customer")) return "Customer Performance Report";
  if (lower.includes("inventory") || lower.includes("item")) return "Inventory Report";
  if (lower.includes("revenue") || lower.includes("profit") || lower.includes("sales")) {
    return "Revenue & Profit Readiness Report";
  }
  return "ChocoDelight Business Report";
}

function summaryText(input: {
  year: number;
  totalRevenue: number;
  totalBalance: number;
  totalOverdue: number;
  totalCustomerSales: number;
  customerCount: number;
  itemCount: number;
}) {
  return `The live company mirror currently includes ${input.customerCount} customers and ${input.itemCount} items. For ${input.year}, ledger invoice revenue is ${money(input.totalRevenue)}. Customer outstanding balance is ${money(input.totalBalance)}, of which ${money(input.totalOverdue)} is overdue. Customer master lifetime sales excluding tax totals ${money(input.totalCustomerSales)}. Profit reporting needs additional cost or G/L data before it can be calculated reliably.`;
}

async function generateAiNarrative(input: {
  prompt: string;
  year: number;
  totalRevenue: number;
  totalBalance: number;
  totalOverdue: number;
  totalCustomerSales: number;
  inventoryValue: number;
  customers: Customer[];
  items: Item[];
  topCustomersBySales: Customer[];
  topCustomersByBalance: Customer[];
  topInventoryItems: Item[];
  revenueByMonth: { label: string; value: number }[];
  topRevenueMonth: { label: string; value: number };
}): Promise<ReportNarrative> {
  if (!geminiConfig.apiKey) {
    return fallbackNarrative(input);
  }

  const dataSummary = {
    userPrompt: input.prompt,
    year: input.year,
    customerCount: input.customers.length,
    itemCount: input.items.length,
    revenueThisYear: money(input.totalRevenue),
    outstandingBalance: money(input.totalBalance),
    overdueAmount: money(input.totalOverdue),
    customerMasterSalesExcludingTax: money(input.totalCustomerSales),
    estimatedInventoryValue: money(input.inventoryValue),
    topRevenueMonth: {
      month: input.topRevenueMonth.label,
      revenue: money(input.topRevenueMonth.value),
    },
    revenueByMonth: input.revenueByMonth.map((month) => ({
      month: month.label,
      revenue: money(month.value),
    })),
    topCustomersBySales: input.topCustomersBySales.slice(0, 5).map((customer) => ({
      number: customer.number,
      name: customer.displayName,
      sales: money(customer.totalSalesExcludingTax),
      balance: money(customer.balance),
      overdue: money(customer.overdueAmount),
    })),
    topOutstandingCustomers: input.topCustomersByBalance.slice(0, 5).map((customer) => ({
      number: customer.number,
      name: customer.displayName,
      balance: money(customer.balance),
      overdue: money(customer.overdueAmount),
    })),
    topInventoryItems: input.topInventoryItems.slice(0, 5).map((item) => ({
      number: item.number,
      name: item.displayName,
      category: item.itemCategory,
      inventory: item.inventory,
      estimatedValue: money(Number(item.inventory ?? 0) * Number(item.unitCost ?? 0)),
    })),
  };

  const prompt = `You are writing content for a professional executive PDF report for ChocoDelight management.

Use only the provided JSON metrics. Do not invent profit because COGS/cost data is not synced.
The user's exact report request is included in the JSON. Tailor the report to that request.

Return only valid JSON. Do not use markdown, hashes, bold markers, tables, HTML, or code fences.
Use this exact shape:
{
  "opening": "2-3 sentence board-ready opening",
  "keyTakeaways": ["short takeaway", "short takeaway", "short takeaway", "short takeaway"],
  "sections": [
    { "heading": "Revenue Performance", "bullets": ["specific observation", "specific implication"] },
    { "heading": "Customer and Receivables", "bullets": ["specific observation", "specific action"] },
    { "heading": "Recommended Actions", "bullets": ["specific action", "specific action"] }
  ],
  "limitations": ["plain-language data limitation"]
}

Write in polished business language. Be specific with numbers from the JSON. Keep bullets concise.

JSON metrics:
${JSON.stringify(dataSummary, null, 2)}`;

  for (const modelName of getGeminiModelChain()) {
    try {
      const genAI = new GoogleGenerativeAI(geminiConfig.apiKey);
      const model = genAI.getGenerativeModel({
        model: modelName,
        generationConfig: { responseMimeType: "application/json" },
      });
      const response = await model.generateContent(prompt);
      const text = response.response.text().trim();
      const parsed = parseReportNarrative(text);
      if (parsed) return parsed;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !message.includes("503") &&
        !message.includes("high demand") &&
        !message.includes("429")
      ) {
        break;
      }
    }
  }

  return fallbackNarrative(input);
}

function fallbackNarrative(input: {
  year: number;
  totalRevenue: number;
  totalBalance: number;
  totalOverdue: number;
  totalCustomerSales: number;
  inventoryValue: number;
  customers: Customer[];
  items: Item[];
}): ReportNarrative {
  return {
    opening: `The live company mirror contains ${input.customers.length} customers and ${input.items.length} inventory items. For ${input.year}, invoice revenue is ${money(input.totalRevenue)} NPR based on customer ledger entries.`,
    keyTakeaways: [
      `${input.year} invoice revenue is ${money(input.totalRevenue)} NPR.`,
      `Outstanding customer balance is ${money(input.totalBalance)} NPR.`,
      `Overdue receivables total ${money(input.totalOverdue)} NPR.`,
      `Estimated inventory value is ${money(input.inventoryValue)} NPR.`,
    ],
    sections: [
      {
        heading: "Revenue Performance",
        bullets: [
          "Revenue is calculated from customer ledger invoice entries in the synced mirror.",
          "Use the month-wise revenue table to identify seasonal peaks and compare current trading momentum.",
        ],
      },
      {
        heading: "Receivables Focus",
        bullets: [
          "Prioritize the highest outstanding balances for collection review.",
          "Compare overdue balances with top-sales customers to separate strategic credit exposure from collection risk.",
        ],
      },
      {
        heading: "Recommended Actions",
        bullets: [
          "Sync posted invoice lines, value entries, or G/L expense accounts before using this report for profit decisions.",
          "Use this report as a management snapshot and validate final numbers against Business Central before board circulation.",
        ],
      },
    ],
    limitations: [
      "True profit is not calculated because COGS and expense data are not currently synced.",
    ],
  };
}

function parseReportNarrative(text: string): ReportNarrative | null {
  try {
    const jsonText = text
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();
    const parsed = JSON.parse(jsonText) as Partial<ReportNarrative>;
    const sections = Array.isArray(parsed.sections)
      ? parsed.sections
          .filter((section) => section?.heading)
          .map((section) => ({
            heading: String(section.heading),
            bullets: Array.isArray(section.bullets)
              ? section.bullets.map(String).filter(Boolean)
              : [],
          }))
      : [];

    return {
      opening: String(parsed.opening ?? ""),
      keyTakeaways: Array.isArray(parsed.keyTakeaways)
        ? parsed.keyTakeaways.map(String).filter(Boolean)
        : [],
      sections,
      limitations: Array.isArray(parsed.limitations)
        ? parsed.limitations.map(String).filter(Boolean)
        : [],
    };
  } catch {
    return null;
  }
}

function cleanAiText(value: string): string {
  return value
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\*\*(.*?)\*\*/g, "$1")
    .replace(/\*(.*?)\*/g, "$1")
    .replace(/^\s*[-*]\s+/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

function extractYear(message: string): number | null {
  const match = message.match(/\b(20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

function sum<T extends Record<string, unknown>>(rows: T[], key: keyof T): number {
  return rows.reduce((total, row) => total + Number(row[key] ?? 0), 0);
}

function money(value: unknown): string {
  return formatAmount(value);
}

function compactMoney(value: number): string {
  return formatCompactAmount(value);
}

function formatDate(value: string): string {
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}
