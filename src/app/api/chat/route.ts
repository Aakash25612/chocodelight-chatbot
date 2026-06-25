import {
  GoogleGenerativeAI,
  type Content,
  type Part,
} from "@google/generative-ai";
import { NextResponse } from "next/server";
import { geminiConfig } from "@/lib/config";
import {
  createConversation,
  getConversationMessages,
  isSupabaseConfigured,
  logApiCall,
  saveMessage,
  updateConversationTitle,
} from "@/lib/db";
import { executeTool, toolDeclarations } from "@/lib/tools";

export const maxDuration = 60;

const SYSTEM_PROMPT = `You are ChocoDelight BC Assistant, an AI chatbot for the ChocoDelight Business Central mobile app API.

You help users query and manage business data including:
- Companies, customers, customer ledger entries
- Items, units of measure, salespersons, MR records
- Sales orders (create, lock, post)
- Pending items to sell for customers
- General journal lines

Guidelines:
- Use the available tools to fetch or modify data. Do not invent data.
- When listing large datasets, summarize key fields and offer to filter or show more.
- For sales orders, confirm customer number and line items before creating.
- For write operations (create sales order, post document, lock order, journal lines), confirm intent when details are ambiguous.
- If an API call fails, explain the error clearly and suggest fixes (e.g. server cannot reach Business Central, invalid customer number).
- Be concise and professional. Format tables and lists clearly in markdown.`;

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

export async function POST(request: Request) {
  if (!geminiConfig.apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not configured" },
      { status: 500 },
    );
  }

  const body = (await request.json()) as {
    messages: ChatMessage[];
    conversationId?: string;
  };
  const { messages, conversationId: existingConversationId } = body;

  if (!messages?.length) {
    return NextResponse.json({ error: "Messages required" }, { status: 400 });
  }

  let conversationId = existingConversationId;

  if (isSupabaseConfigured()) {
    if (!conversationId) {
      const firstUserMsg = messages.find((m) => m.role === "user")?.content;
      const title = firstUserMsg?.slice(0, 60) ?? "New chat";
      const conversation = await createConversation(title);
      conversationId = conversation.id;
    }

    const lastUserMessage = messages[messages.length - 1];
    if (lastUserMessage.role === "user") {
      await saveMessage(conversationId, "user", lastUserMessage.content);
      if (messages.filter((m) => m.role === "user").length === 1) {
        await updateConversationTitle(conversationId, lastUserMessage.content.slice(0, 60));
      }
    }
  }

  const genAI = new GoogleGenerativeAI(geminiConfig.apiKey);
  const model = genAI.getGenerativeModel({
    model: geminiConfig.model,
    systemInstruction: SYSTEM_PROMPT,
    tools: [{ functionDeclarations: toolDeclarations }],
  });

  const history: Content[] = messages.slice(0, -1).map((msg) => ({
    role: msg.role === "assistant" ? "model" : "user",
    parts: [{ text: msg.content }],
  }));

  const lastMessage = messages[messages.length - 1].content;
  const chat = model.startChat({ history });

  try {
    let response = await chat.sendMessage(lastMessage);
    let iterations = 0;
    const maxIterations = 8;

    while (iterations < maxIterations) {
      const functionCalls = response.response.functionCalls();
      if (!functionCalls?.length) break;

      const functionResponses: Part[] = [];

      for (const call of functionCalls) {
        const args = (call.args ?? {}) as Record<string, unknown>;
        const result = await executeTool(call.name, args, async (log) => {
          if (conversationId && isSupabaseConfigured()) {
            await logApiCall({
              conversationId,
              toolName: log.toolName,
              requestArgs: log.requestArgs,
              result: log.result,
              success: log.success,
              error: log.error,
            });
          }
        });

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

    const text = response.response.text();

    if (conversationId && isSupabaseConfigured()) {
      await saveMessage(conversationId, "assistant", text, iterations);
    }

    return NextResponse.json({
      message: text,
      toolCallsUsed: iterations,
      conversationId,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (message.includes("429") || message.includes("depleted")) {
      return NextResponse.json(
        {
          error:
            "Gemini API quota exceeded. Add billing at https://ai.studio/projects or use a key with available credits.",
          conversationId,
        },
        { status: 429 },
      );
    }

    return NextResponse.json({ error: message, conversationId }, { status: 500 });
  }
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const conversationId = searchParams.get("conversationId");

  if (!conversationId || !isSupabaseConfigured()) {
    return NextResponse.json({ error: "conversationId required" }, { status: 400 });
  }

  const messages = await getConversationMessages(conversationId);
  return NextResponse.json({ messages });
}
