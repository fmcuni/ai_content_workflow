"use client";
import { Check, MessagesSquare, X } from "lucide-react";

import {
  commitAll,
  commitHunk,
  computeTrackedChanges,
  dismissAll,
  dismissHunk,
  type CommitResult,
} from "@/lib/tracked-changes";

interface Props {
  /** The committed baseline (last accepted body). */
  committed: string;
  /** The live working body (current editor HTML). */
  working: string;
  /** Apply a commit/dismiss result (new committed + working). */
  onChange: (next: CommitResult) => void;
  /** Start a review thread from a tracked change (its text becomes the anchor). */
  onComment: (anchorText: string) => void;
}

/**
 * Tracked-changes review surface for HUMAN edits. Diffs the committed baseline
 * against the working body and renders each insertion/deletion with per-hunk
 * Commit (accept into the baseline) / Dismiss (revert the working body) /
 * Comment (open a review thread). AI edits never appear here — they advance the
 * baseline directly.
 */
export function TrackedChangesView({ committed, working, onChange, onComment }: Props) {
  const { parts, hunks } = computeTrackedChanges(committed, working);

  if (hunks.length === 0) {
    return (
      <p className="font-mono text-[11px] uppercase tracking-wider text-ink-faint px-1 py-3">
        No pending changes — the working draft matches the committed baseline.
      </p>
    );
  }

  const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").trim();

  return (
    <div>
      <div className="mb-4 flex items-center justify-between gap-3 border-b border-rule pb-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          {hunks.length} pending change{hunks.length === 1 ? "" : "s"}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onChange(commitAll(parts))}
            className="inline-flex items-center gap-1 rounded border border-ink bg-paper px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-ink hover:bg-ink hover:text-paper"
          >
            <Check className="h-3 w-3" /> Commit all
          </button>
          <button
            type="button"
            onClick={() => onChange(dismissAll(parts))}
            className="inline-flex items-center gap-1 rounded border border-rule px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-ink-soft hover:border-ink hover:text-ink"
          >
            <X className="h-3 w-3" /> Dismiss all
          </button>
        </div>
      </div>

      <div className="text-sm leading-7 whitespace-pre-wrap font-mono">
        {parts.map((p, i) => {
          if (!p.added && !p.removed) {
            return (
              <span key={i} className="text-ink-soft">
                {p.value}
              </span>
            );
          }
          return (
            <span
              key={i}
              className={`group relative rounded px-0.5 ${
                p.added ? "bg-emerald-100 text-emerald-900" : "bg-rose-100 text-rose-900 line-through"
              }`}
            >
              {p.value}
              <span className="not-prose ml-1 inline-flex items-center gap-0.5 align-middle no-underline">
                <button
                  type="button"
                  title="Commit this change"
                  aria-label="Commit change"
                  onClick={() => onChange(commitHunk(parts, i))}
                  className="inline-flex h-5 w-5 items-center justify-center rounded bg-paper/70 text-ink-soft hover:bg-ink hover:text-paper"
                >
                  <Check className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  title="Dismiss this change"
                  aria-label="Dismiss change"
                  onClick={() => onChange(dismissHunk(parts, i))}
                  className="inline-flex h-5 w-5 items-center justify-center rounded bg-paper/70 text-ink-soft hover:bg-ink hover:text-paper"
                >
                  <X className="h-3 w-3" />
                </button>
                <button
                  type="button"
                  title="Comment on this change (review thread)"
                  aria-label="Comment on change"
                  onClick={() => onComment(stripTags(p.value).slice(0, 120))}
                  className="inline-flex h-5 w-5 items-center justify-center rounded bg-paper/70 text-ink-soft hover:bg-ink hover:text-paper"
                >
                  <MessagesSquare className="h-3 w-3" />
                </button>
              </span>
            </span>
          );
        })}
      </div>
    </div>
  );
}
