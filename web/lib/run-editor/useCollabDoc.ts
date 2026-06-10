import { useEffect, useRef, useState } from "react";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { Awareness } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

import { withSseTicket } from "@/lib/sse-ticket";

// Wire protocol — MUST stay byte-identical to the RunDoc Durable Object
// (deploy/cloudflare-workers/src/run-doc.ts). The first varUint of every frame
// is the message type.
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
/** Server→client control frame: this session's server-issued cursor colour. */
const MESSAGE_INIT = 2;

/** "connected" means SYNCED: the server's sync step-2 (the DO's doc state) has
 *  been applied to the local ydoc — not merely that the socket/INIT arrived.
 *  Consumers gate Yjs WRITES on this (seed emptiness check, useWorkingBody's
 *  pending whole-doc replace, editor mount), so flipping it any earlier lets a
 *  write land on an empty fragment and CRDT-union with the server state when
 *  step-2 then applies — duplicating the entire document. */
export type CollabStatus = "disabled" | "connecting" | "connected" | "disconnected";

/** Minimal provider surface @tiptap/extension-collaboration-caret needs (it reads `provider.awareness`). */
export interface CollabProvider {
  readonly awareness: Awareness;
  readonly doc: Y.Doc;
  destroy(): void;
}

export interface CollabDocHandle {
  ydoc: Y.Doc | null;
  awareness: Awareness | null;
  provider: CollabProvider | null;
  status: CollabStatus;
  /** Server-issued cursor colour for THIS session (null until the INIT frame). */
  color: string | null;
  /**
   * True only when the RunDoc DO designated THIS session as the authoritative
   * first-writer (the INIT frame's `primary` flag). Drives the seed flow so two
   * brand-new first-joiners can't both seed and duplicate content
   * (lib/run-editor/useSeedCollabDoc.ts). Always false until the INIT frame,
   * false when collab is disabled, and forced false in observer mode (a
   * read-only viewer must never seed).
   */
  isSeedAuthority: boolean;
}

export interface UseCollabDocOptions {
  enabled: boolean;
  user: { name: string; email: string };
  /**
   * Observer / read-only mode. When true the session still opens the socket,
   * receives remote edits, and publishes its awareness (so editors see the
   * viewer present) — but relays NO local document updates and never seeds. The
   * caller is responsible for mounting the editor non-editable. Default false
   * (full read-write editor). See the seeder-grant caveat in the effect.
   */
  readOnly?: boolean;
}

const DISABLED_HANDLE: CollabDocHandle = {
  ydoc: null,
  awareness: null,
  provider: null,
  status: "disabled",
  color: null,
  isSeedAuthority: false,
};

/** Coerce an inbound WebSocket frame (ArrayBuffer / view) to Uint8Array; mirrors
 * the DO's onMessage coercion. Returns null for non-binary frames. */
function toBytes(data: unknown): Uint8Array | null {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    const view = data as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  return null;
}

/** http→ws / https→wss, leaving any other scheme (already ws/wss) untouched. */
function toWsScheme(httpUrl: string): string {
  if (httpUrl.startsWith("https://")) return `wss://${httpUrl.slice("https://".length)}`;
  if (httpUrl.startsWith("http://")) return `ws://${httpUrl.slice("http://".length)}`;
  return httpUrl;
}

/**
 * Browser-side Yjs provider for a run's collaborative document.
 *
 * Talks the hand-rolled y-websocket-compatible sync + awareness protocol of the
 * RunDoc Durable Object (the stock `y-websocket` package can't be used because
 * the DO emits a custom MESSAGE_INIT control frame). On `open` we send sync
 * step 1; the DO answers with INIT (cursor colour) + sync step 2 + current
 * presence — INIT arrives FIRST, a round-trip before step 2, so status stays
 * "connecting" until the step-2 doc state is applied (see CollabStatus).
 * Outbound local doc/awareness updates are relayed back to the DO,
 * skipping anything that originated FROM the server (origin === provider).
 *
 * Reconnect (KISS, Phase 2): exactly ONE connection attempt per effect run — no
 * auto-reconnect loop. A dropped socket flips status to "disconnected"; the
 * caller can remount (e.g. by toggling `enabled`) to retry. This keeps the hook
 * leak-free with no timers to clean up.
 *
 * Safety: when `enabled` is false OR `runId` is null, NO socket is opened and a
 * frozen disabled handle is returned — the feature flag being OFF is guaranteed
 * to have zero side effects.
 */
