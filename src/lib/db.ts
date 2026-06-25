import {
  getSupabaseAdmin,
  isSupabaseConfigured,
  type Conversation,
  type DbMessage,
} from "./supabase";

export async function createConversation(title?: string): Promise<Conversation> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("conversations")
    .insert({ title: title ?? "New chat" })
    .select()
    .single();

  if (error) throw error;
  return data;
}

export async function updateConversationTitle(
  id: string,
  title: string,
): Promise<void> {
  const supabase = getSupabaseAdmin();
  const { error } = await supabase
    .from("conversations")
    .update({ title })
    .eq("id", id);
  if (error) throw error;
}

export async function listConversations(): Promise<Conversation[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("conversations")
    .select("*")
    .order("updated_at", { ascending: false })
    .limit(50);

  if (error) throw error;
  return data ?? [];
}

export async function getConversationMessages(
  conversationId: string,
): Promise<DbMessage[]> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("messages")
    .select("*")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true });

  if (error) throw error;
  return data ?? [];
}

export async function saveMessage(
  conversationId: string,
  role: "user" | "assistant",
  content: string,
  toolCallsUsed = 0,
): Promise<DbMessage> {
  const supabase = getSupabaseAdmin();
  const { data, error } = await supabase
    .from("messages")
    .insert({
      conversation_id: conversationId,
      role,
      content,
      tool_calls_used: toolCallsUsed,
    })
    .select()
    .single();

  if (error) throw error;

  await supabase
    .from("conversations")
    .update({ updated_at: new Date().toISOString() })
    .eq("id", conversationId);

  return data;
}

export async function logApiCall(params: {
  conversationId?: string;
  messageId?: string;
  toolName: string;
  requestArgs: Record<string, unknown>;
  result: unknown;
  success: boolean;
  error?: string;
}): Promise<void> {
  if (!isSupabaseConfigured()) return;

  const supabase = getSupabaseAdmin();
  const preview = JSON.stringify(params.result).slice(0, 4000);

  await supabase.from("api_logs").insert({
    conversation_id: params.conversationId ?? null,
    message_id: params.messageId ?? null,
    tool_name: params.toolName,
    request_args: params.requestArgs,
    response_preview: preview,
    success: params.success,
    error: params.error ?? null,
  });
}

export { isSupabaseConfigured };
