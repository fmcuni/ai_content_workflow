"use client";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import type { ReactNode } from "react";

import { PaperStamp } from "@/components/PaperStamp";
import { RunStatusBadge } from "@/components/RunStatusBadge";
import { SectionHead } from "@/components/SectionHead";
import { Button } from "@/components/ui/button";
import { api, topicBatchesApi } from "@/lib/api";
import type { BatchStatus, RunStatus, RunSummary, TopicBatch } from "@/lib/types";
import { cn } from "@/lib/utils";

const DAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];

function ledgerDate(iso: string) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { day: "---", time: "--:--" };
  return {
    day: DAYS[d.getDay()],
    time: `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`,
  };
}

type Lane = "desk" | "motion" | "filed";
type Category = "rewrite" | "create" | "topic_gen";
type StampTone = "neutral" | "accent" | "ok" | "warn" | "info" | "danger";

// Category lives in a separate signal channel from status: a monochrome mono tag
// + glyph, so the colored status stamp stays the only color-coded signal.
const CATEGORY_META: Record<Category, { label: string; glyph: string }> = {
  rewrite: { label: "Rewrite", glyph: "↻" },
  create: { label: "Create", glyph: "✦" },
  topic_gen: { label: "Topic gen", glyph: "❉" },
};

// Runs blocked on a human, vs. auto-running, vs. terminal. Anything not listed
// in DESK/MOTION is treated as "filed".
const RUN_DESK = new Set<RunStatus>(["hitl_1", "hitl_2", "changes_requested", "failed"]);
const RUN_MOTION = new Set<RunStatus>(["pending", "fetching", "strategy", "production"]);
const BATCH_DESK = new Set<BatchStatus>(["ready_for_review", "partially_promoted", "failed"]);
const BATCH_MOTION = new Set<BatchStatus>(["pending", "generating", "analysing"]);

