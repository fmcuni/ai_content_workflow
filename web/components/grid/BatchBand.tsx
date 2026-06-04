"use client";

import Link from "next/link";

import { NumberCell, SelectCell } from "@/components/grid/InlineCells";
import type { RowView } from "@/components/grid/RunRow";
import { RunRow } from "@/components/grid/RunRow";
import { PaperStamp } from "@/components/PaperStamp";
import { BATCH_META } from "@/lib/desk-items";
import { useBatchChildren } from "@/lib/runs-grid/use-batch-children";
import type { BatchStatus, RunSummary, TopicBatch } from "@/lib/types";
import { cn } from "@/lib/utils";

function batchActionLabel(status: BatchStatus): string {
  switch (status) {
    case "ready_for_review":
      return "Review topics";
    case "partially_promoted":
      return "Finish promotion";
    case "failed":
      return "Inspect failure";
    default:
      return "Open";
  }
}

interface BatchBandProps {
  batch: TopicBatch;
  colSpan: number;
  expanded: boolean;
  onToggle: (id: string) => void;
  runsById: ReadonlyMap<string, RunSummary>;
  view: RowView;
  /** Board-wide set of expanded ids — so promoted child runs can expand too. */
  runExpanded: ReadonlySet<string>;
  /** Board-wide selection set + toggle (covers the batch and its child runs). */
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  /** Roving-tabindex cursor: the focused row id + a setter to sync on focus. */
  focusedId: string | null;
  onFocusRow: (id: string) => void;
}

/**
 * A topic batch as a full-width tinted band with a rust left-spine — NOT mapped
 * to the run columns. Expands to its promoted runs, lazily loaded from the batch
 * detail (the list endpoint omits candidates) and nested + indented beneath it.
 */
export function BatchBand({
  batch,
  colSpan,
  expanded,
  onToggle,
  runsById,
  view,
  runExpanded,
  selected,
  onToggleSelect,
  focusedId,
  onFocusRow,
}: BatchBandProps) {
  const meta = BATCH_META[batch.status];
  const children = useBatchChildren(batch.batch_id, expanded, runsById);
  const pct = children.topicCount > 0 ? Math.round((100 * children.promotedCount) / children.topicCount) : 0;
  const focused = focusedId === batch.batch_id;

  return (
    <>
      <tr
        className="outline-none"
        data-row-id={batch.batch_id}
        tabIndex={focused ? 0 : -1}
        onFocus={(e) => {
          if (e.target === e.currentTarget) onFocusRow(batch.batch_id);
        }}
      >
        <td
          colSpan={colSpan}
          className={cn(
            "p-0 border-t border-b border-ink bg-[color-mix(in_srgb,var(--color-paper-deep)_82%,var(--color-paper))]",
            // Focus signal distinct from the band's always-on left spine: a rust
            // top+bottom inset plus a faint tint.
            focused && "shadow-[inset_0_2px_0_0_var(--color-accent),inset_0_-2px_0_0_var(--color-accent)] bg-accent/[0.06]",
          )}
        >
          <div className="flex items-center gap-5 px-4 py-3 border-l-[3px] border-l-accent flex-wrap">
            <button
              type="button"
              onClick={() => onToggle(batch.batch_id)}
              aria-expanded={expanded}
              aria-label={expanded ? "Hide promoted runs" : "Show promoted runs"}
              className="text-ink-faint hover:text-accent text-[12px] leading-none"
            >
              {expanded ? "▾" : "▸"}
            </button>
            <input
              type="checkbox"
              aria-label={`Select topic batch ${batch.research_theme}`}
              checked={selected.has(batch.batch_id)}
              onChange={() => onToggleSelect(batch.batch_id)}
              className="cursor-pointer accent-accent"
            />
            <div className="min-w-[260px]">
              <div className="flex items-center gap-2 mb-0.5">
                <span className="inline-flex items-center gap-1 font-mono text-[9px] uppercase tracking-[0.09em] text-ink-soft border border-rule rounded-sm px-1.5 py-px bg-paper-deep/60">
                  <span aria-hidden className="text-ink-faint">❉</span>
                  Topic batch
                </span>
                <PaperStamp tone={meta.tone} pulse={meta.pulse}>{meta.label}</PaperStamp>
              </div>
              <Link
                href={`/topic-batches/${batch.batch_id}`}
                title={batch.research_theme}
                className="font-display text-[17px] text-ink hover:text-accent transition-colors"
              >
                {batch.research_theme}
              </Link>
              <div className="font-mono text-[10px] text-ink-faint tracking-[0.02em] mt-0.5">
                {batch.target_audience}
                {batch.priority_focus ? ` · 焦點 ${batch.priority_focus}` : ""}
                {` · ${batch.topic_count} topics · by ${batch.created_by}`}
              </div>
            </div>

            <div className="flex items-center gap-2.5">
              <span className="w-[120px] h-1.5 border border-rule rounded-full overflow-hidden bg-paper">
                <span className="block h-full bg-accent" style={{ width: `${pct}%` }} />
              </span>
              <span className="font-mono text-[11px] text-ink-soft">
                {expanded ? `${children.promotedCount}/${children.topicCount || batch.topic_count} promoted` : `${batch.topic_count} topics`}
              </span>
            </div>

            <BatchDefaults batch={batch} view={view} />

            <span className="flex-1" />
            <Link
              href={`/topic-batches/${batch.batch_id}`}
              className="font-sans text-[11.5px] font-medium text-accent hover:underline underline-offset-2 whitespace-nowrap"
            >
              {batchActionLabel(batch.status)} →
            </Link>
          </div>
        </td>
      </tr>

      {expanded ? (
        <BatchChildren
          batch={batch}
          colSpan={colSpan}
          result={children}
          view={view}
          runExpanded={runExpanded}
          onToggleExpand={onToggle}
          selected={selected}
          onToggleSelect={onToggleSelect}
          focusedId={focusedId}
          onFocusRow={onFocusRow}
        />
      ) : null}
    </>
  );
}

