"use client";

import { useState } from "react";
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
import type { Hitl2Request, RunSummary } from "@/lib/types";
import { cn } from "@/lib/utils";

import { runBulk, summarizeBulk } from "./bulk";
import type { DrawerPerms } from "./RunDrawer";
import { RUNS_LIST_KEY } from "./useLedgerData";

interface BulkBarProps {
  selectedRuns: RunSummary[];
  perms: DrawerPerms;
  editorEmail: string;
  /** Open the "Set CMS metadata" modal (spec §4.7). */
  onSetMeta: () => void;
  onClear: () => void;
  /** After a fan-out: keep only the failed ids selected for retry (spec §6). */
  onResult: (failedIds: string[]) => void;
}

const PILL_BTN =
  "rounded-md px-2.5 py-1.5 text-[12px] font-semibold text-paper/90 hover:bg-paper/20";

/**
 * Floating bulk-action bar (spec §4.6). Appears bottom-centre while rows are
 * selected. `Approve & publish` only shows when the selection contains drafted
 * runs and acts on those alone; `Restart failed` likewise for failed runs;
 * `Reject` covers both HITL gates. Each action is a client-side bounded fan-out
 * (`runBulk`) over the per-run endpoints — failed runs stay selected for retry.
 */
export function BulkBar({ selectedRuns, perms, editorEmail, onSetMeta, onClear, onResult }: BulkBarProps) {
  const qc = useQueryClient();
  const [confirmPublish, setConfirmPublish] = useState(false);

  const n = selectedRuns.length;
  const drafted = selectedRuns.filter((r) => r.status === "hitl_2");
  const failed = selectedRuns.filter((r) => r.status === "failed");
  // Reject covers both gates, but each needs its own capability: cancelling an
  // outline (hitl_1) is an outline decision, rejecting a draft (hitl_2) a publish
  // decision. Bake the perms in so the button shows for an outline-only reviewer
  // and never fires a reject the user can't perform.
  const rejectable = selectedRuns.filter(
    (r) =>
      (r.status === "hitl_1" && perms.canApproveOutline) ||
      (r.status === "hitl_2" && perms.canPublish),
  );
  const liveCount = drafted.filter((r) => r.wp_publish_status === "publish").length;

  const invalidate = () => void qc.invalidateQueries({ queryKey: RUNS_LIST_KEY });

  const publishBody = (run: RunSummary): Hitl2Request => ({
    decision: "approve",
    editor_email: editorEmail,
    wp_publish_status: run.wp_publish_status ?? "draft",
    wp_author_id: run.wp_author_id ?? null,
    wp_category_ids: run.wp_category_ids ?? null,
    wp_slug: run.wp_slug ?? null,
    comments: [],
  });

  const publishMut = useMutation({
    mutationFn: async () => {
      const byId = new Map(drafted.map((r) => [r.run_id, r]));
      return runBulk(drafted.map((r) => r.run_id), (id) =>
        api.resumeHitl2(id, publishBody(byId.get(id)!)),
      );
    },
    onSuccess: (outcome) => {
      setConfirmPublish(false);
      (outcome.failed.length ? toast.error : toast.success)(summarizeBulk(outcome, "published"));
      invalidate();
      onResult(outcome.failed);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const restartMut = useMutation({
    mutationFn: () => runBulk(failed.map((r) => r.run_id), (id) => api.restartRun(id)),
    onSuccess: (outcome) => {
      (outcome.failed.length ? toast.error : toast.success)(summarizeBulk(outcome, "restarted"));
      invalidate();
      onResult(outcome.failed);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const rejectMut = useMutation({
    mutationFn: () => {
      const byId = new Map(rejectable.map((r) => [r.run_id, r]));
      return runBulk(rejectable.map((r) => r.run_id), (id) => {
        const run = byId.get(id)!;
        return run.status === "hitl_1"
          ? api.resumeHitl1(id, { decision: "cancel" })
          : api.resumeHitl2(id, {
              decision: "reject",
              editor_email: editorEmail,
              wp_publish_status: "draft",
              comments: [],
            });
      });
    },
    onSuccess: (outcome) => {
      (outcome.failed.length ? toast.error : toast.success)(summarizeBulk(outcome, "rejected"));
      invalidate();
      onResult(outcome.failed);
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const busy = publishMut.isPending || restartMut.isPending || rejectMut.isPending;
  if (n === 0) return null;

  return (
    <>
      <div
        role="toolbar"
        aria-label="Bulk actions"
        className="fixed bottom-6 left-1/2 z-[60] flex -translate-x-1/2 items-center gap-1.5 rounded-xl bg-ink px-3 py-2 text-paper shadow-[0_10px_40px_rgba(29,26,22,0.3)] max-md:inset-x-2 max-md:left-auto max-md:translate-x-0 max-md:flex-wrap"
      >
        <span className="mr-1.5 whitespace-nowrap text-[12.5px] font-bold">{n} selected</span>

        {perms.canPatch && (
          <button className={PILL_BTN} disabled={busy} onClick={onSetMeta}>
            Set CMS metadata…
          </button>
        )}
        {perms.canPublish && drafted.length > 0 && (
          <button
            className={cn(PILL_BTN, "bg-accent hover:bg-accent-deep")}
            disabled={busy}
            onClick={() => setConfirmPublish(true)}
          >
            Approve &amp; publish
          </button>
        )}

        <span className="mx-0.5 h-[18px] w-px bg-paper/20" />

        {perms.canRestart && failed.length > 0 && (
          <button className={PILL_BTN} disabled={busy} onClick={() => restartMut.mutate()}>
            Restart failed
          </button>
        )}
        {rejectable.length > 0 && (
          <button className={PILL_BTN} disabled={busy} onClick={() => rejectMut.mutate()}>
            Reject
          </button>
        )}

        <span className="mx-0.5 h-[18px] w-px bg-paper/20" />

        <button className={cn(PILL_BTN, "text-paper/70")} disabled={busy} onClick={onClear}>
          Clear
        </button>
      </div>

      {/* Approve & publish — count-confirm flagging any LIVE target (spec §6). */}
      <Dialog open={confirmPublish} onOpenChange={(o) => !o && setConfirmPublish(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Approve &amp; publish {drafted.length} run{drafted.length === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              {liveCount > 0 ? (
                <>
                  <strong>{liveCount}</strong> of these will publish <strong>LIVE</strong> to their CMS
                  target (publish status “publish”). The rest save as drafts. This approves each draft
                  through HITL_2.
                </>
              ) : (
                <>This approves each selected draft through HITL_2 and pushes it to its CMS target.</>
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <button
              className="rounded-md border border-rule px-3 py-1.5 text-[12.5px] font-semibold text-ink hover:bg-paper-deep"
              onClick={() => setConfirmPublish(false)}
              disabled={publishMut.isPending}
            >
              Cancel
            </button>
            <button
              className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-paper hover:bg-accent-deep disabled:opacity-60"
              onClick={() => publishMut.mutate()}
              disabled={publishMut.isPending}
            >
              {publishMut.isPending ? "Publishing…" : "Confirm"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
