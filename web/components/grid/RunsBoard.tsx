"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useMemo, useState } from "react";

import { BulkActionBar } from "@/components/grid/BulkActionBar";
import { GroupedDeskFallback } from "@/components/grid/GroupedDeskFallback";
import { GroupSection } from "@/components/grid/GroupSection";
import type { CellOption } from "@/components/grid/InlineCells";
import type { RowView } from "@/components/grid/RunRow";
import { api, personasApi, topicBatchesApi } from "@/lib/api";
import { TABS, type TabKey } from "@/lib/desk-items";
import type { BoardRecord } from "@/lib/runs-grid/board-record";
import { columnGroupSpans, columnsForTab, totalColumnCount } from "@/lib/runs-grid/columns";
import { batchGroup, byNewest, DONE_GROUPS, GROUPS, runGroup, type GroupKey } from "@/lib/runs-grid/groups";
import { buildNavOrder } from "@/lib/runs-grid/keyboard";
import { buildRecords, distinctVoices, selectTopItems } from "@/lib/runs-grid/select";
import { useBoardKeyboard } from "@/lib/runs-grid/use-board-keyboard";
import { promotedRunIds } from "@/lib/runs-grid/use-batch-children";
import { visibleRunIds } from "@/lib/runs-grid/use-bulk-actions";
import { useBatchPatch } from "@/lib/runs-grid/use-batch-patch";
import { useBoardState } from "@/lib/runs-grid/use-board-state";
import { useRunPatch } from "@/lib/runs-grid/use-run-patch";
import { useRole } from "@/lib/use-role";
import type { RunSummary, TopicBatch } from "@/lib/types";
import { cn } from "@/lib/utils";

const POLL_MS = 15_000;

function toMap<T extends { id: number; name: string }>(items: readonly T[] | undefined): Map<number, string> {
  const m = new Map<number, string>();
  for (const it of items ?? []) m.set(it.id, it.name);
  return m;
}

