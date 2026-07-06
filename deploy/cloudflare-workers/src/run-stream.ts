import { DurableObject } from "cloudflare:workers";

import { getSql } from "./db/client";
import {
  parseEventToRow,
  persistEvents,
  shouldPersist,
  type EventEnvelope,
  type EventLogRow,
  type StartMsByStep,
  type StreamKind,
} from "./db/event-log";
import type { Env } from "./index";

const SSE_HEADERS = {
  "content-type": "text/event-stream",
  "cache-control": "no-cache",
  connection: "keep-alive",
} as const;

// Cap the persisted replay buffer (mirrors RunExecutor._EVENT_BUFFER_SIZE = 500).
// Oldest events are dropped first so a late subscriber still sees the most
// recent, structurally meaningful timeline rather than nothing.
const EVENT_BUFFER_SIZE = 500;

// Heartbeat cadence — a comment frame keeps idle SSE connections (and any proxy
// in between) from being torn down while a run is paused at a HITL gate.
const HEARTBEAT_MS = 15_000;

const HEARTBEAT_FRAME = ": ping\n\n";

// Durable-storage keys for the per-stream verbose event log.
const SEQ_KEY = "seq"; // monotonic seq counter (number), starts at 0
const PENDING_KEY = "pending_logs"; // EventLogRow[] awaiting a DB flush
const START_MS_KEY = "start_ms"; // StartMsByStep map for .done duration derivation

// Debounce window before the alarm flushes pending rows to Postgres. Batches
// the bursty append traffic into one INSERT per ~2s instead of one per event.
const FLUSH_DELAY_MS = 2_000;

/**
 * Per-run event hub. The Workflow POSTs progress events here (`/append`); the
 * browser opens an SSE stream (`/events`). Milestone events are persisted in DO
 * storage (capped at EVENT_BUFFER_SIZE) so a late subscriber replays history,
 * then receives live updates. This is the Workers-native stand-in for the
 * Python app's in-process SSE (content_tool/api/sse.py RunExecutor).
 *
 * `*.thinking` events are broadcast live ONLY — they are never persisted to the
 * replay buffer (they accumulate fast, one per Gemini thought chunk, and would
 * otherwise evict the milestone events the timeline actually replays). This
 * mirrors RunExecutor._emit's `if not event.endswith(".thinking")` guard.
 */
