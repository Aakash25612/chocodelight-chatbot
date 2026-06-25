"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type ReportPayload = {
  title: string;
  html: string;
  createdAt: string;
};

export default function ReportPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const [report, setReport] = useState<ReportPayload | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    params.then(({ id }) => {
      const raw = window.localStorage.getItem(`chocodelight-report:${id}`);
      if (!raw) {
        setMissing(true);
        return;
      }

      try {
        setReport(JSON.parse(raw) as ReportPayload);
      } catch {
        setMissing(true);
      }
    });
  }, [params]);

  if (missing) {
    return (
      <main className="flex min-h-screen items-center justify-center bg-zinc-50 p-6">
        <div className="max-w-md rounded-3xl border border-zinc-200 bg-white p-8 text-center shadow-sm">
          <h1 className="text-2xl font-semibold tracking-tight">Report not found</h1>
          <p className="mt-3 text-sm text-zinc-500">
            Reports are saved locally on the device that generated them. Open the
            original chat and generate the report again.
          </p>
          <Link
            href="/"
            className="mt-6 inline-flex rounded-full bg-zinc-950 px-5 py-3 text-sm font-medium text-white"
          >
            Back to chat
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-zinc-100">
      <div className="flex items-center justify-between border-b border-zinc-200 bg-white/90 px-4 py-3 backdrop-blur">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-zinc-950">
            {report?.title ?? "Loading report..."}
          </p>
          {report?.createdAt && (
            <p className="text-xs text-zinc-500">
              Generated {new Date(report.createdAt).toLocaleString()}
            </p>
          )}
        </div>
        <div className="flex gap-2">
          <Link
            href="/"
            className="rounded-full border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700"
          >
            Chat
          </Link>
          <button
            type="button"
            onClick={() => window.print()}
            className="rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white"
          >
            Print / Save PDF
          </button>
        </div>
      </div>

      {report ? (
        <iframe
          title={report.title}
          srcDoc={report.html}
          className="h-[calc(100vh-65px)] w-full border-0"
        />
      ) : (
        <div className="p-8 text-center text-zinc-500">Loading report...</div>
      )}
    </main>
  );
}
