"use client";

import { useQuery } from "@tanstack/react-query";

import { publishTargetsApi } from "@/lib/api";
import type { PublishTargetReadiness } from "@/lib/types";
import { cn } from "@/lib/utils";

function useReadiness(targetId: string) {
  return useQuery({
    queryKey: ["publish-target-readiness", targetId],
    queryFn: () => publishTargetsApi.readiness(targetId),
    // Provisioning happens out-of-band (wrangler secret); keep it reasonably fresh.
    staleTime: 30 * 1000,
    retry: false,
  });
}

function Dot({ ok }: { ok: boolean }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 rounded-full", ok ? "bg-emerald-500" : "bg-ink-faint/40")}
    />
  );
}

/**
 * Compact ready/not-ready chip for the targets list. Presence-only — reflects
 * whether the target's credential env vars are set, never their values.
 */
export function ReadinessBadge({ targetId }: { targetId: string }) {
  const q = useReadiness(targetId);
  if (q.isLoading) return <span className="text-[11px] text-ink-faint">…</span>;
  if (q.isError || !q.data) return <span className="text-[11px] text-ink-faint">—</span>;
  const r = q.data;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em]",
        r.ready ? "text-emerald-600" : "text-amber-600",
      )}
      title={r.ready ? "All credential env vars present" : "Missing credential env vars"}
    >
      <Dot ok={r.ready} />
      {r.ready ? "ready" : "not set"}
    </span>
  );
}

function Row({ label, ok }: { label: string; ok: boolean }) {
  return (
    <li className="flex items-center gap-2 font-mono text-[11px] text-ink-soft">
      <Dot ok={ok} />
      <span>{label}</span>
      <span className={cn("ml-auto", ok ? "text-emerald-600" : "text-amber-600")}>
        {ok ? "set" : "missing"}
      </span>
    </li>
  );
}

/** Per-secret presence breakdown shown inside the edit drawer. */
export function ReadinessPanel({ targetId }: { targetId: string }) {
  const q = useReadiness(targetId);
  if (q.isLoading) {
    return <p className="text-[11px] text-ink-faint">Checking secrets…</p>;
  }
  if (q.isError || !q.data) {
    return <p className="text-[11px] text-ink-faint">Readiness unavailable.</p>;
  }
  const r: PublishTargetReadiness = q.data;
  // Prefer the kind-aware `secrets` list; fall back to the legacy WordPress
  // triplet for older backends that don't return it.
  const rows = r.secrets ?? [
    { name: `${r.auth_ref}_BASE_URL`, present: r.base_url },
    { name: `${r.auth_ref}_USERNAME`, present: r.username },
    { name: `${r.auth_ref}_APP_PASSWORD`, present: r.app_password },
  ];
  return (
    <ul className="space-y-0.5 border-t border-rule pt-2">
      {rows.map((s) => (
        <Row key={s.name} label={s.name} ok={s.present} />
      ))}
    </ul>
  );
}
