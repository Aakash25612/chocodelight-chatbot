"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type LocalChat = {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: string;
  apiConversationId?: string;
};

type HealthStatus = {
  mode?: string;
  bcApi: {
    reachable: boolean;
    companies?: number;
    error?: string;
    lastSync?: string | null;
    entities?: number;
    pendingWrites?: number;
  };
  ready: boolean;
};

const STORAGE_KEY = "chocodelight-chat-history:v1";
const REPORT_STORAGE_PREFIX = "chocodelight-report:";
const COMPANY_STORAGE_KEY = "chocodelight-active-company";

const COMPANIES = [
  { key: "chocodelight", label: "Choco Delight", short: "CD" },
  { key: "saurabhfood", label: "Saurabh Food", short: "SF" },
] as const;

type CompanyKey = (typeof COMPANIES)[number]["key"];

const DEFAULT_COMPANY: CompanyKey = "chocodelight";

function getCompanyMeta(key: CompanyKey) {
  return COMPANIES.find((c) => c.key === key) ?? COMPANIES[0];
}

function welcomeFor(key: CompanyKey): string {
  const label = getCompanyMeta(key).label;
  return `Hello! I'm your **${label} BC Assistant**. Ask me about customers, items, sales orders, ledger entries, and more.\n\nData is served from **Supabase** so you do not need VPN on this device.\n\nWhat would you like to do?`;
}

const WELCOME = welcomeFor(DEFAULT_COMPANY);

const WELCOME_MESSAGE: Message = { role: "assistant", content: WELCOME };

const SUGGESTIONS = [
  "Branch wise sales",
  "Code W sales",
  "List all customers",
  "What is month-wise sales this year?",
  "Show available items",
];

function createId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function createTitle(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > 44 ? `${clean.slice(0, 44)}...` : clean || "New chat";
}

function isReportPrompt(text: string): boolean {
  return /\b(report|pdf|chart|graph|dashboard|analysis|summary)\b/i.test(text);
}

function readLocalChats(): LocalChat[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as LocalChat[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((chat) => chat.id && Array.isArray(chat.messages))
      .sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
  } catch {
    return [];
  }
}

function writeLocalChats(chats: LocalChat[]): void {
  if (typeof window === "undefined") return;
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(chats));
}

async function readJsonResponse<T>(response: Response): Promise<T> {
  const text = await response.text();

  if (!text.trim()) {
    if (response.ok) return {} as T;
    throw new Error(`Server returned ${response.status} with an empty response`);
  }

  try {
    return JSON.parse(text) as T;
  } catch {
    const preview = text.slice(0, 180).replace(/\s+/g, " ");
    throw new Error(
      `Server returned ${response.status} but not JSON: ${preview || "empty body"}`,
    );
  }
}

