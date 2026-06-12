"use client";

import { useMemo } from "react";
import { useQueries } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { WpCategoryOption, WpUserOption } from "@/lib/types";

export interface OptionMaps {
  users: Map<number, WpUserOption>;
  categories: Map<number, WpCategoryOption>;
}

const EMPTY: OptionMaps = { users: new Map(), categories: new Map() };

// Persona slug → its CMS target's author/category option lists are scoped by
// the backend (auth_ref dedup), so rows of the same voice share one cache entry.
// The empty-string key is the default Bowtie target (runs with no persona).
function personaKey(persona: string | null | undefined): string {
  return persona ?? "";
}

/**
 * Resolve author/category id→option maps for a set of voices in ONE pass, so
 * the table can show destination NAMES without each row firing its own
 * wp-options fetch. Uses `useQueries` (dynamic-length, cached 10 min) keyed by
 * the same `["wp-users"|"wp-categories", "persona", slug]` keys as the editor
 * hooks. Returns a map keyed by persona slug ("" = default target).
 */
export function useWpOptionMaps(personas: string[]): {
  byPersona: Map<string, OptionMaps>;
  get: (persona: string | null | undefined) => OptionMaps;
} {
  // Distinct, stable list so the query array length is deterministic per render.
  const keys = useMemo(() => Array.from(new Set(personas)).sort(), [personas]);

  const userQueries = useQueries({
    queries: keys.map((slug) => ({
      queryKey: ["wp-users", "persona", slug || null],
      queryFn: () => api.listWpUsers(undefined, slug || undefined),
      staleTime: 10 * 60_000,
      retry: false,
    })),
  });
  const catQueries = useQueries({
    queries: keys.map((slug) => ({
      queryKey: ["wp-categories", "persona", slug || null],
      queryFn: () => api.listWpCategories(undefined, slug || undefined),
      staleTime: 10 * 60_000,
      retry: false,
    })),
  });

  // Cheap to rebuild each render (a handful of voices), so we skip memoization
  // rather than thread the per-query data through a dependency array.
  const byPersona = new Map<string, OptionMaps>();
  keys.forEach((slug, i) => {
    const users = new Map<number, WpUserOption>();
    for (const u of userQueries[i]?.data ?? []) users.set(u.id, u);
    const categories = new Map<number, WpCategoryOption>();
    for (const c of catQueries[i]?.data ?? []) categories.set(c.id, c);
    byPersona.set(slug, { users, categories });
  });

  const get = (persona: string | null | undefined): OptionMaps =>
    byPersona.get(personaKey(persona)) ?? EMPTY;

  return { byPersona, get };
}
