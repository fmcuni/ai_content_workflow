"use client";
import { use, useEffect, useRef } from "react";
import Link from "next/link";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { fetchEventSource } from "@microsoft/fetch-event-source";

import { SectionHead } from "@/components/SectionHead";
import { BatchProgress } from "@/components/topics/BatchProgress";
import { CandidateGrid } from "@/components/topics/CandidateGrid";
import { topicBatchesApi } from "@/lib/api";
import type { BatchStatus, TopicBatch } from "@/lib/types";

const TERMINAL: ReadonlySet<BatchStatus> = new Set<BatchStatus>(["done", "failed"]);
const REVIEW: ReadonlySet<BatchStatus> = new Set<BatchStatus>([
  "ready_for_review",
  "partially_promoted",
]);

export default function TopicBatchDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const shortId = id.slice(0, 8);
  const qc = useQueryClient();

  const { data: batch, isError, error } = useQuery({
    queryKey: ["topic-batch", id],
    queryFn: () => topicBatchesApi.detail(id),
    refetchInterval: (q) => {
      const cur = q.state.data as TopicBatch | undefined;
      if (!cur) return 3000;
      return TERMINAL.has(cur.status) ? false : 4000;
    },
  });

  const ctrl = useRef<AbortController | null>(null);
  useEffect(() => {
    const status = batch?.status;
    if (status && TERMINAL.has(status)) return;
    ctrl.current?.abort();
    ctrl.current = new AbortController();
    fetchEventSource(topicBatchesApi.eventsUrl(id), {
      signal: ctrl.current.signal,
      onmessage() {
        qc.invalidateQueries({ queryKey: ["topic-batch", id] });
      },
      onerror(err) {
        console.warn("batch SSE error", err);
        throw err;
      },
    }).catch(() => {
      /* aborted */
    });
    return () => ctrl.current?.abort();
  }, [id, batch?.status, qc]);

  return (
    <div className="mx-auto max-w-[1240px] px-5 md:px-10 py-10 space-y-8">
      <div>
        <Link
          href="/runs/new?front=topics"
          className="font-mono text-[11px] text-ink-faint hover:text-ink uppercase tracking-wider"
        >
          ← The desk · new brief
        </Link>
      </div>

      <SectionHead
        kicker={
          <>
            Brief · <span className="text-accent">№{shortId}</span>
          </>
        }
        hed={batch?.research_theme ?? "…"}
        dek={
          batch ? (
            <span>
              Audience · <span className="text-ink">{batch.target_audience}</span> · status ·{" "}
              <span className="text-ink uppercase tracking-[0.14em] font-mono text-[11px]">
                {batch.status}
              </span>
            </span>
          ) : null
        }
      />

      {isError && (
        <div className="border border-accent/40 bg-accent/[0.06] px-4 py-3 text-[12px] text-accent-deep font-mono">
          {(error as Error).message}
        </div>
      )}

      {batch && REVIEW.has(batch.status) && <CandidateGrid batch={batch} />}
      {batch && !REVIEW.has(batch.status) && batch.status !== "done" && (
        <BatchProgress batch={batch} />
      )}
      {batch && batch.status === "done" && <BatchDoneSummary batch={batch} />}
    </div>
  );
}

function BatchDoneSummary({ batch }: { batch: TopicBatch }) {
  const cands = batch.candidates ?? [];
  const promoted = cands.filter((c) => c.status === "promoted");
  const skipped = cands.filter((c) => c.status === "skipped");

  return (
    <section className="space-y-5">
      <div className="border-y border-ink py-3 flex items-baseline justify-between gap-4">
        <p className="kicker">— 30 — · Budget closed</p>
        <p className="font-mono text-[11px] text-ink-faint tabular-nums">
          {promoted.length} commissioned · {skipped.length} skipped
        </p>
      </div>

      <div>
        <p className="kicker mb-2">Commissioned runs</p>
        <ul className="space-y-1">
          {promoted.map((c) => (
            <li key={c.candidate_id} className="flex items-center gap-3 text-[12.5px]">
              <span className="font-display text-[14px] text-ink-faint tabular-nums w-8">
                {String(c.position + 1).padStart(2, "0")}
              </span>
              <span className="flex-1 text-ink line-clamp-1">{c.topic}</span>
              <span
                className={
                  c.promote_mode === "refresh"
                    ? "font-mono text-[10px] uppercase tracking-[0.14em] text-ok border border-ok/40 px-1.5 py-[1px] bg-ok/[0.06]"
                    : "font-mono text-[10px] uppercase tracking-[0.14em] text-accent-deep border border-accent/40 px-1.5 py-[1px] bg-accent/[0.06]"
                }
              >
                {c.promote_mode ?? "create"}
              </span>
              {c.promoted_run_id && (
                <Link
                  href={`/runs/${c.promoted_run_id}`}
                  className="font-mono text-[11px] text-ink hover:underline underline-offset-2"
                >
                  open run →
                </Link>
              )}
            </li>
          ))}
          {promoted.length === 0 && (
            <li className="text-[12.5px] text-ink-faint">
              No runs were commissioned from this brief.
            </li>
          )}
        </ul>
      </div>

      {skipped.length > 0 && (
        <div>
          <p className="kicker mb-2">Skipped</p>
          <ul className="space-y-0.5 font-mono text-[11.5px] text-ink-soft">
            {skipped.map((c) => (
              <li key={c.candidate_id} className="line-clamp-1">
                {String(c.position + 1).padStart(2, "0")} · {c.topic}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
