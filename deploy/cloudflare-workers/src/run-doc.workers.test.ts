import { env, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";

// Yjs message-type tags (mirror y-websocket).
const MESSAGE_SYNC = 0;
const MESSAGE_AWARENESS = 1;
const MESSAGE_INIT = 2; // server→client: this session's server-issued cursor colour

/**
 * A minimal Yjs WebSocket client (the same protocol the browser's
 * @tiptap/extension-collaboration provider speaks), used to drive the RunDoc DO
 * from the test side and assert that two clients converge through it.
 */
class TestClient {
  readonly doc = new Y.Doc();
  readonly awareness = new awarenessProtocol.Awareness(this.doc);
  assignedColour: string | null = null;

  constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (e) => this.onMessage(e.data));

    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === "remote") return; // don't echo updates we just received
      const enc = encoding.createEncoder();
      encoding.writeVarUint(enc, MESSAGE_SYNC);
      syncProtocol.writeUpdate(enc, update);
      this.send(encoding.toUint8Array(enc));
    });

    this.awareness.on(
      "update",
      ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
        if (origin === "remote") return;
        const changed = added.concat(updated, removed);
        const enc = encoding.createEncoder();
        encoding.writeVarUint(enc, MESSAGE_AWARENESS);
        encoding.writeVarUint8Array(enc, awarenessProtocol.encodeAwarenessUpdate(this.awareness, changed));
        this.send(encoding.toUint8Array(enc));
      },
    );

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
    } else if (type === MESSAGE_AWARENESS) {
      awarenessProtocol.applyAwarenessUpdate(this.awareness, decoding.readVarUint8Array(decoder), "remote");
    } else if (type === MESSAGE_INIT) {
      const init = JSON.parse(decoding.readVarString(decoder)) as { color?: string };
      this.assignedColour = init.color ?? null;
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
  return `run-${runSeq}`;
}

describe("RunDoc collab sync", () => {
  beforeEach(() => {
    void env; // ensure the binding is wired
  });

  it("relays document edits between two clients on the same run", async () => {
    const runId = freshRun();
    const a = await connect(runId);
    const b = await connect(runId);

    a.doc.getText("body").insert(0, "hello world");

    await waitFor(() => b.doc.getText("body").toString() === "hello world");
    expect(b.doc.getText("body").toString()).toBe("hello world");
  });

  it("merges concurrent edits from both clients with no lost characters", async () => {
    const runId = freshRun();
    const a = await connect(runId);
    const b = await connect(runId);

    a.doc.getText("body").insert(0, "AAA");
    b.doc.getText("body").insert(0, "BBB");

    await waitFor(
      () =>
        a.doc.getText("body").toString() === b.doc.getText("body").toString() &&
        a.doc.getText("body").toString().length === 6,
    );
    const merged = a.doc.getText("body").toString();
    expect(merged).toBe(b.doc.getText("body").toString());
    expect(merged.split("").sort().join("")).toBe("AAABBB");
  });

  it("syncs existing document state to a late-joining client", async () => {
    const runId = freshRun();
    const a = await connect(runId);
    a.doc.getText("body").insert(0, "seeded");
    await new Promise((r) => setTimeout(r, 50));

    const late = await connect(runId);
    await waitFor(() => late.doc.getText("body").toString() === "seeded");
    expect(late.doc.getText("body").toString()).toBe("seeded");
  });

  it("relays presence (awareness) between clients", async () => {
    const runId = freshRun();
    const a = await connect(runId);
    const b = await connect(runId);

    a.awareness.setLocalState({ user: { name: "Alice", email: "alice@bowtie.com.hk" } });

    await waitFor(() => {
      for (const state of b.awareness.getStates().values()) {
        const user = (state as { user?: { name?: string } }).user;
        if (user?.name === "Alice") return true;
      }
      return false;
    });
    const names = [...b.awareness.getStates().values()].map(
      (s) => (s as { user?: { name?: string } }).user?.name,
    );
    expect(names).toContain("Alice");
  });

  it("issues a distinct server-side cursor colour to each client", async () => {
    const runId = freshRun();
    const a = await connect(runId);
    const b = await connect(runId);

    await waitFor(() => a.assignedColour !== null && b.assignedColour !== null);
    expect(a.assignedColour).toMatch(/^#[0-9a-f]{6}$/);
    expect(b.assignedColour).toMatch(/^#[0-9a-f]{6}$/);
    expect(a.assignedColour).not.toBe(b.assignedColour);
  });
});
