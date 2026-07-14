import {
  SchemaType,
  type FunctionDeclaration,
} from "@google/generative-ai";
import { bcApi } from "./bc-client";
import {
  getMirror,
  getMirrorCache,
  getMonthlyRevenueFromMirror,
  getUomsFromMirror,
  queueWrite,
} from "./bc-mirror";
import {
  getNepaliMonthlySales,
  getProductSales,
  getReceivablesAging,
  getCustomerStatement,
  getSalesSummary,
  searchCustomers,
  searchItems,
} from "./analytics";
import {
  compareRevenuePeriods,
  compareCustomerYearlySales,
  compareTopCustomersYearly,
  getCategorySales,
  getCollectionMetrics,
  getCustomerAlerts,
  getCustomerProductSales,
  getCustomerSales,
  getDailyRevenue,
  getInventoryByItemType,
  getInventorySummary,
  getItemDetail,
  getLowStockItems,
  getMrRecords,
  getOutstandingReceivables,
  getPaymentsSummary,
  getSalesBySalesperson,
  getSalesByBranch,
  getBranchWiseSales,
  getBranchProductSales,
  getVatReport,
  listBranches,
  getSalesOrdersSummary,
  getPendingSauda,
  getChequeInHand,
  getSyncStatus,
  getTopCustomers,
  getTopCustomersByMonth,
  getTopCustomersByNepaliMonth,
  getTopPayingCustomers,
  searchLedgerEntries,
  searchSalesOrders,
} from "./analytics-queries";
import { useSupabaseMirror } from "./config";
import { type DatePeriodInput } from "./date-period";
import {
  detectCalendarPreference,
  normalizeToolArgs,
  periodArgsFromRecord,
} from "./tool-policy";

const mirrorOnly = "Requires Supabase mirror mode (BC_DATA_SOURCE=supabase).";
const SNAPSHOT_TOOLS = new Set([
  "get_companies",
  "get_customers",
  "search_customers",
  "get_items",
  "search_items",
  "get_item_detail",
  "get_uoms",
  "get_salespersons",
  "get_inventory_summary",
  "get_low_stock_items",
  "get_inventory_by_item_type",
  "get_customer_alerts",
  "get_sync_status",
]);

const periodToolProperties = {
  allTime: {
    type: SchemaType.BOOLEAN,
    description:
      "Set true ONLY when the user explicitly asks for all-time, lifetime, or all synced history. Otherwise current Nepali FY is the default.",
  },
  year: {
    type: SchemaType.NUMBER,
    description:
      "AD calendar year ONLY when user explicitly asks English/Gregorian/AD (e.g. '2026 AD'). Do NOT use for 'this year' in Nepal — use fiscalYearStart instead.",
  },
  month: {
    type: SchemaType.NUMBER,
    description: "AD month 1-12 (use with year for June: month=6). Only for explicit AD months.",
  },
  week: {
    type: SchemaType.NUMBER,
    description: "ISO week 1-53 (requires year).",
  },
  day: {
    type: SchemaType.NUMBER,
    description: "Day of month 1-31 (use with year+month).",
  },
  dateFrom: {
    type: SchemaType.STRING,
    description: "Inclusive start date YYYY-MM-DD.",
  },
  dateTo: {
    type: SchemaType.STRING,
    description: "Inclusive end date YYYY-MM-DD.",
  },
  nepaliMonth: {
    type: SchemaType.STRING,
    description: "BS month name, e.g. Jestha (requires fiscalYearStart).",
  },
  fiscalYearStart: {
    type: SchemaType.NUMBER,
    description:
      "DEFAULT period for Nepal: BS year when FY starts at Shrawan, e.g. 2082 for FY 2082/83. Use for 'this year' / YTD.",
  },
} as const;

function periodArgs(args: Record<string, unknown>): DatePeriodInput {
  return periodArgsFromRecord(args);
}

/** Prefer Nepali FY over a bare AD year (e.g. model wrongly passes year=2026 for "this year"). */
function nepaliPreferredPeriodArgs(
  args: Record<string, unknown>,
): DatePeriodInput {
  return periodArgs(args);
}

