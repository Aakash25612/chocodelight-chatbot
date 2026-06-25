import {
  SchemaType,
  type FunctionDeclaration,
} from "@google/generative-ai";
import { bcApi } from "./bc-client";
import {
  getMirror,
  getMirrorCache,
  getUomsFromMirror,
  queueWrite,
} from "./bc-mirror";
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
    description: "Get all customers for the configured company.",
    parameters: { type: SchemaType.OBJECT, properties: {} },
  },
  {
    name: "get_customer_ledger_entries",
    description:
      "Get customer ledger entries (custLedgEntries) for the configured company.",
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
