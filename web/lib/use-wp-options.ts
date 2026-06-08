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

/**
 * Authors scoped by voice (persona slug). The /runs board uses this so its many
 * rows resolve author names + options against each row's own CMS instance, while
 * N rows of the *same* voice share a single react-query entry (keyed on the
 * slug) — one network fetch per distinct voice, not per row.
 */
export function useWpUsersForPersona(persona?: string) {
  return useQuery<WpUserOption[]>({
    queryKey: ["wp-users", "persona", persona ?? null],
    queryFn: () => api.listWpUsers(undefined, persona),
    ...WP_OPTION_QUERY,
  });
}

/** Categories scoped by voice (persona slug). See {@link useWpUsersForPersona}. */
export function useWpCategoriesForPersona(persona?: string) {
  return useQuery<WpCategoryOption[]>({
    queryKey: ["wp-categories", "persona", persona ?? null],
    queryFn: () => api.listWpCategories(undefined, persona),
    ...WP_OPTION_QUERY,
  });
}
