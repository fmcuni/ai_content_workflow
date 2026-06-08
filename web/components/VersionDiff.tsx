"use client";

import { useMemo } from "react";

import { computeLineDiff, isUnchanged } from "@/lib/diff";
import { cn } from "@/lib/utils";

interface VersionDiffProps {
  /** The selected (older) version's body. */
  before: string;
  /** The current / live body. */
  after: string;
  /** Wrapper className (height, max-height, etc.). */
  className?: string;
  /** Label shown when there is nothing to diff (selected == current). */
  emptyLabel?: string;
}

const LINE_STYLE: Record<"add" | "del" | "ctx", string> = {
  add: "bg-emerald-50 text-emerald-800",
  del: "bg-rose-50 text-rose-800",
  ctx: "text-ink-soft",
};

const LINE_PREFIX: Record<"add" | "del" | "ctx", string> = {
  add: "+",
  del: "-",
  ctx: " ",
};

/**
 * Inline line-diff of a past version (`before`) against the current/live body
 * (`after`). Additions (live has, version lacked) render green; removals
 * (version had, live lacks) render red. Used by the version-history preview
 * dialogs across prompts, source policy, and run snapshots.
 */
export function VersionDiff({
  before,
  after,
  className,
  emptyLabel = "No differences from the current version.",
}: VersionDiffProps) {
  const lines = useMemo(() => computeLineDiff(before, after), [before, after]);

  if (isUnchanged(before, after)) {
    return (
      <p className="font-mono text-[11px] text-ink-faint uppercase tracking-wider py-3">
        {emptyLabel}
      </p>
    );
  }

  return (
    <div
      className={cn(
        "border border-rule rounded-sm bg-paper-deep/30 overflow-auto font-mono text-[12px] leading-[1.55]",
        className,
      )}
    >
      {lines.map((line, i) => (
        <div
          key={i}
          className={cn("flex whitespace-pre-wrap break-words px-3", LINE_STYLE[line.type])}
        >
          <span aria-hidden className="select-none w-3 shrink-0 text-ink-faint">
            {LINE_PREFIX[line.type]}
          </span>
          <span className="flex-1">{line.text || " "}</span>
        </div>
      ))}
    </div>
  );
}