const BATCH_META: Record<BatchStatus, { label: string; tone: StampTone; pulse?: boolean }> = {
  pending: { label: "Queued", tone: "neutral" },
  generating: { label: "Generating", tone: "info", pulse: true },
  analysing: { label: "Analysing", tone: "info", pulse: true },
  ready_for_review: { label: "Ready for review", tone: "accent" },
  partially_promoted: { label: "Partly promoted", tone: "warn" },
  done: { label: "Done", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
};

interface DeskItem {
  key: string;
  kind: "run" | "batch";
  status: string;
  lane: Lane;
  category: Category;
  categoryNote?: string;
  title: string;
  subtitle: string;
  keywords?: string[];
  rowHref: string;
  action: string | null;
  createdAt: string;
}

function runAction(r: RunSummary): string | null {
  switch (r.status) {
    case "hitl_1": return "Review outline";
    case "hitl_2": return "Review draft";
    case "changes_requested": return "Open run";
    case "failed": return "Inspect failure";
    default: return null;
  }
}

function runActionHref(r: RunSummary): string {
  switch (r.status) {
    case "hitl_1": return `/runs/${r.run_id}/hitl1`;
    case "hitl_2": return `/runs/${r.run_id}/hitl2`;
    default: return `/runs/${r.run_id}`;
  }
}

function batchAction(b: TopicBatch): string | null {
  switch (b.status) {
    case "ready_for_review": return "Review topics";
    case "partially_promoted": return "Finish promotion";
    case "failed": return "Inspect failure";
    default: return null;
  }
}

function runToItem(r: RunSummary): DeskItem {
  const category: Category = r.start_mode === "create" ? "create" : "rewrite";
  const lane: Lane = RUN_DESK.has(r.status) ? "desk" : RUN_MOTION.has(r.status) ? "motion" : "filed";
  const action = lane === "desk" ? runAction(r) : null;
  const categoryNote =
    category === "rewrite" && r.chosen_route
      ? r.chosen_route === "full_rewrite"
        ? "Full"
        : "Small"
      : undefined;
  const subtitle =
    category === "create"
      ? r.target_audience
        ? `New article · ${r.target_audience}`
        : "New article"
      : r.article_url;
  return {
    key: `run:${r.run_id}`,
    kind: "run",
    status: r.status,
    lane,
    category,
    categoryNote,
    title: r.topic,
    subtitle,
    keywords: r.keywords,
    rowHref: action ? runActionHref(r) : `/runs/${r.run_id}`,
    action,
    createdAt: r.created_at,
  };
}

function batchToItem(b: TopicBatch): DeskItem {
  const lane: Lane = BATCH_DESK.has(b.status) ? "desk" : BATCH_MOTION.has(b.status) ? "motion" : "filed";
  const action = lane === "desk" ? batchAction(b) : null;
  return {
    key: `batch:${b.batch_id}`,
    kind: "batch",
    status: b.status,
    lane,
    category: "topic_gen",
    title: b.research_theme,
    subtitle: `${b.topic_count} topics · ${b.target_audience}`,
    rowHref: `/topic-batches/${b.batch_id}`,
    action,
    createdAt: b.created_at,
  };
}

function StatusStamp({ item }: { item: DeskItem }) {
  if (item.kind === "run") return <RunStatusBadge status={item.status as RunStatus} />;
  const meta = BATCH_META[item.status as BatchStatus];
  return <PaperStamp tone={meta.tone} pulse={meta.pulse}>{meta.label}</PaperStamp>;
}

function DeskRow({ item, accent }: { item: DeskItem; accent?: boolean }) {
  const { day, time } = ledgerDate(item.createdAt);
  const cat = CATEGORY_META[item.category];
  return (
    <li className="border-b border-rule group">
      <Link
        href={item.rowHref}
        className={cn(
          "grid grid-cols-[64px_1fr_auto] gap-4 md:gap-6 py-4 items-center transition-colors hover:bg-paper-deep/60",
          accent && "border-l-2 border-l-accent pl-4"
        )}
      >
        <div>
          <p className="font-mono text-[11px] text-ink-faint tracking-wider group-hover:text-accent transition-colors">{day}</p>
          <p className="font-mono text-[13px] text-ink-soft tabular-nums">{time}</p>
        </div>
        <div className="min-w-0">
          <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">
            <span aria-hidden className="text-ink-soft mr-1">{cat.glyph}</span>
            {cat.label}
            {item.categoryNote ? <span className="text-ink-soft"> · {item.categoryNote}</span> : null}
          </p>
          <p
            className="font-display text-[20px] leading-tight text-ink truncate mt-0.5"
            style={{ fontVariationSettings: '"opsz" 36, "SOFT" 70' }}
          >
            {item.title}
          </p>
          <p className="font-sans text-[12px] text-ink-faint truncate mt-1">{item.subtitle}</p>
          {item.keywords && item.keywords.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5 mt-1.5">
              {item.keywords.map((kw) => (
                <li
                  key={kw}
                  className="font-mono text-[10px] tracking-[0.04em] text-ink-soft border border-rule rounded-sm px-1.5 py-0.5 bg-paper-deep/40"
                >
                  {kw}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <div className="flex flex-col items-end gap-1.5 text-right">
          <StatusStamp item={item} />
          {item.action ? (
            <span className="font-sans text-[12px] font-medium text-accent group-hover:underline underline-offset-2 whitespace-nowrap">
              {item.action} →
            </span>
          ) : null}
        </div>
      </Link>
    </li>
  );
}

function LaneSection({
  title,
  hint,
  items,
  accent,
}: {
  title: string;
  hint: string;
  items: DeskItem[];
  accent?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <section>
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="kicker">
          {title} <span className="text-ink">· {items.length}</span>
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">{hint}</span>
      </div>
      <ul className="border-t border-rule">
        {items.map((it) => (
          <DeskRow key={it.key} item={it} accent={accent} />
        ))}
      </ul>
    </section>
  );
}

function DeskClear() {
  return (
    <section>
      <div className="flex items-baseline justify-between mb-1">
        <h2 className="kicker">On your desk <span className="text-ink">· 0</span></h2>
        <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint">Waiting on you</span>
      </div>
      <div className="border-t border-b border-rule py-6">
        <p className="font-display italic text-ink-faint text-[16px]">
          Desk clear — nothing is waiting on you.
        </p>
      </div>
    </section>
  );
}

export default function Home() {
  const runsQ = useQuery({
    queryKey: ["runs"],
    queryFn: () => api.listRuns(),
    refetchInterval: 15_000,
  });
  const batchesQ = useQuery({
    queryKey: ["topic-batches"],
    queryFn: () => topicBatchesApi.list(),
    refetchInterval: 15_000,
  });

  const isLoading = runsQ.isLoading;
  const isError = runsQ.isError;

  let content: ReactNode = null;
  if (runsQ.data || batchesQ.data) {
    const items = [
      ...(runsQ.data ?? []).map(runToItem),
      ...(batchesQ.data ?? []).map(batchToItem),
    ].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const desk = items.filter((i) => i.lane === "desk");
    const motion = items.filter((i) => i.lane === "motion");
    const filed = items.filter((i) => i.lane === "filed").slice(0, 15);

    content =
      items.length === 0 ? (
        <p className="font-display italic text-ink-faint text-[18px] mt-12">No stories on the wire.</p>
      ) : (
        <div className="space-y-10">
          {desk.length > 0 ? (
            <LaneSection title="On your desk" hint="Waiting on you" items={desk} accent />
          ) : (
            <DeskClear />
          )}
          <LaneSection title="In motion" hint="Running now" items={motion} />
          <LaneSection title="Filed" hint="Recently completed" items={filed} />
        </div>
      );
  }

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10">
      <SectionHead
        kicker="The Desk · Live"
        hed="Front Page"
        dek="Every rewrite, new article and topic batch in motion — sorted by what needs you first."
        actions={
          <Link href="/runs/new">
            <Button variant="secondary" size="sm">Start a new run →</Button>
          </Link>
        }
      />

      {isLoading && <p className="text-ink-faint">Loading…</p>}

      {isError && <p className="text-accent-deep text-[13px] mt-6">Failed to load runs.</p>}

      <div className="mt-8">{content}</div>
    </div>
  );
}
