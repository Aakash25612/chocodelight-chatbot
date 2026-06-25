import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL ?? "";
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

export function getSupabaseAdmin() {
  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Supabase is not configured");
  }
  return createClient(supabaseUrl, supabaseServiceKey);
}

export function isSupabaseConfigured(): boolean {
  return Boolean(supabaseUrl && supabaseServiceKey);
}

export type Conversation = {
  id: string;
  title: string | null;
  created_at: string;
  updated_at: string;
};

export type DbMessage = {
  id: string;
  conversation_id: string;
  role: "user" | "assistant";
  content: string;
  tool_calls_used: number;
  created_at: string;
};

export type ApiLog = {
  id: string;
  conversation_id: string | null;
  message_id: string | null;
  tool_name: string;
  request_args: Record<string, unknown> | null;
  response_preview: string | null;
  success: boolean;
  error: string | null;
  created_at: string;
};
