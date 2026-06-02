"use client";
import * as React from "react";
import { use } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { ExternalLink } from "@/components/ExternalLink";
import { NavLinkButton } from "@/components/NavLinkButton";
import { SectionHead } from "@/components/SectionHead";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { EventTimeline } from "@/components/EventTimeline";
import { ThinkingStream } from "@/components/ThinkingStream";
import { DebugLogPanel } from "@/components/DebugLogPanel";
import { CostMeter } from "@/components/CostMeter";
import { RunTaskDetails } from "@/components/RunTaskDetails";
import { useRunEvents } from "@/lib/sse";
import { api, topicBatchesApi } from "@/lib/api";

// Finished runs whose stored outline / article can still be edited post-hoc
// and re-pushed. In-flight stages (pending/fetching/strategy/production/
// publishing) and the HITL gates are intentionally excluded.
const TERMINAL_STATUSES = new Set([
  "persisted",
  "published",
  "failed",
  "cancelled",
  "rejected",
  "changes_requested",
]);

function BylineItems({ items }: { items: (React.ReactNode | null)[] }) {
  const visible = items.filter((x): x is React.ReactNode => x !== null && x !== undefined && x !== false);
  return (
    <>
      {visible.map((item, i) => (
        <React.Fragment key={i}>
          {item}
          {i < visible.length - 1 ? <span className="text-ink-faint">·</span> : null}
        </React.Fragment>
      ))}
    </>
  );
}

export default function RunDetail({ params }: { params: Promise<{ runId: string }> }) {
  const { runId } = use(params);
  const shortId = runId.slice(0, 8);
  const queryClient = useQueryClient();
  const { data: run } = useQuery({
    queryKey: ["run", runId], queryFn: () => api.getRun(runId),
    refetchInterval: 3000,
  });
  const events = useRunEvents(runId);

  const restart = useMutation({
    mutationFn: () => api.restartRun(runId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["run", runId] }),
  });

  // Run row exposes candidate_id but not batch_id. Walk recent batches to
  // locate the parent — there is no candidate-lookup endpoint today.
  const { data: batch } = useQuery({
    queryKey: ["topic-batch-for-run", run?.topic_candidate_id],
    queryFn: async () => {
      const candidateId = run?.topic_candidate_id;
      if (!candidateId) return null;
      const list = await topicBatchesApi.list();
      for (const b of list) {
        const detail = await topicBatchesApi.detail(b.batch_id);
        if (detail.candidates?.some((c) => c.candidate_id === candidateId)) {
          return detail;
        }
      }
      return null;
    },
    enabled: !!run?.topic_candidate_id,
    staleTime: 60_000,
  });

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10">
      <div className="mb-4 flex items-center gap-3 flex-wrap">
        <Link href="/" className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider">
          ← All runs
        </Link>
        {batch && (
          <>
            <span className="text-ink-faint font-mono text-[11px]">·</span>
            <Link
              href={`/topic-batches/${batch.batch_id}`}
              className="font-mono text-[11px] text-ink-soft hover:text-ink uppercase tracking-wider"
            >
              From brief №{batch.batch_id.slice(0, 8)} ·{" "}
              <span className="normal-case tracking-normal text-ink">
                &ldquo;{batch.research_theme}&rdquo;
              </span>
            </Link>
          </>
        )}
      </div>

      <SectionHead
        kicker={<>Run · <span className="text-accent">{shortId}</span></>}
        hed={run?.topic ?? "…"}
        dek={
          run?.article_url ? (
            <ExternalLink href={run.article_url} className="hover:text-ink hover:underline underline-offset-2 break-all">
              {run.article_url} <span className="text-ink-faint">↗</span>
            </ExternalLink>
          ) : null
        }
      />

      {/* Byline strip */}
      <div className="font-mono text-[12px] text-ink-soft border-y border-rule py-3 mb-8 flex flex-wrap items-center gap-x-3 gap-y-2">
        {run && (
          <BylineItems
            items={[
              <span key="status" className="inline-flex items-center gap-2">
                STATUS · <RunStatusBadge status={run.status} />
              </span>,
              run.chosen_route ? (
                <span key="route">ROUTE · <span className="text-ink">{run.chosen_route}</span></span>
              ) : null,
              <span key="iter">ITER · <span className="text-ink tabular-nums">{run.iteration_count}</span></span>,
              <CostMeter key="cost" runId={runId} />,
            ]}
          />
        )}
      </div>

      {run && <RunTaskDetails run={run} />}

      <div className="grid grid-cols-1 lg:grid-cols-[1fr_400px] gap-10">
        {/* Live progress */}
        <section>
          <ThinkingStream events={events} live={run?.status === "production"} />
          <p className="kicker mb-3">Live progress</p>
          <EventTimeline events={events} />
          <DebugLogPanel
            streamId={runId}
            streamKind="run"
            liveEvents={events}
            isActive={!run || !TERMINAL_STATUSES.has(run.status)}
          />
        </section>

        {/* Editor's actions */}
        <aside className="lg:sticky lg:top-32 self-start">
          <p className="kicker mb-3">Editor&apos;s actions</p>
          <div className="space-y-3">
            {run?.status === "hitl_1" && (
              <div>
                <p className="kicker mb-2">Outline review</p>
                <NavLinkButton
                  href={`/runs/${runId}/hitl1`}
                  variant="primary"
                  size="lg"
                  className="w-full"
                >
                  Review gap analysis & outline →
                </NavLinkButton>
              </div>
            )}
            {run?.status === "hitl_2" && (
              <div>
                <p className="kicker mb-2">Draft review</p>
                <NavLinkButton
                  href={`/runs/${runId}/hitl2`}
                  variant="primary"
                  size="lg"
                  className="w-full"
                >
                  Review final draft →
                </NavLinkButton>
              </div>
            )}
            {run?.status === "failed" && (
              <div>
                <p className="kicker mb-2">Run failed</p>
                {run.error?.message && (
                  <p className="font-mono text-[12px] text-rose-700 bg-rose-50 border border-rose-200 rounded-md p-3 mb-3 whitespace-pre-wrap break-words">
                    {run.error.message}
                  </p>
                )}
                <Button
                  variant="primary"
                  size="lg"
                  className="w-full"
                  disabled={restart.isPending}
                  onClick={() => restart.mutate()}
                >
                  {restart.isPending ? "Restarting…" : "Restart run"}
                </Button>
                {restart.isError && (
                  <p className="font-mono text-[12px] text-rose-700 mt-2">
                    Couldn&apos;t restart — {String(restart.error)}
                  </p>
                )}
              </div>
            )}
            {run && TERMINAL_STATUSES.has(run.status) && (
              <div>
                <p className="kicker mb-2">Post-hoc edit</p>
                <NavLinkButton
                  href={`/runs/${runId}/edit`}
                  variant={run.status === "failed" ? "secondary" : "primary"}
                  size="lg"
                  className="w-full"
                >
                  Edit outline & article →
                </NavLinkButton>
              </div>
            )}
            {run && !TERMINAL_STATUSES.has(run.status) && run.status !== "hitl_1" && run.status !== "hitl_2" && (
              <p className="font-display italic text-ink-faint text-[15px]">Nothing required of the desk.</p>
            )}
          </div>
        </aside>
      </div>
    </div>
  );
}