export const toolDeclarations: FunctionDeclaration[] = [
  {
    name: "get_companies",
    description:
      "List all companies available in ChocoDelight Business Central.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "get_customers",
    description:
      "Get ALL customers (large list). Do NOT use for name lookup — use search_customers instead. Only use when the user explicitly wants the full customer dump.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "search_customers",
    description:
      "Search customers by name, customer number, or phone. Use FIRST whenever the user mentions a customer by name (e.g. P. D. Traders, Bitran Solutions) or asks who a customer is.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: "Customer name or number fragment, e.g. 'P. D. Traders' or 'ACP0000307'.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_customer_statement",
    description:
      "Get a customer's invoiced vs paid summary, open balance, overdue invoices, and recent payments. Use for 'how much has X paid', payment history, outstanding balance for one customer, or follow-up after receivables aging. Pass query (name), customerNo, and/or documentNo from a prior invoice. NEVER use for 'sauda' / 'pending sauda' — that is get_pending_sauda (unshipped Locked order qty), not open invoices.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: "Customer name search, e.g. 'P. D. Traders'.",
        },
        customerNo: {
          type: SchemaType.STRING,
          description: "Customer number if known, e.g. ACP0000307.",
        },
        documentNo: {
          type: SchemaType.STRING,
          description: "Invoice/document number if known, e.g. W_CDP_SB82/83-00165.",
        },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_customer_ledger_entries",
    description:
      "Get ALL customer ledger entries (very large). Do NOT use for one customer — use get_customer_statement instead.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "get_mr",
    description:
      "Get MR (medical representative / market rep) records for the configured company.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "get_salespersons",
    description: "Get all salespersons for the configured company.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "get_items",
    description: "Get all inventory items/products for the configured company.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "get_uoms",
    description:
      "Get units of measure. Optionally filter by item number using OData $filter syntax, e.g. itemNo eq 'CNCCH0140G'.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        filter: {
          type: SchemaType.STRING,
          description: "Optional OData filter, e.g. itemNo eq 'ITEM001'",
        },
      },
    },
  },
  {
    name: "get_api_catalog",
    description: "Get the root API catalog listing available endpoints.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "get_monthly_revenue",
    description:
      "Month-wise revenue for ONE English/Gregorian (AD) calendar year (January–December ONLY). Use ONLY when the user explicitly wants AD/English months or says 'January, February…' in a Gregorian year. Do NOT use for default month-wise sales in Nepal — use get_nepali_monthly_sales instead.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        year: {
          type: SchemaType.NUMBER,
          description: "AD calendar year, e.g. 2026. Defaults to current year.",
        },
      },
    },
  },
  {
    name: "get_sales_summary",
    description:
      "Total sales summary across ALL synced data (all-time, by Nepali fiscal year, by AD year). Present netSalesIncludingTax and salesIncludingTax fields as primary amounts (Incl. VAT). Do NOT use for branch-wise or depot-wise sales — use get_branch_wise_sales instead.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "get_nepali_monthly_sales",
    description:
      "DEFAULT for month-wise sales/revenue in Nepal. Sales by Bikram Sambat month for a Nepali fiscal year (Shrawan through Ashadh). Returns salesIncludingTax (Incl. VAT) per month and yearToDate.salesIncludingTax. Use for 'monthwise sales', 'this year', YTD, or any BS month.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        allTime: periodToolProperties.allTime,
        fiscalYearStart: {
          type: SchemaType.NUMBER,
          description:
            "BS year in which the fiscal year starts at Shrawan, e.g. 2082 for FY 2082/83. Omit to use the most recent fiscal year in the data.",
        },
      },
    },
  },
  {
    name: "get_receivables_aging",
    description:
      "Aging for open invoice balances. Default ageBy=due_date for overdue/past-due questions. Use ageBy=posting_date for 'outstanding above/beyond X days'. Pass query ONLY for ONE named customer (partial name OK). Do NOT pass query for 'which customer most' — omit query and rank via topCustomersByMinDays. NOT for total balance ranking without day filter (use get_outstanding_receivables).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            "ONE customer name only — partial match OK. Omit for 'which customer most' / ranking questions.",
        },
        customerNo: { type: SchemaType.STRING },
        minDaysOverdue: {
          type: SchemaType.NUMBER,
          description:
            "Minimum days threshold, e.g. 90 for 'above 90 days'. Applied to ageBy basis.",
        },
        ageBy: {
          type: SchemaType.STRING,
          description:
            "due_date (payment overdue) or posting_date (days since invoice). Default due_date unless user asks outstanding above X days / since invoice.",
        },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_outstanding_receivables",
    description:
      "Total outstanding receivables ranked by customer balance (matches ERP/Power BI). Use for 'who owes the most', 'outstanding payment', 'total receivable', 'top parties by balance'. Returns total outstanding plus per-customer overdueAmount and notYetDueAmount (owed but deadline not reached).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        limit: {
          type: SchemaType.NUMBER,
          description: "How many customers to return. Default 15.",
        },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "search_items",
    description:
      "Search products/items by keyword across item number, name, category, and type. Use to LIST or IDENTIFY products (inventory, names, categories). For SALES AMOUNTS of a product or keyword like dip/chocolate/syrup, use get_product_sales instead.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            "Keyword to match, e.g. 'dip', 'dark choco', 'chocolate'. Omit to list categories and a sample of items.",
        },
      },
    },
  },
  {
    name: "get_product_sales",
    description:
      "Get invoiced product sales from posted invoice lines. Returns EVERY matching item. averagePricePerMTInclTax is an EQUAL-CUSTOMER average: calculate each customer's effective sales÷MT rate, then average those rates; never calculate the displayed average as total sales÷total MT. Primary quantity is MT.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            "Product keyword to match item number or name, e.g. 'dip', 'chocolate', 'syrup'.",
        },
        itemNumbers: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description:
            "Optional explicit item numbers to include, e.g. ['FGDCDIP20KG','CMCD-20KG'].",
        },
        returnsOnly: {
          type: SchemaType.BOOLEAN,
          description:
            "Set true only for sales return / credit memo questions. Returns returned quantity and value as positive totals.",
        },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_top_customers_by_month",
    description:
      "Top customers by invoiced sales for ONE English (AD) calendar month. Primary: salesIncludingTax (Incl. VAT).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        year: { type: SchemaType.NUMBER, description: "AD year, e.g. 2026." },
        month: {
          type: SchemaType.NUMBER,
          description: "AD month number 1-12 (June = 6).",
        },
        limit: {
          type: SchemaType.NUMBER,
          description: "How many customers to return. Default 15.",
        },
      },
      required: ["year", "month"],
    },
  },
  {
    name: "get_top_customers",
    description:
      "Rank customers by invoice sales, optionally within one branch via branchCode. Use this for 'top 10 customers in Biratnagar branch'. Primary: salesIncludingTax (Incl. VAT). Use fiscalYearStart for Nepali FY. For outstanding ranking use get_outstanding_receivables.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        allTime: periodToolProperties.allTime,
        fiscalYearStart: {
          type: SchemaType.NUMBER,
          description: "Nepali FY start BS year, e.g. 2082 for FY 2082/83.",
        },
        year: { type: SchemaType.NUMBER, description: "Optional AD year filter." },
        month: { type: SchemaType.NUMBER, description: "Optional AD month 1-12." },
        branchCode: {
          type: SchemaType.STRING,
          description: "Optional accountability-center branch code, e.g. B.",
        },
        limit: { type: SchemaType.NUMBER, description: "Default 15." },
        rankBy: {
          type: SchemaType.STRING,
          description:
            "invoice_sales (default), balance, overdue, or lifetime_master.",
        },
      },
    },
  },
  {
    name: "get_top_customers_by_nepali_month",
    description:
      "Top customers by invoiced sales for one Nepali (BS) month within a fiscal year. Primary: salesIncludingTax (Incl. VAT).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        fiscalYearStart: {
          type: SchemaType.NUMBER,
          description: "BS year at Shrawan start, e.g. 2082 for FY 2082/83.",
        },
        nepaliMonth: {
          type: SchemaType.STRING,
          description:
            "BS month name: Baisakh, Jestha, Asar, Shrawan, Bhadra, Aswin, Kartik, Mangsir, Poush, Magh, Falgun, Chaitra.",
        },
        limit: { type: SchemaType.NUMBER },
      },
      required: ["nepaliMonth"],
    },
  },
  {
    name: "get_customer_sales",
    description:
      "Invoice sales totals for ONE customer. Primary: totalSalesIncludingTax (Incl. VAT). Pass fiscalYearStart for Nepali FY; returns byNepaliMonth. Show salesExcludingTax only when user asks for excl VAT.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: "Customer name search." },
        customerNo: { type: SchemaType.STRING },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_daily_revenue",
    description:
      "Day-by-day invoice revenue for one AD month. Use for 'which day in June had highest sales'.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        year: { type: SchemaType.NUMBER },
        month: { type: SchemaType.NUMBER, description: "AD month 1-12." },
      },
      required: ["year", "month"],
    },
  },
  {
    name: "compare_revenue_periods",
    description:
      "Compare invoice revenue between two AD periods (month vs month or full year vs year).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        year1: { type: SchemaType.NUMBER },
        month1: { type: SchemaType.NUMBER, description: "Omit for full-year compare." },
        year2: { type: SchemaType.NUMBER },
        month2: { type: SchemaType.NUMBER },
      },
      required: ["year1", "year2"],
    },
  },
  {
    name: "get_payments_summary",
    description:
      "Payments and credit memos by period, optionally for one customer. Use for 'total collections in June', 'payments received this year'.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        year: { type: SchemaType.NUMBER },
        month: { type: SchemaType.NUMBER },
        query: { type: SchemaType.STRING, description: "Customer name." },
        customerNo: { type: SchemaType.STRING },
      },
    },
  },
  {
    name: "get_inventory_summary",
    description:
      "Inventory overview: total stock value, counts by category, top items by stock value at cost.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        limit: { type: SchemaType.NUMBER, description: "Top items to include." },
      },
    },
  },
  {
    name: "get_low_stock_items",
    description:
      "Items at or below an inventory quantity threshold. Use for stock-out / reorder questions.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        threshold: {
          type: SchemaType.NUMBER,
          description: "Max inventory qty to flag. Default 10.",
        },
        limit: { type: SchemaType.NUMBER },
      },
    },
  },
  {
    name: "get_category_sales",
    description:
      "Product category sales from posted invoice lines. Primary: totalSalesIncludingTax (Incl. VAT). Show salesExcludingTax only when user asks for excl VAT (BC line.amount).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: { ...periodToolProperties },
    },
  },
  {
    name: "get_sales_orders_summary",
    description:
      "Summary of sales orders: counts by status, top customers by order line value. Supports flexible date filters.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: "Filter to one customer." },
        customerNo: { type: SchemaType.STRING },
        status: {
          type: SchemaType.STRING,
          description: "Locked or Unlocked.",
        },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_pending_sauda",
    description:
      "MANDATORY for any sauda/pending-sauda question. Locked sales orders where quantity − quantityShipped > 0. averagePricePerMT is an EQUAL-CUSTOMER average of each customer's effective pending amount÷pending MT rate, not total amount÷total MT. Pass productQuery for item names; never treat items as customers.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: "Customer name or branch name.",
        },
        customerNo: { type: SchemaType.STRING },
        branchCode: {
          type: SchemaType.STRING,
          description: "Branch/accountability code filter, e.g. W, J, S.",
        },
        productQuery: {
          type: SchemaType.STRING,
          description: "Optional item keyword, e.g. dip, mustard.",
        },
        limit: {
          type: SchemaType.NUMBER,
          description: "Max detail lines to return (default 40).",
        },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "search_sales_orders",
    description:
      "List individual sales orders by customer, status, and date period (month/week/range).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: "Customer name." },
        customerNo: { type: SchemaType.STRING },
        status: { type: SchemaType.STRING },
        limit: { type: SchemaType.NUMBER },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_customer_product_sales",
    description:
      "What products ONE customer bought in a period. Primary: totalSalesIncludingTax (Incl. VAT). Show salesExcludingTax only when user asks for excl VAT (BC line.amount).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: "Customer name." },
        customerNo: { type: SchemaType.STRING },
        productQuery: {
          type: SchemaType.STRING,
          description: "Optional product keyword filter.",
        },
        limit: { type: SchemaType.NUMBER },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_branch_wise_sales",
    description:
      "MANDATORY for 'branch wise sales', 'area wise sales', 'region wise sales', 'sales by branch/area/depot', 'all branches', or depot-wise sales. Area-wise = branch/depot (Kathmandu, Birgunj…), NOT salesperson. Present branchName as the primary label (e.g. Birgunj Factory, Butwal Sales Depot) — NEVER list only codes A/B/S/T. Code may appear after the name. Present salesIncludingTax / totalSalesIncludingTax (Incl. VAT) as primary amounts. Includes current Nepali fiscal year breakdown when no period filter is passed. NEVER say branch data is unavailable — call this tool.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        ...periodToolProperties,
      },
    },
  },
  {
    name: "list_branches",
    description:
      "List branch/depot codes and names for the active company. Saurabh Food uses accountability-center codes on invoices (J_SFP_..., S_SFP_..., EXP_SFP_...). Use before get_sales_by_branch when the user asks about a branch by name.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "get_sales_by_branch",
    description:
      "Posted invoice sales for one branch/depot by name or code. Present totalSalesIncludingTax and salesIncludingTax (Incl. VAT). Saurabh: Bhairahawa=J, Butwal=I, Birgunj Factory=S, Birgunj Office=B, Pokhara=K, Nepalgunj=D. Set monthlyBreakdown=true for month-by-month sales in current Nepali fiscal year (Shrawan → Ashadh). Supports Nepali fiscal period filters (fiscalYearStart, nepaliMonth) or AD date range.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: "Branch name or alias, e.g. Bhairawa, Birgunj, Butwal.",
        },
        branchCode: {
          type: SchemaType.STRING,
          description: "Accountability code, e.g. J for Bhairahawa, I for Butwal, EXP, JB, TN.",
        },
        monthlyBreakdown: {
          type: SchemaType.BOOLEAN,
          description:
            "When true, return month-by-month sales for the current Nepali fiscal year in BS calendar order.",
        },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_sales_by_salesperson",
    description:
      "Posted invoice sales ranked by salesperson code/name. Defaults to current Nepali FY (e.g. 2082/83). Pass fiscalYearStart for a BS FY — NEVER pass AD year like 2026 unless user explicitly asks for English/AD calendar. Primary: salesIncludingTax (Incl. VAT). Use ONLY for field team / salesperson / salesman performance — NOT for area-wise, region-wise, or branch-wise sales (use get_branch_wise_sales for those).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        limit: { type: SchemaType.NUMBER },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_branch_product_sales",
    description:
      "Product sales for one branch/depot from posted invoice lines. E.g. 'code J dip sales', 'Bhairahawa branch chocolate month by month'. Pass branchCode or query, productQuery (dip/chocolate), monthlyBreakdown=true for BS month chart in current FY. Primary: salesIncludingTax (Incl. VAT).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: "Branch name or alias." },
        branchCode: { type: SchemaType.STRING, description: "Accountability code, e.g. J." },
        productQuery: {
          type: SchemaType.STRING,
          description: "Product keyword, e.g. dip, chocolate.",
        },
        monthlyBreakdown: {
          type: SchemaType.BOOLEAN,
          description: "Month-by-month in current Nepali FY (Shrawan → Ashadh).",
        },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_vat_report",
    description:
      "VAT collected summary from posted invoice lines: totalVatCollected (= incl VAT − net excl), by branch, by Nepali month. Use for 'how much VAT this year', 'VAT by branch'. Defaults to current Nepali FY.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        branchCode: {
          type: SchemaType.STRING,
          description: "Optional branch filter, e.g. J.",
        },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_mr_records",
    description:
      "Money receipt (MR) cheque/payment records. For cheque in hand / Cheque Received / not deposited, prefer get_cheque_in_hand. Supports customer query, branchCode, and status (Cheque Received, Cheque Cleared, etc.).",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: "Customer name/number or branch name." },
        customerNo: { type: SchemaType.STRING },
        branchCode: {
          type: SchemaType.STRING,
          description: "Depot code e.g. W (Balkot). Filters by customer's primary sales branch.",
        },
        status: {
          type: SchemaType.STRING,
          description:
            'e.g. "Cheque Received" (in hand), "Cheque Cleared", "Cheque Deposited". Aliases: cheque in hand, not deposited.',
        },
        limit: { type: SchemaType.NUMBER },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_cheque_in_hand",
    description:
      "MANDATORY for cheque in hand / cheques received not deposited. MR status Cheque Received. Pass branchCode for depot (e.g. W=Balkot) or query=customer name. NEVER answer with branch sales for cheque questions.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: "Customer name, or branch name if no branchCode.",
        },
        customerNo: { type: SchemaType.STRING },
        branchCode: {
          type: SchemaType.STRING,
          description: "Depot code, e.g. W for Balkot, J for Bhairahawa.",
        },
        limit: { type: SchemaType.NUMBER },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_item_detail",
    description:
      "Look up one product by item number or name fragment: inventory, cost, price, category.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description: "Item number or name fragment, e.g. FGCH018 or syrup.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "get_customer_alerts",
    description:
      "Customers who are blocked and/or have overdue balance above a threshold.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        type: {
          type: SchemaType.STRING,
          description: "blocked, overdue, or both (default).",
        },
        minOverdue: { type: SchemaType.NUMBER, description: "Minimum overdue NPR." },
        limit: { type: SchemaType.NUMBER },
      },
    },
  },
  {
    name: "search_ledger_entries",
    description:
      "Search customer ledger entries by document number, customer, date, or document type. Use for specific invoice lookup — NOT for rankings.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        documentNo: { type: SchemaType.STRING },
        query: { type: SchemaType.STRING, description: "Customer name." },
        customerNo: { type: SchemaType.STRING },
        year: { type: SchemaType.NUMBER },
        month: { type: SchemaType.NUMBER },
        documentType: {
          type: SchemaType.STRING,
          description: "Invoice, Payment, or Credit Memo.",
        },
        limit: { type: SchemaType.NUMBER },
      },
    },
  },
  {
    name: "get_sync_status",
    description:
      "When BC data was last synced to Supabase and record counts per entity. Use for data freshness questions.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "compare_customer_yearly_sales",
    description:
      "Compare one customer's invoiced sales across multiple AD years (default last 3 years). Use for 'X customer sales last 3 years', year-on-year customer trend.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: "Customer name." },
        customerNo: { type: SchemaType.STRING },
        years: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.NUMBER },
          description: "AD years to compare, e.g. [2024, 2025, 2026].",
        },
      },
    },
  },
  {
    name: "compare_top_customers_yearly",
    description:
      "Top customers by invoice sales for each of several AD years side-by-side. Use for yearly customer sales comparison / ranking trends.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        years: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.NUMBER },
          description: "AD years, e.g. [2024, 2025, 2026]. Default last 3 years.",
        },
        limit: {
          type: SchemaType.NUMBER,
          description: "Top N customers per year. Default 10.",
        },
      },
    },
  },
  {
    name: "get_collection_metrics",
    description:
      "Average collection days / DSO estimate from open invoices and recent sales. Company-wide or one customer (pass query). Use for 'average days of collection', 'how fast does X pay'.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: "Optional customer name." },
        customerNo: { type: SchemaType.STRING },
        lookbackDays: {
          type: SchemaType.NUMBER,
          description: "Sales window for DSO estimate. Default 90.",
        },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_top_paying_customers",
    description:
      "Rank customers by total payments received. Use for 'best 10 customers payment wise', top payers this year/month.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        limit: { type: SchemaType.NUMBER, description: "Default 10." },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_inventory_by_item_type",
    description:
      "List stock by item type: Raw Materials, Finished Goods, Others, Store. Use for RM/FG stock lists.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        itemType: {
          type: SchemaType.STRING,
          description:
            "Filter e.g. 'Raw Materials', 'Finished Goods', 'Finished', 'Raw'.",
        },
        limit: { type: SchemaType.NUMBER },
      },
    },
  },
  {
    name: "create_sales_order",
    description:
      "Create a new sales order with line items. Requires customerNumber and salesOrderLines array.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        customerNumber: {
          type: SchemaType.STRING,
          description: "Customer number, e.g. ACB0000025",
        },
        paymentMethodCode: {
          type: SchemaType.STRING,
          description: "Payment method code, default C-00004",
        },
        locationCode: {
          type: SchemaType.STRING,
          description: "Location code, default A",
        },
        accountabilityCenter: {
          type: SchemaType.STRING,
          description: "Accountability center, default A",
        },
        salesOrderLines: {
          type: SchemaType.ARRAY,
          description: "Array of order line items",
          items: {
            type: SchemaType.OBJECT,
            properties: {
              itemNo: { type: SchemaType.STRING },
              unitPrice: { type: SchemaType.NUMBER },
              quantity: { type: SchemaType.NUMBER },
              unitOfMeasureId: { type: SchemaType.STRING },
            },
            required: ["itemNo", "unitPrice", "quantity", "unitOfMeasureId"],
          },
        },
      },
      required: ["customerNumber", "salesOrderLines"],
    },
  },
  {
    name: "post_sales_document",
    description:
      "Post a sales document (invoice/shipment) using document number via OData SalesPost codeunit.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        documentNo: {
          type: SchemaType.STRING,
          description: "Sales document number to post, e.g. Y-SB-8081-00018",
        },
      },
      required: ["documentNo"],
    },
  },
  {
    name: "get_pending_items_to_sell",
    description:
      "Get pending items available to sell for a customer via OData GetPendingItemToSell codeunit.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        customerNo: {
          type: SchemaType.STRING,
          description: "Customer number, e.g. ACM0000159",
        },
        fileName: {
          type: SchemaType.STRING,
          description: "Optional file name, usually empty string",
        },
      },
      required: ["customerNo"],
    },
  },
  {
    name: "lock_sales_order",
    description: "Lock a sales order by document number via OData locksales codeunit.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        documentNo: {
          type: SchemaType.STRING,
          description: "Sales order document number to lock",
        },
      },
      required: ["documentNo"],
    },
  },
  {
    name: "create_gen_journal_line",
    description:
      "Create a general journal line entry. Use for payments, adjustments, etc.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        journalTemplateName: { type: SchemaType.STRING },
        journalBatchName: { type: SchemaType.STRING },
        postingDate: { type: SchemaType.STRING, description: "YYYY-MM-DD" },
        documentType: { type: SchemaType.STRING },
        documentNo: { type: SchemaType.STRING },
        accountType: { type: SchemaType.STRING },
        accountNo: { type: SchemaType.STRING },
        balAccountType: { type: SchemaType.STRING },
        balAccountNo: { type: SchemaType.STRING },
        debitAmount: { type: SchemaType.NUMBER },
        creditAmount: { type: SchemaType.NUMBER },
        comment: { type: SchemaType.STRING },
        shortcutDimension1Code: { type: SchemaType.STRING },
        dimensionValueCodes: { type: SchemaType.STRING },
        miti: { type: SchemaType.STRING },
      },
      required: [
        "journalTemplateName",
        "journalBatchName",
        "postingDate",
        "documentType",
        "documentNo",
        "accountType",
        "accountNo",
      ],
    },
  },
];

