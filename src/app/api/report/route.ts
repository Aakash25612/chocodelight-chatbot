import { NextResponse } from "next/server";
import { generateBusinessReport } from "@/lib/report-generator";
import { normalizeCompanyKey } from "@/lib/companies";
import { runWithCompany } from "@/lib/company-context";

export const maxDuration = 60;

export async function POST(request: Request) {
  try {
    const body = (await request.json()) as { prompt?: string; company?: string };
    const prompt = body.prompt?.trim();
    const company = normalizeCompanyKey(body.company);

    if (!prompt) {
      return NextResponse.json({ error: "Prompt required" }, { status: 400 });
    }

    const report = await runWithCompany(company, () =>
      generateBusinessReport(prompt),
    );
    return NextResponse.json(report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
