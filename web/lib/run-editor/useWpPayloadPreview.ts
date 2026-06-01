/**
 * The lazy WP-payload dry-publish preview shared by /hitl2 and /edit. Wraps the
 * existing `useMutation(() => api.dryPublish(runId, buildReq()))` + `dryPayload`
 * state pattern. `buildReq` is called fresh on each build so it reads the
 * current edits. See spec §B.
 */
import { useCallback, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";

import { api } from "@/lib/api";
import type { DryPublishRequest, DryPublishResponse } from "@/lib/types";

export interface UseWpPayloadPreviewResult {
  payload: DryPublishResponse | null;
  isPending: boolean;
  isError: boolean;
  error: Error | null;
  /** Trigger a build (Refresh button). */
  build: () => void;
  /** Lazy build the first time the tab opens (only if `canBuild && !isPending`). */
  onTabOpen: (canBuild: boolean) => void;
  /**
   * Seed the preview payload from an external dry-publish (e.g. /edit's
   * save-&-re-push flow), so the WP-payload tab and the re-push confirm dialog
   * stay in sync off a single source of truth — as the pre-refactor page did.
   */
  setPayload: Dispatch<SetStateAction<DryPublishResponse | null>>;
}

export function useWpPayloadPreview(
  runId: string,
  buildReq: () => DryPublishRequest,
): UseWpPayloadPreviewResult {
  const [payload, setPayload] = useState<DryPublishResponse | null>(null);

  const mutation = useMutation({
    mutationFn: () => api.dryPublish(runId, buildReq()),
    onSuccess: (data) => setPayload(data),
    onError: (e: Error) => toast.error(`Couldn't build payload — ${e.message}`),
  });

  const build = useCallback(() => mutation.mutate(), [mutation]);

  const onTabOpen = useCallback(
    (canBuild: boolean) => {
      if (canBuild && !mutation.isPending) mutation.mutate();
    },
    [mutation],
  );

  return {
    payload,
    isPending: mutation.isPending,
    isError: mutation.isError,
    error: (mutation.error as Error | null) ?? null,
    build,
    onTabOpen,
    setPayload,
  };
}