/**
 * The batch's promotion defaults: cost + AUTO-H1 badge, then editable Voice /
 * Adv / Widget defaults (editor+) or read-only text (viewers). Editing a default
 * only affects runs promoted AFTER the change, never an existing draft.
 */
function BatchDefaults({ batch, view }: { batch: TopicBatch; view: RowView }) {
  const pending = view.pendingBatchId === batch.batch_id;

  return (
    <div className="flex items-center gap-3.5 text-ink-soft text-[12px] flex-wrap">
      <span className="font-mono text-[11px]">HK$ {(batch.cost_cents / 100).toFixed(2)}</span>
      {batch.auto_accept_hitl1_default ? (
        <span className="font-mono text-[9px] uppercase tracking-[0.09em] text-ink-soft border border-rule rounded-sm px-1.5 py-px">
          AUTO H1 default
        </span>
      ) : null}

      {view.canEdit ? (
        <>
          <span className="font-mono text-[11px] text-ink-faint">Voice</span>
          <SelectCell
            ariaLabel="Batch default voice"
            value={batch.persona_default ?? ""}
            options={[{ value: "", label: "—" }, ...view.personaOptions]}
            pending={pending}
            onChange={(v) =>
              view.onPatchBatch(batch.batch_id, { persona_default: v || null })
            }
          />
          <span className="font-mono text-[11px] text-ink-faint">Adv</span>
          <NumberCell
            value={batch.acf_adv_id_default}
            pending={pending}
            onCommit={(n) => view.onPatchBatch(batch.batch_id, { acf_adv_id_default: n })}
          />
          <span className="font-mono text-[11px] text-ink-faint">Widget</span>
          <NumberCell
            value={batch.acf_widget_id_default}
            pending={pending}
            onCommit={(n) => view.onPatchBatch(batch.batch_id, { acf_widget_id_default: n })}
          />
        </>
      ) : (
        <>
          {batch.persona_default ? (
            <span className="font-mono text-[11px]">Voice {batch.persona_default}</span>
          ) : null}
          {batch.acf_adv_id_default != null || batch.acf_widget_id_default != null ? (
            <span className="font-mono text-[11px]">
              Adv {batch.acf_adv_id_default ?? "—"} · Widget {batch.acf_widget_id_default ?? "—"}
            </span>
          ) : null}
        </>
      )}
    </div>
  );
}

function BatchChildren({
  batch,
  colSpan,
  result,
  view,
  runExpanded,
  onToggleExpand,
  selected,
  onToggleSelect,
  focusedId,
  onFocusRow,
}: {
  batch: TopicBatch;
  colSpan: number;
  result: ReturnType<typeof useBatchChildren>;
  view: RowView;
  runExpanded: ReadonlySet<string>;
  onToggleExpand: (id: string) => void;
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  focusedId: string | null;
  onFocusRow: (id: string) => void;
}) {
  const bandLabel = cn(
    "px-4 pl-[22px] py-1.5 font-mono text-[9.5px] uppercase tracking-[0.14em] text-ink-faint",
    "border-b border-rule bg-[color-mix(in_srgb,var(--color-paper-deep)_50%,var(--color-paper))]",
  );

  if (result.isLoading) {
    return (
      <tr>
        <td colSpan={colSpan} className={bandLabel}>└ Loading promoted runs…</td>
      </tr>
    );
  }

  if (result.runs.length === 0) {
    return (
      <tr>
        <td colSpan={colSpan} className="px-5 py-4 border-b border-ink bg-paper-deep">
          <p className="font-display italic text-ink-faint text-[15px]">
            No runs promoted yet — review the {result.topicCount || batch.topic_count} candidate topics to promote them.
          </p>
        </td>
      </tr>
    );
  }

  return (
    <>
      <tr>
        <td colSpan={colSpan} className={bandLabel}>
          └ Promoted runs · {result.runs.length} of {result.topicCount || batch.topic_count} topics
        </td>
      </tr>
      {result.runs.map((run) => (
        <RunRow
          key={run.run_id}
          run={run}
          view={view}
          child
          colSpan={colSpan}
          expanded={runExpanded.has(run.run_id)}
          onToggleExpand={onToggleExpand}
          selected={selected}
          onToggleSelect={onToggleSelect}
          focused={focusedId === run.run_id}
          onFocusRow={onFocusRow}
        />
      ))}
    </>
  );
}
