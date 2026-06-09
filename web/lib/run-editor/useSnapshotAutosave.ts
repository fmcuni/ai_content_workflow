"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { isBlankBody, snapshotInFromSaved, snapshotKey } from "@/lib/run-editor/form";
import type { Hitl2Snapshot, Hitl2SnapshotIn, Hitl2SnapshotTrigger } from "@/lib/types";

const AUTOSAVE_INTERVAL_MS = 5 * 60 * 1000;

export type SaveState = "idle" | "saving" | "saved" | "error";

interface UseSnapshotAutosaveArgs {
  runId: string;
  /** Gates baseline init + hydration until the render (the editor seed) loaded. */
  ready: boolean;
  /** Live editor state as a snapshot DTO (memoized by the caller). */
  snapshotIn: Hitl2SnapshotIn;
  /** Clean baseline key for dirty-tracking (memoized by caller; null until ready). */
  baselineKey: string | null;
  /** Latest editor email, for the audit trail on saved snapshots. */
  editorEmailRef: { readonly current: string };
  /** True once a terminal action (decision / re-push) fired — skips the exit save. */
  submittedRef: { readonly current: boolean };
  /** Open the editor at the most recent saved snapshot on load (resume). */
  hydrateEnabled: boolean;
  /** Set to true by the hook once hydrated, so the caller's seed effect can defer. */
  hydratedFromSnapshotRef: { current: boolean };
  /** Apply a restored / hydrated snapshot to the caller's editor state. */
  onHydrate: (snapshot: Hitl2Snapshot) => void;
  /** When true, the run body is owned by the live collab doc (RunDoc DO), so the
   *  snapshot autosave must NOT persist body writes — flatten-on-event lands in
   *  Phase 3. Defaults false (the current string-snapshot behaviour). */
  collabActive?: boolean;
}

export interface SnapshotAutosave {
  saveState: SaveState;
  savedAt: Date | null;
  isDirty: boolean;
  saveStatusLabel: string;
  saveSnapshot: (trigger: Hitl2SnapshotTrigger) => Promise<"saved" | "unchanged" | "error">;
  handleManualSave: () => Promise<void>;
}

/**
 * Snapshot-based autosave + dirty tracking + version hydration, shared by the
 * run-editor gates (/hitl2, /edit). Extracted verbatim from the HITL_2 page so
 * both pages behave identically: a 5-minute interval save, a flush on
 * client-side navigation / unmount, a `pagehide` beacon for tab-close, and an
 * on-load hydration from the most recent saved snapshot. Each caller supplies
 * its own live `snapshotIn`, clean `baselineKey`, and `onHydrate` applier.
 */
