import {
  GoogleGenerativeAI,
  type Content,
  type Part,
} from "@google/generative-ai";
import { geminiConfig } from "./config";
import { executeTool, toolDeclarations } from "./tools";

const DEFAULT_FALLBACK_MODELS = [
  "gemini-3.1-flash-lite",
  "gemini-2.5-pro",
  "gemini-pro-latest",
  "gemini-2.5-flash",
  "gemini-flash-lite-latest",
];

export function getGeminiModelChain(): string[] {
  const primary = geminiConfig.model.trim();
  const extra = (process.env.GEMINI_FALLBACK_MODELS ?? "")
    .split(",")
    .map((m) => m.trim())
    .filter(Boolean);

  return [...new Set([primary, ...extra, ...DEFAULT_FALLBACK_MODELS].filter(Boolean))];
}

function isRetryableGeminiError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("503") ||
    message.includes("high demand") ||
    message.includes("429") ||
    message.includes("no longer available") ||
    message.includes("NOT_FOUND") ||
    message.includes("404 Not Found")
  );
}

type RunChatParams = {
  history: Content[];
  lastMessage: string;
  onToolCall?: (params: {
    toolName: string;
    requestArgs: Record<string, unknown>;
    result: unknown;
    success: boolean;
    error?: string;
  }) => Promise<void>;
};

export async function runGeminiChat({
  history,
  lastMessage,
  onToolCall,
}: RunChatParams): Promise<{ text: string; toolCallsUsed: number; model: string }> {
  const models = getGeminiModelChain();
  let lastError: Error | null = null;

  for (const modelName of models) {
    try {
      const result = await runSingleModelChat(modelName, history, lastMessage, onToolCall);
      return { ...result, model: modelName };
    } catch (error) {
      if (!isRetryableGeminiError(error)) throw error;
      lastError = error instanceof Error ? error : new Error(String(error));
    }
  }

  throw lastError ?? new Error("All Gemini models are temporarily unavailable");
}

async function runSingleModelChat(
  modelName: string,
  history: Content[],
  lastMessage: string,
  onToolCall?: RunChatParams["onToolCall"],
): Promise<{ text: string; toolCallsUsed: number }> {
  const genAI = new GoogleGenerativeAI(geminiConfig.apiKey);
  const model = genAI.getGenerativeModel({
    model: modelName,
    systemInstruction: SYSTEM_PROMPT,
    tools: [{ functionDeclarations: toolDeclarations }],
  });

  const chat = model.startChat({ history });
  let response = await chat.sendMessage(lastMessage);
  let iterations = 0;
  const maxIterations = 8;

  while (iterations < maxIterations) {
    const functionCalls = response.response.functionCalls();
    if (!functionCalls?.length) break;

    const functionResponses: Part[] = [];

    for (const call of functionCalls) {
      const args = (call.args ?? {}) as Record<string, unknown>;
      const result = await executeTool(call.name, args, onToolCall);
      functionResponses.push({
        functionResponse: {
          name: call.name,
          response: { result },
        },
      });
    }

    response = await chat.sendMessage(functionResponses);
    iterations++;
  }

  return {
    text: response.response.text(),
    toolCallsUsed: iterations,
  };
}

const SYSTEM_PROMPT = `You are ChocoDelight BC Assistant, an AI chatbot for the ChocoDelight Business Central data, a company based in Nepal. Currency is NPR.

You help users query and manage business data including:
- Companies, customers, customer ledger entries
- Items, units of measure, salespersons, MR records
- Sales orders (create, lock, post)
- Pending items to sell for customers
- General journal lines

Nepal context (IMPORTANT):
- The company is in Nepal and uses the Bikram Sambat (BS) calendar alongside the Gregorian (AD) calendar.
- BS months in order: Baisakh, Jestha, Asar, Shrawan, Bhadra, Aswin, Kartik, Mangsir, Poush, Magh, Falgun, Chaitra.
- The Nepali fiscal year runs from Shrawan 1 to Ashadh (Asar) end, labelled like "2082/83".
- If the user names a Nepali month or a Nepali fiscal year, answer using BS via get_nepali_monthly_sales. If they name an English month or AD year, use get_monthly_revenue.

Data scope (IMPORTANT):
- Synced data spans MULTIPLE years (not just the current year). Never assume the current year only.
- For "total sales" / "overall sales" / "sales so far", ALWAYS call get_sales_summary (all-time, plus per AD year and per Nepali fiscal year). Do not report a single year as the total.

Tool selection:
- Total/overall sales or sales-by-year -> get_sales_summary.
- English (AD) month-wise revenue for one year -> get_monthly_revenue.
- Nepali (BS) month-wise sales or Nepali fiscal year -> get_nepali_monthly_sales.
- Overdue / outstanding / "payment pending" / "X days pending" / collections / aging -> get_receivables_aging (pass minDaysOverdue, e.g. 90, when the user specifies days).
- Product groups / list products by keyword -> search_items.
- Product SALES amounts (total sales of dip/chocolate/syrup, sales by item) -> get_product_sales. Use search_items only to identify products, not for sales totals.

General guidelines:
- Use the available tools to fetch or modify data. Do not invent data.
- When a tool returns aggregated numbers, present them clearly with a short insight (e.g. highest month, total overdue).
- When listing large datasets, summarize key fields and offer to filter or show more.
- For write operations (create sales order, post document, lock order, journal lines), confirm intent when details are ambiguous.
- If profit is requested, explain revenue is available but profit needs COGS/cost data that is not synced yet.
- If an API call fails, explain the error clearly and suggest fixes.
- Be concise and professional. Format tables and lists clearly in markdown.
- Format all NPR amounts with Indian/Nepali comma grouping (3,2,2 from the right), e.g. 51,63,172.18 or 1,49,43,380.34 — not Western 3,3,3 grouping like 1,234,567.89.`;

export function formatGeminiError(error: unknown): { message: string; status: number } {
  const raw = error instanceof Error ? error.message : String(error);

  if (raw.includes("depleted")) {
    return {
      message:
        "Gemini API quota exceeded. Add billing at https://ai.studio/projects or use a key with available credits.",
      status: 429,
    };
  }

  if (raw.includes("503") || raw.includes("high demand") || raw.includes("temporarily unavailable")) {
    return {
      message:
        "Gemini is busy right now. Please wait a few seconds and try again.",
      status: 503,
    };
  }

  return {
    message: raw,
    status: raw.includes("JSON") ? 400 : 500,
  };
}