export default function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([WELCOME_MESSAGE]);
  const [currentChatId, setCurrentChatId] = useState<string | null>(null);
  const [apiConversationId, setApiConversationId] = useState<string | null>(null);
  const [chats, setChats] = useState<LocalChat[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [reportMode, setReportMode] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [company, setCompany] = useState<CompanyKey>(DEFAULT_COMPANY);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadHealth = useCallback(async (companyKey: CompanyKey) => {
    try {
      const res = await fetch(`/api/health?company=${companyKey}`);
      const data = await readJsonResponse<HealthStatus>(res);
      setHealth(data);
    } catch {
      setHealth(null);
    }
  }, []);

  useEffect(() => {
    const storedChats = readLocalChats();
    setChats(storedChats);
    setSidebarOpen(window.innerWidth >= 768);
    const storedCompany = window.localStorage.getItem(
      COMPANY_STORAGE_KEY,
    ) as CompanyKey | null;
    const initialCompany =
      storedCompany && COMPANIES.some((c) => c.key === storedCompany)
        ? storedCompany
        : DEFAULT_COMPANY;
    setCompany(initialCompany);
  }, []);

  useEffect(() => {
    // Polling an external system (health endpoint) is an allowed effect use.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadHealth(company);
    const interval = setInterval(() => loadHealth(company), 30000);
    return () => clearInterval(interval);
  }, [loadHealth, company]);

  function switchCompany(next: CompanyKey) {
    if (next === company) return;
    setCompany(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(COMPANY_STORAGE_KEY, next);
    }
    setCurrentChatId(null);
    setApiConversationId(null);
    setMessages([{ role: "assistant", content: welcomeFor(next) }]);
    setInput("");
    setReportMode(false);
  }

  useEffect(() => {
    setTimeout(() => {
      scrollRef.current?.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: "smooth",
      });
    }, 50);
  }, [messages]);

  function persistChat(chat: LocalChat): void {
    setChats((prev) => {
      const next = [chat, ...prev.filter((item) => item.id !== chat.id)].sort(
        (a, b) =>
          new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      writeLocalChats(next);
      return next;
    });
  }

  function startNewChat() {
    setCurrentChatId(null);
    setApiConversationId(null);
    setMessages([{ role: "assistant", content: welcomeFor(company) }]);
    setInput("");
    setReportMode(false);
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  }

  function loadChat(chat: LocalChat) {
    setCurrentChatId(chat.id);
    setApiConversationId(chat.apiConversationId ?? null);
    setMessages(chat.messages.length ? chat.messages : [WELCOME_MESSAGE]);
    if (typeof window !== "undefined" && window.innerWidth < 768) {
      setSidebarOpen(false);
    }
  }

  function deleteChat(chatId: string) {
    setChats((prev) => {
      const next = prev.filter((chat) => chat.id !== chatId);
      writeLocalChats(next);
      return next;
    });

    if (chatId === currentChatId) {
      startNewChat();
    }
  }

  async function sendMessage(text: string) {
    if (!text.trim() || loading) return;

    const userMessage: Message = { role: "user", content: text.trim() };
    const previousMessages =
      messages.length === 1 &&
      messages[0].role === "assistant" &&
      messages[0].content.startsWith("Hello! I'm your")
        ? []
        : messages;
    const chatId = currentChatId ?? createId();
    const baseMessages = [...previousMessages, userMessage];
    const now = new Date().toISOString();
    const title =
      chats.find((chat) => chat.id === chatId)?.title ?? createTitle(text);

    setCurrentChatId(chatId);
    setMessages(baseMessages);
    setInput("");
    setLoading(true);
    persistChat({
      id: chatId,
      title,
      messages: baseMessages,
      updatedAt: now,
      apiConversationId: apiConversationId ?? undefined,
    });

    try {
      if (reportMode || isReportPrompt(text)) {
        const reportMessage = await generateReportMessage(text);
        const reportMessages = [...baseMessages, reportMessage];
        setMessages(reportMessages);
        setReportMode(false);
        persistChat({
          id: chatId,
          title,
          messages: reportMessages,
          updatedAt: new Date().toISOString(),
          apiConversationId: apiConversationId ?? undefined,
        });
        return;
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: baseMessages,
          conversationId: apiConversationId,
          company,
        }),
      });

      const data = await readJsonResponse<{
        error?: string;
        message?: string;
        conversationId?: string;
      }>(res);

      if (!res.ok) {
        throw new Error(data.error ?? "Request failed");
      }

      const nextApiConversationId = data.conversationId ?? apiConversationId;
      const assistantMessage: Message = {
        role: "assistant",
        content: data.message ?? "",
      };
      const nextMessages = [...baseMessages, assistantMessage];

      setApiConversationId(nextApiConversationId ?? null);
      setMessages(nextMessages);
      persistChat({
        id: chatId,
        title,
        messages: nextMessages,
        updatedAt: new Date().toISOString(),
        apiConversationId: nextApiConversationId ?? undefined,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Something went wrong";
      const errorMessages = [
        ...baseMessages,
        {
          role: "assistant" as const,
          content: `Sorry, I encountered an error: ${msg}`,
        },
      ];
      setMessages(errorMessages);
      persistChat({
        id: chatId,
        title,
        messages: errorMessages,
        updatedAt: new Date().toISOString(),
        apiConversationId: apiConversationId ?? undefined,
      });
    } finally {
      setLoading(false);
    }
  }

  function toggleReportMode() {
    setReportMode((current) => !current);
  }

  async function generateReportMessage(prompt: string): Promise<Message> {
    const res = await fetch("/api/report", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt, company }),
    });

    const data = await readJsonResponse<{
      error?: string;
      title?: string;
      html?: string;
    }>(res);

    if (!res.ok || !data.html || !data.title) {
      throw new Error(data.error ?? "Could not generate report");
    }

    const reportId = createId();
    window.localStorage.setItem(
      `${REPORT_STORAGE_PREFIX}${reportId}`,
      JSON.stringify({
        title: data.title,
        html: data.html,
        createdAt: new Date().toISOString(),
      }),
    );

    return {
      role: "assistant",
      content: [
        `Your **${data.title}** is ready.`,
        "",
        `[[report:${reportId}|Open Report / Save PDF]]`,
        "",
        "It includes charts, customer/sales tables, and a profit-data note based on the latest Supabase sync.",
      ].join("\n"),
    };
  }

  return (
    <div className="flex h-full w-full overflow-hidden bg-zinc-50 text-zinc-950">
      {sidebarOpen && (
        <button
          type="button"
          aria-label="Close conversations"
          onClick={() => setSidebarOpen(false)}
          className="fixed inset-0 z-20 bg-black/20 backdrop-blur-sm md:hidden"
        />
      )}

      <aside
        className={`fixed inset-y-0 left-0 z-30 flex w-[min(20rem,88vw)] flex-col border-r border-zinc-200 bg-white/95 shadow-xl backdrop-blur transition-transform duration-200 md:relative md:w-72 md:translate-x-0 md:shadow-none ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex items-center gap-2 border-b border-zinc-200 p-3">
          <button
            type="button"
            onClick={startNewChat}
            className="flex-1 rounded-full bg-zinc-950 px-4 py-2.5 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-800"
          >
            New Chat
          </button>
          <button
            type="button"
            onClick={() => setSidebarOpen(false)}
            className="rounded-full p-2 text-zinc-500 transition hover:bg-zinc-100 md:hidden"
            aria-label="Close sidebar"
          >
            x
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {chats.length === 0 ? (
            <p className="px-3 py-4 text-sm text-zinc-400">
              Your chats will be saved on this device.
            </p>
          ) : (
            chats.map((chat) => (
              <div
                key={chat.id}
                className={`group mb-1 flex items-center gap-1 rounded-xl pr-1 transition ${
                  currentChatId === chat.id
                    ? "bg-zinc-100 text-zinc-950"
                    : "text-zinc-500 hover:bg-zinc-50 hover:text-zinc-950"
                }`}
              >
                <button
                  type="button"
                  onClick={() => loadChat(chat)}
                  className="min-w-0 flex-1 px-3 py-2 text-left text-xs"
                >
                  <p className="truncate font-medium">{chat.title}</p>
                  <p className="mt-0.5 text-[10px] text-zinc-400">
                    {new Date(chat.updatedAt).toLocaleDateString()}
                  </p>
                </button>
                <button
                  type="button"
                  onClick={() => deleteChat(chat.id)}
                  className="rounded-full px-2 py-1 text-xs text-zinc-400 opacity-100 transition hover:bg-white hover:text-red-600 md:opacity-0 md:group-hover:opacity-100"
                  aria-label={`Delete ${chat.title}`}
                >
                  Delete
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col overflow-hidden">
        <header className="sticky top-0 z-10 border-b border-zinc-200 bg-white/80 px-3 py-3 backdrop-blur-xl sm:px-6">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-3">
              <button
                type="button"
                onClick={() => setSidebarOpen(true)}
                className="rounded-full p-2 text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-950 md:hidden"
                aria-label="Open conversations"
              >
                <span className="block h-0.5 w-4 bg-current" />
                <span className="mt-1 block h-0.5 w-4 bg-current" />
              </button>
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-2xl bg-zinc-950 text-xs font-semibold text-white shadow-sm sm:h-10 sm:w-10 sm:text-sm">
                {getCompanyMeta(company).short}
              </div>
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold tracking-tight text-zinc-950 sm:text-lg">
                  {getCompanyMeta(company).label} BC Assistant
                </h1>
                <p className="truncate text-xs text-zinc-500 sm:text-sm">
                  Gemini, Business Central, Supabase
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <label className="sr-only" htmlFor="company-select">
                Company
              </label>
              <select
                id="company-select"
                value={company}
                onChange={(e) => switchCompany(e.target.value as CompanyKey)}
                className="rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs font-medium text-zinc-700 shadow-sm transition hover:border-zinc-300 focus:outline-none focus:ring-2 focus:ring-zinc-400 sm:text-sm"
                aria-label="Select company"
              >
                {COMPANIES.map((c) => (
                  <option key={c.key} value={c.key}>
                    {c.label}
                  </option>
                ))}
              </select>
              {health && (
                <div className="hidden items-center gap-3 text-xs sm:flex">
                  <StatusPill
                    label="BC Data"
                    ok={health.bcApi.reachable}
                    detail={
                      health.mode === "supabase_mirror"
                        ? health.bcApi.reachable
                          ? `${health.bcApi.entities ?? 0} synced`
                          : "Awaiting sync"
                        : health.bcApi.reachable
                          ? `${health.bcApi.companies} companies online`
                          : health.bcApi.error?.slice(0, 40) ?? "Offline"
                    }
                  />
                </div>
              )}
            </div>
          </div>
        </header>

        <div
          ref={scrollRef}
          className="flex-1 overflow-y-auto overflow-x-hidden px-3 py-5 sm:px-4 sm:py-8"
        >
          <div className="mx-auto max-w-4xl space-y-4">
            {messages.map((msg, i) => (
              <div
                key={`${msg.role}-${i}`}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[92%] overflow-hidden rounded-2xl px-4 py-3 text-sm leading-relaxed shadow-sm sm:max-w-[85%] ${
                    msg.role === "user"
                      ? "bg-zinc-950 text-white"
                      : "border border-zinc-200 bg-white text-zinc-800"
                  }`}
                >
                  <MessageContent content={msg.content} />
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="rounded-2xl border border-zinc-200 bg-white px-4 py-3 shadow-sm">
                  <div className="flex gap-1">
                    <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:0ms]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:150ms]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-zinc-400 [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {messages.length === 1 && messages[0].content === WELCOME && (
          <div className="px-3 pb-2 sm:px-4">
            <div className="mx-auto flex max-w-4xl gap-2 overflow-x-auto pb-1">
              {SUGGESTIONS.map((suggestion) => (
                <button
                  key={suggestion}
                  type="button"
                  onClick={() => sendMessage(suggestion)}
                  className="shrink-0 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-xs text-zinc-600 shadow-sm transition hover:border-zinc-300 hover:text-zinc-950"
                >
                  {suggestion}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="shrink-0 border-t border-zinc-200 bg-white/90 px-2 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] backdrop-blur-xl sm:px-4 sm:py-4 sm:pb-4">
          {reportMode && (
            <div className="mx-auto mb-2 flex max-w-4xl items-center justify-between rounded-2xl border border-blue-200 bg-blue-50 px-4 py-2 text-xs text-blue-800">
              <span>
                PDF mode is on. Type what report you want, then press Send.
              </span>
              <button
                type="button"
                onClick={() => setReportMode(false)}
                className="font-semibold text-blue-900"
              >
                Cancel
              </button>
            </div>
          )}
          <form
            className="mx-auto grid w-full max-w-4xl grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-1.5 sm:flex sm:gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage(input);
            }}
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder={
                reportMode
                  ? "Describe the PDF report you want..."
                  : "Ask about customers, revenue, items..."
              }
              disabled={loading}
              className="h-12 min-w-0 rounded-full border border-zinc-200 bg-zinc-50 px-4 text-base text-zinc-950 placeholder:text-zinc-400 shadow-inner transition focus:border-zinc-300 focus:bg-white focus:outline-none focus:ring-4 focus:ring-zinc-100 disabled:opacity-50 sm:h-auto sm:flex-1 sm:px-5 sm:py-3 sm:text-sm"
            />
            <button
              type="button"
              onClick={toggleReportMode}
              disabled={loading}
              className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full border text-xs font-semibold shadow-sm transition disabled:opacity-40 sm:h-auto sm:w-auto sm:px-5 sm:py-3 sm:text-sm ${
                reportMode
                  ? "border-blue-200 bg-blue-600 text-white hover:bg-blue-700"
                  : "border-zinc-200 bg-white text-zinc-700 hover:border-zinc-300 hover:text-zinc-950"
              }`}
              title="Turn on PDF report mode"
            >
              <span className="sm:hidden">{reportMode ? "On" : "PDF"}</span>
              <span className="hidden sm:inline">
                {reportMode ? "PDF Mode" : "Make PDF"}
              </span>
            </button>
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-zinc-950 text-lg font-semibold leading-none text-white shadow-sm transition hover:bg-zinc-800 disabled:opacity-40 sm:h-auto sm:w-auto sm:px-6 sm:py-3 sm:text-sm"
              aria-label="Send message"
            >
              <span className="sm:hidden">↑</span>
              <span className="hidden sm:inline">Send</span>
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}

function StatusPill({
  label,
  ok,
  detail,
}: {
  label: string;
  ok: boolean;
  detail: string;
}) {
  return (
    <div className="flex items-center gap-1.5 rounded-full border border-zinc-200 bg-zinc-50 px-3 py-1">
      <span
        className={`h-2 w-2 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`}
      />
      <span className="text-zinc-700">{label}</span>
      <span className="text-zinc-400">- {detail}</span>
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  const lines = content.split("\n");
  const blocks: Array<{ type: "table" | "text"; lines: string[] }> = [];
  let index = 0;

  while (index < lines.length) {
    if (isTableStart(lines, index)) {
      const tableLines: string[] = [];
      while (index < lines.length && lines[index].includes("|")) {
        tableLines.push(lines[index]);
        index++;
      }
      blocks.push({ type: "table", lines: tableLines });
      continue;
    }

    const textLines: string[] = [];
    while (index < lines.length && !isTableStart(lines, index)) {
      textLines.push(lines[index]);
      index++;
    }
    blocks.push({ type: "text", lines: textLines });
  }

  return (
    <div className="space-y-3">
      {blocks.map((block, blockIndex) =>
        block.type === "table" ? (
          <MarkdownTable key={blockIndex} lines={block.lines} />
        ) : (
          <div key={blockIndex} className="whitespace-pre-wrap">
            <InlineMarkdown text={block.lines.join("\n")} />
          </div>
        ),
      )}
    </div>
  );
}

function isTableStart(lines: string[], index: number): boolean {
  return (
    lines[index]?.includes("|") &&
    lines[index + 1]?.includes("|") &&
    /-:?\s*\|/.test(lines[index + 1])
  );
}

function MarkdownTable({ lines }: { lines: string[] }) {
  const [headerLine, , ...rowLines] = lines;
  const headers = parseTableRow(headerLine);
  const rows = rowLines.map(parseTableRow).filter((row) => row.length > 0);

  return (
    <div className="-mx-1 overflow-x-auto rounded-xl border border-zinc-200 bg-white">
      <table className="min-w-full text-left text-xs">
        <thead className="bg-zinc-50 text-zinc-500">
          <tr>
            {headers.map((header, index) => (
              <th key={index} className="whitespace-nowrap px-3 py-2 font-medium">
                <InlineMarkdown text={header} />
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100">
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="whitespace-nowrap px-3 py-2">
                  <InlineMarkdown text={cell} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function parseTableRow(row: string): string[] {
  return row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function InlineMarkdown({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*|\[\[report:[^\]]+\]\])/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className="font-semibold text-zinc-950">
              {part.slice(2, -2)}
            </strong>
          );
        }
        if (part.startsWith("[[report:") && part.endsWith("]]")) {
          const body = part.slice("[[report:".length, -2);
          const [id, label = "Open Report"] = body.split("|");
          return (
            <a
              key={i}
              href={`/report/${encodeURIComponent(id)}`}
              target="_blank"
              rel="noreferrer"
              className="inline-flex rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-zinc-800"
            >
              {label}
            </a>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
