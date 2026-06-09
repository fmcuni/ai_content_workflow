import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate } from "y-protocols/awareness";

import { CollabPresence } from "@/components/run-editor/CollabPresence";

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

function joinRemote(
  target: Awareness,
  user: { name: string; email: string; color: string },
): void {
  const remote = makeAwareness();
  remote.setLocalStateField("user", user);
  applyAwarenessUpdate(target, encodeAwarenessUpdate(remote, [remote.clientID]), "test");
}

describe("CollabPresence", () => {
  it("renders nothing when awareness is null", () => {
    const { container } = render(<CollabPresence awareness={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when nobody has published a presence state", () => {
    const awareness = makeAwareness();
    const { container } = render(<CollabPresence awareness={awareness} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders one avatar per user with initials and accessible names", () => {
    const awareness = makeAwareness();
    awareness.setLocalStateField("user", {
      name: "Alice Lane",
      email: "alice@bowtie.com.hk",
      color: "#ff0000",
    });
    joinRemote(awareness, { name: "Bob Reed", email: "bob@bowtie.com.hk", color: "#00ff00" });

    const { getByLabelText, getByText } = render(<CollabPresence awareness={awareness} />);

    // Self avatar's accessible name ends with "(you)".
    const self = getByLabelText("Alice Lane (you)");
    expect(self).toBeTruthy();
    expect(getByText("AL")).toBeTruthy();

    const other = getByLabelText("Bob Reed");
    expect(other).toBeTruthy();
    expect(getByText("BR")).toBeTruthy();

    // The self avatar is filled with its server colour (inline style).
    expect(self.getAttribute("style")).toContain("rgb(255, 0, 0)");
  });

  it("caps visible avatars and shows a +N overflow chip", () => {
    const awareness = makeAwareness();
    awareness.setLocalStateField("user", {
      name: "Alice Lane",
      email: "alice@bowtie.com.hk",
      color: "#ff0000",
    });
    joinRemote(awareness, { name: "Bob Reed", email: "bob@bowtie.com.hk", color: "#00ff00" });
    joinRemote(awareness, { name: "Cara Vex", email: "cara@bowtie.com.hk", color: "#0000ff" });

    const { getAllByRole, getByText } = render(<CollabPresence awareness={awareness} max={1} />);

    // Exactly one avatar (role=img) visible, plus a "+2" overflow chip.
    expect(getAllByRole("img")).toHaveLength(1);
    expect(getByText("+2")).toBeTruthy();
  });
});
