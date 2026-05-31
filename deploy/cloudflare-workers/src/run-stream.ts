import { DurableObject } from "cloudflare:workers";

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
      // Thinking chunks are live-only: broadcast but DO NOT persist.
      if (!isThinkingEvent(event)) {
        await this.persist(event);
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
