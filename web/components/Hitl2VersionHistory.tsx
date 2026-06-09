"use client";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { PaperStamp } from "@/components/PaperStamp";
import { VersionDiff } from "@/components/VersionDiff";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import { isBlankBody } from "@/lib/run-editor/form";
import type { Hitl2Snapshot, Hitl2SnapshotTrigger, RunDraft } from "@/lib/types";

const TRIGGER_LABEL: Record<Hitl2SnapshotTrigger, string> = {
  interval: "auto · 5-min",
  navigate: "auto · left page",
  unload: "auto · closed tab",
  manual: "manual",
  generated: "AI · original draft",
};

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "just now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.round(hrs / 24)}d ago`;
}

function bodySummary(htmlBody: string, commentCount: number): string {
  const bodyChars = htmlBody.length.toLocaleString();
  return `${bodyChars} chars · ${commentCount} comment${commentCount === 1 ? "" : "s"}`;
}

// The editor who saved this version, bound server-side to the authenticated
// session (not client-supplied). Older rows may predate actor capture → null.
function snapshotAuthor(s: Hitl2Snapshot): string {
  const who = s.created_by?.trim();
  return who && who.length > 0 ? who : "unknown";
}

/** Synthesize a snapshot-shaped value from a draft iteration so the existing
 * `onRestore` (which loads body + SEO into the editor) works for AI drafts too.
 * The synthetic id is namespaced so it never collides with a real snapshot. */
function draftAsSnapshot(d: RunDraft): Hitl2Snapshot {
  return {
    snapshot_id: `draft:${d.draft_id}`,
    created_at: d.created_at,
    created_by: "system:generated",
    trigger: "generated",
    html_body: d.html_body,
    seo_title: d.seo_title,
    meta_description: d.meta_description,
    comments: null,
  };
}

// One row in the unified chronology: a reviewer snapshot or an AI draft
// iteration. Both expose a body so they can be diffed and restored uniformly.
type TimelineEntry =
  | { source: "snapshot"; at: string; snap: Hitl2Snapshot }
  | { source: "draft"; at: string; draft: RunDraft };

interface Props {
  runId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestore: (snapshot: Hitl2Snapshot) => void;
  /** True while a restore is in flight (disables all Restore buttons). */
  restoring?: boolean;
  /** The snapshot currently being restored, for a per-row "Restoring…" label. */
  restoringId?: string | null;
  /**
   * The editor's current working body, used as the Diff "after" baseline. Sourced
   * from the page (under collab: the flattened Yjs doc) so the diff compares the
   * selected version against what the operator is ACTUALLY editing. The list-derived
   * `liveBody` (is_current snapshot / newest draft) is unreliable for an edited run —
   * is_current matches the original render, so every autosaved edit falls back to the
   * AI draft, diffing against the wrong baseline. Falls back to `liveBody` when unset.
   */
  currentBody?: string;
}

