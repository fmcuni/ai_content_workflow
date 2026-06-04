"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

import { api, topicBatchesApi } from "@/lib/api";
import type { BoardRecord } from "@/lib/runs-grid/board-record";
import type { Capability, Role } from "@/lib/roles";
import { hitl2Body } from "@/lib/use-desk-actions";
import type { RunSummary, TopicBatch } from "@/lib/types";

// Phase 4 — frontend fan-out of bulk actions over the EXISTING per-run endpoints.
// No new backend: publish/republish reuse the single-publish path
// (api.resumeHitl2 + hitl2Body / api.republish), so the per-post compliance log
// line is written server-side exactly as a single publish would. Author/category
// assignment reuses the Phase-3 api.patchRun; delete reuses api.deleteRun /
// topicBatchesApi.delete.
//
// The pure core below (action metadata, eligibility, plan, visible-id collection,
// sequential fan-out) is side-effect-free and unit-tested; the hook is a thin
// TanStack-Query wrapper that runs the plan and reports a summary toast.

export type BulkActionKey =
  | "approve"
  | "publish"
  | "republish"
  | "restart"
  | "assign_author"
  | "assign_category"
  | "delete";

export interface BulkActionDef {
  key: BulkActionKey;
  /** Button label in the action bar. */
  label: string;
  /** Capability / minimum role the operator needs (UI gate; server authoritative). */
  need: Role | Capability;
  /** Rendered with the destructive accent + dialog danger styling. */
  danger?: boolean;
  /** Touches a live (public) WordPress post — forces a count-confirmation when live > 0. */
  publishes?: boolean;
  /** Opens a pick dialog for a value before fan-out. */
  picks?: "author" | "category";
}

// Ordered exactly as the demo's bulk bar lays the buttons out.
export const BULK_ACTIONS: readonly BulkActionDef[] = [
  { key: "approve", label: "Approve outline", need: "hitl1_approve" },
  { key: "publish", label: "Publish", need: "publish", publishes: true },
  { key: "republish", label: "Republish", need: "publish", publishes: true },
  { key: "assign_author", label: "Assign author…", need: "editor", picks: "author" },
  { key: "assign_category", label: "Assign category…", need: "editor", picks: "category" },
  { key: "restart", label: "Restart failed", need: "create_run" },
  { key: "delete", label: "Delete", need: "delete_run", danger: true },
];

/**
 * The selected runs eligible for an action, by run status. Status-gated actions
 * (approve/publish/republish/restart) ignore non-matching rows; metadata + delete
 * actions accept every selected run. Ineligible rows are never silently dropped —
 * the caller reports the skipped count via `planRunAction`.
 */
export function eligibleRuns(action: BulkActionKey, runs: readonly RunSummary[]): RunSummary[] {
  switch (action) {
    case "approve":
      return runs.filter((r) => r.status === "hitl_1");
    case "publish":
      return runs.filter((r) => r.status === "hitl_2");
    case "republish":
      return runs.filter((r) => r.status === "persisted" || r.status === "published");
    case "restart":
      return runs.filter((r) => r.status === "failed");
    case "assign_author":
    case "assign_category":
    case "delete":
      return [...runs];
  }
}

export interface BulkPlan {
  /** Selected runs that this action will actually touch. */
  eligible: RunSummary[];
  /** Selected runs skipped because they're ineligible for this action. */
  skipped: number;
  /** Eligible runs that resolve to a live (public) post — drives count-confirmation. */
  live: number;
}

/** Eligibility + skipped-count + live-target count for the action over a selection. */
export function planRunAction(action: BulkActionKey, selectedRuns: readonly RunSummary[]): BulkPlan {
  const eligible = eligibleRuns(action, selectedRuns);
  const live = eligible.filter((r) => r.wp_publish_status === "publish").length;
  return { eligible, skipped: selectedRuns.length - eligible.length, live };
}

/**
 * Run ids the "select all visible" header checkbox covers: every visible run row
 * (top-level runs plus the promoted children of an expanded batch). Batches
 * themselves are selectable independently — they're not run rows, so they're not
 * collected here. `childIdsOf` resolves an expanded batch's promoted run ids.
 */
