"use client";
import type { BatchStatus, TopicBatch, TopicCandidate } from "@/lib/types";
import { cn } from "@/lib/utils";
import { VerdictBadge } from "./VerdictBadge";

interface BatchProgressProps {
  batch: TopicBatch;
}

type Phase = "generating" | "analysing" | "ready";

const PHASES: { key: Phase; label: string; dek: string }[] = [
  { key: "generating", label: "Topic-gen", dek: "Filing the brief." },
  { key: "analysing", label: "Verdicts", dek: "Dedup + hot-topic per candidate." },
  { key: "ready", label: "Review", dek: "HITL_T1 cuts." },
];

function phaseStateForStatus(status: BatchStatus, phase: Phase): "pending" | "running" | "done" {
  if (status === "failed") return phase === "generating" ? "done" : "pending";
  const order: BatchStatus[] = [
    "pending",
    "generating",
    "analysing",
    "ready_for_review",
    "partially_promoted",
    "done",
  ];
  const idx = order.indexOf(status);
  if (phase === "generating") {
    if (idx <= 0) return "running";
    return "done";
  }
  if (phase === "analysing") {
    if (idx <= 1) return "pending";
    if (idx === 2) return "running";
    return "done";
  }
  if (idx <= 2) return "pending";
  if (idx === 3) return "running";
  return "done";
}

export function BatchProgress({ batch }: BatchProgressProps) {
  const candidates = batch.candidates ?? [];
  const expected = batch.topic_count;

  return (
    <section aria-labelledby="batch-progress-title" className="space-y-6">
      <div className="border-b border-rule pb-3">
        <p className="kicker">Front II · On the wire</p>
        <h2
          id="batch-progress-title"
          className="hed text-[24px] mt-1"
          style={{ fontVariationSettings: '"opsz" 36, "SOFT" 60' }}
        >
          {batch.research_theme}
        </h2>
        <p className="mt-1 text-[12.5px] text-ink-soft">
          Audience · {batch.target_audience} · {expected} topics ordered, {batch.keywords_per_topic} keywords each.
        </p>
      </div>

      <ol
        className="grid grid-cols-1 md:grid-cols-3 gap-0 border border-rule"
        aria-label="Progress phases"
      >
        {PHASES.map((p, i) => {
          const state = phaseStateForStatus(batch.status, p.key);
          return (
            <li
              key={p.key}
              className={cn(
                "relative px-4 py-4 border-rule",
                i > 0 && "md:border-l border-t md:border-t-0",
                state === "done" && "bg-paper-deep",
              )}
            >
              <div className="flex items-baseline gap-2">
                <span
                  aria-hidden
                  className={cn(
                    "inline-block size-2 rounded-full",
                    state === "done" && "bg-ok",
                    state === "running" && "bg-warn animate-pulse",
                    state === "pending" && "bg-rule",
                  )}
                />
                <span className="kicker">{p.label}</span>
              </div>
              <p className="mt-1 text-[12.5px] text-ink-soft">{p.dek}</p>
              {state === "running" && p.key === "analysing" && expected > 0 && (
                <p className="mt-1 font-mono text-[11px] text-ink-faint tabular-nums">
                  {candidates.length} / {expected} landed
                </p>
              )}
            </li>
          );
        })}
      </ol>

      {batch.status === "failed" && batch.last_error && (
        <div className="border border-accent/40 bg-accent/[0.06] px-3 py-2 text-[12px] text-accent-deep">
          <span className="kicker text-accent-deep">Wire down</span>
          <p className="mt-1 font-mono text-[11.5px]">{batch.last_error}</p>
        </div>
      )}

      <div>
        <p className="kicker mb-2">Candidates landing</p>
        <ul className="space-y-1.5">
          {Array.from({ length: Math.max(expected, candidates.length) }).map((_, i) => {
            const c: TopicCandidate | undefined = candidates[i];
            return (
              <CandidateRowSkeleton
                key={c?.candidate_id ?? `slot-${i}`}
                candidate={c}
                index={i}
              />
            );
          })}
        </ul>
      </div>
    </section>
  );
}

function CandidateRowSkeleton({
  candidate,
  index,
}: {
  candidate?: TopicCandidate;
  index: number;
}) {
  const verdictsPending =
    candidate && (candidate.existing == null || candidate.hot_topic == null);
  const errored = candidate?.last_error != null;

  return (
    <li
      className={cn(
        "flex items-center gap-3 border border-rule px-3 py-2 bg-paper",
        verdictsPending && "animate-pulse",
      )}
    >
      <span
        className="font-display text-[16px] text-ink-faint tabular-nums w-8 shrink-0"
        style={{ fontVariationSettings: '"opsz" 36' }}
      >
        {String(index + 1).padStart(2, "0")}
      </span>
      <div className="flex-1 min-w-0">
        {candidate ? (
          <>
            <p className="text-[13px] text-ink line-clamp-1">{candidate.topic}</p>
            <p className="font-mono text-[10.5px] text-ink-faint line-clamp-1">
              {candidate.keywords.join(" · ")}
            </p>
          </>
        ) : (
          <div className="space-y-1">
            <div className="h-3 w-2/3 bg-rule/50 rounded" />
            <div className="h-2 w-1/2 bg-rule/30 rounded" />
          </div>
        )}
      </div>
      <div className="flex items-center gap-1.5 shrink-0">
        <VerdictBadge
          kind="existing"
          verdict={candidate?.existing ?? null}
          note={candidate?.existing_note ?? null}
          url={candidate?.existing_url}
        />
        <VerdictBadge
          kind="hot"
          verdict={candidate?.hot_topic ?? null}
          note={candidate?.hot_topic_note ?? null}
        />
        {errored && (
          <span
            title={candidate?.last_error ?? "error"}
            className="font-mono text-[10px] uppercase tracking-[0.14em] text-accent-deep border border-accent/40 px-1.5 py-[1px] bg-accent/[0.06]"
          >
            err
          </span>
        )}
      </div>
    </li>
  );
}