export function RunsBoard() {
  const board = useBoardState();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [manualGroups, setManualGroups] = useState<ReadonlySet<GroupKey>>(new Set());
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  // Roving-tabindex cursor for keyboard nav (Phase 5). Null until the first j/k.
  const [focusedId, setFocusedId] = useState<string | null>(null);

  // Acting on a row hidden under another edition is surprising — clear the
  // selection whenever the tab changes (matches the demo). Done by adjusting
  // state during render (React's recommended pattern) rather than in an effect.
  const [prevTab, setPrevTab] = useState(board.tab);
  if (board.tab !== prevTab) {
    setPrevTab(board.tab);
    setSelected(new Set());
  }

  const runsQ = useQuery({ queryKey: ["runs"], queryFn: () => api.listRuns(), refetchInterval: POLL_MS });
  const batchesQ = useQuery({ queryKey: ["topic-batches"], queryFn: () => topicBatchesApi.list(), refetchInterval: POLL_MS });
  // WordPress option lookups for id→name display. Cached + retry-free: a dev
  // backend without WP configured just falls back to "#id".
  const wpUsersQ = useQuery({ queryKey: ["wp-users"], queryFn: () => api.listWpUsers(), staleTime: 5 * 60_000, retry: false });
  const wpCatsQ = useQuery({ queryKey: ["wp-categories"], queryFn: () => api.listWpCategories(), staleTime: 5 * 60_000, retry: false });
  // Persona slugs for the batch band's editable Voice default. Cached, retry-free.
  const personasQ = useQuery({ queryKey: ["personas"], queryFn: () => personasApi.list(), staleTime: 5 * 60_000, retry: false });

  // Inline-edit wiring (Phase 3): optimistic PATCH mutations + role gate.
  const { can } = useRole();
  // Behavior-preserving rename of the legacy `editor` tier → `reviewer` (WS0).
  // WS1 may relax board inline-edit down to the new `author` tier.
  const canEdit = can("reviewer");
  const runPatch = useRunPatch();
  const batchPatch = useBatchPatch();

  const personaOptions = useMemo<CellOption[]>(
    () => (personasQ.data ?? []).map((p) => ({ value: p.slug, label: p.name })),
    [personasQ.data],
  );

  const runs = useMemo(() => runsQ.data ?? [], [runsQ.data]);
  const batches = useMemo(() => batchesQ.data ?? [], [batchesQ.data]);

  const runsById = useMemo(() => {
    const m = new Map<string, RunSummary>();
    for (const r of runs) m.set(r.run_id, r);
    return m;
  }, [runs]);

  const batchesById = useMemo(() => {
    const m = new Map<string, TopicBatch>();
    for (const b of batches) m.set(b.batch_id, b);
    return m;
  }, [batches]);

  const view: RowView = useMemo(
    () => ({
      columns: columnsForTab(board.tab, board.showWordpress),
      showWordpress: board.showWordpress,
      compact: board.density === "compact",
      canEdit,
      pendingRunId: runPatch.pendingRunId,
      pendingBatchId: batchPatch.pendingBatchId,
      onPatchRun: runPatch.patch,
      onPatchBatch: batchPatch.patch,
      personaOptions,
    }),
    [
      board.tab, board.showWordpress, board.density,
      canEdit, runPatch.pendingRunId, batchPatch.pendingBatchId,
      runPatch.patch, batchPatch.patch, personaOptions,
    ],
  );

  const voices = useMemo(() => distinctVoices(runs, batches), [runs, batches]);

  // Per-tab totals + "needs you" (review group) counts, unfiltered, for the tabs.
  const counts = useMemo(() => {
    const out = {} as Record<TabKey, { total: number; needs: number }>;
    for (const t of TABS) {
      const top = selectTopItems(t.key, runs, batches);
      const groupsOf = [
        ...top.runs.map((r) => runGroup(r.status)),
        ...top.batches.map((b) => batchGroup(b.status)),
      ];
      out[t.key] = { total: groupsOf.length, needs: groupsOf.filter((g) => g === "review").length };
    }
    return out;
  }, [runs, batches]);

  // Search + voice filtered records for the active tab.
  const records = useMemo<BoardRecord[]>(
    () => buildRecords(board.tab, runs, batches, board.search, board.voice),
    [runs, batches, board.tab, board.search, board.voice],
  );

  const colSpan = totalColumnCount(board.showWordpress);
  const groupSpans = columnGroupSpans(board.showWordpress);

  const isGroupOpen = useCallback(
    (key: GroupKey): boolean => {
      const defaultOpen = !(board.collapseDone && DONE_GROUPS.includes(key));
      return manualGroups.has(key) ? !defaultOpen : defaultOpen;
    },
    [board.collapseDone, manualGroups],
  );
  function toggleGroup(key: GroupKey) {
    setManualGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }
  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // ── selection (Phase 4) ──────────────────────────────────────────────────
  const toggleSelect = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);
  const clearSelection = useCallback(() => setSelected(new Set()), []);

  // Run ids the "select all visible" header checkbox covers: top-level run rows
  // plus the promoted children of any expanded batch (read from the cached batch
  // detail loaded on expand). Batches themselves are selected individually.
  const childIdsOf = useCallback(
    (batchId: string): readonly string[] => {
      const detail = queryClient.getQueryData<TopicBatch>(["topic-batch", batchId]);
      return promotedRunIds(detail?.candidates);
    },
    [queryClient],
  );
  const visibleIds = useMemo(
    () => visibleRunIds(records, expanded, childIdsOf),
    [records, expanded, childIdsOf],
  );
  const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const someVisibleSelected = visibleIds.some((id) => selected.has(id));

  const toggleSelectAll = useCallback(
    (checked: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of visibleIds) {
          if (checked) next.add(id);
          else next.delete(id);
        }
        return next;
      });
    },
    [visibleIds],
  );

  // ── keyboard nav (Phase 5) ───────────────────────────────────────────────
  // The visible row order a j/k cursor walks — open groups only, with an
  // expanded batch's promoted children inlined after it.
  const navOrder = useMemo(
    () => buildNavOrder(records, isGroupOpen, expanded, childIdsOf),
    [records, isGroupOpen, expanded, childIdsOf],
  );
  useBoardKeyboard({
    order: navOrder,
    focusedId,
    setFocusedId,
    onToggleSelect: toggleSelect,
    onToggleExpand: toggleExpand,
  });

  const isLoading = runsQ.isLoading || batchesQ.isLoading;
  const isError = runsQ.isError || batchesQ.isError;
  const hasAny = records.length > 0;

  const thColRow = "sticky top-[26px] z-[5] bg-paper-deep text-left font-mono text-[10px] uppercase tracking-[0.08em] text-ink-soft font-medium px-3 pt-1 pb-2.5 whitespace-nowrap border-b-2 border-b-ink";
  const thGroupRow = "sticky top-0 z-[5] bg-paper-deep text-left font-mono text-[9.5px] uppercase tracking-[0.18em] text-ink-faint font-medium px-3 pt-2 pb-1 border-b border-rule";
  // The selection checkbox column is frozen at left:0 (32px wide); the identity
  // column freezes just to its right at left:32px.
  const selTh = "sticky left-0 z-[7] bg-paper-deep w-[32px]";
  const frozenTh = "sticky left-[32px] z-[7] bg-paper-deep min-w-[300px] max-w-[340px]";

  return (
    <div>
      <BoardRail
        board={board}
        voices={voices}
        counts={counts}
      />

      {isLoading ? <p className="text-ink-faint mt-6 text-[13px]">Loading the ledger…</p> : null}
      {isError ? <p className="text-accent-deep mt-6 text-[13px]">Failed to load runs.</p> : null}

      {/* Desktop: the bounded-scroll ledger grid (sticky header + group heads). */}
      <div className="hidden lg:block mt-4 overflow-auto max-h-[calc(100vh-232px)] border-b border-rule">
        <table className="border-separate border-spacing-0 w-full min-w-[1100px] text-[13px]">
          <thead>
            <tr>
              <th className={cn(thGroupRow, selTh)} aria-hidden />
              <th className={cn(thGroupRow, frozenTh)}>Topic — run identity</th>
              {groupSpans.map((g) => (
                <th key={g.group} colSpan={g.span} className={cn(thGroupRow, "border-l border-rule")}>
                  {g.label}
                </th>
              ))}
              <th className={cn(thGroupRow, "border-l border-rule")}>Action</th>
            </tr>
            <tr>
              <th className={cn(thColRow, selTh)}>
                <input
                  type="checkbox"
                  aria-label="Select all visible runs"
                  checked={allVisibleSelected}
                  aria-checked={allVisibleSelected ? "true" : someVisibleSelected ? "mixed" : "false"}
                  ref={(el) => {
                    if (el) el.indeterminate = !allVisibleSelected && someVisibleSelected;
                  }}
                  onChange={(e) => toggleSelectAll(e.target.checked)}
                  className="cursor-pointer accent-accent align-middle"
                />
              </th>
              <th className={cn(thColRow, frozenTh, "z-[7]")}>Topic · type · status · keywords</th>
              {view.columns.map((c, i) => (
                <th
                  key={c.key}
                  className={cn(thColRow, (i === 0 || view.columns[i - 1].group !== c.group) && "border-l border-l-rule")}
                >
                  {c.label}
                </th>
              ))}
              <th className={cn(thColRow, "border-l border-l-rule")}>Action</th>
            </tr>
          </thead>
          <tbody>
            {hasAny ? (
              GROUPS.map((group) => (
                <GroupSection
                  key={group.key}
                  group={group}
                  records={records.filter((r) => r.group === group.key).sort(byNewest)}
                  open={isGroupOpen(group.key)}
                  onToggleGroup={toggleGroup}
                  colSpan={colSpan}
                  view={view}
                  runsById={runsById}
                  expanded={expanded}
                  onToggleExpand={toggleExpand}
                  selected={selected}
                  onToggleSelect={toggleSelect}
                  focusedId={focusedId}
                  onFocusRow={setFocusedId}
                />
              ))
            ) : !isLoading ? (
              <tr>
                <td colSpan={colSpan} className="px-3 py-10">
                  <p className="font-display italic text-ink-faint text-[17px]">Nothing filed under this edition.</p>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {/* Below lg: stacked Desk-style cards (reuses DeskRow). */}
      <div className="lg:hidden mt-4">
        <GroupedDeskFallback runs={runs} batches={batches} tab={board.tab} search={board.search} voice={board.voice} />
      </div>

      <p className="mt-3 font-mono text-[10px] text-ink-faint tracking-[0.04em]">
        ⬤ status colour — the only colour-coded signal · └ = run promoted from the batch above
        <span className="hidden lg:inline"> · keys: <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>x</kbd> select · <kbd>e</kbd> expand · <kbd>↵</kbd> open</span>
      </p>

      <BulkActionBar
        selected={selected}
        runsById={runsById}
        batchesById={batchesById}
        wpUsers={toMap(wpUsersQ.data)}
        wpCategories={toMap(wpCatsQ.data)}
        onClear={clearSelection}
      />
    </div>
  );
}

// ── filter rail ────────────────────────────────────────────────────────────
function BoardRail({
  board,
  voices,
  counts,
}: {
  board: ReturnType<typeof useBoardState>;
  voices: string[];
  counts: Record<TabKey, { total: number; needs: number }>;
}) {
  const chip = "font-mono text-[10.5px] uppercase tracking-[0.1em] border border-rule rounded-sm bg-paper px-2.5 py-1.5 cursor-pointer hover:border-ink transition-colors";
  const chipOn = "bg-accent text-paper border-accent hover:border-accent";

  return (
    <div>
      <nav aria-label="Editions" className="flex flex-wrap border-b border-ink">
        {TABS.map((t) => {
          const active = t.key === board.tab;
          const c = counts[t.key];
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => board.setTab(t.key)}
              aria-pressed={active}
              className={cn(
                "relative flex items-center gap-2 px-4 py-2.5 -mb-px font-mono text-[11px] uppercase tracking-[0.14em] border-b-2 transition-colors",
                active ? "border-accent text-ink" : "border-transparent text-ink-faint hover:text-ink",
              )}
            >
              {t.glyph ? <span aria-hidden className="text-ink-soft">{t.glyph}</span> : null}
              {t.label}
              <span className="tabular-nums text-ink-soft">{c.total}</span>
              {c.needs > 0 ? (
                <span className="inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-accent text-paper text-[9px] tabular-nums leading-none">
                  {c.needs}
                </span>
              ) : null}
            </button>
          );
        })}
      </nav>

      <div className="flex items-center gap-2.5 flex-wrap py-3.5 border-b border-rule">
        <label className="flex-1 min-w-[200px] max-w-[320px] flex items-center gap-1.5 border border-rule rounded-sm bg-paper px-2.5 py-1.5">
          <span aria-hidden className="text-ink-faint">⌕</span>
          <input
            type="search"
            value={board.search}
            onChange={(e) => board.setSearch(e.target.value)}
            placeholder="Search topic, run id or URL…"
            className="w-full bg-transparent outline-none text-[13px] text-ink"
          />
        </label>
        <select
          value={board.voice}
          onChange={(e) => board.setVoice(e.target.value)}
          aria-label="Filter by voice"
          className="font-mono text-[11px] uppercase tracking-[0.06em] text-ink-soft border border-rule rounded-sm bg-paper px-2 py-1.5 cursor-pointer"
        >
          <option value="">Voice · All</option>
          {voices.map((v) => (
            <option key={v} value={v}>Voice · {v}</option>
          ))}
        </select>
        <span className="flex-1" />
        <button
          type="button"
          onClick={board.toggleCollapseDone}
          aria-pressed={board.collapseDone}
          className={cn(chip, board.collapseDone && chipOn)}
          title="Collapse the Approved & Failed groups"
        >
          ⊟ Collapse done
        </button>
        <button
          type="button"
          onClick={board.toggleWordpress}
          aria-pressed={!board.showWordpress}
          className={cn(chip, !board.showWordpress && chipOn)}
          title="Show/hide the WordPress column group"
        >
          ▦ WordPress cols
        </button>
        <button
          type="button"
          onClick={board.toggleDensity}
          aria-pressed={board.density === "compact"}
          className={cn(chip, board.density === "compact" && chipOn)}
        >
          ≡ {board.density === "compact" ? "Comfortable" : "Compact"}
        </button>
      </div>
    </div>
  );
}