function truncateResult(data: unknown, maxLength = 12000): unknown {
  const json = JSON.stringify(data);
  if (json.length <= maxLength) return data;
  return {
    truncated: true,
    message: `Response truncated from ${json.length} to ${maxLength} characters`,
    preview: json.slice(0, maxLength),
  };
}

export async function executeTool(
  name: string,
  args: Record<string, unknown>,
  onLog?: (params: {
    toolName: string;
    requestArgs: Record<string, unknown>;
    result: unknown;
    success: boolean;
    error?: string;
  }) => Promise<void>,
  userMessage = "",
): Promise<unknown> {
  args = normalizeToolArgs(name, args, userMessage);
  try {
    let result: unknown;

    switch (name) {
      case "get_companies":
        result = useSupabaseMirror
          ? await getMirror("companies")
          : await bcApi.getCompanies();
        break;
      case "get_customers":
        result = useSupabaseMirror
          ? await getMirror("customers")
          : await bcApi.getCustomers();
        break;
      case "search_customers":
        if (!useSupabaseMirror) {
          return { error: "Customer search requires Supabase mirror mode." };
        }
        result = await searchCustomers(String(args.query ?? ""));
        break;
      case "get_customer_statement":
        if (!useSupabaseMirror) {
          return { error: "Customer statement requires Supabase mirror mode." };
        }
        result = await getCustomerStatement({
          customerNo: args.customerNo as string | undefined,
          query: args.query as string | undefined,
          documentNo: args.documentNo as string | undefined,
          ...periodArgs(args),
        });
        break;
      case "get_customer_ledger_entries":
        result = useSupabaseMirror
          ? await getMirror("custLedgEntries")
          : await bcApi.getCustomerLedgerEntries();
        break;
      case "get_mr":
        result = useSupabaseMirror
          ? await getMirror("mr")
          : await bcApi.getMr();
        break;
      case "get_salespersons":
        result = useSupabaseMirror
          ? await getMirror("salespersons")
          : await bcApi.getSalespersons();
        break;
      case "get_items":
        result = useSupabaseMirror
          ? await getMirror("items")
          : await bcApi.getItems();
        break;
      case "get_uoms":
        result = useSupabaseMirror
          ? await getUomsFromMirror(args.filter as string | undefined)
          : await bcApi.getUoms(args.filter as string | undefined);
        break;
      case "get_api_catalog":
        result = useSupabaseMirror
          ? await getMirror("api_catalog")
          : await bcApi.getApiCatalog();
        break;
      case "get_monthly_revenue":
        if (detectCalendarPreference(userMessage) !== "ad") {
          result = await getNepaliMonthlySales();
          break;
        }
        if (useSupabaseMirror) {
          result = await getMonthlyRevenueFromMirror(
            typeof args.year === "number" ? args.year : undefined,
          );
        } else {
          return {
            error:
              "Monthly revenue aggregation is currently available in Supabase mirror mode.",
          };
        }
        break;
      case "get_sales_summary":
        if (!useSupabaseMirror) {
          return { error: "Sales summary requires Supabase mirror mode." };
        }
        result = args.allTime
          ? await getSalesSummary()
          : await getNepaliMonthlySales(
              typeof args.fiscalYearStart === "number"
                ? args.fiscalYearStart
                : undefined,
            );
        break;
      case "get_nepali_monthly_sales":
        if (!useSupabaseMirror) {
          return { error: "Nepali monthly sales requires Supabase mirror mode." };
        }
        result = await getNepaliMonthlySales(
          typeof args.fiscalYearStart === "number"
            ? args.fiscalYearStart
            : undefined,
        );
        break;
      case "get_receivables_aging":
        if (!useSupabaseMirror) {
          return { error: "Receivables aging requires Supabase mirror mode." };
        }
        result = await getReceivablesAging({
          minDays:
            typeof args.minDaysOverdue === "number"
              ? args.minDaysOverdue
              : undefined,
          ageBy:
            args.ageBy === "posting_date" || args.ageBy === "due_date"
              ? args.ageBy
              : undefined,
          query: args.query as string | undefined,
          customerNo: args.customerNo as string | undefined,
          ...periodArgs(args),
        });
        break;
      case "get_outstanding_receivables":
        if (!useSupabaseMirror) {
          return {
            error: "Outstanding receivables requires Supabase mirror mode.",
          };
        }
        result = await getOutstandingReceivables({
          limit:
            typeof args.limit === "number" ? (args.limit as number) : undefined,
          ...periodArgs(args),
        });
        break;
      case "search_items":
        if (!useSupabaseMirror) {
          return { error: "Item search requires Supabase mirror mode." };
        }
        result = await searchItems(args.query as string | undefined);
        break;
      case "get_product_sales":
        if (!useSupabaseMirror) {
          return { error: "Product sales requires Supabase mirror mode." };
        }
        result = await getProductSales({
          query: args.query as string | undefined,
          itemNumbers: Array.isArray(args.itemNumbers)
            ? (args.itemNumbers as string[])
            : undefined,
          returnsOnly: args.returnsOnly === true,
          ...periodArgs(args),
        });
        break;
      case "get_top_customers_by_month":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getTopCustomersByMonth({
          year: typeof args.year === "number" ? args.year : undefined,
          month: typeof args.month === "number" ? args.month : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
        break;
      case "get_top_customers":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getTopCustomers({
          fiscalYearStart:
            typeof args.fiscalYearStart === "number"
              ? args.fiscalYearStart
              : undefined,
          year: typeof args.year === "number" ? args.year : undefined,
          month: typeof args.month === "number" ? args.month : undefined,
          allTime: args.allTime === true,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          branchCode:
            typeof args.branchCode === "string" ? args.branchCode : undefined,
          rankBy: args.rankBy as
            | "invoice_sales"
            | "balance"
            | "overdue"
            | "lifetime_master"
            | undefined,
        });
        break;
      case "get_top_customers_by_nepali_month":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getTopCustomersByNepaliMonth({
          fiscalYearStart:
            typeof args.fiscalYearStart === "number"
              ? args.fiscalYearStart
              : undefined,
          nepaliMonth: args.nepaliMonth as string | undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
        break;
      case "get_customer_sales":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getCustomerSales({
          customerNo: args.customerNo as string | undefined,
          query: args.query as string | undefined,
          ...periodArgs(args),
        });
        break;
      case "get_daily_revenue":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        if (detectCalendarPreference(userMessage) !== "ad") {
          result = {
            error:
              "Daily AD revenue requires an explicit English/Gregorian/AD date. Use a Nepali month/fiscal-year tool for BS questions.",
          };
          break;
        }
        result = await getDailyRevenue({
          year: typeof args.year === "number" ? args.year : undefined,
          month: typeof args.month === "number" ? args.month : undefined,
        });
        break;
      case "compare_revenue_periods":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        if (detectCalendarPreference(userMessage) !== "ad") {
          result = {
            error:
              "AD period comparison requires an explicit English/Gregorian/AD request.",
          };
          break;
        }
        result = await compareRevenuePeriods({
          year1: args.year1 as number,
          month1: typeof args.month1 === "number" ? args.month1 : undefined,
          year2: args.year2 as number,
          month2: typeof args.month2 === "number" ? args.month2 : undefined,
        });
        break;
      case "get_payments_summary":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getPaymentsSummary({
          customerNo: args.customerNo as string | undefined,
          query: args.query as string | undefined,
          ...periodArgs(args),
        });
        break;
      case "get_inventory_summary":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getInventorySummary({
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
        break;
      case "get_low_stock_items":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getLowStockItems({
          threshold:
            typeof args.threshold === "number" ? args.threshold : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
        break;
      case "get_category_sales":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getCategorySales(periodArgs(args));
        break;
      case "get_sales_orders_summary":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getSalesOrdersSummary({
          customerNo: args.customerNo as string | undefined,
          query: args.query as string | undefined,
          status: args.status as string | undefined,
          ...periodArgs(args),
        });
        break;
      case "get_pending_sauda":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getPendingSauda({
          query: args.query as string | undefined,
          customerNo: args.customerNo as string | undefined,
          branchCode: args.branchCode as string | undefined,
          productQuery: args.productQuery as string | undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          ...periodArgs(args),
        });
        break;
      case "search_sales_orders":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await searchSalesOrders({
          query: args.query as string | undefined,
          customerNo: args.customerNo as string | undefined,
          status: args.status as string | undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          ...periodArgs(args),
        });
        break;
      case "get_customer_product_sales":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getCustomerProductSales({
          customerNo: args.customerNo as string | undefined,
          query: args.query as string | undefined,
          productQuery: args.productQuery as string | undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          ...periodArgs(args),
        });
        break;
      case "get_sales_by_salesperson":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getSalesBySalesperson({
          limit: typeof args.limit === "number" ? args.limit : undefined,
          ...nepaliPreferredPeriodArgs(args),
        });
        break;
      case "list_branches":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await listBranches();
        break;
      case "get_branch_wise_sales":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getBranchWiseSales(nepaliPreferredPeriodArgs(args));
        break;
      case "get_sales_by_branch":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getSalesByBranch({
          query: args.query as string | undefined,
          branchCode: args.branchCode as string | undefined,
          monthlyBreakdown: args.monthlyBreakdown === true,
          ...nepaliPreferredPeriodArgs(args),
        });
        break;
      case "get_branch_product_sales":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getBranchProductSales({
          query: args.query as string | undefined,
          branchCode: args.branchCode as string | undefined,
          productQuery: args.productQuery as string | undefined,
          monthlyBreakdown: args.monthlyBreakdown === true,
          ...nepaliPreferredPeriodArgs(args),
        });
        break;
      case "get_vat_report":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getVatReport({
          branchCode: args.branchCode as string | undefined,
          fiscalYearStart:
            typeof args.fiscalYearStart === "number"
              ? args.fiscalYearStart
              : undefined,
          ...periodArgs(args),
        });
        break;
      case "get_mr_records":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getMrRecords({
          query: args.query as string | undefined,
          customerNo: args.customerNo as string | undefined,
          branchCode: args.branchCode as string | undefined,
          status: args.status as string | undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          ...periodArgs(args),
        });
        break;
      case "get_cheque_in_hand":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getChequeInHand({
          query: args.query as string | undefined,
          customerNo: args.customerNo as string | undefined,
          branchCode: args.branchCode as string | undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
          ...periodArgs(args),
        });
        break;
      case "get_item_detail":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getItemDetail({ query: String(args.query ?? "") });
        break;
      case "get_customer_alerts":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getCustomerAlerts({
          type: args.type as "blocked" | "overdue" | "both" | undefined,
          minOverdue:
            typeof args.minOverdue === "number" ? args.minOverdue : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
        break;
      case "search_ledger_entries":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await searchLedgerEntries({
          documentNo: args.documentNo as string | undefined,
          query: args.query as string | undefined,
          customerNo: args.customerNo as string | undefined,
          year: typeof args.year === "number" ? args.year : undefined,
          month: typeof args.month === "number" ? args.month : undefined,
          documentType: args.documentType as string | undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
        break;
      case "get_sync_status":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getSyncStatus();
        break;
      case "compare_customer_yearly_sales":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await compareCustomerYearlySales({
          customerNo: args.customerNo as string | undefined,
          query: args.query as string | undefined,
          years: Array.isArray(args.years)
            ? (args.years as number[])
            : undefined,
        });
        break;
      case "compare_top_customers_yearly":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await compareTopCustomersYearly({
          years: Array.isArray(args.years)
            ? (args.years as number[])
            : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
        break;
      case "get_collection_metrics":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getCollectionMetrics({
          customerNo: args.customerNo as string | undefined,
          query: args.query as string | undefined,
          lookbackDays:
            typeof args.lookbackDays === "number"
              ? args.lookbackDays
              : undefined,
          ...periodArgs(args),
        });
        break;
      case "get_top_paying_customers":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getTopPayingCustomers({
          limit: typeof args.limit === "number" ? args.limit : undefined,
          ...periodArgs(args),
        });
        break;
      case "get_inventory_by_item_type":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getInventoryByItemType({
          itemType: args.itemType as string | undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
        });
        break;
      case "create_sales_order":
        if (useSupabaseMirror) {
          result = await queueWrite("create_sales_order", {
            customerNumber: args.customerNumber,
            pricesIncludeTax: false,
            accountabilityCenter: args.accountabilityCenter ?? "A",
            initiatedAccountabilityCenter: args.accountabilityCenter ?? "A",
            number: "",
            locationCode: args.locationCode ?? "A",
            shippingNo: "",
            paymentMethodCode: args.paymentMethodCode ?? "C-00004",
            postingNo: "",
            externalDocumentNumber: "",
            dimCode1: "A",
            salesOrderLines: args.salesOrderLines,
          });
        } else {
          result = await bcApi.createSalesOrder({
            customerNumber: args.customerNumber,
            pricesIncludeTax: false,
            accountabilityCenter: args.accountabilityCenter ?? "A",
            initiatedAccountabilityCenter: args.accountabilityCenter ?? "A",
            number: "",
            locationCode: args.locationCode ?? "A",
            shippingNo: "",
            paymentMethodCode: args.paymentMethodCode ?? "C-00004",
            postingNo: "",
            externalDocumentNumber: "",
            dimCode1: "A",
            salesOrderLines: args.salesOrderLines,
          });
        }
        break;
      case "post_sales_document":
        if (useSupabaseMirror) {
          result = await queueWrite("post_sales_document", {
            documentNo: args.documentNo,
          });
        } else {
          result = await bcApi.postSalesDocument(args.documentNo as string);
        }
        break;
      case "get_pending_items_to_sell": {
        const customerNo = args.customerNo as string;
        if (useSupabaseMirror) {
          const cached = await getMirrorCache(`pending_items:${customerNo}`);
          if (cached) {
            result = cached;
          } else {
            result = await queueWrite("get_pending_items_to_sell", {
              customerNo,
              fileName: (args.fileName as string) ?? "",
            });
          }
        } else {
          result = await bcApi.getPendingItemsToSell(
            customerNo,
            (args.fileName as string) ?? "",
          );
        }
        break;
      }
      case "lock_sales_order":
        if (useSupabaseMirror) {
          result = await queueWrite("lock_sales_order", {
            documentNo: args.documentNo,
          });
        } else {
          result = await bcApi.lockSalesOrder(args.documentNo as string);
        }
        break;
      case "create_gen_journal_line":
        if (useSupabaseMirror) {
          result = await queueWrite("create_gen_journal_line", args);
        } else {
          result = await bcApi.createGenJournalLine(args);
        }
        break;
      default:
        return { error: `Unknown tool: ${name}` };
    }

    if (
      SNAPSHOT_TOOLS.has(name) &&
      result &&
      typeof result === "object" &&
      !Array.isArray(result)
    ) {
      result = {
        ...(result as Record<string, unknown>),
        scope: "current_snapshot",
        periodApplicability:
          "Current snapshot; the synced source has no historical transaction date to apply a fiscal-year filter.",
      };
    }

    const truncated = truncateResult(result);
    await onLog?.({
      toolName: name,
      requestArgs: args,
      result: truncated,
      success: true,
    });
    return truncated;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await onLog?.({
      toolName: name,
      requestArgs: args,
      result: { error: message },
      success: false,
      error: message,
    });
    return { error: message };
  }
}
