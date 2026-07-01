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
  getSalesOrdersSummary,
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

const mirrorOnly = "Requires Supabase mirror mode (BC_DATA_SOURCE=supabase).";

const periodToolProperties = {
  year: {
    type: SchemaType.NUMBER,
    description: "AD calendar year filter.",
  },
  month: {
    type: SchemaType.NUMBER,
    description: "AD month 1-12 (use with year for June: month=6).",
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
    description: "BS fiscal year start at Shrawan, e.g. 2082.",
  },
} as const;

function periodArgs(args: Record<string, unknown>): DatePeriodInput {
  return {
    year: typeof args.year === "number" ? args.year : undefined,
    month: typeof args.month === "number" ? args.month : undefined,
    week: typeof args.week === "number" ? args.week : undefined,
    day: typeof args.day === "number" ? args.day : undefined,
    dateFrom: args.dateFrom as string | undefined,
    dateTo: args.dateTo as string | undefined,
    nepaliMonth: args.nepaliMonth as string | undefined,
    fiscalYearStart:
      typeof args.fiscalYearStart === "number" ? args.fiscalYearStart : undefined,
  };
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
      "Get a customer's invoiced vs paid summary, open balance, overdue invoices, and recent payments. Use for 'how much has X paid', payment history, outstanding balance for one customer, or follow-up after receivables aging. Pass query (name), customerNo, and/or documentNo from a prior invoice.",
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
      "Total sales summary across ALL synced data. Returns all-time net sales, byNepaliFiscalYear (primary for Nepal), currentNepaliFiscalYear (this BS fiscal year total), and byAdYear (secondary). Use for 'total sales', 'all time', or 'revenue this year' when user means the current Nepali fiscal year — combine with get_nepali_monthly_sales for month breakdown.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "get_nepali_monthly_sales",
    description:
      "DEFAULT for month-wise sales/revenue in Nepal. Sales by Bikram Sambat month for a Nepali fiscal year (Shrawan through Ashadh). Use for 'monthwise sales', 'month-wise revenue', 'this year', YTD, or any BS month (Baisakh, Jestha, Asar, Shrawan, Bhadra, Aswin, Kartik, Mangsir, Poush, Magh, Falgun, Chaitra). Returns yearToDate for the current fiscal year. Omit fiscalYearStart for the current Nepali fiscal year.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
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
      "Aging buckets for open invoices by days past due (Not due, 1-30, 31-60, 61-90, Over 90 days). Use for overdue-only questions, 'X days payment pending', or aging analysis — NOT for ranking who owes the most total (use get_outstanding_receivables). Also returns topCustomersByBalance with overdue vs not-yet-due split.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        minDaysOverdue: {
          type: SchemaType.NUMBER,
          description:
            "Optional. Only include invoices overdue by at least this many days, e.g. 90 for '90 days payment pending'.",
        },
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
      "Get invoiced product sales totals and averageUnitPrice from synced sales order lines. Use for product sales amount AND average selling price questions.",
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
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_top_customers_by_month",
    description:
      "Get top customers ranked by invoiced sales for ONE English (AD) calendar month. USE THIS for 'top customer in June 2026', 'best customer last month', etc. Uses customer ledger invoices (salesLcy) — NOT sales orders or company total revenue.",
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
      "Rank customers by invoice sales (ledger), balance, overdue, or lifetime master sales. Use for 'top 10 customers this year', 'biggest customers overall'. For outstanding/receivable ranking use get_outstanding_receivables instead. For a specific AD month use get_top_customers_by_month instead.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        year: { type: SchemaType.NUMBER, description: "Optional AD year filter." },
        month: { type: SchemaType.NUMBER, description: "Optional AD month 1-12." },
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
      "Top customers by invoiced sales for one Nepali (BS) month within a fiscal year. Use for 'top customer in Jestha 2082'.",
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
      "Invoice sales totals for ONE customer, optionally filtered by AD year/month, with monthly breakdown. Use for 'how much did X sell in 2026'.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: "Customer name search." },
        customerNo: { type: SchemaType.STRING },
        year: { type: SchemaType.NUMBER },
        month: { type: SchemaType.NUMBER, description: "AD month 1-12." },
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
      "Product category sales from synced sales order lines. Supports year/month/week/date range/Nepali month filters.",
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
      "What products ONE customer bought in a specific period. USE THIS for 'what did Bhatbhateni buy in June' — pass query + year + month (June=6), or dateFrom/dateTo, or week. Returns item lines for ONLY that window, not year-to-date.",
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
    name: "get_sales_by_salesperson",
    description:
      "Invoiced sales order line totals grouped by salesperson code. Supports date period filters.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        limit: { type: SchemaType.NUMBER },
        ...periodToolProperties,
      },
    },
  },
  {
    name: "get_mr_records",
    description:
      "Money receipt (MR) cheque/payment records. Search by customer or filter by year/status.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: { type: SchemaType.STRING, description: "Customer name/number or MR search." },
        customerNo: { type: SchemaType.STRING },
        year: { type: SchemaType.NUMBER },
        status: { type: SchemaType.STRING, description: "e.g. Cheque Cleared." },
        limit: { type: SchemaType.NUMBER },
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
): Promise<unknown> {
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
        result = await getSalesSummary();
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
        result = await getReceivablesAging(
          typeof args.minDaysOverdue === "number"
            ? args.minDaysOverdue
            : undefined,
        );
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
          year: typeof args.year === "number" ? args.year : undefined,
          month: typeof args.month === "number" ? args.month : undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
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
          year: typeof args.year === "number" ? args.year : undefined,
          month: typeof args.month === "number" ? args.month : undefined,
        });
        break;
      case "get_daily_revenue":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getDailyRevenue({
          year: typeof args.year === "number" ? args.year : undefined,
          month: typeof args.month === "number" ? args.month : undefined,
        });
        break;
      case "compare_revenue_periods":
        if (!useSupabaseMirror) return { error: mirrorOnly };
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
          ...periodArgs(args),
        });
        break;
      case "get_mr_records":
        if (!useSupabaseMirror) return { error: mirrorOnly };
        result = await getMrRecords({
          query: args.query as string | undefined,
          customerNo: args.customerNo as string | undefined,
          year: typeof args.year === "number" ? args.year : undefined,
          status: args.status as string | undefined,
          limit: typeof args.limit === "number" ? args.limit : undefined,
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
