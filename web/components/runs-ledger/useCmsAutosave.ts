"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { RunSummary, RunWpMetaPatch } from "@/lib/types";

import { RUNS_LIST_KEY } from "./useLedgerData";

const DEBOUNCE_MS = 600;

// The CMS-destination fields the drawer edits. SEO title + meta description ride
// the snapshot path (so they version with the draft); the rest ride PATCH.
export interface CmsFormValues {
  seoTitle: string;
  metaDesc: string;
  authorId: number | null;
  categoryId: number | null;
  slug: string;
  pubStatus: "" | "draft" | "publish" | "future";
  pubDate: string; // yyyy-mm-dd (input[type=date]); "" = unset
  // Ghost-destination metadata (kind='ghost' runs) — ride the PATCH path.
  ghostAuthorIds: string[] | null;
  ghostTags: string[] | null;
  // Feature image URL (Ghost) — rides the PATCH path; "" serializes to null.
  featureImageUrl: string | null;
}

type FieldKey = keyof CmsFormValues;

export interface CmsAutosave {
  values: CmsFormValues;
  /** Field keys flashing amber because a save is in flight / just landed. */
  dirty: Set<FieldKey>;
  setField: <K extends FieldKey>(key: K, value: CmsFormValues[K]) => void;
  /**
   * Latest draft body baseline (newest snapshot, else latest render) — preserved
   * on a SEO/meta snapshot AND carried as `edited_html_body` on approve-publish
   * so the drawer's quick edit doesn't drop the body. Null until loaded.
   */
  body: { html_body: string; committed: string } | null;
}

function initialFrom(run: RunSummary): CmsFormValues {
  return {
    seoTitle: run.seo_title ?? "",
    metaDesc: run.meta_description ?? "",
    authorId: run.wp_author_id ?? null,
    categoryId: run.wp_category_ids?.[0] ?? null,
    slug: run.wp_slug ?? "",
    pubStatus: (run.wp_publish_status as CmsFormValues["pubStatus"]) ?? "",
    pubDate: run.wp_publish_at ? run.wp_publish_at.slice(0, 10) : "",
    ghostAuthorIds: run.ghost_author_ids ?? null,
    ghostTags: run.ghost_tags ?? null,
    featureImageUrl: run.feature_image_url ?? null,
  };
}

/**
 * Drawer CMS-metadata autosave (spec §6). Holds the form values and debounces
 * two independent saves:
 *  - SEO title / meta description → `POST /runs/:id/hitl2-snapshots`, preserving
 *    the latest draft body (so it versions like the full editor's autosave).
 *  - author / category / slug / publish status+date → `PATCH /runs/:id`.
 * Each field briefly flashes "dirty". Failures toast and keep the field dirty.
 * `canEditMeta` (author) and `canPatch` (reviewer) gate the two paths.
 */
