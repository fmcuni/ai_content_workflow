// ---------------------------------------------------------------------------
// Verbose per-step event log — pure derivation helpers + bulk insert.
//
// Every SSE event that flows through the RUN_STREAM Durable Object is parsed
// into a `content_tool.run_event_logs` row here. These helpers are PURE (no DB,
// no I/O) so they unit-test cleanly and stay byte-identical to the Python
// reference (`content_tool/observability/event_log.py`) and the frontend's
// understanding of the same contract.
//
// The DO owns the seq counter and the per-step ".start" timing map; this module
// only derives row shape from a single envelope + that caller-supplied context.
// ---------------------------------------------------------------------------

import type { getSql } from "./client";

type Sql = ReturnType<typeof getSql>;

/** Event-name verbs whose presence as the LAST segment means the segment
 *  before it is the node/step name (e.g. `strategy.outline.done` → "outline"). */
const VERBS = new Set(["start", "done", "error", "thinking", "completed", "interrupted"]);

const MAX_BYTES = 16_384;
const MAX_FIELD = 2_048;

export type LogLevel = "info" | "thinking" | "gate" | "error";
export type StreamKind = "run" | "batch";

/** The set of levels accepted by the read-API `level` filter. Anything else is
 *  ignored so a garbage query string never reaches the SQL filter. */
const LOG_LEVELS: readonly LogLevel[] = ["info", "thinking", "gate", "error"];

function isLogLevel(value: string): value is LogLevel {
  return (LOG_LEVELS as readonly string[]).includes(value);
}

/** Coerce a postgres.js numeric (string when fetch_types:false) to number|null. */
function toNumberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    if (value.trim() === "") {
      return null;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** The SSE envelope as POSTed to the DO `/append` route. */
export interface EventEnvelope {
  event: string;
  run_id?: string;
  batch_id?: string;
  timestamp: string;
  iteration?: number | null;
  payload?: unknown;
}

/** A derived `run_event_logs` row, ready to bulk-insert. */
export interface EventLogRow {
  stream_id: string;
  stream_kind: StreamKind;
  seq: number;
  event: string;
  level: LogLevel;
  step: string | null;
  iteration: number | null;
  duration_ms: number | null;
  payload: unknown;
  recorded_at: string;
}

/** Mutable map of step → epoch-ms of the most recent ".start" for that step,
 *  threaded by the DO so a later ".done" can compute its duration. */
export type StartMsByStep = Record<string, number>;

// ---------------------------------------------------------------------------
// Pure derivation
// ---------------------------------------------------------------------------

function byteLen(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Derive the `step` column from an event name. For verb-suffixed events the
 *  step is the segment before the verb; otherwise it is the final segment. */
export function deriveStep(event: string): string | null {
  const segments = event.split(".");
  const last = segments[segments.length - 1];
  if (last !== undefined && VERBS.has(last)) {
    return segments.length > 1 ? (segments[segments.length - 2] ?? null) : null;
  }
  return segments.length > 0 ? (segments[segments.length - 1] ?? null) : null;
}

/** Derive the `level` column from an event name. */
export function deriveLevel(event: string): LogLevel {
  if (event.endsWith(".thinking")) return "thinking";
  if (event.endsWith(".error") || event === "graph.error") return "error";
  if (event === "hitl.interrupted" || event.endsWith(".gate")) return "gate";
  return "info";
}

/** Whether this event should be PERSISTED given the PERSIST_THINKING toggle.
 *  Thinking events are always broadcast; they are only persisted when on. */
export function shouldPersist(event: string, persistThinking: boolean): boolean {
  if (event.endsWith(".thinking")) return persistThinking;
  return true;
}

/** Bound a payload to MAX_BYTES via per-field then whole-payload truncation. */
export function capPayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    // Non-object payloads: only summarize if the encoded form is oversized.
    const serialized = JSON.stringify(payload);
    if (serialized === undefined || byteLen(serialized) <= MAX_BYTES) {
      return payload;
    }
    return { _truncated: true, _bytes: byteLen(serialized) };
  }

  const entries = Object.entries(payload as Record<string, unknown>);
  const full = JSON.stringify(payload);
  if (full !== undefined && byteLen(full) <= MAX_BYTES) {
    return payload;
  }

  // Per-field cap: replace each oversized string field with a stub.
  const capped: Record<string, unknown> = {};
  for (const [key, value] of entries) {
    if (typeof value === "string" && byteLen(value) > MAX_FIELD) {
      capped[key] = { _truncated: true, _bytes: byteLen(value) };
    } else {
      capped[key] = value;
    }
  }
  const cappedSerialized = JSON.stringify(capped);
  if (cappedSerialized !== undefined && byteLen(cappedSerialized) <= MAX_BYTES) {
    return capped;
  }

  // Still too big: whole-payload summary.
  return {
    _truncated: true,
    _bytes: full === undefined ? 0 : byteLen(full),
    _keys: entries.map(([k]) => k).sort(),
  };
}

