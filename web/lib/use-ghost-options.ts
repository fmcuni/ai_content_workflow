import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { GhostAuthorOption, GhostTagOption } from "@/lib/types";

// Live Ghost author/tag option lists for the HITL_2 metadata pickers, scoped to
// a run's (or persona's) Ghost publish target. Mirrors use-wp-options.ts.
const TEN_MIN = 10 * 60_000;
const THIRTY_MIN = 30 * 60_000;

export function useGhostAuthors(runId?: string) {
  return useQuery<GhostAuthorOption[]>({
    queryKey: ["ghost-authors", runId ?? null],
    queryFn: () => api.listGhostAuthors(runId),
    staleTime: TEN_MIN,
    gcTime: THIRTY_MIN,
    retry: false,
  });
}

export function useGhostTags(runId?: string) {
  return useQuery<GhostTagOption[]>({
    queryKey: ["ghost-tags", runId ?? null],
    queryFn: () => api.listGhostTags(runId),
    staleTime: TEN_MIN,
    gcTime: THIRTY_MIN,
    retry: false,
  });
}

export function useGhostAuthorsForPersona(persona?: string) {
  return useQuery<GhostAuthorOption[]>({
    queryKey: ["ghost-authors", "persona", persona ?? null],
    queryFn: () => api.listGhostAuthors(undefined, persona),
    staleTime: TEN_MIN,
    gcTime: THIRTY_MIN,
    retry: false,
  });
}

export function useGhostTagsForPersona(persona?: string) {
  return useQuery<GhostTagOption[]>({
    queryKey: ["ghost-tags", "persona", persona ?? null],
    queryFn: () => api.listGhostTags(undefined, persona),
    staleTime: TEN_MIN,
    gcTime: THIRTY_MIN,
    retry: false,
  });
}
