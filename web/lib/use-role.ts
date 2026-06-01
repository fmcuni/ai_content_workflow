"use client";

import { useQuery } from "@tanstack/react-query";

import { meApi } from "@/lib/api";
import { type Capability, type Role, roleMeetsRequirement } from "@/lib/roles";

// When the backend has no /me route (the local Python dev sidecar returns
// 404/error), we treat the operator as full-access so local development isn't
// blocked. The real Workers backend always returns a role, so this only ever
// applies in dev.
const DEV_FALLBACK_ROLE: Role = "admin";

export interface UseRoleResult {
  /** Resolved role, or null while the /me query is in flight. */
  role: Role | null;
  /** Operator email from /me, when available. */
  email: string | null;
  /** True until the /me query settles (loading state). */
  isLoading: boolean;
  /** True when /me was unavailable and we fell back to full-access dev mode. */
  isDevFallback: boolean;
  /** Capability/min-role check against the resolved (or fallback) role. */
  can: (required: Role | Capability) => boolean;
}

/**
 * Reads the operator's role from `GET /me` via TanStack Query and exposes a
 * `can(capabilityOrMinRole)` checker. UI-gating only — the server remains
 * authoritative. Falls back to full-access "admin" when /me is unavailable
 * (local dev backend has no such endpoint).
 */
export function useRole(): UseRoleResult {
  const query = useQuery({
    queryKey: ["me"],
    queryFn: () => meApi.get(),
    // The role rarely changes within a session; avoid refetch churn but allow a
    // manual invalidation to pick up a server-side change.
    staleTime: 5 * 60 * 1000,
    retry: false,
  });

  // /me failed (e.g. dev backend without the route) → full-access dev mode.
  const isDevFallback = query.isError;
  const role: Role | null = query.data
    ? query.data.role
    : isDevFallback
      ? DEV_FALLBACK_ROLE
      : null;

  const email = query.data?.email ?? null;

  function can(required: Role | Capability): boolean {
    // Still resolving: don't grant — callers decide how to render the pending
    // state (typically by also checking isLoading).
    if (role === null) return false;
    return roleMeetsRequirement(role, required);
  }

  return {
    role,
    email,
    isLoading: query.isLoading,
    isDevFallback,
    can,
  };
}