/**
 * Mutable holder for the live socket. A class with mutator METHODS (not a bare
 * `{ ws }` cell) so the effect can swap the socket via `attach()` without a
 * property ASSIGNMENT on a value reachable from `useState` (which the
 * react-hooks immutability lint forbids). `provider.destroy()` closes through it.
 */
class SocketHolder {
  private ws: WebSocket | null = null;

  attach(ws: WebSocket): void {
    this.ws = ws;
  }

  get current(): WebSocket | null {
    return this.ws;
  }

  close(): void {
    try {
      this.ws?.close();
    } catch {
      // never throw from close
    }
  }
}

interface CollabInstances {
  /** The run this triple belongs to — used to build the WS URL inside the effect
   * (so `runId` need not be a separate effect dependency). */
  runId: string;
  doc: Y.Doc;
  awareness: Awareness;
  provider: CollabProvider;
  socket: SocketHolder;
  /** Owns this session's blame mapping. Held so it isn't GC'd while the doc lives;
   *  its observers are torn down with the doc on cleanup. */
  permanentUserData: Y.PermanentUserData;
}

/** Construct a fresh doc/awareness/provider triple, seeded with the operator's
 * identity (colour filled in once the server's INIT frame arrives).
 *
 * `gc: false` keeps deleted content as tombstones (not garbage-collected) so the
 * Review panel's per-author blame can attribute a DELETED run to its deleter via
 * `PermanentUserData.getUserByDeletedId` (see lib/run-editor/collab-blame.ts).
 * `PermanentUserData.setUserMapping` records THIS session's clientID → display
 * name in the shared doc's `users` map (which rides the DO sync to every peer),
 * and — for LOCAL transactions only (yjs gates this) — appends this user's
 * deletions to their delete-set. That is the write side of blame; the resolver
 * reads it back read-only. Insert authorship comes from the clientID mapping;
 * delete authorship from the per-user delete-set. */
function createInstances(runId: string, user: { name: string; email: string }): CollabInstances {
  const doc = new Y.Doc({ gc: false });
  const awareness = new Awareness(doc);
  const socket = new SocketHolder();
  const provider: CollabProvider = {
    awareness,
    doc,
    destroy: () => socket.close(),
  };
  // Register the blame mapping under the display name (used directly as the
  // "Added/Removed by {name}" label). A returning run already carries prior
  // authors in the synced `users` map; adding this client's id is idempotent.
  const permanentUserData = new Y.PermanentUserData(doc);
  permanentUserData.setUserMapping(doc, doc.clientID, user.name);
  awareness.setLocalStateField("user", { name: user.name, email: user.email, color: null });
  return { runId, doc, awareness, provider, socket, permanentUserData };
}

