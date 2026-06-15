"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";

import { BATCH_META, type StampTone } from "@/lib/desk-items";
import { cn } from "@/lib/utils";

import { summarizeChildren, type ThemeGroup } from "./board";
import { fmtCreator, fmtDateTime } from "./fmt";

interface ThemeGroupRowProps {
  group: ThemeGroup;
  expanded: boolean;
  onToggle: (batchId: string) => void;
  /** Selection state of this theme's children, for the group checkbox. */
  selectedChildIds: Set<string>;
  onToggleChildren: (childIds: string[], select: boolean) => void;
  /** Total table columns the band spans (keeps the row full-width). */
  colSpan: number;
}

const TONE_PILL: Record<StampTone, string> = {
  neutral: "bg-ink-soft/15 text-ink-soft",
  accent: "bg-accent/15 text-accent",
  ok: "bg-ok/15 text-ok",
  warn: "bg-warn/15 text-warn",
  info: "bg-info/15 text-info",
  danger: "bg-accent-deep/15 text-accent-deep",
};

/**
 * Parent "task" row for a theme (topic batch) on the runs board. The whole band
 * toggles its children; an explicit "Open brief →" link navigates to the
 * theme's review page. A collapsed theme still surfaces an at-a-glance summary
 * of its child runs (count + lifecycle breakdown) so operators can triage
 * without expanding.
 */
export function ThemeGroupRow({
  group,
  expanded,
  onToggle,
  selectedChildIds,
  onToggleChildren,
  colSpan,
}: ThemeGroupRowProps) {
  const { batch, children } = group;
  const meta = BATCH_META[batch.status];
  const summary = summarizeChildren(children);

  const childIds = children.map((c) => c.run_id);
  const selectedCount = childIds.filter((id) => selectedChildIds.has(id)).length;
  const allSelected = childIds.length > 0 && selectedCount === childIds.length;
  const someSelected = selectedCount > 0 && !allSelected;

  const checkboxRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (checkboxRef.current) checkboxRef.current.indeterminate = someSelected;
  }, [someSelected]);

  return (
    <tr
      className={cn(
        "cursor-pointer border-b border-rule bg-paper-deep/55 transition-colors hover:bg-paper-deep",
        expanded && "bg-paper-deep",
      )}
      onClick={() => onToggle(batch.batch_id)}
    >
      <td colSpan={colSpan} className="border-l-[3px] border-accent p-0">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1.5 px-2.5 py-2 max-md:px-3">
          {/* Disclosure chevron */}
          <button
            type="button"
            aria-label={expanded ? "Collapse theme" : "Expand theme"}
            aria-expanded={expanded}
            onClick={(e) => {
              e.stopPropagation();
              onToggle(batch.batch_id);
            }}
            className="flex size-5 shrink-0 items-center justify-center rounded text-ink-faint hover:bg-ink/5 hover:text-ink"
          >
            <svg
              viewBox="0 0 24 24"
              fill="none"
              strokeWidth={2.5}
              aria-hidden="true"
              className={cn(
                "size-3.5 stroke-current transition-transform duration-150",
                expanded && "rotate-90",
              )}
            >
              <path d="M9 6l6 6-6 6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>

          {/* Select-all-children checkbox */}
          <input
            ref={checkboxRef}
            type="checkbox"
            checked={allSelected}
            disabled={childIds.length === 0}
            onClick={(e) => e.stopPropagation()}
            onChange={() => onToggleChildren(childIds, !allSelected)}
            aria-label={`Select all runs in theme ${batch.research_theme}`}
            className="size-[15px] shrink-0 cursor-pointer accent-accent disabled:cursor-default disabled:opacity-30"
          />

          {/* Title + audience */}
          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <div className="flex min-w-0 items-center gap-2">
              <span className="shrink-0 rounded bg-accent/10 px-1.5 py-px text-[9.5px] font-semibold uppercase tracking-wider text-accent">
                Theme
              </span>
              <span className="truncate text-[13px] font-semibold text-ink">
                {batch.research_theme}
              </span>
            </div>
            {batch.target_audience && (
              <span className="truncate text-[11px] text-ink-faint max-md:hidden">
                {batch.target_audience}
              </span>
            )}
          </div>

          {/* Child lifecycle summary (hidden when empty) */}
          {summary.total > 0 && (
            <div className="flex shrink-0 items-center gap-2 text-[11px] text-ink-faint max-sm:hidden">
              <SummaryDot tone="bg-ok" n={summary.published} label="published" />
              <SummaryDot tone="bg-accent" n={summary.needsReview} label="in review" />
              <SummaryDot tone="bg-info" n={summary.inFlight} label="in flight" />
              <SummaryDot tone="bg-accent-deep" n={summary.failed} label="failed" />
            </div>
          )}

          {/* Sub-task count */}
          <span className="shrink-0 whitespace-nowrap text-[11px] font-medium tabular-nums text-ink-soft">
            {summary.total} {summary.total === 1 ? "run" : "runs"}
          </span>

          {/* Created — when the theme was created + who created it */}
          <div className="flex shrink-0 flex-col items-end leading-tight text-ink-faint max-sm:hidden">
            <span className="whitespace-nowrap text-[11px] tabular-nums">
              {fmtDateTime(batch.created_at)}
            </span>
            <span className="max-w-[120px] truncate text-[10px]" title={batch.created_by}>
              {fmtCreator(batch.created_by)}
            </span>
          </div>

          {/* Batch status pill */}
          <span
            className={cn(
              "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-1 text-[11px] font-semibold",
              TONE_PILL[meta.tone],
            )}
          >
            <span className={cn("size-1.5 rounded-full bg-current", meta.pulse && "animate-pulse")} />
            {meta.label}
          </span>

          {/* Open brief */}
          <Link
            href={`/topic-batches/${batch.batch_id}`}
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 whitespace-nowrap text-[11.5px] font-semibold text-info hover:underline"
          >
            Open brief →
          </Link>
        </div>
      </td>
    </tr>
  );
}

function SummaryDot({ tone, n, label }: { tone: string; n: number; label: string }) {
  if (n === 0) return null;
  return (
    <span className="inline-flex items-center gap-1" title={`${n} ${label}`}>
      <span className={cn("size-1.5 rounded-full", tone)} />
      <span className="tabular-nums">{n}</span>
    </span>
  );
}
