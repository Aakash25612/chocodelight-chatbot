"use client";

import { useCallback, useEffect, useRef, useState } from "react";

type Message = {
  role: "user" | "assistant";
  content: string;
};

type Conversation = {
  id: string;
  title: string | null;
  updated_at: string;
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

const WELCOME =
  "Hello! I'm your **ChocoDelight BC Assistant**. Ask me about customers, items, sales orders, ledger entries, and more.\n\nData is served from **Supabase** — no VPN needed on your device.\n\nWhat would you like to do?";

const SUGGESTIONS = [
  "List all customers",
  "Show available items",
  "Get pending items for customer ACM0000159",
  "What API endpoints are available?",
];

export default function ChatInterface() {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", content: WELCOME },
  ]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const loadHealth = useCallback(async () => {
    try {
      const res = await fetch("/api/health");
      const data = await res.json();
      setHealth(data);
    } catch {
      setHealth(null);
    }
  }, []);

  const loadConversations = useCallback(async () => {
    try {
      const res = await fetch("/api/conversations");
      if (!res.ok) return;
      const data = await res.json();
      setConversations(data.conversations ?? []);
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    loadHealth();
    loadConversations();
    const interval = setInterval(loadHealth, 30000);
    return () => clearInterval(interval);
  }, [loadHealth, loadConversations]);

  async function loadConversation(id: string) {
    setLoading(true);
    try {
      const res = await fetch(`/api/conversations/${id}`);
      const data = await res.json();
      const loaded: Message[] = (data.messages ?? []).map(
        (m: { role: string; content: string }) => ({
          role: m.role as "user" | "assistant",
          content: m.content,
        }),
      );
      setConversationId(id);
      setMessages(loaded.length ? loaded : [{ role: "assistant", content: WELCOME }]);
    } finally {
      setLoading(false);
    }
  }

  function startNewChat() {
    setConversationId(null);
    setMessages([{ role: "assistant", content: WELCOME }]);
  }

  async function sendMessage(text: string) {
    if (!text.trim() || loading) return;

    const userMessage: Message = { role: "user", content: text.trim() };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: nextMessages, conversationId }),
      });

      const data = await res.json();

      if (!res.ok) {
        throw new Error(data.error ?? "Request failed");
      }

      if (data.conversationId) {
        setConversationId(data.conversationId);
        loadConversations();
      }

      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: data.message },
      ]);
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Something went wrong";
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `Sorry, I encountered an error: ${msg}` },
      ]);
    } finally {
      setLoading(false);
      setTimeout(() => {
        scrollRef.current?.scrollTo({
          top: scrollRef.current.scrollHeight,
          behavior: "smooth",
        });
      }, 100);
    }
  }

  return (
    <div className="flex h-full bg-[#1a0f0a]">
      {sidebarOpen && (
        <aside className="flex w-64 flex-col border-r border-amber-900/40 bg-[#140c08]">
          <div className="border-b border-amber-900/40 p-4">
            <button
              type="button"
              onClick={startNewChat}
              className="w-full rounded-xl bg-amber-600 px-4 py-2.5 text-sm font-medium text-white hover:bg-amber-500"
            >
              + New Chat
            </button>
          </div>
          <div className="flex-1 overflow-y-auto p-2">
            {conversations.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => loadConversation(c.id)}
                className={`mb-1 w-full rounded-lg px-3 py-2 text-left text-xs transition ${
                  conversationId === c.id
                    ? "bg-amber-900/50 text-amber-100"
                    : "text-amber-200/70 hover:bg-amber-900/20"
                }`}
              >
                <p className="truncate font-medium">{c.title ?? "Untitled"}</p>
                <p className="mt-0.5 text-[10px] text-amber-200/40">
                  {new Date(c.updated_at).toLocaleDateString()}
                </p>
              </button>
            ))}
          </div>
        </aside>
      )}

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="border-b border-amber-900/40 bg-[#2d1810] px-6 py-4">
          <div className="mx-auto flex max-w-4xl items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => setSidebarOpen(!sidebarOpen)}
                className="rounded-lg p-2 text-amber-200/60 hover:bg-amber-900/30"
              >
                ☰
              </button>
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-600 text-lg">
                🍫
              </div>
              <div>
                <h1 className="text-lg font-semibold text-amber-50">
                  ChocoDelight BC Assistant
                </h1>
                <p className="text-sm text-amber-200/60">
                  Gemini · Business Central · Supabase
                </p>
              </div>
            </div>
            {health && (
              <div className="flex items-center gap-3 text-xs">
                <StatusPill
                  label="BC Data"
                  ok={health.bcApi.reachable}
                  detail={
                    health.mode === "supabase_mirror"
                      ? health.bcApi.reachable
                        ? `${health.bcApi.entities ?? 0} datasets synced`
                        : "Awaiting sync"
                      : health.bcApi.reachable
                        ? `${health.bcApi.companies} companies online`
                        : health.bcApi.error?.slice(0, 40) ?? "Offline"
                  }
                />
              </div>
            )}
          </div>
        </header>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-6">
          <div className="mx-auto max-w-4xl space-y-4">
            {messages.map((msg, i) => (
              <div
                key={i}
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div
                  className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap ${
                    msg.role === "user"
                      ? "bg-amber-600 text-white"
                      : "bg-[#2d1810] text-amber-50 border border-amber-900/30"
                  }`}
                >
                  <MessageContent content={msg.content} />
                </div>
              </div>
            ))}

            {loading && (
              <div className="flex justify-start">
                <div className="rounded-2xl border border-amber-900/30 bg-[#2d1810] px-4 py-3">
                  <div className="flex gap-1">
                    <span className="h-2 w-2 animate-bounce rounded-full bg-amber-500 [animation-delay:0ms]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-amber-500 [animation-delay:150ms]" />
                    <span className="h-2 w-2 animate-bounce rounded-full bg-amber-500 [animation-delay:300ms]" />
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {messages.length === 1 && !conversationId && (
          <div className="px-4 pb-2">
            <div className="mx-auto flex max-w-4xl flex-wrap gap-2">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => sendMessage(s)}
                  className="rounded-full border border-amber-800/50 bg-[#2d1810] px-3 py-1.5 text-xs text-amber-200/80 transition hover:border-amber-600 hover:text-amber-100"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="border-t border-amber-900/40 bg-[#2d1810] px-4 py-4">
          <form
            className="mx-auto flex max-w-4xl gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              sendMessage(input);
            }}
          >
            <input
              type="text"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask about customers, items, sales orders..."
              disabled={loading}
              className="flex-1 rounded-xl border border-amber-900/40 bg-[#1a0f0a] px-4 py-3 text-sm text-amber-50 placeholder:text-amber-200/30 focus:border-amber-600 focus:outline-none disabled:opacity-50"
            />
            <button
              type="submit"
              disabled={loading || !input.trim()}
              className="rounded-xl bg-amber-600 px-5 py-3 text-sm font-medium text-white transition hover:bg-amber-500 disabled:opacity-40"
            >
              Send
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
    <div className="flex items-center gap-1.5 rounded-full border border-amber-900/40 bg-[#1a0f0a] px-3 py-1">
      <span
        className={`h-2 w-2 rounded-full ${ok ? "bg-green-500" : "bg-red-500"}`}
      />
      <span className="text-amber-200/80">{label}</span>
      <span className="text-amber-200/40">· {detail}</span>
    </div>
  );
}

function MessageContent({ content }: { content: string }) {
  const parts = content.split(/(\*\*[^*]+\*\*)/g);
  return (
    <>
      {parts.map((part, i) => {
        if (part.startsWith("**") && part.endsWith("**")) {
          return (
            <strong key={i} className="font-semibold text-amber-300">
              {part.slice(2, -2)}
            </strong>
          );
        }
        return <span key={i}>{part}</span>;
      })}
    </>
  );
}
