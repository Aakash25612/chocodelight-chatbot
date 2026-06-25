import { NextResponse } from "next/server";
import {
  createConversation,
  getConversationMessages,
  isSupabaseConfigured,
  logApiCall,
  saveMessage,
  updateConversationTitle,
} from "@/lib/db";
import { formatGeminiError, runGeminiChat } from "@/lib/gemini-chat";
import { geminiConfig } from "@/lib/config";
import { getDirectResponse } from "@/lib/direct-responses";

export const maxDuration = 60;

type ChatMessage = {
  role: "user" | "assistant";
  content: string;
};

function getGeminiHistory(messages: ChatMessage[]) {
  const historyMessages = [...messages.slice(0, -1)];

  while (historyMessages[0]?.role === "assistant") {
    historyMessages.shift();
  }

  return historyMessages.map((msg) => ({
    role: msg.role === "assistant" ? ("model" as const) : ("user" as const),
    parts: [{ text: msg.content }],
  }));
}

export async function POST(request: Request) {
  if (!geminiConfig.apiKey) {
    return NextResponse.json(
      { error: "GEMINI_API_KEY is not configured" },
      { status: 500 },
    );
  }

  try {
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
          await updateConversationTitle(
            conversationId,
            lastUserMessage.content.slice(0, 60),
          );
        }
      }
    }

    const history = getGeminiHistory(messages);
    const lastMessage = messages[messages.length - 1].content;
    const directResponse = await getDirectResponse(lastMessage);

    if (directResponse) {
      if (conversationId && isSupabaseConfigured()) {
        await saveMessage(conversationId, "assistant", directResponse, 0);
      }

      return NextResponse.json({
        message: directResponse,
        toolCallsUsed: 0,
        conversationId,
        source: "supabase_direct",
      });
    }

    const { text, toolCallsUsed } = await runGeminiChat({
      history,
      lastMessage,
      onToolCall: async (log) => {
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
      },
    });

    if (conversationId && isSupabaseConfigured()) {
      await saveMessage(conversationId, "assistant", text, toolCallsUsed);
    }

    return NextResponse.json({
      message: text,
      toolCallsUsed,
      conversationId,
    });
  } catch (error) {
    const { message, status } = formatGeminiError(error);
    return NextResponse.json({ error: message }, { status });
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
