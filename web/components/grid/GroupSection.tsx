"use client";

import { BatchBand } from "@/components/grid/BatchBand";
import type { RowView } from "@/components/grid/RunRow";
import { RunRow } from "@/components/grid/RunRow";
import type { BoardRecord } from "@/lib/runs-grid/board-record";
import type { GroupDef, GroupKey, GroupTone } from "@/lib/runs-grid/groups";
import type { RunSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

// Group bar colour — the one colour-coded signal, carried from the group's tone.
const BAR: Record<GroupTone, string> = {
  accent: "bg-accent",
  info: "bg-info",
  ok: "bg-ok",
  danger: "bg-accent-deep",
};

interface GroupSectionProps {
  group: GroupDef;
  records: BoardRecord[];
  open: boolean;
  onToggleGroup: (key: GroupKey) => void;
  colSpan: number;
  view: RowView;
  runsById: ReadonlyMap<string, RunSummary>;
  expanded: ReadonlySet<string>;
  onToggleExpand: (id: string) => void;
  /** Board-wide selection set + toggle, threaded to rows and bands. */
  selected: ReadonlySet<string>;
  onToggleSelect: (id: string) => void;
  /** Roving-tabindex cursor: the focused row id + a setter to sync on focus. */
  focusedId: string | null;
  onFocusRow: (id: string) => void;
}

/**
 * A sticky, collapsible group header followed by its rows (newest-first). The
 * header sticks just below the two-row column header so it stays legible while
 * scrolling the bounded viewport. Empty groups render nothing.
 */
export function GroupSection({
  group,
  records,
  open,
  onToggleGroup,
  colSpan,
  view,
  runsById,
  expanded,
  onToggleExpand,
  selected,
  onToggleSelect,
  focusedId,
  onFocusRow,
}: GroupSectionProps) {
  if (records.length === 0) return null;

  return (
    <>
      <tr>
        <td
          colSpan={colSpan}
          className="sticky left-0 top-[51px] z-[3] p-0 bg-paper border-b border-ink"
        >
          <button
            type="button"
            onClick={() => onToggleGroup(group.key)}
            aria-expanded={open}
            className="flex items-center gap-2.5 w-full px-3 pt-3.5 pb-1.5 text-left"
          >
            <span aria-hidden className="text-ink-faint text-[10px] w-3">{open ? "▾" : "▸"}</span>
            <span aria-hidden className={cn("w-[3px] h-[15px] rounded-sm", BAR[group.tone])} />
            <span className="font-mono text-[10.5px] uppercase tracking-[0.16em] text-ink">
              {group.label}
            </span>
            <span className="font-mono text-[11px] tabular-nums text-ink-faint">{records.length}</span>
            {group.hint ? (
              <span className="ml-auto pr-1.5 font-mono text-[9.5px] uppercase tracking-[0.1em] text-ink-faint">
                {group.hint}
              </span>
            ) : null}
          </button>
        </td>
      </tr>

      {open
        ? records.map((rec) =>
            rec.kind === "batch" ? (
              <BatchBand
                key={`batch:${rec.id}`}
                batch={rec.batch}
                colSpan={colSpan}
                expanded={expanded.has(rec.id)}
                onToggle={onToggleExpand}
                runsById={runsById}
                view={view}
                runExpanded={expanded}
                selected={selected}
                onToggleSelect={onToggleSelect}
                focusedId={focusedId}
                onFocusRow={onFocusRow}
              />
            ) : (
              <RunRow
                key={`run:${rec.id}`}
                run={rec.run}
                view={view}
                colSpan={colSpan}
                expanded={expanded.has(rec.id)}
                onToggleExpand={onToggleExpand}
                selected={selected}
                onToggleSelect={onToggleSelect}
                focused={focusedId === rec.id}
                onFocusRow={onFocusRow}
              />
            ),
          )
        : null}
    </>
  );
}
