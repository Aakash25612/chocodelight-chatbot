import { NextResponse } from "next/server";
import { runFullSync } from "@/lib/bc-sync";
import { getSyncStatus } from "@/lib/bc-mirror";
import { syncConfig, useSupabaseMirror } from "@/lib/config";
import { isSupabaseConfigured } from "@/lib/db";

export const maxDuration = 120;

function authorize(request: Request): boolean {
  if (!syncConfig.secret) return false;
  const header = request.headers.get("authorization");
  const url = new URL(request.url);
  const querySecret = url.searchParams.get("secret");
  return (
    header === `Bearer ${syncConfig.secret}` || querySecret === syncConfig.secret
  );
}

export async function GET(request: Request) {
  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  const status = await getSyncStatus();
  return NextResponse.json({
    mode: useSupabaseMirror ? "supabase_mirror" : "direct_bc",
    ...status,
  });
}

export async function POST(request: Request) {
  if (!authorize(request)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (!isSupabaseConfigured()) {
    return NextResponse.json({ error: "Supabase not configured" }, { status: 500 });
  }

  try {
    const result = await runFullSync();
    return NextResponse.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