export function useCollabDoc(runId: string | null, opts: UseCollabDocOptions): CollabDocHandle {
  const { enabled, user, readOnly = false } = opts;
  // Identity gate: defer creating the doc until we know WHO the user is. The
  // PermanentUserData blame mapping that drives DELETE attribution is written
  // exactly once, in createInstances → setUserMapping, and Yjs has no clean
  // re-mapping (a second setUserMapping registers a duplicate afterTransaction
  // handler and double-attributes). useSession() resolves async, so at first
  // render the email is "" and the caller's display name falls back to "Editor";
  // baking that placeholder into the PUD would label every deletion "Removed by
  // Editor" forever. Inserts dodge this because they resolve through live
  // awareness (which updates once identity arrives) — only deletes read the
  // static PUD mapping. Waiting for the email means the mapping is written with
  // the real identity from the start, so adds and deletes attribute alike.
  const identityReady = user.email !== "";
  const active = enabled && runId !== null && identityReady;

  const [status, setStatus] = useState<CollabStatus>(active ? "connecting" : "disabled");
  const [color, setColor] = useState<string | null>(null);
  const [isSeedAuthority, setIsSeedAuthority] = useState<boolean>(false);

  // Create the doc/awareness/provider triple at first render (lazy initializer)
  // so consumers see it immediately — no setState-in-effect to publish it. The
  // socket effect then wires the protocol onto these existing instances.
  const [instances, setInstances] = useState<CollabInstances | null>(() =>
    active && runId !== null ? createInstances(runId, user) : null,
  );

  // Adjust state during render when the (runId, enabled) key changes — React's
  // recommended pattern (mirrors useRunEvents). Recreates the doc for a new run
  // and tears the disabled handle to null, all without a setState-in-effect.
  const [trackedKey, setTrackedKey] = useState<string>(active ? `${runId}` : "");
  const currentKey = active ? `${runId}` : "";
  if (currentKey !== trackedKey) {
    setTrackedKey(currentKey);
    setInstances(active && runId !== null ? createInstances(runId, user) : null);
    setStatus(active ? "connecting" : "disabled");
    setColor(null);
    setIsSeedAuthority(false);
  }

  // Keep the latest identity available to the effect's async callbacks without
  // re-running the effect (and tearing the socket down) on identity changes.
  const userRef = useRef(user);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Observer flag read via ref so toggling it never tears the socket down (it is
  // surface-stable in practice). Gates the outbound doc-update relay + seeding.
  const readOnlyRef = useRef(readOnly);
  useEffect(() => {
    readOnlyRef.current = readOnly;
  }, [readOnly]);

  useEffect(() => {
    if (!active || !instances) return;

    const { doc, awareness, provider, socket } = instances;

    let cancelled = false;

    const send = (bytes: Uint8Array): void => {
      const ws = socket.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      try {
        // Send a fresh ArrayBuffer slice — never the underlying pooled buffer.
        ws.send(bytes.slice().buffer);
      } catch (err: unknown) {
        console.warn("useCollabDoc: send failed", err);
      }
    };

    // Outbound: local doc updates → MESSAGE_SYNC update frame. Skip updates that
    // came FROM the server (origin === provider) to avoid echoing them back.
    // Observer mode relays NO local edits at all — the editor is mounted
    // non-editable, but guard here too so any programmatic local mutation stays
    // local (sync REPLIES in onMessage still flow, so the observer keeps
    // receiving remote state).
    const onDocUpdate = (update: Uint8Array, origin: unknown): void => {
      if (origin === provider || readOnlyRef.current) return;
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.writeUpdate(encoder, update);
      send(encoding.toUint8Array(encoder));
    };

    // Outbound: local awareness changes → MESSAGE_AWARENESS frame.
    const onAwarenessUpdate = (
      { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
      origin: unknown,
    ): void => {
      if (origin === provider) return;
      const changed = added.concat(updated, removed);
      const encoder = encoding.createEncoder();
      encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
      encoding.writeVarUint8Array(
        encoder,
        awarenessProtocol.encodeAwarenessUpdate(awareness, changed),
      );
      send(encoding.toUint8Array(encoder));
    };

    doc.on("update", onDocUpdate);
    awareness.on("update", onAwarenessUpdate);

    const onMessage = (data: unknown): void => {
      const bytes = toBytes(data);
      if (!bytes) return; // ignore non-binary frames
      const decoder = decoding.createDecoder(bytes);
      const messageType = decoding.readVarUint(decoder);
      switch (messageType) {
        case MESSAGE_SYNC: {
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          // `provider` as the transaction origin → onDocUpdate skips the echo.
          const syncMessageType = syncProtocol.readSyncMessage(decoder, encoder, doc, provider);
          if (encoding.length(encoder) > 1) send(encoding.toUint8Array(encoder));
          // Status flips to "connected" only once the server's step-2 reply (the
          // DO's doc state, answering our on-open step 1) has been APPLIED above.
          // Flipping on INIT instead opened a race: consumers gate Yjs writes on
          // "connected", and a queued whole-doc replace flushed into the still-
          // empty fragment would CRDT-union with the late-arriving server state,
          // duplicating the whole article (compounding per page revisit).
          if (syncMessageType === syncProtocol.messageYjsSyncStep2) setStatus("connected");
          break;
        }
        case MESSAGE_AWARENESS: {
          awarenessProtocol.applyAwarenessUpdate(
            awareness,
            decoding.readVarUint8Array(decoder),
            provider,
          );
          break;
        }
        case MESSAGE_INIT: {
          try {
            // The INIT payload is untrusted JSON; narrow it rather than casting.
            const raw: unknown = JSON.parse(decoding.readVarString(decoder));
            const issued =
              typeof raw === "object" &&
              raw !== null &&
              typeof (raw as { color?: unknown }).color === "string"
                ? (raw as { color: string }).color
                : null;
            if (issued !== null) {
              setColor(issued);
              const ident = userRef.current;
              awareness.setLocalStateField("user", {
                name: ident.name,
                email: ident.email,
                color: issued,
              });
            }
            // `primary` (DO seeder grant) gates the seed flow. Defensive: a frame
            // without a boolean `primary` (older server) reads as false. An
            // observer must NEVER seed, so force false in read-only mode.
            // CAVEAT: the DO grants `primary` to the first connection on an empty
            // doc regardless of role; if a read-only observer ever opens an empty
            // run before any editor, it would consume the seeder slot server-side
            // (and then decline to seed here). That is harmless today (no
            // observer surface is wired), but when one is added the DO grant must
            // learn to skip observers (e.g. an `?observe=1` upgrade query).
            const primary =
              typeof raw === "object" &&
              raw !== null &&
              typeof (raw as { primary?: unknown }).primary === "boolean"
                ? (raw as { primary: boolean }).primary
                : false;
            setIsSeedAuthority(readOnlyRef.current ? false : primary);
          } catch (err: unknown) {
            console.warn("useCollabDoc: malformed INIT frame", err);
          }
          // Deliberately NOT "connected" yet — INIT is the DO's first frame,
          // sent before its sync step-2; the doc is still empty here.
          break;
        }
        default:
          break; // unknown frame — ignore
      }
    };

    // Build the URL, then open the socket. Ticket fetch is async; bail if the
    // effect was torn down while it was in flight.
    void (async () => {
      const apiBase = process.env.NEXT_PUBLIC_API_BASE;
      if (!apiBase) {
        console.warn("useCollabDoc: NEXT_PUBLIC_API_BASE is not set; collab disabled");
        if (!cancelled) setStatus("disconnected");
        return;
      }
      const wsUrl = toWsScheme(`${apiBase}/runs/${instances.runId}/doc`);
      let url: string;
      try {
        url = await withSseTicket(wsUrl);
      } catch (err: unknown) {
        console.warn("useCollabDoc: ticket fetch failed", err);
        url = wsUrl;
      }
      if (cancelled) return;

      try {
        const ws = new WebSocket(url);
        socket.attach(ws);
        // Frames arrive as ArrayBuffer (default is Blob, which breaks decoding).
        ws.binaryType = "arraybuffer";

        ws.addEventListener("open", () => {
          // Sync step 1 — ask the DO to reconcile against our state vector.
          const encoder = encoding.createEncoder();
          encoding.writeVarUint(encoder, MESSAGE_SYNC);
          syncProtocol.writeSyncStep1(encoder, doc);
          send(encoding.toUint8Array(encoder));
        });
        ws.addEventListener("message", (event: MessageEvent) => onMessage(event.data));
        ws.addEventListener("close", () => {
          if (!cancelled) setStatus("disconnected");
        });
        ws.addEventListener("error", () => {
          if (!cancelled) setStatus("disconnected");
        });
      } catch (err: unknown) {
        console.warn("useCollabDoc: WebSocket construction failed", err);
        if (!cancelled) setStatus("disconnected");
      }
    })();

    return () => {
      cancelled = true;
      // Best-effort teardown — NEVER throw from cleanup.
      try {
        doc.off("update", onDocUpdate);
      } catch {
        /* ignore */
      }
      try {
        awareness.off("update", onAwarenessUpdate);
      } catch {
        /* ignore */
      }
      try {
        awarenessProtocol.removeAwarenessStates(awareness, [doc.clientID], "unmount");
      } catch {
        /* ignore */
      }
      socket.close();
      try {
        awareness.destroy();
      } catch {
        /* ignore */
      }
      try {
        doc.destroy();
      } catch {
        /* ignore */
      }
      // Intentionally do NOT setStatus here. On a true unmount the component is
      // gone (no consumer reads status). On a (runId/enabled) key change the
      // render path above already set the correct next status ("connecting" /
      // "disabled") BEFORE this cleanup runs — setting "disconnected" here would
      // clobber it and strand the indicator. Live drops are covered by the
      // socket "close"/"error" handlers (guarded by `cancelled`).
    };
    // `user` is read via ref (see the identity-sync effect) so identity changes
    // don't tear the socket down; only the instances (keyed on runId/enabled)
    // drive the connection lifetime.
  }, [active, instances]);

  if (!active) return DISABLED_HANDLE;

  return {
    ydoc: instances?.doc ?? null,
    awareness: instances?.awareness ?? null,
    provider: instances?.provider ?? null,
    status,
    color,
    isSeedAuthority,
  };
}
