"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

import { api } from "@/lib/api";
import { encodeSlug } from "@/lib/runs-grid/slug";
import type { Render, RunSummary, RunWpMetaPatch } from "@/lib/types";

// Inline edit of a run's destination / brief fields from the Ledger board.
// Optimistically patches the ["runs"] cache (which also feeds the batch-children
// nesting, since those rows are mapped from it), rolls back on failure, and
// surfaces a distinct toast when the server rejects a stale `expected_version`.
//
// Optimistic concurrency is wired automatically: when the run's render is cached
// (it is once a row is expanded, under ["run-render", runId]), its version is
// sent as `expected_version` so a concurrent edit is caught with a 409. A
// collapsed row with no cached render sends none → last-write-wins, matching the
// backend contract.

const RUNS_KEY = ["runs"] as const;

/** True when an `http()` error carries a 409 status (its message is `409: …`). */
function isConflict(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("409");
}

/** Apply a patch to a run row for the optimistic cache update (null = skip). */
function applyPatch(run: RunSummary, body: RunWpMetaPatch): RunSummary {
  const next: RunSummary = { ...run };
  if (body.acf_adv_id != null) next.acf_adv_id = body.acf_adv_id;
  if (body.acf_widget_id != null) next.acf_widget_id = body.acf_widget_id;
  if (body.wp_author_id != null) next.wp_author_id = body.wp_author_id;
  if (body.wp_category_ids != null) next.wp_category_ids = body.wp_category_ids;
  // Store the canonical encoded slug so the grid's decodeSlug shows decoded.
  if (body.wp_slug != null) next.wp_slug = encodeSlug(body.wp_slug);
  if (body.wp_publish_status != null) next.wp_publish_status = body.wp_publish_status;
  if (body.wp_publish_at != null) next.wp_publish_at = body.wp_publish_at;
  return next;
}

export interface RunPatchVars {
  runId: string;
  /** Fields to change (slug accepts decoded or encoded — canonicalized server-side). */
  body: RunWpMetaPatch;
}

interface RunPatchContext {
  previous: RunSummary[] | undefined;
}

export interface UseRunPatchResult {
  patch: (runId: string, body: RunWpMetaPatch) => void;
  pendingRunId: string | null;
  isPending: boolean;
}

export function useRunPatch(): UseRunPatchResult {
  const queryClient = useQueryClient();

  const mutation = useMutation<{ ok: boolean; version: number | null }, Error, RunPatchVars, RunPatchContext>({
    mutationFn: ({ runId, body }) => {
      // Attach the cached render version (when the row was expanded) so the
      // server can detect a concurrent edit. Omit when unknown.
      const render = queryClient.getQueryData<Render>(["run-render", runId]);
      const withVersion: RunWpMetaPatch =
        body.expected_version === undefined && render?.version !== undefined
          ? { ...body, expected_version: render.version }
          : body;
      return api.patchRun(runId, withVersion);
    },
    onMutate: async ({ runId, body }) => {
      await queryClient.cancelQueries({ queryKey: RUNS_KEY });
      const previous = queryClient.getQueryData<RunSummary[]>(RUNS_KEY);
      queryClient.setQueryData<RunSummary[]>(RUNS_KEY, (old) =>
        old?.map((r) => (r.run_id === runId ? applyPatch(r, body) : r)),
      );
      return { previous };
    },
    onError: (error, _vars, context) => {
      if (context?.previous) {
        queryClient.setQueryData(RUNS_KEY, context.previous);
      }
      if (isConflict(error)) {
        toast.error("This run changed since you loaded it — reloading the latest.");
      } else {
        toast.error(`Couldn't save — ${error.message}`);
      }
    },
    onSuccess: (data, { runId }) => {
      // Keep the cached render version fresh so a second edit of the same
      // expanded row doesn't send a now-stale token and 409 against itself.
      if (data.version != null) {
        queryClient.setQueryData<Render>(["run-render", runId], (old) =>
          old ? { ...old, version: data.version ?? old.version } : old,
        );
      }
    },
    onSettled: (_data, error, { runId }) => {
      void queryClient.invalidateQueries({ queryKey: RUNS_KEY });
      // On conflict, pull the authoritative render (and its version) back.
      if (error && isConflict(error)) {
        void queryClient.invalidateQueries({ queryKey: ["run-render", runId] });
      }
    },
  });

  const { mutate } = mutation;
  const patch = useCallback(
    (runId: string, body: RunWpMetaPatch) => mutate({ runId, body }),
    [mutate],
  );

  return {
    patch,
    pendingRunId: mutation.isPending ? mutation.variables?.runId ?? null : null,
    isPending: mutation.isPending,
  };
}
