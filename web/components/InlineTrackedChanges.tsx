"use client";
import { useCallback, useEffect, useState } from "react";
import { Check, MessagesSquare, X } from "lucide-react";

import {
  buildInlineDiffHtml,
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

interface ActiveChange {
  /** Index into the diff `parts` array (the `data-tc-i` value). */
  index: number;
  type: "add" | "del";
  /** Viewport coords of the change, for positioning the floating popover. */
  left: number;
  bottom: number;
}

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").trim();

/**
 * In-editor tracked-changes review surface for HUMAN edits. Renders the
 * committed-baseline → working-body diff AS the rendered article (green
 * insertions, red strikethrough deletions) and floats an Accept / Reject /
 * Comment popover over the change under the pointer, keyboard focus, or click.
 *
 * Accept commits the change into the baseline; Reject reverts the working body;
 * Comment opens a human review thread anchored on the change text. Both
 * transforms reuse the pure `commitHunk` / `dismissHunk` engine, so the inline
 * surface and any other view stay byte-for-byte consistent. AI edits never
 * appear here — they advance the baseline directly.
 */
export function InlineTrackedChanges({ committed, working, onChange, onComment }: Props) {
  const { parts, hunks } = computeTrackedChanges(committed, working);
  const [active, setActive] = useState<ActiveChange | null>(null);

  const openFor = useCallback((el: HTMLElement) => {
    const raw = el.getAttribute("data-tc-i");
    const type = el.getAttribute("data-tc");
    if (raw === null || (type !== "add" && type !== "del")) return;
    const index = Number(raw);
    if (!Number.isInteger(index)) return;
    const rect = el.getBoundingClientRect();
    setActive({ index, type, left: rect.left, bottom: rect.bottom });
  }, []);

  // Event delegation over the rendered diff (which is injected HTML, so we can't
  // attach React handlers to each <ins>/<del> directly).
  const onPointer = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tc-i]");
      if (el) openFor(el);
    },
    [openFor],
  );
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== "Enter" && e.key !== " ") return;
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tc-i]");
      if (!el) return;
      e.preventDefault();
      openFor(el);
    },
    [openFor],
  );
  const onFocus = useCallback(
    (e: React.FocusEvent<HTMLDivElement>) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>("[data-tc-i]");
      if (el) openFor(el);
    },
    [openFor],
  );

  // Escape closes the popover.
  useEffect(() => {
    if (!active) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [active]);

  // accept/reject re-index the parts in the parent, so close the (now-stale)
  // popover as we apply the change.
  const accept = (index: number) => {
    onChange(commitHunk(parts, index));
    setActive(null);
  };
  const reject = (index: number) => {
    onChange(dismissHunk(parts, index));
    setActive(null);
  };
  const comment = (index: number) => {
    const part = parts[index];
    if (part) onComment(stripTags(part.value).slice(0, 120));
    setActive(null);
  };

  if (hunks.length === 0) {
    return (
      <div className="rounded border border-rule bg-paper px-6 py-5 min-h-[480px]">
        <p className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          No pending changes — the working draft matches the committed baseline. Switch to{" "}
          <span className="text-ink">Edit</span> to revise the article; your edits appear here as
          tracked changes.
        </p>
      </div>
    );
  }

  return (
    <div className="relative">
      <div className="mb-3 flex items-center justify-between gap-3 border-b border-rule pb-2">
        <span className="font-mono text-[11px] uppercase tracking-wider text-ink-faint">
          {hunks.length} pending change{hunks.length === 1 ? "" : "s"} · hover or focus a change to
          accept / reject
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => onChange(commitAll(parts))}
            className="inline-flex items-center gap-1 rounded border border-ink bg-paper px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-ink hover:bg-ink hover:text-paper"
          >
            <Check className="h-3 w-3" /> Accept all
          </button>
          <button
            type="button"
            onClick={() => onChange(dismissAll(parts))}
            className="inline-flex items-center gap-1 rounded border border-rule px-2 py-1 font-mono text-[11px] uppercase tracking-wider text-ink-soft hover:border-ink hover:text-ink"
          >
            <X className="h-3 w-3" /> Reject all
          </button>
        </div>
      </div>

      {/* The diff rendered AS the article. <ins>/<del> carry data-tc-i so the
          delegated handlers below resolve a click/hover/focus back to its hunk. */}
      <div
        onClick={onPointer}
        onMouseOver={onPointer}
        onKeyDown={onKeyDown}
        onFocus={onFocus}
        dangerouslySetInnerHTML={{ __html: buildInlineDiffHtml(parts) }}
        className={[
          "editorial-prose max-w-none min-h-[480px] rounded border border-rule bg-paper px-6 py-5",
          "[&_ins[data-tc]]:bg-emerald-100 [&_ins[data-tc]]:text-emerald-900 [&_ins[data-tc]]:no-underline [&_ins[data-tc]]:rounded-sm [&_ins[data-tc]]:px-0.5 [&_ins[data-tc]]:cursor-pointer",
          "[&_ins[data-tc]:hover]:ring-1 [&_ins[data-tc]:hover]:ring-emerald-400 [&_ins[data-tc]:focus-visible]:outline-none [&_ins[data-tc]:focus-visible]:ring-2 [&_ins[data-tc]:focus-visible]:ring-emerald-500",
          "[&_del[data-tc]]:bg-rose-100 [&_del[data-tc]]:text-rose-900 [&_del[data-tc]]:line-through [&_del[data-tc]]:rounded-sm [&_del[data-tc]]:px-0.5 [&_del[data-tc]]:cursor-pointer",
          "[&_del[data-tc]:hover]:ring-1 [&_del[data-tc]:hover]:ring-rose-400 [&_del[data-tc]:focus-visible]:outline-none [&_del[data-tc]:focus-visible]:ring-2 [&_del[data-tc]:focus-visible]:ring-rose-500",
        ].join(" ")}
      />

      {active && (
        <div
          role="group"
          aria-label="Tracked change actions"
          style={{
            position: "fixed",
            left: Math.min(active.left, (typeof window !== "undefined" ? window.innerWidth : 9999) - 140),
            top: active.bottom + 6,
            zIndex: 50,
          }}
          // Keep the popover open while the pointer is on it; close on leave.
          onMouseLeave={() => setActive(null)}
          className="flex items-center gap-0.5 rounded border border-ink bg-paper px-1 py-1 shadow-md"
        >
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => accept(active.index)}
            title={active.type === "add" ? "Accept insertion" : "Accept deletion"}
            aria-label="Accept change"
            className="inline-flex h-7 items-center gap-1 rounded px-1.5 text-[11px] font-mono uppercase tracking-wider text-ink hover:bg-ink hover:text-paper"
          >
            <Check className="h-3.5 w-3.5" /> Accept
          </button>
          <span aria-hidden className="mx-0.5 h-4 w-px bg-rule" />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => reject(active.index)}
            title={active.type === "add" ? "Reject insertion" : "Restore deletion"}
            aria-label="Reject change"
            className="inline-flex h-7 items-center gap-1 rounded px-1.5 text-[11px] font-mono uppercase tracking-wider text-ink hover:bg-ink hover:text-paper"
          >
            <X className="h-3.5 w-3.5" /> Reject
          </button>
          <span aria-hidden className="mx-0.5 h-4 w-px bg-rule" />
          <button
            type="button"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => comment(active.index)}
            title="Comment on this change (review thread)"
            aria-label="Comment on change"
            className="inline-flex h-7 w-7 items-center justify-center rounded text-ink-soft hover:bg-ink hover:text-paper"
          >
            <MessagesSquare className="h-3.5 w-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