export function visibleRunIds(
  records: readonly BoardRecord[],
  expanded: ReadonlySet<string>,
  childIdsOf: (batchId: string) => readonly string[],
): string[] {
  const ids: string[] = [];
  for (const rec of records) {
    if (rec.kind === "batch") {
      if (expanded.has(rec.id)) ids.push(...childIdsOf(rec.id));
    } else {
      ids.push(rec.id);
    }
  }
  return [...new Set(ids)];
}

export interface FanOutSummary {
  succeeded: number;
  failed: number;
  /** First error message, surfaced in the summary toast when any row fails. */
  firstError: string | null;
}

/**
 * Run `fn` over `items` strictly sequentially, tracking per-item success/failure.
 * A rejected item never aborts the run — every item is attempted and the failures
 * are aggregated into the summary.
 */
export async function fanOut<T>(
  items: readonly T[],
  fn: (item: T) => Promise<unknown>,
): Promise<FanOutSummary> {
  let succeeded = 0;
  let firstError: string | null = null;
  const errors: string[] = [];
  for (const item of items) {
    try {
      await fn(item);
      succeeded += 1;
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Unknown error";
      if (firstError === null) firstError = message;
      errors.push(message);
    }
  }
  return { succeeded, failed: errors.length, firstError };
}

export interface BulkActionParams {
  authorId?: number;
  categoryIds?: number[];
}

/** The fan-out call for a single eligible run, by action. */
function runCall(
  action: BulkActionKey,
  run: RunSummary,
  params: BulkActionParams,
): Promise<unknown> {
  switch (action) {
    case "approve":
      return api.resumeHitl1(run.run_id, { decision: "approve" });
    case "publish":
      // Reuse the single-publish path so the per-post compliance log is written.
      return api.resumeHitl2(run.run_id, hitl2Body(run, "approve"));
    case "republish":
      return api.republish(run.run_id);
    case "restart":
      return api.restartRun(run.run_id);
    case "assign_author":
      return api.patchRun(run.run_id, { wp_author_id: params.authorId ?? null });
    case "assign_category":
      return api.patchRun(run.run_id, { wp_category_ids: params.categoryIds ?? [] });
    case "delete":
      return api.deleteRun(run.run_id);
  }
}

const VERB: Record<BulkActionKey, string> = {
  approve: "Approved",
  publish: "Published",
  republish: "Republished",
  restart: "Restarted",
  assign_author: "Updated author on",
  assign_category: "Updated category on",
  delete: "Removed",
};

export interface BulkExecuteVars {
  action: BulkActionKey;
  /** Eligible runs to act on (already filtered + confirmed by the caller). */
  runs: readonly RunSummary[];
  /** Batches to delete (delete action only). */
  batches?: readonly TopicBatch[];
  params?: BulkActionParams;
}

export interface UseBulkActionsResult {
  execute: (vars: BulkExecuteVars) => void;
  pendingAction: BulkActionKey | null;
  isPending: boolean;
}

export function useBulkActions(): UseBulkActionsResult {
  const queryClient = useQueryClient();

  const mutation = useMutation<FanOutSummary, Error, BulkExecuteVars>({
    mutationFn: async ({ action, runs, batches, params }) => {
      const runResult = await fanOut(runs, (r) => runCall(action, r, params ?? {}));
      if (action === "delete" && batches && batches.length > 0) {
        const batchResult = await fanOut(batches, (b) => topicBatchesApi.delete(b.batch_id));
        return {
          succeeded: runResult.succeeded + batchResult.succeeded,
          failed: runResult.failed + batchResult.failed,
          firstError: runResult.firstError ?? batchResult.firstError,
        };
      }
      return runResult;
    },
    onSuccess: (summary, { action }) => {
      const headline = `${VERB[action]} ${summary.succeeded}`;
      if (summary.failed > 0) {
        toast.error(`${headline} · ${summary.failed} failed — ${summary.firstError ?? ""}`.trim());
      } else {
        toast.success(headline);
      }
    },
    onError: (error, { action }) => toast.error(`Couldn't ${action.replace(/_/g, " ")} — ${error.message}`),
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      void queryClient.invalidateQueries({ queryKey: ["topic-batches"] });
    },
  });

  const { mutate } = mutation;
  const execute = useCallback((vars: BulkExecuteVars) => mutate(vars), [mutate]);

  return {
    execute,
    pendingAction: mutation.isPending ? mutation.variables?.action ?? null : null,
    isPending: mutation.isPending,
  };
}