/**
 * Derive a full `run_event_logs` row from one envelope.
 *
 * `seq` is supplied by the caller (the DO's monotonic counter). `startMsByStep`
 * is mutated in place: a ".start" event records its epoch-ms keyed by step; a
 * ".done" event reads (and clears) the matching start to compute `duration_ms`.
 */
export function parseEventToRow(
  streamId: string,
  streamKind: StreamKind,
  envelope: EventEnvelope,
  seq: number,
  startMsByStep: StartMsByStep,
): EventLogRow {
  const event = envelope.event;
  const step = deriveStep(event);
  const recordedAt = envelope.timestamp;
  const recordedMs = Date.parse(recordedAt);

  let durationMs: number | null = null;
  if (event.endsWith(".start") && step !== null) {
    startMsByStep[step] = recordedMs;
  } else if (event.endsWith(".done") && step !== null) {
    const startMs = startMsByStep[step];
    if (startMs !== undefined && Number.isFinite(recordedMs)) {
      durationMs = recordedMs - startMs;
      delete startMsByStep[step];
    }
  }

  return {
    stream_id: streamId,
    stream_kind: streamKind,
    seq,
    event,
    level: deriveLevel(event),
    step,
    iteration: envelope.iteration ?? null,
    duration_ms: durationMs,
    payload: capPayload(envelope.payload ?? {}),
    recorded_at: recordedAt,
  };
}

// ---------------------------------------------------------------------------
// Persistence (bulk insert, idempotent on (stream_id, seq))
// ---------------------------------------------------------------------------

/**
 * Bulk-insert event rows. `ON CONFLICT (stream_id, seq) DO NOTHING` makes the
 * write idempotent so a Workflow replay (which re-emits memoized events) or a
 * retried DO alarm never double-inserts. JSON payloads are stringified so
 * postgres.js binds them as `jsonb` text.
 */
export async function persistEvents(sql: Sql, rows: readonly EventLogRow[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }
  const values = rows.map((r) => ({
    stream_id: r.stream_id,
    stream_kind: r.stream_kind,
    seq: r.seq,
    event: r.event,
    level: r.level,
    step: r.step,
    iteration: r.iteration,
    duration_ms: r.duration_ms,
    payload: JSON.stringify(r.payload),
    recorded_at: r.recorded_at,
  }));

  await sql`
    INSERT INTO content_tool.run_event_logs ${sql(
      values,
      "stream_id",
      "stream_kind",
      "seq",
      "event",
      "level",
      "step",
      "iteration",
      "duration_ms",
      "payload",
      "recorded_at",
    )}
    ON CONFLICT (stream_id, seq) DO NOTHING
  `;
}

// ---------------------------------------------------------------------------
// Read API
// ---------------------------------------------------------------------------

/** Default + hard cap on the number of rows a single /logs read returns. */
export const DEFAULT_LOG_LIMIT = 2_000;
export const MAX_LOG_LIMIT = 10_000;

