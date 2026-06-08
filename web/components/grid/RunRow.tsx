"use client";

import Link from "next/link";
import type { ReactNode } from "react";

import { IdentityCell } from "@/components/grid/IdentityCell";
import {
  type CellOption,
  DateCell,
  MultiSelectCell,
  NumberCell,
  SelectCell,
  SlugCell,
} from "@/components/grid/InlineCells";
import { RunExpand } from "@/components/grid/RunExpand";
import { runToItem } from "@/lib/desk-items";
import type { RunColumn } from "@/lib/runs-grid/columns";
import { decodeSlug, isLivePublish, ledgerDate, publishLabel } from "@/lib/runs-grid/display";
import type { RunSummary, RunWpMetaPatch, TopicBatchDefaultsPatch } from "@/lib/types";
import { cn } from "@/lib/utils";

// Shared display + edit context threaded to every run row. WP id→name maps come
// from the cached wp-options queries; missing ids fall back to `#id` / "—".
// `canEdit` gates the inline editors (editor+); viewers see read-only text.
export interface RowView {
  columns: RunColumn[];
  showWordpress: boolean;
  compact: boolean;
  wpUsers: ReadonlyMap<number, string>;
  wpCategories: ReadonlyMap<number, string>;
  // Inline-edit wiring (Phase 3).
  canEdit: boolean;
  pendingRunId: string | null;
  pendingBatchId: string | null;
  onPatchRun: (runId: string, body: RunWpMetaPatch) => void;
  onPatchBatch: (batchId: string, body: TopicBatchDefaultsPatch) => void;
  /** Persona slug options for the batch band's editable Voice default. */
  personaOptions: readonly CellOption[];
}

const EMPTY = "—";

const PUBLISH_OPTIONS: readonly CellOption[] = [
  { value: "draft", label: "Draft" },
  { value: "future", label: "Scheduled" },
  { value: "publish", label: "Publish" },
];

function authorName(view: RowView, id: number | null | undefined): string {
  if (id == null) return EMPTY;
  return view.wpUsers.get(id) ?? `#${id}`;
}

function categoryNames(view: RowView, ids: number[] | null | undefined): string {
  if (!ids || ids.length === 0) return EMPTY;
  return ids.map((id) => view.wpCategories.get(id) ?? `#${id}`).join(", ");
}

function optionsFromMap(map: ReadonlyMap<number, string>): CellOption[] {
  return Array.from(map.entries()).map(([id, name]) => ({ value: String(id), label: name }));
}

/** Author options + an "unassigned" sentinel + the current id when off-list. */
function authorOptions(view: RowView, current: number | null | undefined): CellOption[] {
  const opts = optionsFromMap(view.wpUsers);
  if (current != null && !view.wpUsers.has(current)) {
    opts.unshift({ value: String(current), label: `#${current}` });
  }
  return [{ value: "", label: EMPTY }, ...opts];
}

/** Cell content for a run column — inline editor when editable, else plain text. */
function cellContent(run: RunSummary, col: RunColumn, view: RowView): ReactNode {
  const pending = view.pendingRunId === run.run_id;
  const patch = (body: RunWpMetaPatch) => view.onPatchRun(run.run_id, body);

  switch (col.key) {
    // Voice is read-only in the board (audit decision 1) — edit it on the run page.
    case "voice":
      return run.persona || EMPTY;

    case "adv":
      return view.canEdit ? (
        <NumberCell value={run.acf_adv_id} pending={pending} onCommit={(n) => patch({ acf_adv_id: n })} />
      ) : (
        run.acf_adv_id || "none"
      );
    case "widget":
      return view.canEdit ? (
        <NumberCell
          value={run.acf_widget_id}
          pending={pending}
          onCommit={(n) => patch({ acf_widget_id: n })}
        />
      ) : (
        run.acf_widget_id || "none"
      );

    case "author":
      return view.canEdit ? (
        <SelectCell
          ariaLabel="WordPress author"
          value={run.wp_author_id != null ? String(run.wp_author_id) : ""}
          options={authorOptions(view, run.wp_author_id)}
          pending={pending}
          onChange={(v) => {
            if (v !== "") patch({ wp_author_id: Number(v) });
          }}
        />
      ) : (
        authorName(view, run.wp_author_id)
      );
    case "category":
      return view.canEdit ? (
        <MultiSelectCell
          ariaLabel="WordPress categories"
          selected={run.wp_category_ids ?? []}
          options={optionsFromMap(view.wpCategories)}
          pending={pending}
          onChange={(ids) => patch({ wp_category_ids: ids })}
        />
      ) : (
        categoryNames(view, run.wp_category_ids)
      );
    case "slug":
      return view.canEdit ? (
        <SlugCell slug={run.wp_slug} pending={pending} onCommit={(raw) => patch({ wp_slug: raw })} />
      ) : (
        decodeSlug(run.wp_slug) || EMPTY
      );
    case "publish": {
      if (view.canEdit) {
        return (
          <SelectCell
            ariaLabel="Publish status"
            value={run.wp_publish_status ?? "draft"}
            options={PUBLISH_OPTIONS}
            pending={pending}
            onChange={(v) =>
              patch({ wp_publish_status: v as "draft" | "future" | "publish" })
            }
          />
        );
      }
      const live = isLivePublish(run.wp_publish_status);
      return (
        <span className={cn(live && "text-accent-deep font-medium")}>
          {publishLabel(run.wp_publish_status)}
        </span>
      );
    }
    case "postDate":
      return view.canEdit ? (
        <DateCell
          isoValue={run.wp_publish_at}
          pending={pending}
          onChange={(iso) => patch({ wp_publish_at: iso })}
        />
      ) : run.wp_publish_at ? (
        ledgerDate(run.wp_publish_at)
      ) : (
        EMPTY
      );
    default:
      return EMPTY;
  }
}

