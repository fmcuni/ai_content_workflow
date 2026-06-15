"use client";

import { useMemo, useState } from "react";

import { useRole } from "@/lib/use-role";

import { buildBoard } from "./board";
import { BulkBar } from "./BulkBar";
import { BulkMetadataModal } from "./BulkMetadataModal";
import { LedgerTable } from "./LedgerTable";
import { RunDrawer, type DrawerPerms } from "./RunDrawer";
import { Toolbar } from "./Toolbar";
import { useExpandedThemes } from "./useExpandedThemes";
import { useLedgerData, type LedgerTab, type SortOrder } from "./useLedgerData";
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
  const [creator, setCreator] = useState("");
  const [sort, setSort] = useState<SortOrder>("newest");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [openRun, setOpenRun] = useState<string | null>(null);
  const [bulkOpen, setBulkOpen] = useState(false);

  const { expanded, toggle: toggleTheme } = useExpandedThemes();

  // Board model: themes (topic batches) as parent tasks, their promoted runs
  // nested beneath, standalone runs flat below. `visible` is the flattened run
  // order of everything currently rendered — drives select-all + drawer nav.
  const board = useMemo(
    () => buildBoard(data.runs, data.batches, { tab, voice, creator, search, sort }, expanded),
    [data.runs, data.batches, tab, voice, creator, search, sort, expanded],
  );
  const visible = board.visibleRuns;

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
  // A theme row's checkbox selects / clears all of its child runs at once.
  const toggleChildren = (childIds: string[], select: boolean) =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of childIds) {
        if (select) next.add(id);
        else next.delete(id);
      }
      return next;
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
  // Theme title for the open run's parent batch, resolved from already-loaded
  // batches so the drawer's brief can link back to /topic-batches/{id}.
  const openRunTheme = openRunData?.topic_batch_id
    ? (data.batches.find((b) => b.batch_id === openRunData.topic_batch_id)?.research_theme ?? null)
    : null;

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
        creator={creator}
        onCreator={setCreator}
        creators={data.creators}
        sort={sort}
        onSort={setSort}
      />

      <LedgerTable
        board={board}
        selected={selected}
        openRun={openRun}
        expanded={expanded}
        onToggleSelect={toggleSelect}
        onToggleAll={toggleAll}
        onToggleTheme={toggleTheme}
        onToggleChildren={toggleChildren}
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
          themeTitle={openRunTheme}
          onClose={() => setOpenRun(null)}
          onStep={stepDrawer}
        />
      )}
    </div>
  );
}
