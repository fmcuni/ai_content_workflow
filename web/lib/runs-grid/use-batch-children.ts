"use client";

import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import { topicBatchesApi } from "@/lib/api";
import type { RunSummary, TopicCandidate } from "@/lib/types";

// A topic batch's promoted runs are nested under its band when expanded. The
// runs *list* endpoint omits candidates, so the linkage (candidate →
// promoted_run_id → run) only comes from the batch *detail* endpoint, which we
// fetch lazily on expand. The two pure mappers below are the testable core; the
// hook is a thin TanStack-Query wrapper around them.

/** Promoted run ids for a batch's candidates, in candidate position order. */
export function promotedRunIds(
  candidates: readonly TopicCandidate[] | null | undefined,
): string[] {
  if (!candidates) return [];
  return [...candidates]
    .sort((a, b) => a.position - b.position)
    .map((c) => c.promoted_run_id)
    .filter((id): id is string => id != null);
}

/**
 * Resolve a batch's promoted candidates to the run rows already loaded in the
 * board's runs list, in candidate position order. A promoted candidate whose run
 * isn't in the list (e.g. filtered out, or not yet refetched) is skipped — never
 * silently counted as present.
 */
export function mapPromotedRuns(
  candidates: readonly TopicCandidate[] | null | undefined,
  runsById: ReadonlyMap<string, RunSummary>,
): RunSummary[] {
  return promotedRunIds(candidates)
    .map((id) => runsById.get(id))
    .filter((r): r is RunSummary => r != null);
}

export interface BatchChildrenResult {
  /** Resolved promoted runs, position-ordered. */
  runs: RunSummary[];
  /** Promoted candidate count from the batch (may exceed `runs.length`). */
  promotedCount: number;
  /** Total candidate/topic count from the batch detail. */
  topicCount: number;
  isLoading: boolean;
  isError: boolean;
}

/**
 * Lazily load a batch's detail (only once `enabled`, i.e. the band is expanded)
 * and map its promoted candidates to the board's already-loaded run rows.
 */
export function useBatchChildren(
  batchId: string,
  enabled: boolean,
  runsById: ReadonlyMap<string, RunSummary>,
): BatchChildrenResult {
  const query = useQuery({
    queryKey: ["topic-batch", batchId],
    queryFn: () => topicBatchesApi.detail(batchId),
    enabled,
    staleTime: 15_000,
  });

  const candidates = query.data?.candidates;
  const runs = useMemo(() => mapPromotedRuns(candidates, runsById), [candidates, runsById]);
  const promotedCount = useMemo(() => promotedRunIds(candidates).length, [candidates]);

  return {
    runs,
    promotedCount,
    topicCount: query.data?.topic_count ?? 0,
    isLoading: enabled && query.isLoading,
    isError: query.isError,
  };
}
