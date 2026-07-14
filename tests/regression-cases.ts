export const REFERENCE_DATE = new Date("2026-07-14T12:00:00+05:45");

export type RegressionCase = {
  id: string;
  question: string;
  tool: string;
  intent: string;
  args: Record<string, unknown>;
};

export const REGRESSION_CASES: RegressionCase[] = [
  {
    id: "top-customers-sales",
    question: "first 5 customer amount wise total sales",
    tool: "get_top_customers",
    intent: "top_customer_sales",
    args: { limit: 5, rankBy: "invoice_sales", fiscalYearStart: 2082 },
  },
  {
    id: "customer-sales",
    question: "total sales of bhat bhateni",
    tool: "get_customer_sales",
    intent: "customer_sales",
    args: { query: "bhat bhateni", fiscalYearStart: 2082 },
  },
  {
    id: "mustard-oil-mt",
    question: "total mustard oil sales in metric ton this year",
    tool: "get_product_sales",
    intent: "product_sales",
    args: { query: "mustard oil", fiscalYearStart: 2082 },
  },
  {
    id: "sawa-rice-default-fy",
    question: "total sales of sawa rice",
    tool: "get_product_sales",
    intent: "product_sales",
    args: { query: "sawa rice", fiscalYearStart: 2082 },
  },
  {
    id: "pending-sauda-product",
    question: "MUSTARD CAKE 50 KGS [QNT] average price in pending sauda",
    tool: "get_pending_sauda",
    intent: "pending_sauda",
    args: { fiscalYearStart: 2082 },
  },
  {
    id: "cheque-code-w",
    question: "cheque in hand code W Balkot depo",
    tool: "get_cheque_in_hand",
    intent: "cheque_in_hand",
    args: { branchCode: "W", fiscalYearStart: 2082 },
  },
  {
    id: "branch-code-w",
    question: "code W sales",
    tool: "get_sales_by_branch",
    intent: "branch_sales",
    args: { branchCode: "W", fiscalYearStart: 2082 },
  },
  {
    id: "collection-days",
    question: "what is avg collection days of bhat bhateni",
    tool: "get_collection_metrics",
    intent: "collection_metrics",
    args: { query: "bhat bhateni", fiscalYearStart: 2082 },
  },
  {
    id: "product-returns",
    question:
      "what is the total sales return of gyan extra long grain rice this fiscal year",
    tool: "get_product_sales",
    intent: "product_returns",
    args: {
      query: "gyan extra long grain rice",
      returnsOnly: true,
      fiscalYearStart: 2082,
    },
  },
  {
    id: "explicit-ad",
    question: "total sales for June 2026 AD",
    tool: "get_monthly_revenue",
    intent: "company_sales",
    args: { year: 2026, month: 6 },
  },
];
