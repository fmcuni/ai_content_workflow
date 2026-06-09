import { DurableObject } from "cloudflare:workers";
import postgres from "postgres";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { parseRunIdFromUrl } from "./run-doc-persistence";

/** Minimal binding env for the RunDoc collab sync DO (spike-local; Phase 1 folds
 * this into the app-wide Env in src/index.ts). */
export interface RunDocEnv {
  RUN_DOC: DurableObjectNamespace<RunDoc>;
  /**
   * Hyperdrive binding for the Postgres cold-store / backup layer.
   *
   * OPTIONAL on purpose: the hermetic workers-pool harness
   * (run-doc.harness.ts / vitest.workers.config.ts) binds only `RUN_DOC` and no
   * Hyperdrive, and its env `{ RUN_DOC }` must still satisfy this type. When the
   * binding is absent the DO falls back to DO-storage-only (the Phase 0
   * behaviour) — the Postgres backup/cold-load is a strict no-op.
   */
  HYPERDRIVE?: Hyperdrive;
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
/** Postgres cold-store table for the per-run merged Yjs doc (DO-eviction backup). */
const COLLAB_TABLE = "content_tool.run_collab_state";

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
  /**
   * The one connection designated as the seed authority for an empty doc.
   * The DO is the single source of truth for first-write, so exactly one
   * joiner is told `primary: true` and seeds the initial content; everyone
   * else is told `primary: false` and must not seed (closes the
   * two-first-joiners duplicate-seed race the client guard alone can't).
   */
  private seederWs: WebSocket | null = null;
  private loaded = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  /**
   * This DO's run id, parsed from the upgrade URL (`/runs/:id/doc`). The DO is
   * addressed via `idFromName(runId)` but never receives that name, so we read
   * it off the request. Stays null if the URL doesn't match → the Postgres
   * cold-store path no-ops rather than keying on a guessed/wrong id.
   */
  private runId: string | null = null;

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
    // Capture the run id from the upgrade URL before the first load so the
    // Postgres cold-store can key on it (see `runId` field).
    if (this.runId === null) this.runId = parseRunIdFromUrl(request.url);
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

    // Grant the seeder role to the FIRST connection that reaches an empty doc
    // while no seeder is assigned yet (sticky). A returning run is non-empty
    // after ensureLoaded() → primary=false for everyone (no seed needed); a
    // second concurrent joiner sees seederWs !== null → primary=false.
    let primary = false;
    if (this.seederWs === null && this.docIsEmpty()) {
      this.seederWs = server;
      primary = true;
    }

