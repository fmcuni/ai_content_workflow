"use client";

import { useMemo, useState } from "react";

import { useRole } from "@/lib/use-role";

import { BulkBar } from "./BulkBar";
import { BulkMetadataModal } from "./BulkMetadataModal";
import { LedgerTable } from "./LedgerTable";
import { RunDrawer, type DrawerPerms } from "./RunDrawer";
import { Toolbar } from "./Toolbar";
import {
  filterAndSortRuns,
  useLedgerData,
  type LedgerTab,
  type SortOrder,
} from "./useLedgerData";
import { useWpOptionMaps } from "./useWpOptionMaps";

/**
 * Top-level `/runs` ledger (spec §4). Owns the view state (tab/search/voice/sort/
 * selection/open drawer) and composes the toolbar, dense table, bulk bar, run
 * drawer and bulk-metadata modal. All data flows from `useLedgerData`; row
 * destination names resolve through one `useWpOptionMaps` pass; every action
 * hits an existing per-run endpoint (no new backend surface). Defaults to the
 * `drafted` tab — the operator's main work queue.
 */
export function RunsLedger() {
  const { can, email: roleEmail } = useRole();
  const email = roleEmail ?? "";
  const data = useLedgerData();

  const [tab, setTab] = useState<LedgerTab>("drafted");
  const [search, setSearch] = useState("");
  const [voice, setVoice] = useState("");
  const [sort, setSort] = useState<SortOrder>("newest");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const visible = useMemo(
    () => filterAndSortRuns(data.runs, { tab, voice, search, sort }),
    [data.runs, tab, voice, search, sort],
  );

  // One option-map pass over every voice present, so rows show destination names
  // without each firing its own wp-options fetch.
  const distinctPersonas = useMemo(
    () => Array.from(new Set(data.runs.map((r) => r.persona ?? ""))),
    [data.runs],
  );
  const maps = useWpOptionMaps(distinctPersonas);

  const perms: DrawerPerms = {
    canEditMeta: can("save_snapshot"), // author
    canPatch: can("hitl2_decide"), // reviewer — destination PATCH
    canPublish: can("publish"), // reviewer
    canApproveOutline: can("hitl1_approve"), // reviewer
    canRestart: can("create_run"), // author
    canRepublish: can("publish"), // reviewer
  };

  const selectedRuns = useMemo(
    () => data.runs.filter((r) => selected.has(r.run_id)),
    [data.runs, selected],
  );

  // Selection is scoped to the visible tab (demo parity) — switching tabs clears
  // it so a bulk action never touches a hidden run.
  const changeTab = (t: LedgerTab) => {
    setTab(t);
    setSelected(new Set());
  };
  const toggleSelect = (runId: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(runId)) next.delete(runId);
      else next.add(runId);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) => {
      const allOn = visible.length > 0 && visible.every((r) => prev.has(r.run_id));
      return allOn ? new Set() : new Set(visible.map((r) => r.run_id));
    });

  // Step the open drawer through the visible list (j/k / ↑↓), clamped to bounds.
  const stepDrawer = (delta: number) => {
    if (!openRun) return;
    const i = visible.findIndex((r) => r.run_id === openRun);
    if (i < 0) return;
    const next = visible[i + delta];
    if (next) setOpenRun(next.run_id);
  };

  const openRunData = openRun ? (data.runs.find((r) => r.run_id === openRun) ?? null) : null;

  return (
    <div className="pb-20">
      <header className="mx-auto flex max-w-[1400px] items-end justify-between gap-4 px-7 pb-3 pt-7 max-md:px-3.5">
        <div>
          <h1 className="font-display text-[26px] font-semibold leading-tight text-ink">Runs</h1>
          <p className="mt-1 max-w-[640px] text-[13px] leading-relaxed text-ink-soft">
            Every rewrite and new article in one ledger. Click a row to review and set its CMS
            destination — select several to act in bulk.
          </p>
        </div>
      </header>

      <Toolbar
        tab={tab}
        onTab={changeTab}
        counts={data.counts}
        search={search}
        onSearch={setSearch}
        voice={voice}
        onVoice={setVoice}
        voices={data.voices}
        sort={sort}
        onSort={setSort}
      />

      <LedgerTable
        runs={visible}
        selected={selected}
        openRun={openRun}
        onToggleSelect={toggleSelect}
        onToggleAll={toggleAll}
        onOpen={setOpenRun}
        personaBySlug={data.personaBySlug}
        targetById={data.targetById}
        optionsFor={maps.get}
        loading={data.isLoading}
      />

      <BulkBar
        selectedRuns={selectedRuns}
        perms={perms}
        editorEmail={email}
        onSetMeta={() => setBulkOpen(true)}
        onClear={() => setSelected(new Set())}
        onResult={(failed) => setSelected(new Set(failed))}
      />

      <BulkMetadataModal
        open={bulkOpen}
        onClose={() => setBulkOpen(false)}
        selectedRuns={selectedRuns}
        personaBySlug={data.personaBySlug}
        targetById={data.targetById}
        canPatch={perms.canPatch}
        onApplied={(failed) => setSelected(new Set(failed))}
      />

      {openRunData && (
        <RunDrawer
          key={openRun}
          run={openRunData}
          personaBySlug={data.personaBySlug}
          targetById={data.targetById}
          editorEmail={email}
          perms={perms}
          onClose={() => setOpenRun(null)}
          onStep={stepDrawer}
        />
      )}
    </div>
  );
}
