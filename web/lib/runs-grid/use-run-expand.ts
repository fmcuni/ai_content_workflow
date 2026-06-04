"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { Audit, RunCost, Render } from "@/lib/types";

// The run-expand insert previews a draft + its destination without opening the
// run. The three sources (render, audit, cost) are fetched lazily — only once
// the row is expanded (`enabled`) — mirroring use-batch-children's on-expand
// pattern. Each can legitimately 404 for a run that hasn't drafted yet
// (pending/fetching/strategy), so we model 404 as a distinct `notFound` state
// the panels render as "nothing yet" rather than an error.

/** True when an `http()` error carries a 404 status (its message is `404: …`). */
function is404(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("404");
}

// Don't burn retries on a 404 (the draft simply isn't there yet); allow one
// retry for genuine transient failures.
function retryNon404(failureCount: number, error: unknown): boolean {
  if (is404(error)) return false;
  return failureCount < 1;
}

/** Per-panel load state, with 404 separated from real errors. */
export interface PanelState<T> {
  data: T | undefined;
  isLoading: boolean;
  /** A non-404 failure — show an error fallback. */
  isError: boolean;
  /** The resource 404'd — the run simply hasn't produced it yet. */
  notFound: boolean;
}

function toPanel<T>(query: UseQueryResult<T, unknown>, enabled: boolean): PanelState<T> {
  const notFound = query.isError && is404(query.error);
  return {
    data: query.data,
    isLoading: enabled && query.isLoading,
    isError: query.isError && !notFound,
    notFound,
  };
}

export interface RunExpandResult {
  render: PanelState<Render>;
  audit: PanelState<Audit>;
  cost: PanelState<RunCost>;
}

/**
 * Lazily load a run's draft render, audit and cost once `enabled` (the row is
 * expanded). Results are cached briefly so collapse/re-expand is instant.
 */
export function useRunExpand(runId: string, enabled: boolean): RunExpandResult {
  const renderQ = useQuery({
    queryKey: ["run-render", runId],
    queryFn: () => api.getLatestRender(runId),
    enabled,
    staleTime: 15_000,
    retry: retryNon404,
  });
  const auditQ = useQuery({
    queryKey: ["run-audit", runId],
    queryFn: () => api.getLatestAudit(runId),
    enabled,
    staleTime: 15_000,
    retry: retryNon404,
  });
  const costQ = useQuery({
    queryKey: ["run-cost", runId],
    queryFn: () => api.getRunCost(runId),
    enabled,
    staleTime: 15_000,
    retry: retryNon404,
  });

  return {
    render: toPanel(renderQ, enabled),
    audit: toPanel(auditQ, enabled),
    cost: toPanel(costQ, enabled),
  };
}
