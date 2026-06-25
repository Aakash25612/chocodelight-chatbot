import { NextResponse } from "next/server";
import { getConversationMessages, isSupabaseConfigured } from "@/lib/db";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  const { id } = await params;
  const messages = await getConversationMessages(id);
  return NextResponse.json({ messages });
}
