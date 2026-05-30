"use client";

import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { SetupScreen } from "@/components/SetupScreen";
import { setupApi } from "@/lib/api";

/**
 * First-run gate. Queries the backend setup status and decides what to render:
 * a loading state while the local service boots, an error/retry panel if it is
 * unreachable, the setup form if credentials are missing, or the app once
 * configured. The setup form invalidates ["setup-status"] on success, so a
 * successful save flips this gate into the app without a reload.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const statusQuery = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => setupApi.status(),
    retry: 5,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 4000),
    staleTime: Infinity,
  });

  if (statusQuery.isPending) {
    return (
      <div
        data-testid="setup-loading"
        className="min-h-screen bg-paper text-ink-faint flex items-center justify-center"
      >
        <p className="font-mono text-[12px] tracking-[0.14em] uppercase">
          Connecting to the local service…
        </p>
      </div>
    );
  }

  if (statusQuery.isError) {
    return (
      <div
        data-testid="setup-error"
        className="min-h-screen bg-paper text-ink flex items-center justify-center px-5"
      >
        <div className="max-w-[420px] text-center">
          <p className="kicker">Bowtie Content Desk</p>
          <h1
            className="font-display text-[26px] leading-tight mt-1"
            style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}
          >
            Can&rsquo;t reach the local service
          </h1>
          <p className="font-sans text-[13px] text-ink-faint mt-2">
            The background service may still be starting. Wait a moment, then try again.
          </p>
          <div className="mt-6">
            <Button onClick={() => statusQuery.refetch()} disabled={statusQuery.isFetching}>
              {statusQuery.isFetching ? "Retrying…" : "Retry"}
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!statusQuery.data.configured) {
    return <SetupScreen />;
  }

  return <>{children}</>;
}
