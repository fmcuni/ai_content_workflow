import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as awarenessProtocol from "y-protocols/awareness";
import { Awareness } from "y-protocols/awareness";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// withSseTicket is mocked to pass the URL through unchanged — no network.
vi.mock("@/lib/sse-ticket", () => ({
  withSseTicket: (url: string) => Promise.resolve(url),
}));

import { useCollabDoc } from "./useCollabDoc";

// Wire protocol bytes (mirror the DO).
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_INIT = 2;

const API_BASE = "https://backend.example.test";

/** A controllable fake WebSocket installed on globalThis (jsdom has none). It
 * captures every frame the hook sends and lets the test fire open + server
 * messages synchronously. */
class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;

  static instances: FakeWebSocket[] = [];

  readonly CONNECTING = FakeWebSocket.CONNECTING;
  readonly OPEN = FakeWebSocket.OPEN;
  readonly CLOSING = FakeWebSocket.CLOSING;
  readonly CLOSED = FakeWebSocket.CLOSED;

  url: string;
  binaryType: BinaryType = "blob";
  readyState: number = FakeWebSocket.CONNECTING;
  closeCalls = 0;
  sent: Uint8Array[] = [];

  private listeners: Record<string, Array<(ev: unknown) => void>> = {};

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, cb: (ev: unknown) => void): void {
    (this.listeners[type] ??= []).push(cb);
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    // Copy so later buffer reuse can't mutate captured frames.
    this.sent.push(new Uint8Array(bytes));
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = FakeWebSocket.CLOSED;
    this.fire("close", {});
  }

  // ---- test helpers ----
  fireOpen(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.fire("open", {});
  }

  fireServerMessage(bytes: Uint8Array): void {
    this.fire("message", { data: bytes.buffer.slice(0) });
  }

  private fire(type: string, ev: unknown): void {
    for (const cb of this.listeners[type] ?? []) cb(ev);
  }
}

function buildInitFrame(color: string): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_INIT);
  encoding.writeVarString(encoder, JSON.stringify({ color }));
  return encoding.toUint8Array(encoder);
}

/** INIT frame carrying the DO's seeder grant (`primary`). */
function buildInitFrameWithPrimary(color: string, primary: boolean): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_INIT);
  encoding.writeVarString(encoder, JSON.stringify({ color, primary }));
  return encoding.toUint8Array(encoder);
}

/** Server sync step-2 frame (the DO's doc state in full). Applying this is what
 *  flips the hook's status to "connected" — INIT alone must not, else gated Yjs
 *  writes can land on a pre-sync empty fragment and union-duplicate the doc. */
function buildSyncStep2Frame(serverDoc?: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_SYNC);
  syncProtocol.writeSyncStep2(encoder, serverDoc ?? new Y.Doc());
  return encoding.toUint8Array(encoder);
}

/** Insert a paragraph into the doc's body fragment (a local content edit). */
function insertLocalEdit(ydoc: Y.Doc): void {
  const frag = ydoc.getXmlFragment("default");
  const el = new Y.XmlElement("paragraph");
  el.insert(0, [new Y.XmlText("hi")]);
  frag.insert(0, [el]);
}

/** A second simulated client's awareness, encoded as a MESSAGE_AWARENESS frame. */
function buildAwarenessFrame(): { frame: Uint8Array; clientId: number } {
  const otherDoc = new Y.Doc();
  const otherAwareness = new Awareness(otherDoc);
  otherAwareness.setLocalStateField("user", {
    name: "Bob",
    email: "bob@bowtie.com.hk",
    color: "#3b82f6",
  });
  const clientId = otherDoc.clientID;
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, MESSAGE_AWARENESS);
  encoding.writeVarUint8Array(
    encoder,
    awarenessProtocol.encodeAwarenessUpdate(otherAwareness, [clientId]),
  );
  return { frame: encoding.toUint8Array(encoder), clientId };
}

function firstSentMessageType(ws: FakeWebSocket): number {
  const frame = ws.sent[0];
  if (!frame) throw new Error("no frame sent");
  return decoding.readVarUint(decoding.createDecoder(frame));
}

const identity = { name: "Alice", email: "alice@bowtie.com.hk" };

