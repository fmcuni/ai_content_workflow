"use client";

import Link from "next/link";

import { RunStatusBadge } from "@/components/RunStatusBadge";
import { hostPath, runTypeChip } from "@/lib/runs-grid/display";
import type { RunStatus, RunSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

const MAX_KEYWORDS = 3;

interface IdentityCellProps {
  run: RunSummary;
  /** A promoted run nested under its batch band — indented with the └ marker. */
  child?: boolean;
  /** Whether this run's draft-preview insert is open. */
  expanded: boolean;
  onToggleExpand: (id: string) => void;
}

/**
 * The frozen identity column for a run: a draft-preview chevron, type chip +
 * status badge + AUTO H1 flag, the topic linking into the run, a mono sub-line
 * (run id · mode · WP post), the source link for rewrites, and up to three
 * keyword chips. Status colour is the single colour-coded signal.
 */
export function IdentityCell({ run, child, expanded, onToggleExpand }: IdentityCellProps) {
  const type = runTypeChip(run);
  const keywords = run.keywords ?? [];
  const shown = keywords.slice(0, MAX_KEYWORDS);
  const extra = keywords.length - shown.length;
  const isRewrite = run.start_mode !== "create" && Boolean(run.article_url);

  return (
    <div className={cn("flex items-start gap-2", child && "relative pl-[22px]")}>
      {child ? (
        <span
          aria-hidden
          className="absolute left-1.5 top-px font-mono text-[12px] text-ink-faint"
        >
          └
        </span>
      ) : null}
      <button
        type="button"
        onClick={() => onToggleExpand(run.run_id)}
        aria-expanded={expanded}
        aria-label={expanded ? "Hide draft preview" : "Show draft preview"}
        title="Show draft preview"
        className="shrink-0 text-ink-faint hover:text-accent text-[11px] leading-none pt-0.5"
      >
        {expanded ? "▾" : "▸"}
      </button>
      <div className="min-w-0">
        <div className="flex items-center gap-1.5 flex-wrap mb-0.5">
          <span className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.09em] text-paper bg-ink rounded-sm px-1.5 py-0.5 whitespace-nowrap">
            <span aria-hidden className="text-paper/70">{type.glyph}</span>
            {type.label}
          </span>
          <RunStatusBadge status={run.status as RunStatus} />
          {run.auto_accept_hitl1 ? (
            <span
              className="font-mono text-[8px] uppercase tracking-[0.1em] text-ink-soft border border-rule rounded-sm px-1 py-px"
              title="Auto-approves the HITL_1 outline gate"
            >
              AUTO H1
            </span>
          ) : null}
        </div>
        <div className="flex items-baseline gap-1.5 max-w-[300px]">
          <Link
            href={`/runs/${run.run_id}`}
            title={run.topic}
            className="font-display text-[15.5px] leading-tight text-ink truncate min-w-0 hover:text-accent transition-colors"
            style={{ fontVariationSettings: '"opsz" 28, "SOFT" 70' }}
          >
            {run.topic}
          </Link>
          {run.wp_pushed_post_id ? (
            <span
              className="shrink-0 font-mono text-[9px] uppercase tracking-[0.08em] text-ink-soft border border-rule rounded-sm px-1 py-px bg-paper-deep/60 whitespace-nowrap"
              title="Published WordPress post id"
            >
              WP #{run.wp_pushed_post_id}
            </span>
          ) : null}
        </div>
        <div className="font-mono text-[10px] text-ink-faint tracking-[0.02em] mt-1">
          <span>{run.run_id}</span>
          <span> · {run.mode}</span>
        </div>
        {isRewrite ? (
          <div className="font-mono text-[10px] mt-1 max-w-[280px] truncate">
            <a
              href={run.article_url}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open source article — ${run.article_url}`}
              className="text-ink-soft hover:text-accent"
            >
              ↗ {hostPath(run.article_url)}
            </a>
          </div>
        ) : null}
        {shown.length > 0 ? (
          <ul className="flex flex-wrap gap-x-2 gap-y-0.5 mt-1.5">
            {shown.map((kw) => (
              <li key={kw} className="font-mono text-[9.5px] text-ink-soft">
                <span aria-hidden className="text-ink-faint">#</span>
                {kw}
              </li>
            ))}
            {extra > 0 ? (
              <li className="font-mono text-[9.5px] text-ink-faint">+{extra}</li>
            ) : null}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
