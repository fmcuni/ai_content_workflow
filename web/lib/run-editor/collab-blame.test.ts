import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { Awareness } from "y-protocols/awareness";

import { buildEditorExtensions } from "@/components/tiptap/editor-extensions";
import { computeTrackedChanges } from "@/lib/tracked-changes";
import { buildBlameResolver } from "@/lib/run-editor/collab-blame";
import { NEUTRAL_COLLAB_COLOR } from "@/lib/run-editor/collab-color";

/**
 * Phase 4 blame mapping. Two headless editors on two gc:false docs (one per
 * author, each with its own PermanentUserData mapping) exchange Yjs updates — the
 * exact shape the RunDoc DO relays — then the resolver attributes the
 * tracked-changes hunks back to the correct author. Built on the real SSOT schema
 * so FAQ/table/link/CJK round-trip exactly (see collab-roundtrip.test.tsx).
 */

function makeEditor(ydoc: Y.Doc): Editor {
  return new Editor({ element: document.createElement("div"), extensions: buildEditorExtensions({ collabDoc: ydoc }) });
}
function flatten(ydoc: Y.Doc): string {
  const e = makeEditor(ydoc);
  try {
    return e.getHTML();
  } finally {
    e.destroy();
  }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

/** Author A's doc seeded from `seedHtml`; returns the committed baseline + the doc. */
function seedByAlice(seedHtml: string): { docA: Y.Doc; committed: string } {
  const docA = new Y.Doc({ gc: false });
  const pudA = new Y.PermanentUserData(docA);
  pudA.setUserMapping(docA, docA.clientID, "Alice");
  const a = makeEditor(docA);
  a.commands.setContent(seedHtml);
  const committed = flatten(docA);
  a.destroy();
  return { docA, committed };
}

/** Bring up author B's doc synced to A, ready for B to edit. */
function joinAsBob(docA: Y.Doc): { docB: Y.Doc; b: Editor } {
  const docB = new Y.Doc({ gc: false });
  const pudB = new Y.PermanentUserData(docB);
  pudB.setUserMapping(docB, docB.clientID, "Bob");
  Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA));
  return { docB, b: makeEditor(docB) };
}

/** Merge B's state into A (what the DO relays). */
function mergeIntoA(docA: Y.Doc, docB: Y.Doc): void {
  Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA)));
}

