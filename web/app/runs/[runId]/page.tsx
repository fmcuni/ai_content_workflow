"use client";
import { use } from "react";
import Link from "next/link";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { SectionHead } from "@/components/SectionHead";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { EventTimeline } from "@/components/EventTimeline";
import { CostMeter } from "@/components/CostMeter";
import { useRunEvents } from "@/lib/sse";
import { api } from "@/lib/api";

export default function RunDetail({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const shortId = runId.slice(0, 8);
  const { data: run } = useQuery({
    queryKey: ["run", runId], queryFn: () => api.getRun(runId),
    refetchInterval: 3000,
  });
  const events = useRunEvents(runId);

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10">
      <div className="mb-4">
        <Link href="/" className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider">
          ← All runs
        </Link>
      </div>

      <SectionHead
        kicker={<>Run · <span className="text-accent">{shortId}</span></>}
        hed={run?.topic ?? "…"}
        dek={
          run?.article_url ? (
            <a href={run.article_url} target="_blank" rel="noopener noreferrer" className="hover:text-ink hover:underline underline-offset-2 break-all">
              {run.article_url} <span className="text-ink-faint">↗</span>
            </a>
          ) : null
        }
      />

      {/* Byline strip */}
      <div className="font-mono text-[12px] text-ink-soft border-y border-rule py-3 mb-8 flex flex-wrap items-center gap-x-3 gap-y-2">
        {run && (
          <>
            <span className="inline-flex items-center gap-2">
              STATUS · <RunStatusBadge status={run.status} />
            </span>
            <span className="text-ink-faint">·</span>
            {run.chosen_route && (
              <>
                <span>ROUTE · <span className="text-ink">{run.chosen_route}</span></span>
                <span className="text-ink-faint">·</span>
              </>
            )}
            <span>ITER · <span className="text-ink tabular-nums">{run.iteration_count}</span></span>
            <span className="text-ink-faint">·</span>
            <CostMeter runId={runId} />
          </>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-10">
        {/* Live progress */}
        <section>
          <p className="kicker mb-3">Live progress</p>
          <EventTimeline events={events} />
        </section>

        {/* Editor's actions */}
        <aside className="lg:sticky lg:top-32 self-start">
          <p className="kicker mb-3">Editor's actions</p>
          <div className="space-y-3">
            {run?.status === "hitl_1" && (
              <div>
                <p className="kicker mb-2">Hitl · Stage 1</p>
                <Link href={`/runs/${runId}/hitl1`} className="block">
                  <Button variant="primary" size="lg" className="w-full">Review gap analysis & outline →</Button>
                </Link>
              </div>
            )}
            {run?.status === "hitl_2" && (
              <div>
                <p className="kicker mb-2">Hitl · Stage 2</p>
                <Link href={`/runs/${runId}/hitl2`} className="block">
                  <Button variant="primary" size="lg" className="w-full">Review final draft →</Button>
                </Link>
              </div>
            )}
            {run && run.status !== "hitl_1" && run.status !== "hitl_2" && (
              <p className="font-display italic text-ink-faint text-[15px]">Nothing required of the desk.</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
