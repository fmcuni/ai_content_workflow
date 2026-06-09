import { DurableObject } from "cloudflare:workers";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

/** Minimal binding env for the RunDoc collab sync DO (spike-local; Phase 1 folds
 * this into the app-wide Env in src/index.ts). */
export interface RunDocEnv {
  RUN_DOC: DurableObjectNamespace<RunDoc>;
}

// Wire protocol (mirrors y-websocket so the browser's
// @tiptap/extension-collaboration provider talks to us unmodified).
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
/** Server→client control frame: this session's server-issued cursor colour. */
const MESSAGE_INIT = 2;

/** Durable-storage key for the persisted Yjs state (a full state update). */
const DOC_KEY = "ydoc";
/** Debounce window before flushing the merged doc to DO storage. */
const PERSIST_DEBOUNCE_MS = 1_000;

/**
 * Server-issued cursor palette (decision 2026-06-09: colours are assigned by the
 * server per session, never self-picked). Round-robin by least current use.
 */
const CURSOR_PALETTE = [
  "#ef4444", "#f97316", "#eab308", "#22c55e", "#06b6d4",
  "#3b82f6", "#8b5cf6", "#ec4899", "#14b8a6", "#f43f5e",
] as const;

/**
 * Per-run collaborative document hub (Phase 0 spike).
 *
 * Holds the authoritative Yjs document for one run and relays the y-websocket
 * sync + awareness protocol between every connected editor, so concurrent edits
 * merge conflict-free (CRDT) and presence (live cursors) propagates. The merged
 * document is debounce-persisted to DO storage so it survives eviction.
 *
 * NOTE (spike): connections are held in-memory (matching RunStream's SSE Set),
 * not via WebSocket hibernation. Hibernation is a Phase 1 hardening.
 */
export class RunDoc extends DurableObject<RunDocEnv> {
  private readonly doc = new Y.Doc();
  private readonly awareness = new awarenessProtocol.Awareness(this.doc);
  private readonly conns = new Set<WebSocket>();
  /** Awareness client ids owned by each connection (for cleanup on close). */
  private readonly controlledIds = new Map<WebSocket, Set<number>>();
  /** Server-issued cursor colour per connection. */
  private readonly colours = new Map<WebSocket, string>();
  private loaded = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(ctx: DurableObjectState, env: RunDocEnv) {
    super(ctx, env);
    // The server holds no awareness state of its own.
    this.awareness.setLocalState(null);

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      const message = encoding.toUint8Array(encoder);
      for (const ws of this.conns) {
        if (ws !== origin) this.trySend(ws, message);
      }
      this.schedulePersist();
    });

    this.awareness.on(
      "update",
      (
        { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
        origin: unknown,
      ) => {
        const changedClients = added.concat(updated, removed);
        if (origin instanceof WebSocket) {
          const ids = this.controlledIds.get(origin);
          if (ids) {
            for (const id of added) ids.add(id);
            for (const id of removed) ids.delete(id);
          }
        }
        const encoder = encoding.createEncoder();
        encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(this.awareness, changedClients),
        );
        const message = encoding.toUint8Array(encoder);
        for (const ws of this.conns) {
          if (ws !== origin) this.trySend(ws, message);
        }
      },
    );
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    await this.ensureLoaded();

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    // Receive Yjs frames as ArrayBuffer (workerd defaults binary frames to Blob).
    server.binaryType = "arraybuffer";

    this.conns.add(server);
    this.controlledIds.set(server, new Set());
    const colour = this.assignColour();
    this.colours.set(server, colour);

    server.addEventListener("message", (event) => this.onMessage(server, event.data));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));

    // 1. Server-issued cursor colour for this session.
    this.trySend(server, this.initFrame(colour));
    // 2. Sync step 1 — ask the client to reconcile against our state vector.
    const syncEncoder = encoding.createEncoder();
    encoding.writeVarUint(syncEncoder, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(syncEncoder, this.doc);
    this.trySend(server, encoding.toUint8Array(syncEncoder));
    // 3. Current presence of everyone already connected.
    const states = this.awareness.getStates();
    if (states.size > 0) {
      const awarenessEncoder = encoding.createEncoder();
      encoding.writeVarUint(awarenessEncoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        awarenessEncoder,
        awarenessProtocol.encodeAwarenessUpdate(this.awareness, [...states.keys()]),
      );
      this.trySend(server, encoding.toUint8Array(awarenessEncoder));
    }

    return new Response(null, { status: 101, webSocket: client });
  }

  private onMessage(ws: WebSocket, data: unknown): void {
    let bytes: Uint8Array | null = null;
    if (data instanceof ArrayBuffer) bytes = new Uint8Array(data);
    else if (ArrayBuffer.isView(data))
      bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (!bytes) return; // ignore non-binary frames
    const decoder = decoding.createDecoder(bytes);
    const encoder = encoding.createEncoder();
    const messageType = decoding.readVarUint(decoder);
    switch (messageType) {
      case MESSAGE_SYNC: {
        encoding.writeVarUint(encoder, MESSAGE_SYNC);
        // Applies updates to this.doc with `ws` as origin → the doc 'update'
        // handler relays to the other connections. A non-empty reply (e.g. the
        // sync step 2 answering a step 1) goes back to this sender only.
        syncProtocol.readSyncMessage(decoder, encoder, this.doc, ws);
        if (encoding.length(encoder) > 1) this.trySend(ws, encoding.toUint8Array(encoder));
        break;
      }
      case MESSAGE_AWARENESS: {
        awarenessProtocol.applyAwarenessUpdate(
          this.awareness,
          decoding.readVarUint8Array(decoder),
          ws,
        );
        break;
      }
      default:
        break; // unknown frame — ignore
    }
  }

  private onClose(ws: WebSocket): void {
    if (!this.conns.has(ws)) return;
    this.conns.delete(ws);
    this.colours.delete(ws);
    const ids = this.controlledIds.get(ws);
    this.controlledIds.delete(ws);
    if (ids && ids.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], "disconnect");
    }
  }

  private initFrame(colour: string): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_INIT);
    encoding.writeVarString(encoder, JSON.stringify({ color: colour }));
    return encoding.toUint8Array(encoder);
  }

  /** Least-used colour from the palette, so small groups get distinct cursors. */
  private assignColour(): string {
    const inUse = [...this.colours.values()];
    let best: string = CURSOR_PALETTE[0]!;
    let bestCount = Infinity;
    for (const colour of CURSOR_PALETTE) {
      const count = inUse.filter((c) => c === colour).length;
      if (count < bestCount) {
        best = colour;
        bestCount = count;
      }
    }
    return best;
  }

  private trySend(ws: WebSocket, message: Uint8Array): void {
    try {
      ws.send(message);
    } catch {
      this.onClose(ws);
    }
  }

  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;
    const stored = await this.ctx.storage.get<Uint8Array>(DOC_KEY);
    if (stored) Y.applyUpdate(this.doc, stored, "storage");
    this.loaded = true;
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    try {
      await this.ctx.storage.put(DOC_KEY, Y.encodeStateAsUpdate(this.doc));
    } catch {
      // Persistence must never break the live stream; a later update retries.
    }
  }
}
