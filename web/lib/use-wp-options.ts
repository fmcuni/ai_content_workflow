"use client";
import { useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { WpCategoryOption, WpUserOption } from "@/lib/types";

const TEN_MIN = 10 * 60_000;
const THIRTY_MIN = 30 * 60_000;

// Shared cache config for the WP taxonomy lookups so every surface (the HITL_2
// metadata form and the /runs board) hits the same react-query entries.
const WP_OPTION_QUERY = { staleTime: TEN_MIN, gcTime: THIRTY_MIN, retry: false } as const;

/**
 * Authors for a run's CMS target. `runId` scopes the lookup to that voice's
 * publish target (per-voice cache); omit it for the legacy Bowtie default.
 * Keyed by runId so different runs (possibly different CMS instances) don't
 * share a cache entry.
 */
export function useWpUsers(runId?: string) {
  return useQuery<WpUserOption[]>({
    queryKey: ["wp-users", runId ?? null],
    queryFn: () => api.listWpUsers(runId),
    ...WP_OPTION_QUERY,
  });
}

/** Categories for a run's CMS target. See {@link useWpUsers}. */
export function useWpCategories(runId?: string) {
  return useQuery<WpCategoryOption[]>({
    queryKey: ["wp-categories", runId ?? null],
    queryFn: () => api.listWpCategories(runId),
    ...WP_OPTION_QUERY,
  });
}
