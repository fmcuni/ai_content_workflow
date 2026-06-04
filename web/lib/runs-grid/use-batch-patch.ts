"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";

import { topicBatchesApi } from "@/lib/api";
import type { TopicBatch, TopicBatchDefaultsPatch } from "@/lib/types";

// Inline edit of a topic batch's promotion defaults from the Ledger band.
// Optimistically patches both the ["topic-batches"] list (which the band reads)
// and the ["topic-batch", id] detail cache, rolls back on failure. No version
// guard — a default only affects runs promoted after the change.

const BATCHES_KEY = ["topic-batches"] as const;

/** Apply a defaults patch to a batch for the optimistic cache update. */
function applyPatch(batch: TopicBatch, body: TopicBatchDefaultsPatch): TopicBatch {
  const next: TopicBatch = { ...batch };
  if (body.persona_default !== undefined) next.persona_default = body.persona_default;
  if (body.acf_adv_id_default !== undefined) next.acf_adv_id_default = body.acf_adv_id_default;
  if (body.acf_widget_id_default !== undefined) next.acf_widget_id_default = body.acf_widget_id_default;
  if (body.auto_accept_hitl1_default !== undefined) {
    next.auto_accept_hitl1_default = body.auto_accept_hitl1_default ?? false;
  }
  return next;
}

export interface BatchPatchVars {
  batchId: string;
  body: TopicBatchDefaultsPatch;
}

interface BatchPatchContext {
  previousList: TopicBatch[] | undefined;
  previousDetail: TopicBatch | undefined;
}

export interface UseBatchPatchResult {
  patch: (batchId: string, body: TopicBatchDefaultsPatch) => void;
  pendingBatchId: string | null;
  isPending: boolean;
}

export function useBatchPatch(): UseBatchPatchResult {
  const queryClient = useQueryClient();

  const mutation = useMutation<TopicBatch, Error, BatchPatchVars, BatchPatchContext>({
    mutationFn: ({ batchId, body }) => topicBatchesApi.patch(batchId, body),
    onMutate: async ({ batchId, body }) => {
      await queryClient.cancelQueries({ queryKey: BATCHES_KEY });
      await queryClient.cancelQueries({ queryKey: ["topic-batch", batchId] });
      const previousList = queryClient.getQueryData<TopicBatch[]>(BATCHES_KEY);
      const previousDetail = queryClient.getQueryData<TopicBatch>(["topic-batch", batchId]);
      queryClient.setQueryData<TopicBatch[]>(BATCHES_KEY, (old) =>
        old?.map((b) => (b.batch_id === batchId ? applyPatch(b, body) : b)),
      );
      queryClient.setQueryData<TopicBatch>(["topic-batch", batchId], (old) =>
        old ? applyPatch(old, body) : old,
      );
      return { previousList, previousDetail };
    },
    onError: (error, { batchId }, context) => {
      if (context?.previousList !== undefined) {
        queryClient.setQueryData(BATCHES_KEY, context.previousList);
      }
      if (context?.previousDetail !== undefined) {
        queryClient.setQueryData(["topic-batch", batchId], context.previousDetail);
      }
      toast.error(`Couldn't save default — ${error.message}`);
    },
    onSettled: (_data, _error, { batchId }) => {
      void queryClient.invalidateQueries({ queryKey: BATCHES_KEY });
      void queryClient.invalidateQueries({ queryKey: ["topic-batch", batchId] });
    },
  });

  const { mutate } = mutation;
  const patch = useCallback(
    (batchId: string, body: TopicBatchDefaultsPatch) => mutate({ batchId, body }),
    [mutate],
  );

  return {
    patch,
    pendingBatchId: mutation.isPending ? mutation.variables?.batchId ?? null : null,
    isPending: mutation.isPending,
  };
}