    server.addEventListener("message", (event) => this.onMessage(server, event.data));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));

    // 1. Server-issued cursor colour + seeder grant for this session.
    this.trySend(server, this.initFrame(colour, primary));
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
    // Release the seeder grant if the designated seeder leaves. Sticky-then-
    // released: while the doc is still empty the next joiner can claim it; once
    // the doc has content docIsEmpty() is false so no new primary is granted
    // anyway. Narrow residual: a client already told primary=false will not be
    // re-granted on a later seeder departure — acceptable, and far better than
    // duplicate seeding.
    if (ws === this.seederWs) this.seederWs = null;
    const ids = this.controlledIds.get(ws);
    this.controlledIds.delete(ws);
    if (ids && ids.size > 0) {
      awarenessProtocol.removeAwarenessStates(this.awareness, [...ids], "disconnect");
    }
  }

  private initFrame(colour: string, primary: boolean): Uint8Array {
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_INIT);
    encoding.writeVarString(encoder, JSON.stringify({ color: colour, primary }));
    return encoding.toUint8Array(encoder);
  }

  /**
   * Schema-agnostic emptiness check: an empty Y.Doc encodes its full state as
   * the 2-byte update `[0,0]`; any content makes it longer. Avoids reaching
   * into `this.doc.store` internals.
   */
  private docIsEmpty(): boolean {
    try {
      return Y.encodeStateAsUpdate(this.doc).byteLength <= 2;
    } catch {
      // On the (very unlikely) encode failure, bias toward "empty" so a seeder
      // is still granted rather than the run being permanently unseeded: an
      // erroneously-granted primary that turns out to face content simply
      // no-ops in seedCollabDocIfEmpty (editor.isEmpty === false) after sync.
      return true;
    }
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
    // A DO does NOT serialize concurrent fetch() handlers across await points, so
    // two simultaneous first connects could both pass the `loaded` check and load
    // twice. Fence the load (as RunStream does) and re-check inside, so only the
    // first caller hydrates the doc.
    await this.ctx.blockConcurrencyWhile(async () => {
      if (this.loaded) return;
      const stored = await this.ctx.storage.get<Uint8Array>(DOC_KEY);
      if (stored) {
        Y.applyUpdate(this.doc, stored, "storage");
      } else {
        // DO storage was empty (cold DO, possibly relocated/evicted). Fall back to
        // the Postgres cold-store so the doc survives DO loss. Strict no-op when
        // no Hyperdrive is bound (the workers-pool harness) or the run id is
        // unknown — never throws, so a backup miss can't block the live sync.
        await this.coldLoadFromDb();
      }
      this.loaded = true;
    });
  }

  /** Best-effort cold-load of the merged doc from Postgres into this.doc. */
  private async coldLoadFromDb(): Promise<void> {
    const env = this.env.HYPERDRIVE;
    if (!env || !this.runId) return;
    let sql: ReturnType<typeof postgres> | null = null;
    try {
      sql = this.openSql(env);
      // Read bytea as base64 text (encode(...)) so the round-trip does not depend
      // on postgres.js bytea OID parsing under `fetch_types: false`.
      const rows = await sql<{ ydoc_b64: string }[]>`
        SELECT encode(ydoc, 'base64') AS ydoc_b64
        FROM ${sql(COLLAB_TABLE)} WHERE run_id = ${this.runId}
      `;
      const b64 = rows[0]?.ydoc_b64;
      if (b64) {
        const bytes = new Uint8Array(Buffer.from(b64, "base64"));
        if (bytes.byteLength > 0) Y.applyUpdate(this.doc, bytes, "db");
      }
    } catch {
      // A cold-store miss/failure must never break the live sync; the DO simply
      // starts from an empty doc and the first persist re-seeds Postgres.
    } finally {
      // A DO has no executionCtx — close the socket inline rather than deferring.
      if (sql) await sql.end().catch(() => undefined);
    }
  }

  private schedulePersist(): void {
    if (this.persistTimer) return;
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persist(): Promise<void> {
    let update: Uint8Array;
    try {
      update = Y.encodeStateAsUpdate(this.doc);
    } catch {
      // Can't snapshot the doc; a later update retries. (Never throw — the timer
      // fire-and-forgets this, so a reject would be unhandled.)
      return;
    }
    // DO storage and the Postgres cold-store are INDEPENDENT best-effort backups:
    // if DO storage fails, Postgres is the only recovery path, so the DB backup
    // must still run. Neither failure may break the live stream (a later flush
    // retries both; both swallow their own errors).
    await this.ctx.storage.put(DOC_KEY, update).catch(() => undefined);
    // Cadence (KISS, v1): one upsert per DO-storage flush — already throttled by
    // the 1s persist debounce, so write volume is bounded without extra bookkeeping.
    await this.backupToDb(update);
  }

  /** Best-effort UPSERT of the merged doc into the Postgres cold-store. */
  private async backupToDb(update: Uint8Array): Promise<void> {
    const env = this.env.HYPERDRIVE;
    if (!env || !this.runId) return; // strict no-op without a DB binding / run id
    let sql: ReturnType<typeof postgres> | null = null;
    try {
      sql = this.openSql(env);
      // Send the binary payloads as base64 text decoded server-side
      // (decode(...,'base64')), so the write does not depend on postgres.js
      // serializing a Uint8Array to bytea — robust under `fetch_types: false`.
      const ydocB64 = Buffer.from(update).toString("base64");
      const stateVectorB64 = Buffer.from(Y.encodeStateVector(this.doc)).toString("base64");
      await sql`
        INSERT INTO ${sql(COLLAB_TABLE)} (run_id, ydoc, state_vector, updated_at)
        VALUES (
          ${this.runId},
          decode(${ydocB64}, 'base64'),
          decode(${stateVectorB64}, 'base64'),
          now()
        )
        ON CONFLICT (run_id) DO UPDATE
          SET ydoc = EXCLUDED.ydoc,
              state_vector = EXCLUDED.state_vector,
              updated_at = now()
      `;
    } catch {
      // A backup failure must NEVER break the live sync; the next flush retries.
    } finally {
      if (sql) await sql.end().catch(() => undefined);
    }
  }

  /**
   * Short-lived postgres client over Hyperdrive. Mirrors src/db/client.ts
   * (`fetch_types: false`), but `max: 1` — a DO holds one connection at a time
   * for its single backup/cold-load query, then closes it inline.
   */
  private openSql(hyperdrive: Hyperdrive): ReturnType<typeof postgres> {
    return postgres(hyperdrive.connectionString, { max: 1, fetch_types: false });
  }
}
