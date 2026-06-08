"use client";
import { useQuery } from "@tanstack/react-query";

import { topicBatchesApi } from "@/lib/api";
import type { RunSummary, TopicBatch } from "@/lib/types";

/**
 * Resolve the topic batch a run was promoted from (Expand Topics → promote).
 *
 * The run row carries `topic_candidate_id` but not the parent `batch_id`, and
 * there is no candidate-lookup endpoint, so we walk recent batches and match the
 * candidate. The query is disabled (no fetch) for runs that were not promoted
 * from a batch. The shared query key dedupes with any other caller on the same
 * page (e.g. the run-detail crumb).
 */
export function useTopicBatchForRun(
  run: RunSummary | undefined,
): TopicBatch | null | undefined {
  const candidateId = run?.topic_candidate_id ?? null;
  const { data } = useQuery({
    queryKey: ["topic-batch-for-run", candidateId],
    queryFn: async () => {
      if (!candidateId) return null;
      const list = await topicBatchesApi.list();
      for (const b of list) {
        const detail = await topicBatchesApi.detail(b.batch_id);
        if (detail.candidates?.some((c) => c.candidate_id === candidateId)) {
          return detail;
        }
      }
      return null;
    },
    enabled: !!candidateId,
    staleTime: 60_000,
  });
  return data;
}