export class RunStream extends DurableObject<Env> {
  private readonly encoder = new TextEncoder();
  private readonly controllers = new Set<ReadableStreamDefaultController<Uint8Array>>();
  private heartbeat: ReturnType<typeof setInterval> | null = null;

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/append") {
      const event = (await request.json()) as Record<string, unknown>;
      // Thinking chunks are live-only for the SSE replay buffer: broadcast but
      // DO NOT add to the in-memory milestone buffer.
      if (!isThinkingEvent(event)) {
        await this.persist(event);
      }
      // Verbose persisted log (separate from the replay buffer): every event,
      // including raw *.thinking, is appended to the pending-flush queue and
      // written to Postgres on the next alarm. Persistence must never break
      // streaming, so enqueue failures are swallowed.
      try {
        await this.enqueueLog(event);
      } catch {
        // Never let log persistence interfere with the live stream.
      }
      this.broadcast(event);
      return new Response("ok");
    }

    if (url.pathname === "/dump") {
      const events = await this.loadEvents();
      return Response.json({ count: events.length, events });
    }

    if (url.pathname === "/events") {
      return this.openStream();
    }

    return new Response("not found", { status: 404 });
  }

  // -------------------------------------------------------------------------
  // Storage
  // -------------------------------------------------------------------------

  private async loadEvents(): Promise<Record<string, unknown>[]> {
    return (await this.ctx.storage.get<Record<string, unknown>[]>("events")) ?? [];
  }

  /** Append one milestone event, dropping the oldest once the cap is reached. */
  private async persist(event: Record<string, unknown>): Promise<void> {
    const events = await this.loadEvents();
    events.push(event);
    // Bounded buffer: keep only the most recent EVENT_BUFFER_SIZE events.
    const trimmed =
      events.length > EVENT_BUFFER_SIZE
        ? events.slice(events.length - EVENT_BUFFER_SIZE)
        : events;
    await this.ctx.storage.put("events", trimmed);
  }

  // -------------------------------------------------------------------------
  // Verbose persisted event log → content_tool.run_event_logs
  //
  // The DO is the ONLY place that sees every event (incl. *.thinking), so it
  // owns the monotonic per-stream seq and the per-step ".start" timing map used
  // to compute .done durations. Rows accumulate in `pending_logs` and a single
  // debounced alarm bulk-inserts them with ON CONFLICT DO NOTHING (idempotent
  // against Workflow replays and retried alarms).
  // -------------------------------------------------------------------------

  /** Derive a row for this event, assign the next seq, and queue it for flush.
   *  Honors PERSIST_THINKING: thinking events are skipped here when off (they
   *  are still broadcast by the caller). */
  private async enqueueLog(event: Record<string, unknown>): Promise<void> {
    const name = event["event"];
    if (typeof name !== "string") {
      return;
    }
    if (!shouldPersist(name, persistThinkingEnabled(this.env))) {
      return;
    }

    const streamId = streamIdOf(event);
    if (streamId === null) {
      return;
    }
    const streamKind = streamKindOf(event);

    // Topic batches fan out ~5 candidates concurrently → concurrent POST /append
    // to one batch DO. The read→derive→write below MUST be atomic: separate
    // awaited storage ops can interleave across concurrent appends and lose a
    // seq increment or clobber `pending`. blockConcurrencyWhile fully serializes
    // them so each append sees the prior append's committed state.
    await this.ctx.blockConcurrencyWhile(async () => {
      const seq = (await this.ctx.storage.get<number>(SEQ_KEY)) ?? 0;
      const startMs = (await this.ctx.storage.get<StartMsByStep>(START_MS_KEY)) ?? {};

      const row = parseEventToRow(streamId, streamKind, toEnvelope(event), seq, startMs);

      const pending = (await this.ctx.storage.get<EventLogRow[]>(PENDING_KEY)) ?? [];
      pending.push(row);

      await this.ctx.storage.put(PENDING_KEY, pending);
      await this.ctx.storage.put(SEQ_KEY, seq + 1);
      await this.ctx.storage.put(START_MS_KEY, startMs);

      await this.ensureFlushAlarm();
    });
  }

  /** Schedule the flush alarm unless one is already pending. */
  private async ensureFlushAlarm(): Promise<void> {
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_DELAY_MS);
    }
  }

  /** Alarm: bulk-insert pending rows. Uses snapshot-and-clear so any /append
   *  arriving DURING the (slow) PG write accumulates into a fresh `pending` and
   *  is never deleted unflushed. On success the snapshot is already cleared; on
   *  failure the snapshot is re-prepended to the current pending and retried.
   *  Never throws. */
  async alarm(): Promise<void> {
    // Atomically take a snapshot of the pending rows and clear the slot, so
    // concurrent appends during the PG write below land in a fresh buffer
    // rather than being clobbered when we clear.
    const snapshot = await this.ctx.blockConcurrencyWhile(async () => {
      const pending = (await this.ctx.storage.get<EventLogRow[]>(PENDING_KEY)) ?? [];
      if (pending.length === 0) {
        return [] as EventLogRow[];
      }
      await this.ctx.storage.put(PENDING_KEY, [] as EventLogRow[]);
      return pending;
    });

    if (snapshot.length === 0) {
      return;
    }

    // Persist OUTSIDE the block: the PG round-trip must not stall new appends.
    // ON CONFLICT (stream_id, seq) DO NOTHING keeps this idempotent against a
    // retry that re-inserts rows a prior attempt may have partially committed.
    // A DO alarm runs outside any request's AsyncLocalStorage scope (see
    // src/db/client.ts), so getSql() here always builds a fresh, uncached
    // client — this alarm owns its full lifecycle and must close it itself.
    const sql = getSql(this.env);
    try {
      await persistEvents(sql, snapshot);
      // Success: snapshot already cleared; new appends accumulate safely.
    } catch {
      // Failure: re-prepend the snapshot ahead of any rows appended meanwhile so
      // seq order is preserved, then reschedule. Done inside the block to stay
      // atomic against concurrent appends mutating `pending`.
      await this.ctx.blockConcurrencyWhile(async () => {
        const current = (await this.ctx.storage.get<EventLogRow[]>(PENDING_KEY)) ?? [];
        await this.ctx.storage.put(PENDING_KEY, [...snapshot, ...current]);
      });
      await this.ctx.storage.setAlarm(Date.now() + FLUSH_DELAY_MS);
    } finally {
      this.ctx.waitUntil(sql.end().catch(() => undefined));
    }
  }

  // -------------------------------------------------------------------------
  // SSE stream
  // -------------------------------------------------------------------------

  private openStream(): Response {
    const controllers = this.controllers;
    const encode = (e: unknown): Uint8Array => this.encoder.encode(frame(e));
    const encodeRaw = (s: string): Uint8Array => this.encoder.encode(s);
    const ensureHeartbeat = (): void => this.ensureHeartbeat();
    const maybeStopHeartbeat = (): void => this.maybeStopHeartbeat();
    const loadEvents = (): Promise<Record<string, unknown>[]> => this.loadEvents();

    let active: ReadableStreamDefaultController<Uint8Array> | undefined;

    const replay = async (
      controller: ReadableStreamDefaultController<Uint8Array>,
    ): Promise<void> => {
      active = controller;
      // Replay persisted history first so a late subscriber sees the timeline
      // so far before live events arrive.
      const stored = await loadEvents();
      for (const e of stored) {
        controller.enqueue(encode(e));
      }
      controllers.add(controller);
      ensureHeartbeat();
    };

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Emit a heartbeat immediately so the client sees bytes (and the proxy
        // commits the response) before history replay completes.
        controller.enqueue(encodeRaw(HEARTBEAT_FRAME));
        return replay(controller);
      },
      cancel() {
        if (active) {
          controllers.delete(active);
        }
        maybeStopHeartbeat();
      },
    });

    return new Response(stream, { headers: SSE_HEADERS });
  }

  private broadcast(event: Record<string, unknown>): void {
    this.fanOut(this.encoder.encode(frame(event)));
  }

  /** Push a raw byte chunk to every live controller, dropping dead readers. */
  private fanOut(chunk: Uint8Array): void {
    for (const controller of this.controllers) {
      try {
        controller.enqueue(chunk);
      } catch {
        // Reader gone; drop it.
        this.controllers.delete(controller);
      }
    }
    this.maybeStopHeartbeat();
  }

  // -------------------------------------------------------------------------
  // Heartbeat — only runs while there is at least one live subscriber.
  // -------------------------------------------------------------------------

  private ensureHeartbeat(): void {
    if (this.heartbeat !== null || this.controllers.size === 0) {
      return;
    }
    const ping = this.encoder.encode(HEARTBEAT_FRAME);
    this.heartbeat = setInterval(() => {
      this.fanOut(ping);
    }, HEARTBEAT_MS);
  }

  private maybeStopHeartbeat(): void {
    if (this.controllers.size === 0 && this.heartbeat !== null) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Match RunExecutor's `event.endswith(".thinking")` guard. */
function isThinkingEvent(event: Record<string, unknown>): boolean {
  const name = event["event"];
  return typeof name === "string" && name.endsWith(".thinking");
}

function frame(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

/** PERSIST_THINKING toggle: ON by default; "0"/"false"/"off" disable it. */
function persistThinkingEnabled(env: Env): boolean {
  const raw = env.PERSIST_THINKING;
  if (raw === undefined) {
    return true;
  }
  const normalized = raw.trim().toLowerCase();
  return !(normalized === "0" || normalized === "false" || normalized === "off");
}

/** The stream id is the run_id (run streams) or batch_id (topic batches). */
function streamIdOf(event: Record<string, unknown>): string | null {
  const runId = event["run_id"];
  if (typeof runId === "string" && runId.length > 0) {
    return runId;
  }
  const batchId = event["batch_id"];
  if (typeof batchId === "string" && batchId.length > 0) {
    return batchId;
  }
  return null;
}

/** A `batch_id` envelope is a topic batch; everything else is a run. */
function streamKindOf(event: Record<string, unknown>): StreamKind {
  const batchId = event["batch_id"];
  return typeof batchId === "string" && batchId.length > 0 ? "batch" : "run";
}

/** Narrow a raw append body into the typed envelope the parser expects. */
function toEnvelope(event: Record<string, unknown>): EventEnvelope {
  const iterationRaw = event["iteration"];
  return {
    event: String(event["event"]),
    timestamp: typeof event["timestamp"] === "string" ? event["timestamp"] : "",
    iteration: typeof iterationRaw === "number" ? iterationRaw : null,
    payload: event["payload"] ?? {},
  };
}
