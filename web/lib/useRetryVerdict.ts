"use client";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { topicBatchesApi } from "@/lib/api";

/**
 * Re-run dedup + hot for a single errored candidate. On success we invalidate
 * the batch query: a successful retry may also lift the batch from `failed`
 * back to `ready_for_review` (server-side), so the page must refetch to swap
 * from the progress view to the review grid. Shared by CandidateGrid (review
 * surface) and BatchProgress (failed surface). The mutation variable is the
 * candidate_id, so callers can scope per-row pending state via `variables`.
 */
export function useRetryVerdict(batchId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (candidateId: string) =>
      topicBatchesApi.retryVerdict(batchId, candidateId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["topic-batch", batchId] });
    },
  });
}