export interface LogQuery {
  sinceSeq?: number;
  limit?: number;
  level?: string;
}

/** A row as returned by the read API (keys match the shared contract). */
export interface LogResponseRow {
  log_id: string;
  stream_id: string;
  stream_kind: string;
  seq: number;
  event: string;
  level: string;
  step: string | null;
  iteration: number | null;
  duration_ms: number | null;
  payload: unknown;
  recorded_at: string;
}

/** The raw shape a row arrives in from postgres.js. With `fetch_types:false`,
 *  numeric columns (seq, iteration, duration_ms) come back as strings. */
export interface RawLogRow {
  log_id: string;
  stream_id: string;
  stream_kind: string;
  seq: string | number;
  event: string;
  level: string;
  step: string | null;
  iteration: string | number | null;
  duration_ms: string | number | null;
  payload: unknown;
  recorded_at: string;
}

/**
 * Pure mapper from a raw DB row to the read-API response shape. Coerces the
 * postgres.js numeric strings (`seq`, `iteration`, `duration_ms`) to
 * `number | null` so the frontend renders durations as time, not literal
 * strings like "2500ms". Extracted as a pure function so it unit-tests without
 * a database.
 */
export function mapLogRow(row: RawLogRow): LogResponseRow {
  return {
    log_id: row.log_id,
    stream_id: row.stream_id,
    stream_kind: row.stream_kind,
    seq: toNumberOrNull(row.seq) ?? 0,
    event: row.event,
    level: row.level,
    step: row.step,
    iteration: toNumberOrNull(row.iteration),
    duration_ms: toNumberOrNull(row.duration_ms),
    payload: row.payload,
    recorded_at: row.recorded_at,
  };
}

/** Clamp a requested limit into [1, MAX_LOG_LIMIT], defaulting when unset. */
export function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
    return DEFAULT_LOG_LIMIT;
  }
  return Math.min(Math.trunc(limit), MAX_LOG_LIMIT);
}

/**
 * Read a stream's event log ordered by seq ASC. Supports `since_seq`
 * (seq > sinceSeq), a `limit` (clamped), and a `level` equality filter. `seq`
 * and `duration_ms` are coerced from postgres.js strings to numbers.
 */
export async function getEventLogs(
  sql: Sql,
  streamId: string,
  query: LogQuery,
): Promise<LogResponseRow[]> {
  const limit = clampLimit(query.limit);
  const sinceClause =
    query.sinceSeq !== undefined ? sql`AND seq > ${query.sinceSeq}` : sql``;
  const levelClause = query.level !== undefined ? sql`AND level = ${query.level}` : sql``;

  const rows = await sql<RawLogRow[]>`
    SELECT log_id, stream_id, stream_kind, seq, event, level, step,
           iteration, duration_ms, payload, recorded_at
    FROM content_tool.run_event_logs
    WHERE stream_id = ${streamId}
      ${sinceClause}
      ${levelClause}
    ORDER BY seq ASC
    LIMIT ${limit}
  `;

  return rows.map(mapLogRow);
}

/** Parse the query string of a /logs request into a typed LogQuery. */
export function parseLogQuery(searchParams: URLSearchParams): LogQuery {
  const query: LogQuery = {};
  const since = searchParams.get("since_seq");
  if (since !== null && since.trim() !== "") {
    const parsed = Number(since);
    if (Number.isFinite(parsed)) {
      query.sinceSeq = Math.trunc(parsed);
    }
  }
  const limit = searchParams.get("limit");
  if (limit !== null && limit.trim() !== "") {
    const parsed = Number(limit);
    if (Number.isFinite(parsed)) {
      query.limit = parsed;
    }
  }
  const level = searchParams.get("level");
  if (level !== null) {
    const normalized = level.trim();
    // Only accept a known level; ignore garbage so it never reaches the SQL filter.
    if (isLogLevel(normalized)) {
      query.level = normalized;
    }
  }
  return query;
}
