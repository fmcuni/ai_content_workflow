"use client";

import { useQuery } from "@tanstack/react-query";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { SetupScreen } from "@/components/SetupScreen";
import { isAuthRoute } from "@/lib/auth-routes";
import { setupApi } from "@/lib/api";

// The packaged desktop backend is a PyInstaller binary: cold boot (unpack +
// imports + startup) takes ~15s and can run longer when startup makes a network
// call. The window navigates here as soon as the frontend (:3000) is up — well
// before the backend (:8000) — so this gate must ride out the whole cold boot
// rather than surfacing a dead-end error mid-startup.
const BOOT_RETRY_COUNT = 12; // ~30s of retries at the capped delay below
const RETRY_DELAY_CAP_MS = 2_500;
// Once retries are exhausted we keep polling in the background so a slow or
// recovering backend reconnects on its own — no manual click required.
const RECONNECT_POLL_MS = 3_000;

/**
 * First-run gate. Queries the backend setup status and decides what to render:
 * a loading state while the local service boots, an error/retry panel if it is
 * unreachable, the setup form if credentials are missing, or the app once
 * configured. The setup form invalidates ["setup-status"] on success, so a
 * successful save flips this gate into the app without a reload.
 */
export function SetupGate({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const onAuthRoute = isAuthRoute(pathname);

  const statusQuery = useQuery({
    queryKey: ["setup-status"],
    queryFn: () => setupApi.status(),
    // Auth pages (login/signup/verify) render before a session exists, and
    // /setup/status is now auth-gated — skip the check there.
    enabled: !onAuthRoute,
    retry: BOOT_RETRY_COUNT,
    retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, RETRY_DELAY_CAP_MS),
    // Self-heal: keep polling while unreachable so the gate recovers without a
    // manual retry the moment the backend finishes booting.
    refetchInterval: (query) => (query.state.status === "error" ? RECONNECT_POLL_MS : false),
    staleTime: Infinity,
  });

  // Auth routes render their own centered layout — bypass the gate entirely.
  if (onAuthRoute) return <>{children}</>;

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
            The background service is taking longer than usual to start. Reconnecting
            automatically — this should clear on its own in a moment.
          </p>
          <div className="mt-6">
            <Button onClick={() => statusQuery.refetch()} disabled={statusQuery.isFetching}>
              {statusQuery.isFetching ? "Reconnecting…" : "Retry now"}
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
