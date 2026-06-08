"use client";
import { useState } from "react";
import { X } from "lucide-react";

import { ReviewThreadList } from "@/components/ReviewThreadList";
import type { ReviewThreadsApi } from "@/lib/useReviewThreads";

interface Props {
  rt: ReviewThreadsApi;
}

/**
 * The "Review" rail surface (human-only threads). Owns the pending-first-comment
 * composer and the thread list, wired to the `useReviewThreads` hook. Shared by
 * /hitl2 and /edit so both stay identical.
 */
export function ReviewPanel({ rt }: Props) {
  return (
    <>
      {rt.pending && (
        <PendingComposer
          anchorText={rt.pending.anchorText}
          busy={rt.create.isPending}
          onSubmit={rt.submitPending}
          onCancel={rt.cancelPending}
        />
      )}
      <ReviewThreadList
        threads={rt.threads}
        focusedId={rt.focusedThreadId}
        onFocus={rt.setFocusedThreadId}
        onReply={(threadId, body) => rt.reply.mutate({ threadId, body })}
        onResolve={(thread, resolved) => rt.resolve.mutate({ thread, resolved })}
        onDelete={(thread) => rt.remove.mutate(thread)}
        busy={rt.reply.isPending || rt.resolve.isPending || rt.remove.isPending}
      />
    </>
  );
}

interface PendingComposerProps {
  anchorText: string;
  busy: boolean;
  onSubmit: (body: string) => void;
  onCancel: () => void;
}

function PendingComposer({ anchorText, busy, onSubmit, onCancel }: PendingComposerProps) {
  const [body, setBody] = useState("");
  const submit = () => {
    const trimmed = body.trim();
    if (trimmed) onSubmit(trimmed);
  };
  return (
    <div className="mb-4 rounded border border-accent/60 bg-paper p-3 shadow-sm">
      <div className="mb-2 flex items-start justify-between gap-2">
        <p className="line-clamp-2 font-mono text-[10px] uppercase tracking-wider text-ink-faint">
          &ldquo;{anchorText}&rdquo;
        </p>
        <button
          type="button"
          onClick={onCancel}
          className="shrink-0 text-ink-faint hover:text-ink"
          aria-label="Cancel review note"
          title="Cancel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <textarea
        autoFocus
        value={body}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            submit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onCancel();
          }
        }}
        rows={2}
        placeholder="Start a review note for the team… (⌘↵ to post)"
        className="w-full resize-y border-b border-rule bg-transparent pb-1 text-[13px] text-ink focus:border-accent focus:outline-none"
      />
      <div className="mt-2 flex items-center justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="font-mono text-[11px] uppercase tracking-wider text-ink-faint hover:text-ink"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={busy || !body.trim()}
          onClick={submit}
          className="rounded border border-ink bg-paper px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider text-ink hover:bg-ink hover:text-paper disabled:opacity-40"
        >
          {busy ? "Posting…" : "Post note"}
        </button>
      </div>
    </div>
  );
}
