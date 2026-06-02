"use client";
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import { toast } from "sonner";

import { api, topicBatchesApi } from "@/lib/api";
import {
  filterRowsByLevel,
  formatLogDuration,
  formatLogTime,
  hasExpandablePayload,
  highestSeq,
  mergeLogRows,
  type LogLevelFilter,
  type MergedLogRow,
} from "@/lib/debug-log";
import type { RunEventLog, RunEventLogLevel, SseEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

const POLL_INTERVAL_MS = 3000;
const PAGE_LIMIT = 2000;
const DOWNLOAD_LIMIT = 1_000_000;
const RENDER_CAP = 500;

const FILTERS: { id: LogLevelFilter; label: string }[] = [
  { id: "milestones", label: "Milestones" },
  { id: "all", label: "All" },
  { id: "thinking", label: "Thinking" },
  { id: "errors", label: "Errors" },
];

interface DebugLogPanelProps {
  streamId: string;
  streamKind: "run" | "batch";
  liveEvents: SseEvent[];
  isActive: boolean;
}

function fetchLogs(
  streamKind: "run" | "batch",
  streamId: string,
  params: { since_seq?: number; limit?: number },
): Promise<RunEventLog[]> {
  return streamKind === "batch"
    ? topicBatchesApi.getLogs(streamId, params)
    : api.getRunLogs(streamId, params);
}

const LEVEL_GLYPH: Record<RunEventLogLevel, { ch: string; tone: string }> = {
  info: { ch: "▪", tone: "text-ink-soft" },
  gate: { ch: "▴", tone: "text-accent" },
  thinking: { ch: "◦", tone: "text-ink-faint" },
  error: { ch: "✕", tone: "text-accent-deep" },
};

export function DebugLogPanel({ streamId, streamKind, liveEvents, isActive }: DebugLogPanelProps) {
  const shortId = streamId.slice(0, 8);
  const [filter, setFilter] = React.useState<LogLevelFilter>("milestones");
  const [open, setOpen] = React.useState(true);
  const [downloading, setDownloading] = React.useState(false);
  const [expanded, setExpanded] = React.useState<Set<string>>(() => new Set());

  // Accumulate persisted rows across incremental polls so we never refetch the
  // full history. Each poll fetches only seq > the highest seq we already hold,
  // then merges the new rows into state (deduped by seq, ordered by seq ASC).
  const [persisted, setPersisted] = React.useState<RunEventLog[]>([]);

  // The incremental-poll cursor. A ref (not the `persisted` closure) is the
  // authoritative high-water mark so each poll reads the latest value rather
  // than a value captured when the queryFn was created — avoiding stale-closure
  // re-fetches from seq 0 and the StrictMode double-run setState anti-pattern.
  const highWaterRef = React.useRef(0);

  useQuery({
    queryKey: ["stream-logs", streamKind, streamId],
    queryFn: async () => {
      const since = highWaterRef.current;
      const fresh = await fetchLogs(streamKind, streamId, {
        since_seq: since > 0 ? since : undefined,
        limit: PAGE_LIMIT,
      });
      if (fresh.length > 0) {
        // Advance the cursor as soon as new rows arrive, in lockstep with the
        // accumulated rows below.
        const freshMax = highestSeq(fresh);
        if (freshMax > highWaterRef.current) highWaterRef.current = freshMax;
        setPersisted((prev) => {
          const bySeq = new Map<number, RunEventLog>();
          for (const r of prev) bySeq.set(r.seq, r);
          for (const r of fresh) bySeq.set(r.seq, r);
          return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
        });
      }
      return fresh;
    },
    refetchInterval: isActive ? POLL_INTERVAL_MS : false,
    refetchOnWindowFocus: false,
  });

  const merged = React.useMemo(
    () => mergeLogRows(persisted, liveEvents),
    [persisted, liveEvents],
  );
  const filtered = React.useMemo(() => filterRowsByLevel(merged, filter), [merged, filter]);

  const total = filtered.length;
  const visible = total > RENDER_CAP ? filtered.slice(total - RENDER_CAP) : filtered;

  const toggleExpanded = React.useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const onDownload = React.useCallback(async () => {
    setDownloading(true);
    try {
      const full = await fetchLogs(streamKind, streamId, { limit: DOWNLOAD_LIMIT });
      const blob = new Blob([JSON.stringify(full, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${streamKind}-${shortId}-debug-log.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      toast.error(`Could not download debug log: ${message}`);
    } finally {
      setDownloading(false);
    }
  }, [streamKind, streamId, shortId]);

  return (
    <section className="mt-8 border border-rule rounded-md bg-paper">
      <div className="flex items-center justify-between px-4 py-3 gap-3">
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="flex items-center gap-2 text-left"
        >
          <span className="kicker">Debug log</span>
          <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-ink-faint border border-rule rounded-sm px-1.5 py-[1px]">
            {streamKind} · {shortId}
          </span>
          <span className="font-mono text-[11px] text-ink-faint">{open ? "−" : "+"}</span>
        </button>
        <div className="flex items-center gap-2">
          <div className="flex items-center border border-rule rounded-sm overflow-hidden">
            {FILTERS.map((f) => (
              <button
                key={f.id}
                type="button"
                onClick={() => setFilter(f.id)}
                className={cn(
                  "font-mono text-[10px] uppercase tracking-[0.1em] px-2 py-1 transition-colors",
                  filter === f.id
                    ? "bg-ink text-paper"
                    : "text-ink-soft hover:text-ink hover:bg-paper-deep/40",
                )}
              >
                {f.label}
              </button>
            ))}
          </div>
          <button
            type="button"
            onClick={onDownload}
            disabled={downloading}
            className="font-mono text-[10px] uppercase tracking-[0.1em] px-2 py-1 border border-rule rounded-sm text-ink-soft hover:text-ink disabled:opacity-50"
          >
            {downloading ? "…" : "Download"}
          </button>
        </div>
      </div>

      {open && (
        <div className="border-t border-rule">
          {total > RENDER_CAP && (
            <p className="px-4 py-2 font-mono text-[10px] text-ink-faint border-b border-rule">
              showing latest {RENDER_CAP} of {total} — Download for full
            </p>
          )}
          {visible.length === 0 ? (
            <p className="px-4 py-6 text-ink-faint italic font-display text-[15px]">
              No log entries{filter !== "all" ? " at this level" : ""} yet.
            </p>
          ) : (
            <ol className="max-h-[460px] overflow-y-auto">
              {visible.map((r) => (
                <LogRow
                  key={r.key}
                  row={r}
                  expanded={expanded.has(r.key)}
                  onToggle={() => toggleExpanded(r.key)}
                />
              ))}
            </ol>
          )}
        </div>
      )}
    </section>
  );
}

function LogRow({
  row,
  expanded,
  onToggle,
}: {
  row: MergedLogRow;
  expanded: boolean;
  onToggle: () => void;
}) {
  const glyph = LEVEL_GLYPH[row.level];
  const duration = formatLogDuration(row.duration_ms);
  const canExpand = hasExpandablePayload(row.payload);

  const content = (
    <div className="grid grid-cols-[96px_16px_1fr] gap-3 items-start px-4 py-1.5 text-left w-full">
      <span className="font-mono text-[11px] text-ink-faint tabular-nums pt-[2px]">
        {formatLogTime(row.recordedAt)}
      </span>
      <span className={cn("text-[12px] leading-none pt-[4px]", glyph.tone)} aria-hidden>
        {glyph.ch}
      </span>
      <div className="min-w-0">
        <p className="font-mono text-[12px] text-ink break-words flex flex-wrap items-baseline gap-x-2">
          <span>{row.event}</span>
          {row.step && <span className="text-ink-faint">· {row.step}</span>}
          {row.iteration !== null && (
            <span className="text-ink-faint tabular-nums">· iter {row.iteration}</span>
          )}
          {duration && <span className="text-accent tabular-nums">· {duration}</span>}
          {row.source === "live" && (
            <span className="font-mono text-[9px] uppercase tracking-[0.14em] text-accent animate-pulse">
              live
            </span>
          )}
        </p>
        {expanded && canExpand && (
          <pre className="mt-1 max-h-64 overflow-auto bg-paper-deep/40 border border-rule rounded-sm p-2 font-mono text-[11px] text-ink-soft whitespace-pre-wrap break-words">
            {JSON.stringify(row.payload, null, 2)}
          </pre>
        )}
      </div>
    </div>
  );

  return (
    <li className="border-b border-rule last:border-b-0">
      {canExpand ? (
        <button type="button" onClick={onToggle} className="w-full hover:bg-paper-deep/30">
          {content}
        </button>
      ) : (
        content
      )}
    </li>
  );
}
