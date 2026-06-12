"use client";

import type { Persona, PublishTarget, RunSummary } from "@/lib/types";

import { LedgerRow } from "./LedgerRow";
import type { OptionMaps } from "./useWpOptionMaps";

interface LedgerTableProps {
  runs: RunSummary[];
  selected: Set<string>;
  openRun: string | null;
  onToggleSelect: (runId: string) => void;
  onToggleAll: () => void;
  onOpen: (runId: string) => void;
  personaBySlug: Map<string, Persona>;
  targetById: Map<string, PublishTarget>;
  optionsFor: (persona: string | null | undefined) => OptionMaps;
  loading: boolean;
}

const TH =
  "sticky top-[52px] z-20 whitespace-nowrap border-b border-rule bg-paper px-2.5 py-2 text-left text-[10.5px] font-semibold uppercase tracking-wider text-ink-faint";

/** Dense ledger table (spec §4.4). Header hides on mobile (rows become cards). */
export function LedgerTable({
  runs,
  selected,
  openRun,
  onToggleSelect,
  onToggleAll,
  onOpen,
  personaBySlug,
  targetById,
  optionsFor,
  loading,
}: LedgerTableProps) {
  const allSelected = runs.length > 0 && runs.every((r) => selected.has(r.run_id));

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
          {runs.map((run) => (
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

      {!loading && runs.length === 0 && (
        <div className="py-16 text-center text-ink-faint">No runs match this filter.</div>
      )}
      {loading && runs.length === 0 && (
        <div className="py-16 text-center text-[13px] text-ink-faint">Loading the ledger…</div>
      )}
    </div>
  );
}