export function useSnapshotAutosave({
  runId,
  ready,
  snapshotIn,
  baselineKey,
  editorEmailRef,
  submittedRef,
  hydrateEnabled,
  hydratedFromSnapshotRef,
  onHydrate,
  collabActive = false,
}: UseSnapshotAutosaveArgs): SnapshotAutosave {
  const qc = useQueryClient();
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  const currentKey = useMemo(() => snapshotKey(snapshotIn), [snapshotIn]);

  // `lastSavedKey` drives the dirty indicator (state, read during render);
  // `lastSavedKeyRef` mirrors it for the unmount / pagehide handlers that run
  // outside render and must see the latest value without re-subscribing.
  const [lastSavedKey, setLastSavedKey] = useState<string | null>(null);
  const lastSavedKeyRef = useRef<string | null>(null);
  const snapshotRef = useRef(snapshotIn);
  const hydrationDoneRef = useRef(false);

  useEffect(() => {
    snapshotRef.current = snapshotIn;
  });
  useEffect(() => {
    lastSavedKeyRef.current = lastSavedKey;
  }, [lastSavedKey]);
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (baselineKey != null && lastSavedKey == null) setLastSavedKey(baselineKey);
  }, [baselineKey, lastSavedKey]);

  const isDirty = lastSavedKey != null && currentKey !== lastSavedKey;

  const saveSnapshot = useCallback(
    async (trigger: Hitl2SnapshotTrigger): Promise<"saved" | "unchanged" | "error"> => {
      // Under live collab the RunDoc DO owns the body; the string-snapshot
      // autosave is fully gated (the whole snapshot, not just the body — KISS).
      // Metadata-only persistence under collab is a Phase 3 concern. The
      // interval / navigate effects call this and so no-op automatically.
      if (collabActive) return "unchanged";
      if (submittedRef.current || lastSavedKeyRef.current == null) return "unchanged";
      const snap = snapshotRef.current;
      // Never persist a blank body — TipTap reports empty mid-teardown, and a
      // blank save would overwrite good work and reload to an empty editor.
      if (isBlankBody(snap.html_body)) return "unchanged";
      const key = snapshotKey(snap);
      if (key === lastSavedKeyRef.current) return "unchanged"; // nothing changed
      try {
        setSaveState("saving");
        await api.saveHitl2Snapshot(runId, {
          ...snap,
          trigger,
          editor_email: editorEmailRef.current,
        });
        lastSavedKeyRef.current = key;
        setLastSavedKey(key);
        setSavedAt(new Date());
        setSaveState("saved");
        qc.invalidateQueries({ queryKey: ["hitl2-snapshots", runId] });
        return "saved";
      } catch {
        setSaveState("error");
        return "error";
      }
    },
    [runId, qc, editorEmailRef, submittedRef, collabActive],
  );

  const handleManualSave = useCallback(async () => {
    const result = await saveSnapshot("manual");
    if (result === "saved") toast.success("Saved version");
    else if (result === "error") toast.error("Couldn't save — try again");
    else toast("Already up to date");
  }, [saveSnapshot]);

  // Every 5 minutes, persist a snapshot if anything changed.
  useEffect(() => {
    const id = setInterval(() => void saveSnapshot("interval"), AUTOSAVE_INTERVAL_MS);
    return () => clearInterval(id);
  }, [saveSnapshot]);

  // Leaving the page — client-side nav, link click, or unmount — flushes a save.
  useEffect(() => () => void saveSnapshot("navigate"), [saveSnapshot]);

  // Tab close / reload: an awaited fetch would be cancelled, so beacon instead.
  useEffect(() => {
    const handler = () => {
      // Collab body is owned by the RunDoc DO — no beacon write (see saveSnapshot).
      if (collabActive) return;
      if (submittedRef.current || lastSavedKeyRef.current == null) return;
      const snap = snapshotRef.current;
      if (isBlankBody(snap.html_body)) return;
      if (snapshotKey(snap) === lastSavedKeyRef.current) return;
      api.beaconHitl2Snapshot(runId, {
        ...snap,
        trigger: "unload",
        editor_email: editorEmailRef.current,
      });
    };
    window.addEventListener("pagehide", handler);
    return () => window.removeEventListener("pagehide", handler);
  }, [runId, editorEmailRef, submittedRef, collabActive]);

  // On load, reopen the editor at the most recent saved snapshot (autosave or
  // manual) rather than the pristine render, and treat it as the clean baseline.
  useEffect(() => {
    if (!hydrateEnabled || hydrationDoneRef.current || !ready) return;
    let cancelled = false;
    void (async () => {
      // Pull a FRESH list, not the reactive cache: returning via client-side nav
      // would otherwise hydrate from a stale cache that predates the navigate-away
      // autosave, loading an older version.
      const list = await qc.fetchQuery({
        queryKey: ["hitl2-snapshots", runId],
        queryFn: () => api.listHitl2Snapshots(runId),
        staleTime: 0,
      });
      // Mark done only after the fetch resolves so StrictMode's double-invoke
      // (which cancels the first pass) doesn't leave hydration permanently skipped.
      if (cancelled || hydrationDoneRef.current) return;
      hydrationDoneRef.current = true;
      // Skip any blank-body rows left by the teardown bug; load the newest real save.
      const latest = list.find((s) => !isBlankBody(s.html_body));
      if (!latest) return;
      hydratedFromSnapshotRef.current = true;
      onHydrate(latest);
      const key = snapshotKey(snapshotInFromSaved(latest));
      lastSavedKeyRef.current = key;
      setLastSavedKey(key);
      setSavedAt(new Date(latest.created_at));
      setSaveState("saved");
    })();
    return () => {
      cancelled = true;
    };
  }, [ready, runId, qc, hydrateEnabled, hydratedFromSnapshotRef, onHydrate]);

  const saveStatusLabel =
    saveState === "saving"
      ? "Saving…"
      : saveState === "error"
      ? "Autosave failed"
      : isDirty
      ? "Unsaved changes"
      : savedAt
      ? `Saved ${savedAt.toLocaleTimeString()}`
      : "Autosave on";

  return { saveState, savedAt, isDirty, saveStatusLabel, saveSnapshot, handleManualSave };
}
