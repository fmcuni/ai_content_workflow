"use client";
import { useEffect, useRef, useState } from "react";
import { Check, CornerDownLeft, RotateCcw, Trash2 } from "lucide-react";

import { AnchorQuote } from "@/components/annotations/AnchorQuote";
import { AnnotationCard } from "@/components/annotations/AnnotationCard";
import { onComposerKeyDown } from "@/lib/run-editor/composer-keys";
import type { ReviewThread } from "@/lib/types";

type Filter = "open" | "resolved" | "all";

interface Props {
  threads: ReviewThread[];
  focusedId: string | null;
  onFocus: (threadId: string) => void;
  onReply: (threadId: string, body: string) => void;
  onResolve: (thread: ReviewThread, resolved: boolean) => void;
  onDelete: (thread: ReviewThread) => void;
  /** Disables actions while a mutation is in flight. */
  busy?: boolean;
}

/** First-letter initials from a display name, falling back to the email local part. */
function initials(name: string | null, email: string | null): string {
  const source = (name ?? email ?? "?").trim();
  const parts = source.split(/[\s@.]+/).filter(Boolean);
  const letters = parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "");
  return letters.join("") || "?";
}

function authorLabel(name: string | null, email: string | null): string {
  return name?.trim() || email?.trim() || "Unknown";
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleString();
}

function Avatar({ name, email }: { name: string | null; email: string | null }) {
  return (
    <span
      aria-hidden
      className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-ink/10 font-mono text-[10px] font-medium text-ink"
      title={authorLabel(name, email)}
    >
      {initials(name, email)}
    </span>
  );
}

export function ReviewThreadList({
  threads,
  focusedId,
  onFocus,
  onReply,
  onResolve,
  onDelete,
  busy = false,
}: Props) {
  const [filter, setFilter] = useState<Filter>("open");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const cardRefs = useRef<Record<string, HTMLLIElement | null>>({});

  useEffect(() => {
    const card = focusedId ? cardRefs.current[focusedId] : null;
    // `scrollIntoView` is absent in jsdom and older webviews — guard it.
    if (card && typeof card.scrollIntoView === "function") {
      card.scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }, [focusedId]);

  const counts = {
    open: threads.filter((t) => t.status === "open").length,
    resolved: threads.filter((t) => t.status === "resolved").length,
    all: threads.length,
  };
  const shown = threads.filter((t) => (filter === "all" ? true : t.status === filter));

  const submitReply = (thread: ReviewThread) => {
    const body = (drafts[thread.thread_id] ?? "").trim();
    if (!body) return;
    onReply(thread.thread_id, body);
    setDrafts((d) => ({ ...d, [thread.thread_id]: "" }));
  };

  return (
    <div>
      <div className="mb-3 flex items-center gap-1">
        {(["open", "resolved", "all"] as const).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={`rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider transition-colors ${
              filter === f ? "bg-ink text-paper" : "text-ink-faint hover:text-ink"
            }`}
          >
            {f} ({counts[f]})
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <p className="px-1 py-3 font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          {threads.length === 0
            ? "No review notes yet. Highlight text and choose “Review” to start one."
            : `No ${filter} threads.`}
        </p>
      ) : (
        <ul className="space-y-3">
          {shown.map((t) => {
            const isResolved = t.status === "resolved";
            return (
              <AnnotationCard
                key={t.thread_id}
                cardRef={(el) => {
                  cardRefs.current[t.thread_id] = el;
                }}
                focused={focusedId === t.thread_id}
                resolved={isResolved}
                onClick={() => onFocus(t.thread_id)}
              >
                <div className="mb-2 flex items-center justify-between gap-2">
                  <AnchorQuote text={t.anchor_text} />
                  {isResolved && (
                    <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-ok">
                      Resolved
                    </span>
                  )}
                </div>

                <ul className="space-y-2.5">
                  {t.messages.map((m) => (
                    <li key={m.id} className="flex gap-2">
                      <Avatar name={m.author_name} email={m.author_email} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate text-[12px] font-medium text-ink">
                            {authorLabel(m.author_name, m.author_email)}
                          </span>
                          <span className="shrink-0 font-mono text-[9px] uppercase tracking-wider text-ink-faint">
                            {shortTime(m.created_at)}
                          </span>
                        </div>
                        <p className="whitespace-pre-wrap break-words text-[13px] text-ink-soft">
                          {m.body}
                        </p>
                      </div>
                    </li>
                  ))}
                </ul>

                <div className="mt-2 flex items-end gap-1.5" onClick={(e) => e.stopPropagation()}>
                  <textarea
                    value={drafts[t.thread_id] ?? ""}
                    onChange={(e) =>
                      setDrafts((d) => ({ ...d, [t.thread_id]: e.target.value }))
                    }
                    onKeyDown={(e) => onComposerKeyDown(e, () => submitReply(t))}
                    rows={1}
                    placeholder="Reply… (⌘↵)"
                    className="w-full resize-y border-b border-rule bg-transparent pb-1 text-[13px] text-ink focus:border-accent focus:outline-none"
                  />
                  <button
                    type="button"
                    disabled={busy || !(drafts[t.thread_id] ?? "").trim()}
                    onClick={() => submitReply(t)}
                    className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-ink-soft hover:text-ink disabled:opacity-40"
                    aria-label="Reply"
                    title="Reply"
                  >
                    <CornerDownLeft className="h-3.5 w-3.5" />
                  </button>
                </div>

                <div className="mt-2 flex items-center justify-end gap-3">
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => onResolve(t, !isResolved)}
                    className="inline-flex items-center gap-1 text-[11px] text-ink-faint hover:text-ink disabled:opacity-40"
                  >
                    {isResolved ? (
                      <>
                        <RotateCcw className="h-3 w-3" /> Reopen
                      </>
                    ) : (
                      <>
                        <Check className="h-3 w-3" /> Resolve
                      </>
                    )}
                  </button>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      if (window.confirm("Delete this review thread and all its replies? This cannot be undone."))
                        onDelete(t);
                    }}
                    className="inline-flex items-center gap-1 text-[11px] text-ink-faint hover:text-accent-deep disabled:opacity-40"
                    aria-label="Delete thread"
                  >
                    <Trash2 className="h-3 w-3" /> Delete
                  </button>
                </div>
              </AnnotationCard>
            );
          })}
        </ul>
      )}
    </div>
  );
}
