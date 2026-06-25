import { NextResponse } from "next/server";
import { getSyncStatus } from "@/lib/bc-mirror";
import { useSupabaseMirror } from "@/lib/config";
import { isSupabaseConfigured } from "@/lib/db";

export async function GET() {
  if (useSupabaseMirror && isSupabaseConfigured()) {
    try {
      const status = await getSyncStatus();
      const entityCount = Object.keys(status.entities).length;
      const hasData = entityCount > 0;

      return NextResponse.json({
        mode: "supabase_mirror",
        bcApi: {
          reachable: hasData,
          companies: status.entities.companies?.recordCount,
          lastSync: status.lastFullSync,
          pendingWrites: status.pendingWrites,
          entities: entityCount,
        },
        ready: hasData,
      });
    } catch (error) {
      return NextResponse.json({
        mode: "supabase_mirror",
        bcApi: {
          reachable: false,
          error: error instanceof Error ? error.message : String(error),
        },
        ready: false,
      });
    }
  }

  const { bcApi } = await import("@/lib/bc-client");
  let bcApiStatus: {
    reachable: boolean;
    error?: string;
    companies?: number;
  } = { reachable: false };

  try {
    const data = (await bcApi.getCompanies()) as { value?: unknown[] };
    bcApiStatus = {
      reachable: true,
      companies: data.value?.length ?? 0,
    };
  } catch (error) {
    bcApiStatus = {
      reachable: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return NextResponse.json({
    mode: "direct_bc",
    bcApi: bcApiStatus,
    ready: bcApiStatus.reachable,
  });
}