/** First-of-group columns get the group-divider left rule. */
function isGroupStart(columns: RunColumn[], index: number): boolean {
  return index === 0 || columns[index - 1].group !== columns[index].group;
}

interface RunRowProps {
  run: RunSummary;
  view: RowView;
  child?: boolean;
  /** Full board column count — the expanded preview insert spans all columns. */
  colSpan: number;
  /** Whether this run's draft-preview insert is open. */
  expanded: boolean;
  onToggleExpand: (id: string) => void;
  /** Board-wide selection set + toggle, for the frozen checkbox column. */
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  /** Roving-tabindex cursor: this row holds the keyboard focus. */
  focused?: boolean;
  /** Sync the cursor when the row is focused by click / Tab. */
  onFocusRow?: (id: string) => void;
}

/**
 * One run as a ledger row: frozen identity column (with a draft-preview
 * chevron), the visible BRIEF/WORDPRESS data cells (inline-editable for
 * editors, read-only text for viewers; Voice always read-only), and a
 * navigation Action cell. When expanded it is followed by a full-width
 * <RunExpand> insert row.
 */
export function RunRow({
  run,
  view,
  child,
  colSpan,
  expanded,
  onToggleExpand,
  selected,
  onToggleSelect,
  focused,
  onFocusRow,
}: RunRowProps) {
  const item = runToItem(run);
  const td = cn(
    "border-b border-rule align-top whitespace-nowrap px-3",
    view.compact ? "py-1" : "py-2",
  );
  const groupStart = "border-l border-rule";
  // Focus indicator: a row-wide tint plus a 3px rust spine on the frozen edge.
  // Box-shadow on a <tr> is unreliable across table layouts, so the signal lives
  // on the cells — the spine (accent on paper ≈ 5.8:1) carries SC 2.4.11.
  const frozenBg = focused ? "bg-accent/[0.08]" : "bg-paper group-hover/row:bg-paper-deep";
  const focusBg = focused && "bg-accent/[0.06]";

  return (
    <>
      <tr
        className="group/row outline-none"
        data-row-id={run.run_id}
        tabIndex={focused ? 0 : -1}
        onFocus={(e) => {
          // Only sync when the row itself (not an inner control) takes focus,
          // so Tabbing into a cell editor doesn't move the j/k cursor.
          if (e.target === e.currentTarget) onFocusRow?.(run.run_id);
        }}
      >
        <td
          className={cn(
            td,
            "sticky left-0 z-[2] w-[32px]",
            frozenBg,
            focused && "shadow-[inset_3px_0_0_0_var(--color-accent)]",
          )}
        >
          <input
            type="checkbox"
            aria-label={`Select run ${run.topic}`}
            checked={selected.has(run.run_id)}
            onChange={() => onToggleSelect(run.run_id)}
            className="cursor-pointer accent-accent align-middle"
          />
        </td>
        <th
          scope="row"
          className={cn(
            td,
            "sticky left-[32px] z-[2] text-left font-normal",
            frozenBg,
            "min-w-[300px] max-w-[340px]",
          )}
        >
          <IdentityCell run={run} child={child} expanded={expanded} onToggleExpand={onToggleExpand} />
        </th>
        {view.columns.map((col, i) => (
          <td
            key={col.key}
            className={cn(
              td,
              "text-[12.5px] text-ink-soft",
              col.numeric && "font-mono tabular-nums",
              isGroupStart(view.columns, i) && groupStart,
              focusBg,
            )}
          >
            {cellContent(run, col, view)}
          </td>
        ))}
        <td className={cn(td, groupStart, focusBg)}>
          <Link
            href={item.rowHref}
            className="font-sans text-[11.5px] font-medium text-accent hover:underline underline-offset-2 whitespace-nowrap"
          >
            {item.action ?? "Open"} →
          </Link>
        </td>
      </tr>
      {expanded ? <RunExpand run={run} view={view} colSpan={colSpan} /> : null}
    </>
  );
}
