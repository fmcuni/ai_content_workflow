"use client";

import type { Persona, PublishTarget, RunSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

import { decodeSlug, fmtCreator, fmtDateTime, resolveTarget, voiceName } from "./fmt";
import { StatusPill } from "./StatusPill";
import type { OptionMaps } from "./useWpOptionMaps";

export interface RowView {
  selected: boolean;
  open: boolean;
  onToggleSelect: (runId: string) => void;
  onOpen: (runId: string) => void;
}

interface LedgerRowProps {
  run: RunSummary;
  view: RowView;
  personaBySlug: Map<string, Persona>;
  targetById: Map<string, PublishTarget>;
  options: OptionMaps;
}

const PUB_PILL: Record<string, string> = {
  publish: "bg-ok/15 text-ok",
  draft: "bg-ink-soft/15 text-ink-soft",
  future: "bg-info/15 text-info",
};

function Flag({ tone, children, title }: { tone: "blue" | "gray" | "amber"; children: string; title?: string }) {
  const cls = {
    blue: "bg-info/10 text-info",
    gray: "bg-ink-soft/10 text-ink-soft",
    amber: "bg-warn/10 text-warn",
  }[tone];
  return (
    <span
      title={title}
      className={cn(
        "whitespace-nowrap rounded px-1.5 py-px text-[10px] font-semibold tracking-wide",
        cls,
      )}
    >
      {children}
    </span>
  );
}

/**
 * One ledger row (spec §4.4) — a 3-line Topic & draft cell, voice badge, status
 * pill, CMS destination mini-lines and the created timestamp. On mobile it
 * reflows into a card (the table cells become stacked blocks). Clicking the row
 * opens the drawer; the checkbox is isolated so selecting never opens it.
 */
export function LedgerRow({ run, view, personaBySlug, targetById, options }: LedgerRowProps) {
  const target = resolveTarget(run, personaBySlug, targetById);
  const voice = voiceName(run, personaBySlug);
  const slug = decodeSlug(run);
  const snippet = run.seo_title ?? run.meta_description ?? null;

  const author = run.wp_author_id != null ? options.users.get(run.wp_author_id)?.name : null;
  const catNames = (run.wp_category_ids ?? [])
    .map((id) => options.categories.get(id)?.name ?? `#${id}`)
    .filter(Boolean);
  const pub = run.wp_publish_status ?? null;
  const rev = run.hitl_2_iteration ?? 0;

  return (
    <tr
      onClick={() => view.onOpen(run.run_id)}
      aria-selected={view.open}
      className={cn(
        "cursor-pointer align-top hover:bg-paper-deep/40 max-md:relative max-md:my-2.5 max-md:block max-md:rounded-[10px] max-md:border max-md:border-rule max-md:py-3 max-md:pl-10 max-md:pr-3",
        view.selected && "bg-accent/[0.06]",
        view.open && "bg-accent/[0.06] shadow-[inset_3px_0_0_var(--color-accent)] max-md:shadow-[inset_0_0_0_1.5px_var(--color-accent)]",
      )}
    >
      <td
        className="w-[34px] border-b border-rule/60 p-2.5 max-md:absolute max-md:left-3 max-md:top-3.5 max-md:border-0 max-md:p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="checkbox"
          checked={view.selected}
          onChange={() => view.onToggleSelect(run.run_id)}
          aria-label={`Select run ${run.topic}`}
          className="mt-0.5 size-[15px] cursor-pointer accent-accent"
        />
      </td>

      {/* Topic & draft */}
      <td className="border-b border-rule/60 p-2.5 max-md:block max-md:border-0 max-md:p-0">
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-[13.5px] font-semibold leading-snug text-ink">{run.topic}</span>
          <span className="inline-flex gap-1">
            {run.start_mode === "refresh" && <Flag tone="blue">rewrite</Flag>}
            {run.start_mode === "create" && <Flag tone="gray">new</Flag>}
            {run.edit_note && (
              <Flag tone="amber" title={run.edit_note}>
                brief
              </Flag>
            )}
            {rev > 0 && <Flag tone="gray">{`rev ${rev}`}</Flag>}
          </span>
        </div>
        {snippet && (
          <div className="mt-1 line-clamp-1 text-[12px] leading-snug text-ink-soft">{snippet}</div>
        )}
        <div className="mt-1 flex flex-wrap gap-x-2.5 font-mono text-[10.5px] text-ink-faint">
          <span title={run.run_id}>{run.run_id.slice(0, 8)}</span>
          {slug && <span className="truncate">{slug}</span>}
          {run.wp_pushed_post_id != null && (
            <span className="font-semibold text-ok">
              {target.tag}#{run.wp_pushed_post_id}
            </span>
          )}
        </div>
      </td>

      {/* Voice */}
      <td className="w-[118px] border-b border-rule/60 p-2.5 max-md:mr-2 max-md:mt-2 max-md:inline-block max-md:border-0 max-md:p-0 max-md:align-middle">
        {voice && (
          <span className="inline-block whitespace-nowrap rounded-md border border-rule bg-paper-deep px-1.5 py-0.5 text-[11px] font-semibold text-ink">
            {voice}
          </span>
        )}
      </td>

      {/* Status */}
      <td className="w-[138px] border-b border-rule/60 p-2.5 max-md:mr-2 max-md:mt-2 max-md:inline-block max-md:border-0 max-md:p-0 max-md:align-middle">
        <StatusPill status={run.status} />
      </td>

      {/* CMS destination */}
      <td className="w-[270px] border-b border-rule/60 p-2.5 text-[12px] leading-relaxed text-ink-soft min-[761px]:max-[1080px]:hidden max-md:mt-2 max-md:block max-md:border-0 max-md:border-t max-md:border-dashed max-md:border-rule/60 max-md:p-0 max-md:pt-2">
        <DestLine k="cms" v={target.name} />
        <DestLine k="auth" v={author} unsetLabel="unset" />
        <DestLine k="cat" v={catNames.length ? catNames.join(", ") : null} unsetLabel="unset" />
        <div className="flex items-baseline gap-1.5">
          <span className="w-[38px] flex-none text-[10.5px] uppercase tracking-wide text-ink-faint">
            pub
          </span>
          {pub ? (
            <span className="flex items-baseline gap-1.5">
              <span
                className={cn(
                  "rounded px-1.5 py-px text-[10px] font-bold uppercase tracking-wide",
                  PUB_PILL[pub] ?? PUB_PILL.draft,
                )}
              >
                {pub}
              </span>
              {pub === "future" && run.wp_publish_at && (
                <span className="text-ink-soft">{fmtDateTime(run.wp_publish_at)}</span>
              )}
            </span>
          ) : (
            <span className="italic text-ink-faint">draft (default)</span>
          )}
        </div>
      </td>

      {/* Created — timestamp + who created the run */}
      <td className="w-[118px] whitespace-nowrap border-b border-rule/60 p-2.5 text-[12px] text-ink-soft max-md:mr-2 max-md:mt-2 max-md:inline-block max-md:border-0 max-md:p-0 max-md:align-middle max-md:text-[11px]">
        <div className="tabular-nums">{fmtDateTime(run.created_at)}</div>
        <div
          className="mt-0.5 truncate text-[11px] text-ink-faint max-md:inline max-md:before:content-['·_']"
          title={run.created_by ?? undefined}
        >
          {fmtCreator(run.created_by)}
        </div>
      </td>
    </tr>
  );
}

function DestLine({ k, v, unsetLabel }: { k: string; v: string | null | undefined; unsetLabel?: string }) {
  return (
    <div className="flex items-baseline gap-1.5 overflow-hidden">
      <span className="w-[38px] flex-none text-[10.5px] uppercase tracking-wide text-ink-faint">
        {k}
      </span>
      <span
        className={cn(
          "truncate",
          v ? "text-ink" : "italic text-ink-faint",
        )}
      >
        {v || unsetLabel || "—"}
      </span>
    </div>
  );
}
