"use client";

import { Fragment } from "react";

import type { Persona, PublishTarget } from "@/lib/types";

import type { BoardModel } from "./board";
import { LedgerRow } from "./LedgerRow";
import { ThemeGroupRow } from "./ThemeGroupRow";
import type { OptionMaps } from "./useWpOptionMaps";

interface LedgerTableProps {
  board: BoardModel;
  selected: Set<string>;
  openRun: string | null;
  expanded: ReadonlySet<string>;
  onToggleSelect: (runId: string) => void;
  onToggleAll: () => void;
  onToggleTheme: (batchId: string) => void;
  onToggleChildren: (childIds: string[], select: boolean) => void;
  onOpen: (runId: string) => void;
  personaBySlug: Map<string, Persona>;
  targetById: Map<string, PublishTarget>;
  optionsFor: (persona?: string | null) => OptionMaps;
  loading: boolean;
}

const TH =
  "sticky top-[52px] z-20 whitespace-nowrap border-b border-rule bg-paper px-2.5 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint";

const COL_SPAN = 6;

/**
 * Monday.com-style runs board. Themes (topic batches) headline as collapsible
 * parent rows; their promoted runs nest beneath as indented sub-tasks.
 * Standalone (no-theme) runs render as a flat list below every theme group.
 * Header hides on mobile (rows reflow to cards).
 */
export function LedgerTable({
  board,
  selected,
  openRun,
  expanded,
  onToggleSelect,
  onToggleAll,
  onToggleTheme,
  onToggleChildren,
  onOpen,
  personaBySlug,
  targetById,
  optionsFor,
  loading,
}: LedgerTableProps) {
  const { themes, standalone, visibleRuns } = board;
  const allSelected =
    visibleRuns.length > 0 && visibleRuns.every((r) => selected.has(r.run_id));
  const isEmpty = themes.length === 0 && standalone.length === 0;

  return (
    <div className="mx-auto max-w-[1400px] px-7 pb-[120px] max-md:px-3.5 max-md:pb-[160px]">
      <table className="w-full border-collapse max-md:block">
        <thead className="max-md:hidden">
          <tr>
            <th className={`${TH} w-[34px]`}>
              <input
                type="checkbox"
                checked={allSelected}
                onChange={onToggleAll}
                aria-label="Select all visible"
                className="size-[15px] cursor-pointer accent-accent"
              />
            </th>
            <th className={TH}>Topic &amp; draft</th>
            <th className={`${TH} w-[118px]`}>Voice</th>
            <th className={`${TH} w-[138px]`}>Status</th>
            <th className={`${TH} w-[270px] min-[761px]:max-[1080px]:hidden`}>CMS destination</th>
            <th className={`${TH} w-[118px]`}>Created</th>
          </tr>
        </thead>
        <tbody className="max-md:block">
          {themes.map((group) => {
            const isOpen = expanded.has(group.batch.batch_id);
            return (
              <Fragment key={group.batch.batch_id}>
                <ThemeGroupRow
                  group={group}
                  expanded={isOpen}
                  onToggle={onToggleTheme}
                  selectedChildIds={selected}
                  onToggleChildren={onToggleChildren}
                  colSpan={COL_SPAN}
                />
                {isOpen &&
                  group.children.map((run) => (
                    <LedgerRow
                      key={run.run_id}
                      run={run}
                      nested
                      view={{
                        selected: selected.has(run.run_id),
                        open: openRun === run.run_id,
                        onToggleSelect,
                        onOpen,
                      }}
                      personaBySlug={personaBySlug}
                      targetById={targetById}
                      options={optionsFor(run.persona)}
                    />
                  ))}
              </Fragment>
            );
          })}
          {standalone.map((run) => (
            <LedgerRow
              key={run.run_id}
              run={run}
              view={{
                selected: selected.has(run.run_id),
                open: openRun === run.run_id,
                onToggleSelect,
                onOpen,
              }}
              personaBySlug={personaBySlug}
              targetById={targetById}
              options={optionsFor(run.persona)}
            />
          ))}
        </tbody>
      </table>

      {!loading && isEmpty && (
        <div className="py-16 text-center text-ink-faint">No runs match this filter.</div>
      )}
      {loading && isEmpty && (
        <div className="py-16 text-center text-[13px] text-ink-faint">Loading the ledger…</div>
      )}
    </div>
  );
}

export default LedgerTable;
