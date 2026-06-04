"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";

import { DeskRow } from "@/components/desk/DeskRow";
import { SectionHead } from "@/components/SectionHead";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { api, topicBatchesApi } from "@/lib/api";
import {
  buildDeskItems,
  filterByTab,
  TABS,
  type DeskItem,
  type GateAction,
  type TabKey,
} from "@/lib/desk-items";
import type { RunSummary } from "@/lib/types";
import { hitl2Body, useDeskActions } from "@/lib/use-desk-actions";
import { useRole } from "@/lib/use-role";
import { cn } from "@/lib/utils";

const FILED_LIMIT = 15;

// HITL_2 decisions that go back to the operator through the feedback dialog
// (both want an optional note before they fire).
type FeedbackMode = "request_changes" | "reject";

function EditionTabs({
  active,
  counts,
  deskCounts,
  onChange,
}: {
  active: TabKey;
  counts: Record<TabKey, number>;
  deskCounts: Record<TabKey, number>;
  onChange: (tab: TabKey) => void;
}) {
  return (
    <nav aria-label="Editions" className="flex flex-wrap items-stretch gap-0 border-b border-ink">
      {TABS.map((t) => {
        const selected = t.key === active;
        const needs = deskCounts[t.key];
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            aria-pressed={selected}
            className={cn(
              "relative px-4 py-2.5 -mb-px font-mono text-[11px] uppercase tracking-[0.14em] transition-colors",
              "border-b-2 flex items-center gap-2",
              selected
                ? "border-accent text-ink"
                : "border-transparent text-ink-faint hover:text-ink",
            )}
          >
            <span className="flex items-center gap-1.5">
              {t.glyph ? <span aria-hidden className="text-ink-soft">{t.glyph}</span> : null}
              {t.label}
            </span>
            <span className="tabular-nums text-ink-soft">{counts[t.key]}</span>
            {needs > 0 ? (
              <span
                aria-label={`${needs} waiting on you`}
                className="inline-flex items-center justify-center min-w-4 h-4 px-1 rounded-full bg-accent text-paper text-[9px] tabular-nums leading-none"
              >
                {needs}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
}

function LaneSection({
  title,
  hint,
  items,
  accent,
  onAction,
  onDelete,
  pendingId,
}: {
  title: string;
  hint: string;
  items: DeskItem[];
  accent?: boolean;
  onAction?: (item: DeskItem, action: GateAction) => void;
  onDelete?: (item: DeskItem) => void;
  pendingId?: string | null;
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
          <DeskRow
            key={it.key}
            item={it}
            accent={accent}
            onAction={onAction}
            onDelete={onDelete}
            pendingId={pendingId}
          />
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

const EMPTY_COUNTS: Record<TabKey, number> = { all: 0, rewrite: 0, create: 0, topic_gen: 0 };

export default function Home() {
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<TabKey>("all");
  const [pendingDelete, setPendingDelete] = useState<DeskItem | null>(null);
  const [publishTarget, setPublishTarget] = useState<{ item: DeskItem; run: RunSummary } | null>(null);
  const [feedback, setFeedback] = useState<{ item: DeskItem; run: RunSummary; mode: FeedbackMode } | null>(null);
  const [feedbackNote, setFeedbackNote] = useState("");

  // Deleting runs / topic batches is admin-only (server-authoritative).
  const { can } = useRole();
  const canDelete = can("delete_run");
  const onDelete = canDelete ? setPendingDelete : undefined;

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

  const gate = useDeskActions();

  const runById = useMemo(() => {
    const m = new Map<string, RunSummary>();
    for (const r of runsQ.data ?? []) m.set(r.run_id, r);
    return m;
  }, [runsQ.data]);

  const allItems = useMemo(
    () => buildDeskItems(runsQ.data, batchesQ.data),
    [runsQ.data, batchesQ.data],
  );

  const counts = useMemo(() => {
    const c: Record<TabKey, number> = { ...EMPTY_COUNTS };
    const d: Record<TabKey, number> = { ...EMPTY_COUNTS };
    for (const it of allItems) {
      c.all += 1;
      c[it.category] += 1;
      if (it.lane === "desk") {
        d.all += 1;
        d[it.category] += 1;
      }
    }
    return { totals: c, desk: d };
  }, [allItems]);

  // Routes a row's inline gate action: one-click for low-stakes gates, a dialog
  // for the outward / feedback-bearing ones. Publishing as a public WordPress
  // post is the only path that always confirms (it goes live + is hard to undo).
  function handleAction(item: DeskItem, action: GateAction) {
    if (action === "approve_outline" || action === "restart") {
      gate.run({ kind: action, runId: item.id, title: item.title });
      return;
    }
    const run = runById.get(item.id);
    if (!run) return;
    if (action === "approve_publish") {
      const status = run.wp_publish_status ?? "draft";
      if (status === "publish") {
        setPublishTarget({ item, run }); // goes live → confirm first
      } else {
        gate.run({ kind: "approve_publish", runId: run.run_id, title: item.title, body: hitl2Body(run, "approve") });
      }
      return;
    }
    if (action === "request_changes" || action === "reject") {
      setFeedbackNote("");
      setFeedback({ item, run, mode: action });
    }
  }

  const deleteItem = useMutation({
    mutationFn: (item: DeskItem) =>
      item.kind === "batch" ? topicBatchesApi.delete(item.id) : api.deleteRun(item.id),
    onSuccess: (_data, item) => {
      toast.success(item.kind === "batch" ? "Topic batch removed" : "Run removed");
      setPendingDelete(null);
      void queryClient.invalidateQueries({ queryKey: ["runs"] });
      void queryClient.invalidateQueries({ queryKey: ["topic-batches"] });
    },
    onError: (e: Error) => toast.error(`Couldn't remove — ${e.message}`),
  });

  const isLoading = runsQ.isLoading;
  const isError = runsQ.isError;

  let content: ReactNode = null;
  if (runsQ.data || batchesQ.data) {
    const items = filterByTab(allItems, tab);
    const desk = items.filter((i) => i.lane === "desk");
    const motion = items.filter((i) => i.lane === "motion");
    const filed = items.filter((i) => i.lane === "filed").slice(0, FILED_LIMIT);

    content =
      allItems.length === 0 ? (
        <p className="font-display italic text-ink-faint text-[18px] mt-12">No stories on the wire.</p>
      ) : items.length === 0 ? (
        <p className="font-display italic text-ink-faint text-[16px] mt-10">
          Nothing filed under this edition yet.
        </p>
      ) : (
        <div className="space-y-10">
          {desk.length > 0 ? (
            <LaneSection
              title="On your desk"
              hint="Waiting on you"
              items={desk}
              accent
              onAction={handleAction}
              onDelete={onDelete}
              pendingId={gate.pendingId}
            />
          ) : (
            <DeskClear />
          )}
          <LaneSection
            title="In motion"
            hint="Running now"
            items={motion}
            onAction={handleAction}
            onDelete={onDelete}
            pendingId={gate.pendingId}
          />
          <LaneSection
            title="Filed"
            hint="Recently completed"
            items={filed}
            onAction={handleAction}
            onDelete={onDelete}
            pendingId={gate.pendingId}
          />
        </div>
      );
  }

  return (
    <div className="mx-auto max-w-[1180px] px-5 md:px-10 py-10">
      <SectionHead
        kicker="The Desk · Live"
        hed="Front Page"
        dek="Every rewrite, new article and topic batch in motion — act on what needs you without leaving the desk."
        actions={
          <Link href="/runs/new">
            <Button variant="secondary" size="sm">Start a new run →</Button>
          </Link>
        }
      />

      <div className="mt-2">
        <EditionTabs active={tab} counts={counts.totals} deskCounts={counts.desk} onChange={setTab} />
      </div>

      {isLoading && <p className="text-ink-faint mt-8">Loading…</p>}
      {isError && <p className="text-accent-deep text-[13px] mt-6">Failed to load runs.</p>}

      <div className="mt-8">{content}</div>

      {/* Publish-to-live confirm (only when the run publishes a public post). */}
      <Dialog open={publishTarget !== null} onOpenChange={(open) => !open && setPublishTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve & publish live?</DialogTitle>
            <DialogDescription>
              {publishTarget ? (
                <>
                  &ldquo;<span className="text-ink">{publishTarget.item.title}</span>&rdquo; will be
                  approved and published to WordPress as a{" "}
                  <span className="text-ink font-medium">public, live post</span> using its persisted
                  draft and last-saved metadata. This is hard to undo. To review the draft or the
                  publish target first, open the run instead.
                </>
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="secondary" onClick={() => setPublishTarget(null)} disabled={gate.isPending}>
              Cancel
            </Button>
            {publishTarget ? (
              <Link
                href={publishTarget.item.rowHref}
                className="inline-flex items-center text-[13px] text-accent hover:underline underline-offset-2 mr-2"
              >
                Open run →
              </Link>
            ) : null}
            <Button
              onClick={() => {
                if (!publishTarget) return;
                gate.run({
                  kind: "approve_publish",
                  runId: publishTarget.run.run_id,
                  title: publishTarget.item.title,
                  body: hitl2Body(publishTarget.run, "approve"),
                });
                setPublishTarget(null);
              }}
              disabled={gate.isPending}
            >
              {gate.isPending ? "Publishing…" : "Publish live"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Request-changes / reject feedback. */}
      <Dialog open={feedback !== null} onOpenChange={(open) => !open && setFeedback(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {feedback?.mode === "reject" ? "Reject this draft?" : "Request changes"}
            </DialogTitle>
            <DialogDescription>
              {feedback?.mode === "reject" ? (
                <>
                  &ldquo;<span className="text-ink">{feedback?.item.title}</span>&rdquo; will be
                  rejected and the run closed. Add an optional reason for the audit trail.
                </>
              ) : (
                <>
                  Send &ldquo;<span className="text-ink">{feedback?.item.title}</span>&rdquo; back for
                  a revision pass. Your note steers the rewrite.
                </>
              )}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={feedbackNote}
            onChange={(e) => setFeedbackNote(e.target.value)}
            rows={4}
            placeholder={
              feedback?.mode === "reject"
                ? "Optional — why this draft is being rejected."
                : "What the desk wants changed on the next pass."
            }
            className="bg-paper"
            autoFocus
          />
          <DialogFooter>
            <Button variant="secondary" onClick={() => setFeedback(null)} disabled={gate.isPending}>
              Cancel
            </Button>
            <Button
              variant={feedback?.mode === "reject" ? "destructive" : "primary"}
              onClick={() => {
                if (!feedback) return;
                gate.run({
                  kind: feedback.mode,
                  runId: feedback.run.run_id,
                  title: feedback.item.title,
                  body: hitl2Body(feedback.run, feedback.mode, feedbackNote),
                });
                setFeedback(null);
              }}
              disabled={
                gate.isPending || (feedback?.mode === "request_changes" && !feedbackNote.trim())
              }
            >
              {feedback?.mode === "reject"
                ? gate.isPending
                  ? "Rejecting…"
                  : "Reject draft"
                : gate.isPending
                  ? "Sending…"
                  : "Request changes"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete confirm. */}
      <Dialog open={pendingDelete !== null} onOpenChange={(open) => !open && setPendingDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Remove this {pendingDelete?.kind === "batch" ? "topic batch" : "run"}?
            </DialogTitle>
            <DialogDescription>
              {pendingDelete ? (
                pendingDelete.kind === "batch" ? (
                  <>
                    &ldquo;<span className="text-ink">{pendingDelete.title}</span>&rdquo; and all of
                    its topic candidates will be permanently deleted. This cannot be undone. Any
                    article already promoted from this batch is kept — it only loses its link back
                    to the batch.
                    {pendingDelete.lane === "motion" ? (
                      <> This batch is still generating — it will be stopped before removal.</>
                    ) : null}
                  </>
                ) : (
                  <>
                    &ldquo;<span className="text-ink">{pendingDelete.title}</span>&rdquo; and all of
                    its derived work (outline, drafts, render, audit, compliance log) will be
                    permanently deleted. This cannot be undone. The live WordPress post, if any, is
                    not affected.
                    {pendingDelete.lane === "motion" ? (
                      <> This run is still in motion — it will be stopped before removal.</>
                    ) : null}
                  </>
                )
              ) : null}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="secondary"
              onClick={() => setPendingDelete(null)}
              disabled={deleteItem.isPending}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => pendingDelete && deleteItem.mutate(pendingDelete)}
              disabled={deleteItem.isPending}
            >
              {deleteItem.isPending
                ? "Removing…"
                : `Remove ${pendingDelete?.kind === "batch" ? "batch" : "run"}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
