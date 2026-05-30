"use client";
import { useQuery } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { PaperStamp } from "@/components/PaperStamp";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { api } from "@/lib/api";
import type { Hitl2Snapshot, Hitl2SnapshotTrigger } from "@/lib/types";

const TRIGGER_LABEL: Record<Hitl2SnapshotTrigger, string> = {
  interval: "auto · 5-min",
  navigate: "auto · left page",
  unload: "auto · closed tab",
  manual: "manual",
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

/** Blank-body snapshots are teardown artifacts — never offer them for restore. */
function isBlankBody(html: string): boolean {
  return html.replace(/<[^>]*>/g, "").replace(/ /g, "").trim().length === 0;
}

function snapshotSummary(s: Hitl2Snapshot): string {
  const bodyChars = s.html_body.length.toLocaleString();
  const commentCount = s.comments?.length ?? 0;
  return `${bodyChars} chars · ${commentCount} comment${commentCount === 1 ? "" : "s"}`;
}

interface Props {
  runId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRestore: (snapshot: Hitl2Snapshot) => void;
  /** True while a restore is in flight (disables all Restore buttons). */
  restoring?: boolean;
  /** The snapshot currently being restored, for a per-row "Restoring…" label. */
  restoringId?: string | null;
}

export function Hitl2VersionHistory({
  runId,
  open,
  onOpenChange,
  onRestore,
  restoring = false,
  restoringId = null,
}: Props) {
  const snapshots = useQuery({
    queryKey: ["hitl2-snapshots", runId],
    queryFn: () => api.listHitl2Snapshots(runId),
    enabled: open,
    refetchOnMount: "always",
  });
  const versions = snapshots.data?.filter((s) => !isBlankBody(s.html_body));

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Version history</DialogTitle>
          <DialogDescription>
            Autosaved snapshots of the edit, WP metadata, and comments. Restoring
            first saves your current state, then loads the selected version.
          </DialogDescription>
        </DialogHeader>

        <div className="max-h-[60vh] overflow-y-auto -mx-1 px-1">
          {snapshots.isPending && (
            <p className="font-mono text-[11px] text-ink-faint uppercase tracking-wider animate-pulse py-3">
              Loading history…
            </p>
          )}
          {snapshots.isError && (
            <p className="font-mono text-[12px] text-accent-deep py-3">
              Failed to load history — {(snapshots.error as Error).message}
            </p>
          )}
          {versions?.length === 0 && (
            <p className="font-mono text-[11px] text-ink-faint uppercase tracking-wider py-3">
              No saved versions yet.
            </p>
          )}
          {versions && versions.length > 0 && (
            <ul className="divide-y divide-rule">
              {versions.map((s) => (
                <li
                  key={s.snapshot_id}
                  className="flex items-center justify-between gap-3 py-3"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <PaperStamp tone="neutral">{TRIGGER_LABEL[s.trigger]}</PaperStamp>
                      <span className="font-mono text-[12px] text-ink">
                        {relativeTime(s.created_at)}
                      </span>
                      <span className="font-mono text-[10px] text-ink-faint">
                        {new Date(s.created_at).toLocaleString()}
                      </span>
                    </div>
                    <p className="font-mono text-[11px] text-ink-faint mt-1 truncate">
                      {snapshotSummary(s)}
                    </p>
                  </div>
                  <Button
                    variant="secondary"
                    size="sm"
                    disabled={restoring}
                    onClick={() => onRestore(s)}
                  >
                    {restoring && restoringId === s.snapshot_id ? "↻ Restoring…" : "Restore"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
