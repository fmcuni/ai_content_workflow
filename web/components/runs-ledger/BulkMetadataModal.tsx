"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { useWpCategoriesForPersona, useWpUsersForPersona } from "@/lib/use-wp-options";
import type { Persona, PublishTarget, RunSummary, RunWpMetaPatch } from "@/lib/types";

import { runBulk, summarizeBulk } from "./bulk";
import { CmsCombobox } from "./CmsCombobox";
import { resolveTarget } from "./fmt";
import { RUNS_LIST_KEY } from "./useLedgerData";

interface BulkMetadataModalProps {
  open: boolean;
  onClose: () => void;
  selectedRuns: RunSummary[];
  personaBySlug: Map<string, Persona>;
  targetById: Map<string, PublishTarget>;
  canPatch: boolean;
  /** After applying: keep only failed ids selected for retry (spec §6). */
  onApplied: (failedIds: string[]) => void;
}

const FIELD_LABEL = "text-[10.5px] font-semibold uppercase tracking-wide text-ink-faint";
const INPUT =
  "w-full rounded-md border border-rule bg-paper px-2 py-1.5 text-[12.5px] text-ink focus:border-accent focus:outline-2 focus:outline-accent/25 disabled:opacity-50";

/**
 * Bulk "Set CMS metadata" modal (spec §4.7). Author/Category options are scoped
 * to the selection's single shared voice (their CMS ids are target-specific); if
 * the selection spans more than one voice, those two fields are disabled and
 * only publish status/date can be set across the mixed batch. Blank fields are
 * left untouched. Apply fans out a PATCH per run; failed runs stay selected.
 */
export function BulkMetadataModal({
  open,
  onClose,
  selectedRuns,
  personaBySlug,
  targetById,
  canPatch,
  onApplied,
}: BulkMetadataModalProps) {
  const qc = useQueryClient();

  const personas = useMemo(
    () => Array.from(new Set(selectedRuns.map((r) => r.persona ?? ""))),
    [selectedRuns],
  );
  const multiPersona = personas.length > 1;
  const sharedPersona = personas.length === 1 ? personas[0] : "";
  const tag = sharedPersona
    ? resolveTarget({ persona: sharedPersona }, personaBySlug, targetById).tag
    : "WP";

  const users = useWpUsersForPersona(sharedPersona || undefined);
  const categories = useWpCategoriesForPersona(sharedPersona || undefined);

  const [authorId, setAuthorId] = useState<number | null>(null);
  const [categoryId, setCategoryId] = useState<number | null>(null);
  const [pubStatus, setPubStatus] = useState<"" | "draft" | "publish" | "future">("");
  const [pubDate, setPubDate] = useState("");

  // Reset the form on each open transition (closed → open). Tracking the prior
  // open flag in state is React's "adjust state during render on prop change"
  // pattern — an effect that setStates trips react-hooks/set-state-in-effect.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setAuthorId(null);
      setCategoryId(null);
      setPubStatus("");
      setPubDate("");
    }
  }

  const buildPatch = (): RunWpMetaPatch | null => {
    const patch: RunWpMetaPatch = {};
    if (!multiPersona && authorId != null) patch.wp_author_id = authorId;
    if (!multiPersona && categoryId != null) patch.wp_category_ids = [categoryId];
    if (pubStatus) patch.wp_publish_status = pubStatus;
    if (pubStatus === "future" && pubDate) patch.wp_publish_at = `${pubDate}T00:00:00Z`;
    return Object.keys(patch).length ? patch : null;
  };

  const apply = useMutation({
    mutationFn: () => {
      const patch = buildPatch();
      if (!patch) return Promise.reject(new Error("Nothing to apply — set at least one field."));
      return runBulk(selectedRuns.map((r) => r.run_id), (id) => api.patchRun(id, patch));
    },
    onSuccess: (outcome) => {
      (outcome.failed.length ? toast.error : toast.success)(summarizeBulk(outcome, "updated"));
      void qc.invalidateQueries({ queryKey: RUNS_LIST_KEY });
      onApplied(outcome.failed);
      onClose();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Set CMS metadata</DialogTitle>
          <DialogDescription>
            Applies to {selectedRuns.length} selected run{selectedRuns.length === 1 ? "" : "s"}. Blank
            fields are left untouched.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-2 gap-x-3 gap-y-2.5">
          <div className="flex flex-col gap-1">
            <label htmlFor="bm-author" className={FIELD_LABEL}>
              Author
            </label>
            <CmsCombobox
              inputId="bm-author"
              value={authorId}
              onChange={setAuthorId}
              options={users.data ?? []}
              tag={tag}
              loading={users.isLoading}
              error={users.isError ? "error" : null}
              onRetry={() => void users.refetch()}
              disabled={!canPatch || multiPersona}
              placeholder="Search author…"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="bm-category" className={FIELD_LABEL}>
              Category
            </label>
            <CmsCombobox
              inputId="bm-category"
              value={categoryId}
              onChange={setCategoryId}
              options={categories.data ?? []}
              tag={tag}
              loading={categories.isLoading}
              error={categories.isError ? "error" : null}
              onRetry={() => void categories.refetch()}
              disabled={!canPatch || multiPersona}
              placeholder="Search category…"
            />
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="bm-pubstatus" className={FIELD_LABEL}>
              Publish status
            </label>
            <select
              id="bm-pubstatus"
              value={pubStatus}
              disabled={!canPatch}
              onChange={(e) => setPubStatus(e.target.value as typeof pubStatus)}
              className={INPUT}
            >
              <option value="">— leave as is</option>
              <option value="draft">draft</option>
              <option value="publish">publish</option>
              <option value="future">future (scheduled)</option>
            </select>
          </div>

          <div className="flex flex-col gap-1">
            <label htmlFor="bm-pubdate" className={FIELD_LABEL}>
              Publish date
            </label>
            <input
              id="bm-pubdate"
              type="date"
              value={pubDate}
              disabled={!canPatch}
              onChange={(e) => setPubDate(e.target.value)}
              className={INPUT}
            />
          </div>
        </div>

        <p className="mt-2 text-[11px] leading-relaxed text-ink-faint">
          {multiPersona
            ? "Selection spans more than one voice — author and category are voice-specific, so only publish status/date apply here."
            : "Slug, SEO title and meta description stay per-run — edit those in the run drawer. Author/category options come from the voice’s CMS target."}
        </p>

        <DialogFooter>
          <button
            className="rounded-md border border-rule px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-paper-deep"
            onClick={onClose}
            disabled={apply.isPending}
          >
            Cancel
          </button>
          <button
            className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-paper hover:bg-accent-deep disabled:opacity-60"
            onClick={() => apply.mutate()}
            disabled={apply.isPending || !canPatch}
          >
            {apply.isPending ? "Applying…" : "Apply to selection"}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