beforeEach(() => {
  FakeWebSocket.instances = [];
  vi.stubGlobal("WebSocket", FakeWebSocket);
  vi.stubEnv("NEXT_PUBLIC_API_BASE", API_BASE);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("useCollabDoc — disabled (safety)", () => {
  it("opens NO socket and returns a disabled handle when enabled=false", () => {
    const { result } = renderHook(() =>
      useCollabDoc("run-1", { enabled: false, user: identity }),
    );
    expect(result.current.status).toBe("disabled");
    expect(result.current.ydoc).toBeNull();
    expect(result.current.awareness).toBeNull();
    expect(result.current.provider).toBeNull();
    expect(result.current.color).toBeNull();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it("opens NO socket when runId is null", () => {
    const { result } = renderHook(() => useCollabDoc(null, { enabled: true, user: identity }));
    expect(result.current.status).toBe("disabled");
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});

describe("useCollabDoc — connection", () => {
  it("constructs a wss:// socket to /runs/:id/doc with binaryType arraybuffer and sends sync step 1 on open", async () => {
    const { result } = renderHook(() => useCollabDoc("run-1", { enabled: true, user: identity }));

    // Ticket fetch is async — wait for the socket to be constructed.
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;

    expect(ws.url).toBe(`wss://backend.example.test/runs/run-1/doc`);
    expect(ws.binaryType).toBe("arraybuffer");
    expect(result.current.status).toBe("connecting");
    expect(result.current.ydoc).not.toBeNull();
    expect(result.current.awareness).not.toBeNull();
    expect(result.current.provider).not.toBeNull();

    act(() => ws.fireOpen());

    // First frame sent must be a MESSAGE_SYNC (step 1) frame.
    expect(ws.sent.length).toBeGreaterThanOrEqual(1);
    expect(firstSentMessageType(ws)).toBe(MESSAGE_SYNC);
  });

  it("INIT frame sets color + local awareness user colour but does NOT mark connected (pre-sync)", async () => {
    const { result } = renderHook(() => useCollabDoc("run-1", { enabled: true, user: identity }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.fireOpen());

    act(() => ws.fireServerMessage(buildInitFrame("#ef4444")));

    // INIT is the DO's FIRST frame, sent before its sync step-2 — the local doc
    // is still empty here. Consumers gate Yjs writes on "connected", so flipping
    // now would let a queued whole-doc replace union-duplicate the article.
    await waitFor(() => expect(result.current.color).toBe("#ef4444"));
    expect(result.current.status).toBe("connecting");

    const awareness = result.current.awareness!;
    const localState = awareness.getLocalState() as {
      user?: { name: string; email: string; color: string };
    };
    expect(localState.user?.color).toBe("#ef4444");
    expect(localState.user?.name).toBe("Alice");
  });

  it("marks status connected only once the server's sync step-2 is applied", async () => {
    const { result } = renderHook(() => useCollabDoc("run-1", { enabled: true, user: identity }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.fireOpen());
    act(() => ws.fireServerMessage(buildInitFrame("#ef4444")));
    expect(result.current.status).toBe("connecting");

    // Server step-2 carries the DO's doc state; applying it = synced.
    const serverDoc = new Y.Doc();
    serverDoc.getXmlFragment("default").insert(0, [new Y.XmlText("persisted body")]);
    act(() => ws.fireServerMessage(buildSyncStep2Frame(serverDoc)));

    await waitFor(() => expect(result.current.status).toBe("connected"));
    // The persisted content is already in the local doc by the time consumers
    // see "connected" — a flushed whole-doc replace now diffs against it.
    expect(result.current.ydoc!.getXmlFragment("default").length).toBeGreaterThan(0);
  });

  it("surfaces a second client from a server MESSAGE_AWARENESS frame", async () => {
    const { result } = renderHook(() => useCollabDoc("run-1", { enabled: true, user: identity }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.fireOpen());

    const { frame, clientId } = buildAwarenessFrame();
    act(() => ws.fireServerMessage(frame));

    const awareness = result.current.awareness!;
    expect(awareness.getStates().has(clientId)).toBe(true);
    const remote = awareness.getStates().get(clientId) as {
      user?: { name: string };
    };
    expect(remote.user?.name).toBe("Bob");
  });

  it("relays a local doc edit to the server as a MESSAGE_SYNC update frame", async () => {
    const { result } = renderHook(() => useCollabDoc("run-1", { enabled: true, user: identity }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.fireOpen());

    const sentBefore = ws.sent.length;
    act(() => {
      const frag = result.current.ydoc!.getXmlFragment("default");
      const el = new Y.XmlElement("paragraph");
      el.insert(0, [new Y.XmlText("hello")]);
      frag.insert(0, [el]);
    });

    // A new frame was sent and it is a MESSAGE_SYNC frame.
    expect(ws.sent.length).toBeGreaterThan(sentBefore);
    const last = ws.sent[ws.sent.length - 1]!;
    expect(decoding.readVarUint(decoding.createDecoder(last))).toBe(MESSAGE_SYNC);
  });

  it("does NOT echo a server-originated sync update back to the server", async () => {
    renderHook(() => useCollabDoc("run-1", { enabled: true, user: identity }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.fireOpen());

    // Build a sync UPDATE frame from a server doc that has content.
    const serverDoc = new Y.Doc();
    serverDoc.getXmlFragment("default").insert(0, [new Y.XmlText("from server")]);
    const update = Y.encodeStateAsUpdate(serverDoc);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const frame = encoding.toUint8Array(encoder);

    const sentBefore = ws.sent.length;
    act(() => ws.fireServerMessage(frame));

    // The doc applied the update (origin === provider) so onDocUpdate skipped
    // the echo — no SYNC update frame was sent in response.
    expect(ws.sent.length).toBe(sentBefore);
  });
});

describe("useCollabDoc — seed authority", () => {
  it("INIT with primary=true marks the session as the seed authority", async () => {
    const { result } = renderHook(() => useCollabDoc("run-1", { enabled: true, user: identity }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.fireOpen());

    expect(result.current.isSeedAuthority).toBe(false); // not until INIT
    act(() => ws.fireServerMessage(buildInitFrameWithPrimary("#ef4444", true)));

    await waitFor(() => expect(result.current.isSeedAuthority).toBe(true));
  });

  it("INIT without a primary flag leaves isSeedAuthority false (back-compat)", async () => {
    const { result } = renderHook(() => useCollabDoc("run-1", { enabled: true, user: identity }));
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.fireOpen());

    act(() => ws.fireServerMessage(buildInitFrame("#ef4444")));
    act(() => ws.fireServerMessage(buildSyncStep2Frame()));

    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(result.current.isSeedAuthority).toBe(false);
  });
});

describe("useCollabDoc — observer (read-only)", () => {
  it("relays NO local doc edit to the server in observer mode", async () => {
    const { result } = renderHook(() =>
      useCollabDoc("run-1", { enabled: true, user: identity, readOnly: true }),
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.fireOpen());

    const sentBefore = ws.sent.length;
    act(() => insertLocalEdit(result.current.ydoc!));

    // The outbound relay is suppressed for an observer — no frame was sent.
    expect(ws.sent.length).toBe(sentBefore);
  });

  it("never becomes the seed authority even when the server grants primary=true", async () => {
    const { result } = renderHook(() =>
      useCollabDoc("run-1", { enabled: true, user: identity, readOnly: true }),
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.fireOpen());

    act(() => ws.fireServerMessage(buildInitFrameWithPrimary("#ef4444", true)));
    act(() => ws.fireServerMessage(buildSyncStep2Frame()));

    await waitFor(() => expect(result.current.status).toBe("connected"));
    expect(result.current.isSeedAuthority).toBe(false);
  });

  it("still receives + applies a remote edit in observer mode", async () => {
    const { result } = renderHook(() =>
      useCollabDoc("run-1", { enabled: true, user: identity, readOnly: true }),
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.fireOpen());

    // Server pushes a doc that has content.
    const serverDoc = new Y.Doc();
    serverDoc.getXmlFragment("default").insert(0, [new Y.XmlText("from server")]);
    const update = Y.encodeStateAsUpdate(serverDoc);
    const encoder = encoding.createEncoder();
    encoding.writeVarUint(encoder, MESSAGE_SYNC);
    syncProtocol.writeUpdate(encoder, update);
    const frame = encoding.toUint8Array(encoder);

    act(() => ws.fireServerMessage(frame));

    // The observer applied the remote update locally (read path intact).
    expect(result.current.ydoc!.getXmlFragment("default").length).toBeGreaterThan(0);
  });
});

describe("useCollabDoc — teardown", () => {
  it("closes the WS and destroys doc/awareness on unmount without throwing", async () => {
    const { result, unmount } = renderHook(() =>
      useCollabDoc("run-1", { enabled: true, user: identity }),
    );
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
    const ws = FakeWebSocket.instances[0]!;
    act(() => ws.fireOpen());

    const doc = result.current.ydoc!;
    let destroyed = false;
    doc.once("destroy", () => {
      destroyed = true;
    });

    expect(() => unmount()).not.toThrow();

    // Cleanup closed the socket and destroyed the doc. (An unmounted hook keeps
    // its final render, so we assert on the live ws/doc instances, not on
    // result.current.status — React ignores setState after unmount.)
    expect(ws.closeCalls).toBeGreaterThanOrEqual(1);
    expect(destroyed).toBe(true);
    // Re-running destroy must also not throw (idempotent cleanup).
    expect(() => doc.destroy()).not.toThrow();
  });
});
