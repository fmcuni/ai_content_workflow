import type { RunEventLog, RunEventLogLevel, SseEvent } from "@/lib/types";

// A unified row for the debug-log panel. Persisted rows carry the full
// authoritative shape; live-only rows are projected from SSE events that have
// not yet been persisted (no seq) and render with a subtle "live" marker.
export interface MergedLogRow {
  key: string;
  source: "persisted" | "live";
  seq: number | null;
  event: string;
  level: RunEventLogLevel;
  step: string | null;
  iteration: number | null;
  duration_ms: number | null;
  payload: Record<string, unknown>;
  recordedAt: string;
}

export type LogLevelFilter = "all" | "milestones" | "thinking" | "errors";

// Highest persisted seq already loaded — the cursor for incremental polling.
export function highestSeq(rows: readonly RunEventLog[]): number {
  let max = 0;
  for (const r of rows) {
    if (r.seq > max) max = r.seq;
  }
  return max;
}

function persistedToRow(row: RunEventLog): MergedLogRow {
  return {
    key: `p:${row.log_id}`,
    source: "persisted",
    seq: row.seq,
    event: row.event,
    level: row.level,
    step: row.step,
    iteration: row.iteration,
    duration_ms: row.duration_ms,
    payload: row.payload,
    recordedAt: row.recorded_at,
  };
}

// Map a live SSE event onto a row. SSE events have no level/step/duration, so
// we infer a level from the event name to keep filtering coherent.
function liveLevelFor(event: string): RunEventLogLevel {
  const e = event.toLowerCase();
  if (e.endsWith(".thinking")) return "thinking";
  if (e.includes("error") || e.includes("fail")) return "error";
  if (e.includes("hitl") || e.includes("human") || e.includes("await") || e.includes("gate")) {
    return "gate";
  }
  return "info";
}

function liveToRow(ev: SseEvent): MergedLogRow {
  return {
    key: `l:${ev.event}:${ev.timestamp}`,
    source: "live",
    seq: null,
    event: ev.event,
    level: liveLevelFor(ev.event),
    step: null,
    iteration: ev.iteration ?? null,
    duration_ms: null,
    payload: ev.payload,
    recordedAt: ev.timestamp,
  };
}

// Merge persisted rows (authoritative, ordered by seq) with live SSE events
// that are newer than the persisted high-water mark. Live events already
// represented in the persisted set (same event + timestamp) are dropped so a
// row does not flicker between "live" and "persisted" on each poll.
export function mergeLogRows(
  persisted: readonly RunEventLog[],
  live: readonly SseEvent[],
): MergedLogRow[] {
  const ordered = [...persisted].sort((a, b) => a.seq - b.seq);
  const rows = ordered.map(persistedToRow);

  const persistedKeys = new Set(ordered.map((r) => `${r.event}:${r.recorded_at}`));
  let maxRecordedAt = 0;
  for (const r of ordered) {
    const t = Date.parse(r.recorded_at);
    if (!Number.isNaN(t) && t > maxRecordedAt) maxRecordedAt = t;
  }

  // Sort the live tail chronologically so out-of-order SSE arrivals still
  // render in timestamp order. Dedup below is keyed by identity, so ordering
  // here does not affect which events survive.
  const orderedLive = [...live].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const seenLive = new Set<string>();
  for (const ev of orderedLive) {
    const identity = `${ev.event}:${ev.timestamp}`;
    if (persistedKeys.has(identity)) continue;
    if (seenLive.has(identity)) continue;
    const t = Date.parse(ev.timestamp);
    // Keep live events strictly newer than the persisted frontier. When there
    // is no persisted data yet (maxRecordedAt === 0) keep everything.
    if (maxRecordedAt > 0 && !Number.isNaN(t) && t <= maxRecordedAt) continue;
    seenLive.add(identity);
    rows.push(liveToRow(ev));
  }

  return rows;
}

const MILESTONE_LEVELS: ReadonlySet<RunEventLogLevel> = new Set(["info", "gate"]);

export function filterRowsByLevel(
  rows: readonly MergedLogRow[],
  filter: LogLevelFilter,
): MergedLogRow[] {
  switch (filter) {
    case "all":
      return [...rows];
    case "milestones":
      return rows.filter((r) => MILESTONE_LEVELS.has(r.level));
    case "thinking":
      return rows.filter((r) => r.level === "thinking");
    case "errors":
      return rows.filter((r) => r.level === "error");
    default:
      return [...rows];
  }
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

// HH:MM:SS.mmm in local time, mono/tabular-friendly.
export function formatLogTime(iso: string): string {
  const d = new Date(iso);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

const ONE_SECOND_MS = 1000;

export function formatLogDuration(ms: number | null | undefined): string | null {
  if (ms === null || ms === undefined) return null;
  if (ms < ONE_SECOND_MS) return `${Math.round(ms)}ms`;
  return `${(ms / ONE_SECOND_MS).toFixed(1)}s`;
}

// Whether a payload is worth rendering an expand affordance for.
export function hasExpandablePayload(payload: Record<string, unknown>): boolean {
  return payload !== null && typeof payload === "object" && Object.keys(payload).length > 0;
}
