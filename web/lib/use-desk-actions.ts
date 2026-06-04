"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { Hitl2Request, RunSummary } from "@/lib/types";

// A gate action fired from a Front Page row, without opening the run. The page
// builds the intent (it holds the run summaries); this hook owns the mutation,
// optimistic toasts, and cache invalidation.
export type GateIntent =
  | { kind: "approve_outline"; runId: string; title: string }
  | { kind: "restart"; runId: string; title: string }
  | { kind: "approve_publish"; runId: string; title: string; body: Hitl2Request }
  | { kind: "request_changes"; runId: string; title: string; body: Hitl2Request }
  | { kind: "reject"; runId: string; title: string; body: Hitl2Request };

const SUCCESS_COPY: Record<GateIntent["kind"], string> = {
  approve_outline: "Outline approved — drafting now",
  restart: "Run restarted",
  approve_publish: "Approved & publishing to WordPress",
  request_changes: "Changes requested — revising",
  reject: "Draft rejected",
};

/**
 * Build the HITL_2 resume body from a run's last-saved WordPress metadata, so a
 * one-click publish honors the operator's earlier selections (author, category,
 * slug…) and the run's persisted render — no inline edits.
 */
export function hitl2Body(
  run: RunSummary,
  decision: Hitl2Request["decision"],
  notes?: string | null,
): Hitl2Request {
  return {
    decision,
    wp_publish_status: run.wp_publish_status ?? "draft",
    wp_author_id: run.wp_author_id ?? null,
    wp_category_ids: run.wp_category_ids ?? null,
    wp_tag_ids: run.wp_tag_ids ?? null,
    wp_featured_media_id: run.wp_featured_media_id ?? null,
    wp_slug: run.wp_slug ?? null,
    wp_excerpt: run.wp_excerpt ?? null,
    notes: notes?.trim() ? notes.trim() : null,
  };
}

export interface UseDeskActionsResult {
  run: (intent: GateIntent) => void;
  pendingId: string | null;
  isPending: boolean;
}

export function useDeskActions(): UseDeskActionsResult {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (intent: GateIntent) => {
      switch (intent.kind) {
        case "approve_outline":
          return api.resumeHitl1(intent.runId, { decision: "approve" });
        case "restart":
          return api.restartRun(intent.runId);
        case "approve_publish":
        case "request_changes":
        case "reject":
          return api.resumeHitl2(intent.runId, intent.body);
      }
    },
    onSuccess: (_data, intent) => {
      toast.success(SUCCESS_COPY[intent.kind]);
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
    },
    onError: (e: Error, intent) =>
      toast.error(`Couldn't ${intent.kind.replace(/_/g, " ")} — ${e.message}`),
  });

  return {
    run: (intent) => mutation.mutate(intent),
    pendingId: mutation.isPending ? mutation.variables?.runId ?? null : null,
    isPending: mutation.isPending,
  };
}
