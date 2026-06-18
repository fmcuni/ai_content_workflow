import { useQuery } from "@tanstack/react-query";

import { api, personasApi, publishTargetsApi } from "@/lib/api";
import type { PublishTargetKind } from "@/lib/types";

/**
 * Resolve a run's CMS kind (wordpress | ghost) the same way the /runs board
 * does: run.persona → persona.publish_target_id → publish_target.kind. Defaults
 * to "wordpress" while loading or when no target is assigned. Queries share the
 * board's cache keys so this is usually free.
 */
export function useRunCmsKind(runId?: string): PublishTargetKind {
  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => api.getRun(runId as string),
    enabled: runId !== undefined && runId !== "",
  });
  const personas = useQuery({ queryKey: ["personas"], queryFn: () => personasApi.list() });
  const targets = useQuery({ queryKey: ["publish-targets"], queryFn: () => publishTargetsApi.list() });

  const personaSlug = run.data?.persona ?? null;
  const persona = personas.data?.find((p) => p.slug === personaSlug);
  const targetId = persona?.publish_target_id ?? null;
  const target = targets.data?.find((t) => t.publish_target_id === targetId);
  return target?.kind === "ghost" ? "ghost" : "wordpress";
}
