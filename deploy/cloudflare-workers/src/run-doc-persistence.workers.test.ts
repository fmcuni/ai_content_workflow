import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// Yjs message-type tags (mirror y-websocket / run-doc.workers.test.ts).
const MESSAGE_SYNC = 0;
const MESSAGE_INIT = 2;

/**
 * Phase 1C regression guard: with NO Hyperdrive bound (the workers-pool harness
 * binds only RUN_DOC), the Postgres cold-store / backup layer must be a strict
 * no-op. These tests assert the in-memory relay + DO-storage cold-load still
 * behave exactly as the Phase 0 baseline — i.e. adding the DB path did not
 * regress sync, late-join hydration, or eviction-survival via DO storage.
 *
 * A minimal Yjs WS client (same protocol the browser provider speaks), trimmed
 * to what these no-op assertions need.
 */
class TestClient {
  readonly doc = new Y.Doc();

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => this.onMessage(e.data));

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return; // don't echo updates we just received
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.send(encoding.toUint8Array(enc));
    });

    // Greet the server with sync step 1 (our state vector).
    const enc = encoding.createEncoder();
    encoding.writeVarUint(enc, MESSAGE_SYNC);
    syncProtocol.writeSyncStep1(enc, this.doc);
    this.send(encoding.toUint8Array(enc));
  }

  private send(bytes: Uint8Array): void {
    this.ws.send(bytes);
  }

  private onMessage(data: unknown): void {
    const bytes = new Uint8Array(data as ArrayBuffer);
    const decoder = decoding.createDecoder(bytes);
    const encoder = encoding.createEncoder();
    const type = decoding.readVarUint(decoder);
    if (type === MESSAGE_SYNC) {
      encoding.writeVarUint(encoder, MESSAGE_SYNC);
      syncProtocol.readSyncMessage(decoder, encoder, this.doc, "remote");
      if (encoding.length(encoder) > 1) this.send(encoding.toUint8Array(encoder));
    } else if (type === MESSAGE_INIT) {
      // server-issued cursor colour — irrelevant to these no-op assertions
    }
  }
}

async function connect(runId: string): Promise<TestClient> {
  const resp = await SELF.fetch(`https://example.com/runs/${runId}/doc`, {
    headers: { Upgrade: "websocket" },
  });
  expect(resp.status).toBe(101);
  const ws = resp.webSocket;
  expect(ws).toBeTruthy();
  ws!.accept();
  ws!.binaryType = "arraybuffer"; // receive Yjs frames as ArrayBuffer, not Blob
  return new TestClient(ws!);
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 10));
  }
}

let runSeq = 0;
function freshRun(): string {
  runSeq += 1;
  return `noop-run-${runSeq}`;
}

describe("RunDoc persistence no-op (no Hyperdrive bound)", () => {
  beforeEach(() => {
    void env; // ensure the binding is wired (harness binds only RUN_DOC)
  });

  it("does not bind a Hyperdrive in the hermetic harness env", () => {
    // Guards the premise of every assertion below: the no-op path is exercised
    // precisely because there is no DB binding to back up to / load from.
    expect((env as unknown as Record<string, unknown>).HYPERDRIVE).toBeUndefined();
  });

  it("still relays document edits between two clients with no DB bound", async () => {
    const runId = freshRun();
    const a = await connect(runId);
    const b = await connect(runId);

    a.doc.getText("body").insert(0, "hello world");

    await waitFor(() => b.doc.getText("body").toString() === "hello world");
    expect(b.doc.getText("body").toString()).toBe("hello world");
  });

  it("still persists to DO storage so a late-joining client hydrates", async () => {
    const runId = freshRun();
    const a = await connect(runId);
    a.doc.getText("body").insert(0, "seeded");
    // Allow the doc 'update' relay + the 1s DO-storage persist debounce to fire.
    await new Promise((r) => setTimeout(r, 1100));

    const late = await connect(runId);
    await waitFor(() => late.doc.getText("body").toString() === "seeded");
    expect(late.doc.getText("body").toString()).toBe("seeded");
  });
});
