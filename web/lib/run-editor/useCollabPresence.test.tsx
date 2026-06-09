import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  applyAwarenessUpdate,
  Awareness,
  encodeAwarenessUpdate,
} from "y-protocols/awareness";

import { useCollabPresence } from "@/lib/run-editor/useCollabPresence";

// Track the docs/awareness we build so we can tear them down deterministically.
const teardown: Array<() => void> = [];

afterEach(() => {
  while (teardown.length > 0) teardown.pop()?.();
});

function makeAwareness(): Awareness {
  const doc = new Y.Doc();
  const awareness = new Awareness(doc);
  teardown.push(() => {
    awareness.destroy();
    doc.destroy();
  });
  return awareness;
}

/** Simulate a SECOND remote client joining `target`'s awareness: build a real
 *  second Awareness, set its user state, then apply its encoded update onto the
 *  target — exactly how the wire protocol relays a peer's presence. */
function joinRemote(
  target: Awareness,
  user: { name: string; email: string; color: string },
): number {
  const remote = makeAwareness();
  remote.setLocalStateField("user", user);
  const update = encodeAwarenessUpdate(remote, [remote.clientID]);
  applyAwarenessUpdate(target, update, "test");
  return remote.clientID;
}

describe("useCollabPresence", () => {
  it("returns [] when awareness is null (collab off)", () => {
    const { result } = renderHook(() => useCollabPresence(null));
    expect(result.current).toEqual([]);
  });

  it("derives the connected users with correct identity, colour, and isSelf", () => {
    const awareness = makeAwareness();
    awareness.setLocalStateField("user", {
      name: "Alice Local",
      email: "alice@bowtie.com.hk",
      color: "#ff0000",
    });

    const { result } = renderHook(() => useCollabPresence(awareness));

    act(() => {
      joinRemote(awareness, {
        name: "Bob Remote",
        email: "bob@bowtie.com.hk",
        color: "#00ff00",
      });
    });

    expect(result.current).toHaveLength(2);

    const self = result.current.find((u) => u.isSelf);
    const other = result.current.find((u) => !u.isSelf);

    expect(self).toMatchObject({
      name: "Alice Local",
      email: "alice@bowtie.com.hk",
      color: "#ff0000",
      clientId: awareness.clientID,
    });
    expect(other).toMatchObject({
      name: "Bob Remote",
      email: "bob@bowtie.com.hk",
      color: "#00ff00",
    });
    // Self sorts first.
    expect(result.current[0].isSelf).toBe(true);
  });

  it("ignores states missing a usable user.name", () => {
    const awareness = makeAwareness();
    awareness.setLocalStateField("user", {
      name: "Alice Local",
      email: "alice@bowtie.com.hk",
      color: "#ff0000",
    });

    const { result } = renderHook(() => useCollabPresence(awareness));

    act(() => {
      // A client that published a blank name (e.g. before identity hydrated).
      joinRemote(awareness, { name: "   ", email: "ghost@bowtie.com.hk", color: "#0000ff" });
    });

    expect(result.current).toHaveLength(1);
    expect(result.current[0].name).toBe("Alice Local");
  });

  it("updates when awareness changes after mount (list grows)", () => {
    const awareness = makeAwareness();
    awareness.setLocalStateField("user", {
      name: "Alice Local",
      email: "alice@bowtie.com.hk",
      color: "#ff0000",
    });

    const { result } = renderHook(() => useCollabPresence(awareness));
    expect(result.current).toHaveLength(1);

    act(() => {
      joinRemote(awareness, { name: "Bob Remote", email: "bob@bowtie.com.hk", color: "#00ff00" });
    });
    expect(result.current).toHaveLength(2);

    act(() => {
      joinRemote(awareness, { name: "Cara Remote", email: "cara@bowtie.com.hk", color: "#0000ff" });
    });
    expect(result.current).toHaveLength(3);
  });
});
