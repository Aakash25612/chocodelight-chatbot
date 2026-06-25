import { NextResponse } from "next/server";
import {
  createConversation,
  isSupabaseConfigured,
  listConversations,
} from "@/lib/db";

export async function GET() {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  const conversations = await listConversations();
  return NextResponse.json({ conversations });
}

export async function POST(request: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  const body = (await request.json()) as { title?: string };
  const conversation = await createConversation(body.title);
  return NextResponse.json({ conversation });
}