export function useCmsAutosave(
  run: RunSummary,
  editorEmail: string,
  perms: { canEditMeta: boolean; canPatch: boolean },
): CmsAutosave {
  const qc = useQueryClient();
  const runId = run.run_id;

  const [values, setValues] = useState<CmsFormValues>(() => initialFrom(run));
  const [dirty, setDirty] = useState<Set<FieldKey>>(new Set());

  // Re-seed when the drawer switches to a different run. Tracking the previous
  // run id in state (not a ref) is React's sanctioned "adjust state on prop
  // change during render" pattern — a ref write here trips react-hooks/refs.
  const [seededFor, setSeededFor] = useState(runId);
  if (seededFor !== runId) {
    setSeededFor(runId);
    setValues(initialFrom(run));
    setDirty(new Set());
  }

  // Latest draft body to preserve on a SEO/meta snapshot — newest snapshot wins,
  // else the latest render. Only fetched for drafted runs (where meta is editable).
  const bodyQuery = useQuery({
    queryKey: ["run-body-baseline", runId],
    enabled: perms.canEditMeta && run.status === "hitl_2",
    queryFn: async () => {
      const snaps = await api.listHitl2Snapshots(runId).catch(() => []);
      const current = snaps.find((s) => s.is_current) ?? snaps[0];
      if (current?.html_body) {
        return { html_body: current.html_body, committed: current.committed_html_body ?? current.html_body };
      }
      const render = await api.getLatestRender(runId).catch(() => null);
      if (render?.html_body) return { html_body: render.html_body, committed: render.html_body };
      return null;
    },
    staleTime: 60_000,
  });

  const clearDirty = useCallback((keys: FieldKey[]) => {
    setDirty((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.delete(k);
      return next;
    });
  }, []);

  const snapshotMut = useMutation({
    mutationFn: (vals: CmsFormValues) => {
      const body = bodyQuery.data;
      return api.saveHitl2Snapshot(runId, {
        trigger: "manual",
        editor_email: editorEmail,
        html_body: body?.html_body ?? "",
        committed_html_body: body?.committed ?? body?.html_body ?? "",
        seo_title: vals.seoTitle || null,
        meta_description: vals.metaDesc || null,
      });
    },
    onSuccess: () => {
      clearDirty(["seoTitle", "metaDesc"]);
      void qc.invalidateQueries({ queryKey: RUNS_LIST_KEY });
    },
    onError: (e: Error) => toast.error(`Couldn't save SEO fields — ${e.message}`),
  });

  const patchMut = useMutation({
    mutationFn: (patch: RunWpMetaPatch) => api.patchRun(runId, patch),
    onSuccess: (_d, patch) => {
      clearDirty(Object.keys(patch) as FieldKey[]);
      void qc.invalidateQueries({ queryKey: RUNS_LIST_KEY });
    },
    onError: (e: Error) => {
      const msg = e.message.includes("stale_version")
        ? "This run changed since you loaded it — reloading the latest."
        : `Couldn't save metadata — ${e.message}`;
      toast.error(msg);
      void qc.invalidateQueries({ queryKey: RUNS_LIST_KEY });
    },
  });

  // Debounce timers keyed by which save path the field belongs to.
  const metaTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const patchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror the latest values into a ref so the debounced timers read fresh data
  // without re-arming on every keystroke. Synced in an effect (not during
  // render) per react-hooks/refs.
  const valuesRef = useRef(values);
  useEffect(() => {
    valuesRef.current = values;
  }, [values]);

  const META_FIELDS: FieldKey[] = useMemo(() => ["seoTitle", "metaDesc"], []);

  const buildPatch = useCallback((v: CmsFormValues): RunWpMetaPatch => ({
    wp_author_id: v.authorId,
    wp_category_ids: v.categoryId != null ? [v.categoryId] : null,
    wp_slug: v.slug || null,
    wp_publish_status: v.pubStatus || null,
    wp_publish_at: v.pubStatus === "future" && v.pubDate ? `${v.pubDate}T00:00:00Z` : null,
    // ALWAYS send an array (never null) so the drawer can clear Ghost tags: the
    // backend COALESCE treats `[]` as "clear" and a populated array as "set".
    ghost_author_ids: v.ghostAuthorIds ?? [],
    ghost_tags: v.ghostTags ?? [],
    // Empty string ⇒ null (mirrors the edit page's `value || null` treatment).
    feature_image_url: v.featureImageUrl || null,
  }), []);

  const setField = useCallback(
    <K extends FieldKey>(key: K, value: CmsFormValues[K]) => {
      setValues((prev) => ({ ...prev, [key]: value }));
      setDirty((prev) => new Set(prev).add(key));
      const isMeta = META_FIELDS.includes(key);
      if (isMeta) {
        if (!perms.canEditMeta) return;
        if (metaTimer.current) clearTimeout(metaTimer.current);
        metaTimer.current = setTimeout(() => snapshotMut.mutate(valuesRef.current), DEBOUNCE_MS);
      } else {
        if (!perms.canPatch) return;
        if (patchTimer.current) clearTimeout(patchTimer.current);
        patchTimer.current = setTimeout(() => patchMut.mutate(buildPatch(valuesRef.current)), DEBOUNCE_MS);
      }
    },
    [META_FIELDS, perms.canEditMeta, perms.canPatch, snapshotMut, patchMut, buildPatch],
  );

  // Flush pending debounces on unmount / run switch so a fast close still saves.
  useEffect(() => {
    return () => {
      if (metaTimer.current) clearTimeout(metaTimer.current);
      if (patchTimer.current) clearTimeout(patchTimer.current);
    };
  }, [runId]);

  return { values, dirty, setField, body: bodyQuery.data ?? null };
}