describe("buildBlameResolver", () => {
  it("returns null when there is no doc (non-collab path stays untouched)", () => {
    expect(buildBlameResolver(null)).toBeNull();
    expect(buildBlameResolver(undefined)).toBeNull();
  });

  it("attributes an INSERTION hunk to its author (char-precise)", () => {
    const { docA, committed } = seedByAlice("<p>Alpha bravo</p>");
    const { docB, b } = joinAsBob(docA);
    b.commands.insertContentAt(b.state.doc.content.size - 1, " charlie delta");
    mergeIntoA(docA, docB);
    const working = flatten(docA);

    const resolver = buildBlameResolver(docA)!;
    const tracked = computeTrackedChanges(committed, working);
    const hunks = resolver.annotate(tracked);

    const adds = hunks.filter((h) => h.type === "add");
    expect(adds.length).toBeGreaterThan(0);
    for (const h of adds) expect(h.author?.name).toBe("Bob");
    b.destroy();
  });

  it("attributes a DELETION hunk to the deleter (gc:false + flushed ds)", async () => {
    const { docA, committed } = seedByAlice("<p>one two three four</p>");
    const { docB, b } = joinAsBob(docA);
    // delete "two " : <p>=1, o n e(2..4) space(5) t w o(6..8) space(9) -> from 6 to 10
    b.commands.deleteRange({ from: 6, to: 10 });
    // PermanentUserData records the deleter's delete-set on a setTimeout(0).
    await tick();
    mergeIntoA(docA, docB);
    await tick();
    const working = flatten(docA);

    const resolver = buildBlameResolver(docA)!;
    const hunks = resolver.annotate(computeTrackedChanges(committed, working));

    const removes = hunks.filter((h) => h.type === "remove");
    expect(removes.length).toBeGreaterThan(0);
    expect(removes.some((h) => h.author?.name === "Bob")).toBe(true);
    b.destroy();
  });

  it("keeps offsets aligned PAST a FAQ atom — prose after the widget attributes correctly", () => {
    const seed = `<p>Intro paragraph here.</p>
<div class="editor__item editor__faq">
  <div class="e-faq__wrap">
    <div class="e-faq__list is--active">
      <div class="e-faq__head">問題一<span class="e-faq__icon icon-add"></span></div>
      <div class="e-faq__body" style="display: block;"><p>答案一。</p></div>
    </div>
  </div>
</div>
<p>Tail paragraph.</p>`;
    const { docA, committed } = seedByAlice(seed);
    const { docB, b } = joinAsBob(docA);
    // Bob edits the tail paragraph (which sits AFTER the FAQ atom).
    b.commands.insertContentAt(b.state.doc.content.size - 1, " Bob was here.");
    mergeIntoA(docA, docB);
    const working = flatten(docA);

    const resolver = buildBlameResolver(docA)!;
    const hunks = resolver.annotate(computeTrackedChanges(committed, working));
    const adds = hunks.filter((h) => h.type === "add");
    expect(adds.length).toBeGreaterThan(0);
    // If FAQ text had drifted the offset, this would slice the wrong chars and
    // attribute to Alice (or null). It must be Bob.
    for (const h of adds) expect(h.author?.name).toBe("Bob");
    // And the FAQ widget itself survived the round-trip.
    expect(working).toContain('<div class="editor__item editor__faq">');
    b.destroy();
  });

  it("uses the dominant author for a hunk and never throws on mixed authorship", () => {
    const { docA, committed } = seedByAlice("<p>The quick brown fox</p>");
    const { docB, b } = joinAsBob(docA);
    b.commands.insertContentAt(10, "really fast ");
    mergeIntoA(docA, docB);
    const working = flatten(docA);
    const resolver = buildBlameResolver(docA)!;
    const hunks = resolver.annotate(computeTrackedChanges(committed, working));
    // Every add hunk that resolves an author resolves to a real name (Alice/Bob).
    for (const h of hunks.filter((x) => x.type === "add" && x.author)) {
      expect(["Alice", "Bob"]).toContain(h.author?.name);
    }
    b.destroy();
  });

  it("colours the author from peer awareness, neutral when absent", () => {
    const { docA, committed } = seedByAlice("<p>Alpha bravo</p>");
    const { docB, b } = joinAsBob(docA);
    b.commands.insertContentAt(b.state.doc.content.size - 1, " charlie");
    mergeIntoA(docA, docB);
    const working = flatten(docA);
    const tracked = computeTrackedChanges(committed, working);

    // No awareness → neutral fallback.
    const neutral = buildBlameResolver(docA)!.annotate(tracked).find((h) => h.author);
    expect(neutral?.author?.color).toBe(NEUTRAL_COLLAB_COLOR);

    // Awareness carrying Bob's server colour → that colour.
    const awareness = new Awareness(docA);
    awareness.setLocalStateField("user", { name: "Bob", email: "bob@bowtie.com.hk", color: "#3b82f6" });
    const coloured = buildBlameResolver(docA, awareness)!.annotate(tracked).find((h) => h.author?.name === "Bob");
    expect(coloured?.author?.color).toBe("#3b82f6");
    b.destroy();
  });

  it("returns the hunks unchanged when there are none (no work, no mutation)", () => {
    const { docA } = seedByAlice("<p>Same body</p>");
    const same = flatten(docA);
    const resolver = buildBlameResolver(docA)!;
    const tracked = computeTrackedChanges(same, same);
    expect(tracked.hunks).toHaveLength(0);
    expect(resolver.annotate(tracked)).toBe(tracked.hunks);
  });
});
