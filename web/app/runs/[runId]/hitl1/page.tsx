"use client";
import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery, useMutation } from "@tanstack/react-query";
import Link from "next/link";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { SectionHead } from "@/components/SectionHead";
import { GapAnalysisView } from "@/components/GapAnalysisView";
import { OutlineEditor } from "@/components/OutlineEditor";
import { RunTaskDetails } from "@/components/RunTaskDetails";
import { api } from "@/lib/api";
import type { Outline } from "@/lib/types";

export default function Hitl1Page({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const shortId = runId.slice(0, 8);
  const router = useRouter();
  const run = useQuery({ queryKey: ["run", runId], queryFn: () => api.getRun(runId) });
  const ga = useQuery({ queryKey: ["ga", runId], queryFn: () => api.getGapAnalysis(runId) });
  const ol = useQuery({ queryKey: ["outline", runId], queryFn: () => api.getOutline(runId) });
  const isCreate = run.data?.start_mode === "create";
  const [edited, setEdited] = useState<Outline | null>(null);

  const approve = useMutation({
    mutationFn: () => api.resumeHitl1(runId, edited ? { decision: "edit_outline", edited_outline: edited } : { decision: "approve" }),
    onSuccess: () => router.push(`/runs/${runId}`),
    onError: (e: Error) => toast.error(e.message),
  });
  const overrideRoute = useMutation({
    mutationFn: (newRoute: "small_refresh" | "full_rewrite") =>
      api.resumeHitl1(runId, { decision: "override_route", new_route: newRoute }),
    onSuccess: () => router.push(`/runs/${runId}`),
    onError: (e: Error) => toast.error(e.message),
  });

  const isBusy = approve.isPending || overrideRoute.isPending;

  // This page is reachable by direct URL / bookmark / back-button even after the
  // run has moved past the outline gate (e.g. a published run). Only let the
  // editor act when the run is genuinely paused at HITL_1; otherwise show a
  // "resolved" notice so stale decision buttons can't be re-submitted.
  const atGate = run.data?.status === "hitl_1";
  const gateResolved = run.data != null && !atGate;

  const outline = edited ?? ol.data?.payload ?? null;

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10 pb-32">
      <div className="mb-4">
        <Link href={`/runs/${runId}`} className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider">
          ← Run · {shortId}
        </Link>
      </div>

      <SectionHead
        kicker={<>Galley Proof · Stage 1 · <span className="text-accent">{shortId}</span></>}
        hed="Editor's review"
        dek="Confirm the gap analysis and approve the proposed outline — or override the route."
      />

      {run.data && <RunTaskDetails run={run.data} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-10">
        <section>
          <p className="kicker mb-3">Gap analysis</p>
          {ga.data && <GapAnalysisView ga={ga.data} />}
        </section>
        <section>
          <p className="kicker mb-3">Outline (editable)</p>
          {outline && <OutlineEditor outline={outline} onChange={setEdited} />}
        </section>
      </div>

      {/* Sticky action bar */}
      <div className="fixed bottom-0 inset-x-0 bg-paper/95 backdrop-blur border-t border-ink z-40">
        <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-3 flex items-center justify-between gap-4">
          {gateResolved ? (
            <>
              <p className="font-mono text-[11px] text-ink-faint uppercase tracking-wider">
                Gate resolved · run is now{" "}
                <span className="text-ink">{run.data?.status}</span> — this outline review is read-only.
              </p>
              <Link
                href={`/runs/${runId}`}
                className="font-mono text-[11px] uppercase tracking-wider text-accent hover:text-ink"
              >
                Back to run →
              </Link>
            </>
          ) : (
            <>
              <p className="font-mono text-[11px] text-ink-faint uppercase tracking-wider">
                {edited ? "EDITS PENDING" : "AWAITING DECISION"}
              </p>
              <div className="flex gap-2">
                {!isCreate && (
                  <>
                    <Button variant="secondary" size="sm" disabled={isBusy || !atGate} onClick={() => overrideRoute.mutate("small_refresh")}>Force small_refresh</Button>
                    <Button variant="secondary" size="sm" disabled={isBusy || !atGate} onClick={() => overrideRoute.mutate("full_rewrite")}>Force full_rewrite</Button>
                  </>
                )}
                <Button variant="primary" disabled={isBusy || !atGate} onClick={() => approve.mutate()}>
                  {approve.isPending ? "Submitting…" : edited ? "Approve with edits ↪" : "Approve ↪"}
                </Button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