export function Hitl2VersionHistory({
  runId,
  open,
  onOpenChange,
  onRestore,
  restoring = false,
  restoringId = null,
  currentBody,
}: Props) {
  const snapshots = useQuery({
    queryKey: ["hitl2-snapshots", runId],
    queryFn: () => api.listHitl2Snapshots(runId),
    enabled: open,
    refetchOnMount: "always",
  });
  const drafts = useQuery({
    queryKey: ["run-drafts", runId],
    queryFn: () => api.listRunDrafts(runId),
    enabled: open,
    refetchOnMount: "always",
  });

  // Diff dialog: the selected entry's body vs the current live body.
  const [diffEntry, setDiffEntry] = useState<
    { label: string; body: string } | null
  >(null);

  // Merge reviewer snapshots and AI draft iterations into one chronology.
  // A draft whose body is already represented by a snapshot is dropped (the
  // snapshot is authoritative and carries metadata + a stable id), so the
  // `generated` baseline doesn't duplicate the latest draft.
  const { entries, liveBody } = useMemo(() => {
    const snaps = (snapshots.data ?? []).filter((s) => !isBlankBody(s.html_body));
    const snapBodies = new Set(snaps.map((s) => s.html_body));
    const draftRows = (drafts.data ?? []).filter((d) => !snapBodies.has(d.html_body));

    const merged: TimelineEntry[] = [
      ...snaps.map((snap) => ({ source: "snapshot" as const, at: snap.created_at, snap })),
      ...draftRows.map((draft) => ({ source: "draft" as const, at: draft.created_at, draft })),
    ].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());

    // The live body the run would publish: the snapshot flagged is_current
    // (matches the latest render), else the newest draft iteration.
    const current = snaps.find((s) => s.is_current)?.html_body ?? drafts.data?.[0]?.html_body ?? null;
    return { entries: merged, liveBody: current };
  }, [snapshots.data, drafts.data]);

  const isPending = snapshots.isPending || drafts.isPending;
  const error = snapshots.error ?? drafts.error;
  const total = entries.length;

  return (
    <>
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            AI draft iterations and reviewer snapshots in one timeline. Restoring
            first saves your current state, then loads the selected version.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1">
          {isPending && (
            <p className="font-mono text-[11px] text-ink-faint uppercase tracking-wider animate-pulse py-3">
              Loading history…
            </p>
          )}
          {!isPending && error && (
            <p className="font-mono text-[12px] text-accent-deep py-3">
              Failed to load history — {(error as Error).message}
            </p>
          )}
          {!isPending && !error && total === 0 && (
            <p className="font-mono text-[11px] text-ink-faint uppercase tracking-wider py-3">
              No saved versions yet.
            </p>
          )}
          {!isPending && !error && total > 0 && (
            <ul className="divide-y divide-rule">
              {entries.map((entry, i) => {
                const versionNumber = total - i;
                const isDraft = entry.source === "draft";
                const htmlBody = isDraft ? entry.draft.html_body : entry.snap.html_body;
                const createdAt = entry.at;
                const rowId = isDraft
                  ? `draft:${entry.draft.draft_id}`
                  : entry.snap.snapshot_id;
                const isCurrent = !isDraft && (entry.snap.is_current ?? false);
                const badgeTone = isDraft
                  ? "info"
                  : entry.snap.trigger === "generated"
                    ? "info"
                    : "neutral";
                const badgeLabel = isDraft
                  ? `AI · draft #${entry.draft.iteration}`
                  : TRIGGER_LABEL[entry.snap.trigger];
                const summary = isDraft
                  ? bodySummary(entry.draft.html_body, 0)
                  : bodySummary(entry.snap.html_body, entry.snap.comments?.length ?? 0);
                const author = isDraft ? "AI" : snapshotAuthor(entry.snap);

                return (
                  <li
                    key={rowId}
                    className="flex items-center justify-between gap-3 py-3"
                  >
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-mono text-[11px] text-ink-faint tabular-nums">
                          v{versionNumber}
                        </span>
                        <PaperStamp tone={badgeTone}>{badgeLabel}</PaperStamp>
                        {isCurrent && (
                          <PaperStamp tone="accent">
                            <span aria-label="Currently live version">● Live</span>
                          </PaperStamp>
                        )}
                        <span className="font-mono text-[12px] text-ink">
                          {relativeTime(createdAt)}
                        </span>
                        <span className="font-mono text-[10px] text-ink-faint">
                          {new Date(createdAt).toLocaleString()}
                        </span>
                      </div>
                      <p className="font-mono text-[11px] text-ink-faint mt-1 truncate">
                        {summary}
                      </p>
                      <p className="font-mono text-[11px] text-ink-faint truncate">
                        by {author}
                      </p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() =>
                          setDiffEntry({ label: `v${versionNumber} · ${badgeLabel}`, body: htmlBody })
                        }
                      >
                        Diff
                      </Button>
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={restoring}
                        onClick={() =>
                          onRestore(isDraft ? draftAsSnapshot(entry.draft) : entry.snap)
                        }
                      >
                        {restoring && restoringId === rowId ? "↻ Restoring…" : "Restore"}
                      </Button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>

    <Dialog
      open={diffEntry !== null}
      onOpenChange={(o) => {
        if (!o) setDiffEntry(null);
      }}
    >
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{diffEntry?.label ?? "Diff"}</DialogTitle>
          <DialogDescription>
            This version&rsquo;s body compared against the current live body.
          </DialogDescription>
        </DialogHeader>
        {diffEntry && (
          <VersionDiff
            before={diffEntry.body}
            after={currentBody ?? liveBody ?? ""}
            className="max-h-[55vh]"
            emptyLabel="This is the current live body — no differences."
          />
        )}
      </DialogContent>
    </Dialog>
    </>
  );
}
