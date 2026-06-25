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
import { useSupabaseMirror } from "./config";

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
      "Get month-wise revenue for ONE English/Gregorian (AD) calendar year (Jan-Dec) from customer ledger invoice entries. Use for AD month questions like 'which month in 2026 had most revenue'. For TOTAL sales across all time use get_sales_summary. For Nepali (Bikram Sambat) months use get_nepali_monthly_sales.",
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
      "Get the TOTAL sales summary across ALL synced data (multiple years). Returns all-time net sales, invoice count, date range, plus a breakdown by AD year AND by Nepali fiscal year (Shrawan-Ashadh). Use this whenever the user asks for 'total sales', 'overall sales', 'sales so far', or sales by year / by fiscal year. Do NOT use a single-year tool for total sales.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "get_nepali_monthly_sales",
    description:
      "Get sales by Nepali (Bikram Sambat) month for a Nepali fiscal year (Shrawan through Ashadh). Use for any Nepali-month question (Baisakh, Jestha, Asar, Shrawan, Bhadra, Aswin, Kartik, Mangsir, Poush, Magh, Falgun, Chaitra) or Nepali fiscal-year sales. Returns each BS month's sales and the top month.",
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
      "Get accounts receivable aging from open customer invoices, bucketed by days past due (Not due, 1-30, 31-60, 61-90, Over 90 days). Use for overdue / outstanding / 'payment pending' / 'X days pending' / collection questions. Returns bucket totals, top overdue customers, and overdue invoice details.",
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
      "Get invoiced product sales totals from synced sales order lines. Use for questions like total sales of dip, chocolate sales this year, how much FGCH021 sold, sales by product keyword or item number. Returns total sales excl. tax, quantity invoiced, and per-item breakdown.",
    parameters: {
      type: SchemaType.OBJECT,
      properties: {
        query: {
          type: SchemaType.STRING,
          description:
            "Product keyword to match item number or name, e.g. 'dip', 'chocolate', 'syrup'.",
        },
        year: {
          type: SchemaType.NUMBER,
          description:
            "Optional AD calendar year filter on sales order posting date, e.g. 2026.",
        },
        itemNumbers: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING },
          description:
            "Optional explicit item numbers to include, e.g. ['FGDCDIP20KG','CMCD-20KG'].",
        },
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
          year: typeof args.year === "number" ? args.year : undefined,
          itemNumbers: Array.isArray(args.itemNumbers)
            ? (args.itemNumbers as string[])
            : undefined,
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
