"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { api, personasApi, publishTargetsApi } from "@/lib/api";
import { statusTone } from "@/lib/run-status";
import type { Persona, PublishTarget, RunSummary } from "@/lib/types";

import { fmtCreator, voiceName } from "./fmt";

// Shared query keys — the drawer + bulk mutations invalidate these to refresh
// the table after a PATCH / resume / restart.
export const RUNS_LIST_KEY = ["runs", "ledger"] as const;
export const PERSONAS_KEY = ["personas"] as const;
export const PUBLISH_TARGETS_KEY = ["publish-targets"] as const;

// The ledger's status tabs. `pending` is the "in progress" bucket — it absorbs
// EVERY transient/working status (spec §2) via the shared blue tone, so no run
// is invisible. `all` is the always-everything fallback.
export type LedgerTab =
  | "all"
  | "drafted"
  | "outlined"
  | "pending"
  | "failed"
  | "published"
  | "rejected";

export const TAB_ORDER: LedgerTab[] = [
  "all",
  "drafted",
  "outlined",
  "pending",
  "failed",
  "published",
  "rejected",
];

export const TAB_LABEL: Record<LedgerTab, string> = {
  all: "All",
  drafted: "drafted",
  outlined: "outlined",
  pending: "pending",
  failed: "failed",
  published: "published",
  rejected: "rejected",
};

// Tab membership predicates. Specific tabs are explicit; anything that matches
// none (rare oddballs like `changes_requested`) still appears under `all`.
const TAB_MATCH: Record<LedgerTab, (status: string) => boolean> = {
  all: () => true,
  drafted: (s) => s === "hitl_2",
  outlined: (s) => s === "hitl_1",
  pending: (s) => statusTone(s) === "blue", // pending + all transient/in-flight
  failed: (s) => s === "failed",
  published: (s) => s === "published" || s === "persisted",
  rejected: (s) => s === "rejected" || s === "cancelled",
};

export function tabMatches(tab: LedgerTab, status: string): boolean {
  return TAB_MATCH[tab](status);
}

export type SortOrder = "newest" | "oldest";

export interface VoiceOption {
  slug: string;
  name: string;
}

export interface CreatorOption {
  /** Raw `created_by` (the filter value) — usually an email. */
  value: string;
  /** Short display label (see `fmtCreator`). */
  name: string;
}

export interface LedgerData {
  runs: RunSummary[];
  isLoading: boolean;
  isError: boolean;
  personaBySlug: Map<string, Persona>;
  targetById: Map<string, PublishTarget>;
  /** Per-tab totals across ALL runs (not just the visible page) — spec §4.3. */
  counts: Record<LedgerTab, number>;
  /** Distinct voices present in the run set, for the voice filter. */
  voices: VoiceOption[];
  /** Distinct creators present in the run set, for the "who created" filter. */
  creators: CreatorOption[];
}

/**
 * Loads the three lists the ledger needs (runs + personas + publish targets)
 * and derives the lookup maps, per-tab counts and voice options once. The
 * personas/targets lists are long-lived (10-min stale) — only `runs` churns.
 */
export function useLedgerData(): LedgerData {
  const runsQuery = useQuery({
    queryKey: RUNS_LIST_KEY,
    queryFn: () => api.listRuns(),
  });
  const personasQuery = useQuery({
    queryKey: PERSONAS_KEY,
    queryFn: () => personasApi.list(),
    staleTime: 10 * 60_000,
  });
  const targetsQuery = useQuery({
    queryKey: PUBLISH_TARGETS_KEY,
    queryFn: () => publishTargetsApi.list(),
    staleTime: 10 * 60_000,
  });

  const runs = useMemo(() => runsQuery.data ?? [], [runsQuery.data]);

  const personaBySlug = useMemo(() => {
    const m = new Map<string, Persona>();
    for (const p of personasQuery.data ?? []) m.set(p.slug, p);
    return m;
  }, [personasQuery.data]);

  const targetById = useMemo(() => {
    const m = new Map<string, PublishTarget>();
    for (const t of targetsQuery.data ?? []) m.set(t.publish_target_id, t);
    return m;
  }, [targetsQuery.data]);

  const counts = useMemo(() => {
    const c = {
      all: 0,
      drafted: 0,
      outlined: 0,
      pending: 0,
      failed: 0,
      published: 0,
      rejected: 0,
    } as Record<LedgerTab, number>;
    for (const r of runs) {
      for (const tab of TAB_ORDER) {
        if (TAB_MATCH[tab](r.status)) c[tab] += 1;
      }
    }
    return c;
  }, [runs]);

  const voices = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of runs) {
      if (!r.persona || seen.has(r.persona)) continue;
      seen.set(r.persona, voiceName(r, personaBySlug) ?? r.persona);
    }
    return Array.from(seen, ([slug, name]) => ({ slug, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [runs, personaBySlug]);

  const creators = useMemo(() => {
    const seen = new Map<string, string>();
    for (const r of runs) {
      const value = r.created_by?.trim();
      if (!value || seen.has(value)) continue;
      seen.set(value, fmtCreator(value));
    }
    return Array.from(seen, ([value, name]) => ({ value, name })).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
  }, [runs]);

  return {
    runs,
    isLoading: runsQuery.isLoading,
    isError: runsQuery.isError,
    personaBySlug,
    targetById,
    counts,
    voices,
    creators,
  };
}

/** Apply tab + voice + search filters, then sort — pure for testability. */
export function filterAndSortRuns(
  runs: RunSummary[],
  opts: { tab: LedgerTab; voice: string; creator: string; search: string; sort: SortOrder },
): RunSummary[] {
  const q = opts.search.trim().toLowerCase();
  const filtered = runs.filter((r) => {
    if (!tabMatches(opts.tab, r.status)) return false;
    if (opts.voice && r.persona !== opts.voice) return false;
    if (opts.creator && (r.created_by ?? "") !== opts.creator) return false;
    if (q) {
      const haystack = [
        r.topic,
        r.seo_title ?? "",
        r.meta_description ?? "",
        r.wp_slug ?? "",
        ...(r.keywords ?? []),
      ]
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
  const dir = opts.sort === "newest" ? -1 : 1;
  return filtered.sort((a, b) => dir * a.created_at.localeCompare(b.created_at));
}
