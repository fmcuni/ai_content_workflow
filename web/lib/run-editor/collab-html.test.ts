import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import * as Y from "yjs";

import { buildEditorExtensions } from "@/components/tiptap/editor-extensions";
import { flattenCollabDoc, seedCollabDocIfEmpty } from "@/lib/run-editor/collab-html";

/**
 * Flatten/seed fidelity — the headless collab primitives MUST stay byte-identical
 * to the non-collab production editor for the same content (same class of risk as
 * the 2026-06-09 FAQ-widget flattening regression). All editors here build their
 * schema through the SSOT `buildEditorExtensions`, so the test proves the SSOT is
 * truly single-sourced: flatten/seed cannot drift from the live editor.
 */

// Rich article fragment: CJK heading + paragraph with a link + a review-anchor +
// a table + the exact Bowtie FAQ widget the renderer emits.
const RICH_HTML = `<h2>產品比較</h2>
<p>詳情請見<a href="https://gobowtie.com/my/vhis">官方頁面</a>。<span data-review-id="r-abc123">需要覆核</span></p>
<table><tbody><tr><th>方案</th><th>保費</th></tr><tr><td>基本</td><td>HK$100</td></tr></tbody></table>
<div class="editor__item editor__faq">
  <div class="e-faq__wrap">
    <div class="e-faq__list is--active">
      <div class="e-faq__head">什麼是自願醫保？<span class="e-faq__icon icon-add"></span></div>
      <div class="e-faq__body" style="display: block;"><p>一項政府計劃。</p></div>
    </div>
    <div class="e-faq__list">
      <div class="e-faq__head">誰可以投保？<span class="e-faq__icon icon-add"></span></div>
      <div class="e-faq__body"><p>任何人。</p></div>
    </div>
  </div>
</div>`;

function expectAllFeaturesPreserved(html: string): void {
  // Custom FAQ accordion node (the headline risk).
  expect(html).toContain('<div class="editor__item editor__faq">');
  expect(html).toContain('<div class="e-faq__wrap">');
  expect(html).toContain('<div class="e-faq__list is--active">');
  expect(html).toContain('<span class="e-faq__icon icon-add">');
  expect(html).toContain('<div class="e-faq__body" style="display: block;">');
  expect(html).toContain("什麼是自願醫保？");
  expect(html).toContain("誰可以投保？");
  // Table content + structure.
  expect(html).toContain("<table");
  expect(html).toContain("方案");
  expect(html).toContain("保費");
  expect(html).toContain("HK$100");
  // Link, review anchor, CJK heading.
  expect(html).toContain('href="https://gobowtie.com/my/vhis"');
  expect(html).toContain('data-review-id="r-abc123"');
  expect(html).toContain("產品比較");
}

/** Non-collab baseline built through the SSOT: what today's standalone editor
 *  produces from the same HTML. flatten/seed must add NO loss beyond this. */
function baselineHtml(html: string): string {
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: buildEditorExtensions(),
  });
  try {
    editor.commands.setContent(html);
    return editor.getHTML();
  } finally {
    editor.destroy();
  }
}

/** Seed a fresh Yjs doc with RICH_HTML via a headless collab editor (mirrors the
 *  round-trip test) — the doc's shared type then holds the article. */
function seedDoc(html: string): Y.Doc {
  const ydoc = new Y.Doc();
  const editor = new Editor({
    element: document.createElement("div"),
    extensions: buildEditorExtensions({ collabDoc: ydoc }),
  });
  try {
    editor.commands.setContent(html);
  } finally {
    editor.destroy();
  }
  return ydoc;
}

describe("flattenCollabDoc", () => {
  it("is byte-identical to the non-collab baseline (FAQ/table/link/anchor/CJK preserved)", () => {
    const ydoc = seedDoc(RICH_HTML);
    const flattened = flattenCollabDoc(ydoc);

    expectAllFeaturesPreserved(flattened);
    // Strongest proof: flattening the shared doc equals what the standalone
    // non-collab editor produces — the collab path adds zero loss.
    expect(flattened).toBe(baselineHtml(RICH_HTML));
  });
});

describe("seedCollabDocIfEmpty", () => {
  it("seeds an empty doc (returns true) and the flatten then equals the baseline", () => {
    const ydoc = new Y.Doc();

    const seeded = seedCollabDocIfEmpty(ydoc, RICH_HTML);
    expect(seeded).toBe(true);

    const flattened = flattenCollabDoc(ydoc);
    expectAllFeaturesPreserved(flattened);
    expect(flattened).toBe(baselineHtml(RICH_HTML));
  });

  it("no-ops on a non-empty doc (returns false, no duplication, no new content)", () => {
    const ydoc = new Y.Doc();
    expect(seedCollabDocIfEmpty(ydoc, RICH_HTML)).toBe(true);
    const afterFirst = flattenCollabDoc(ydoc);

    // A second seed with different content must be rejected.
    const second = seedCollabDocIfEmpty(ydoc, "<p>other</p>");
    expect(second).toBe(false);

    const afterSecond = flattenCollabDoc(ydoc);
    expect(afterSecond).toBe(afterFirst); // unchanged
    expect(afterSecond).not.toContain("other"); // no clobber
  });

  it("no-ops on empty/whitespace draftHtml (returns false)", () => {
    expect(seedCollabDocIfEmpty(new Y.Doc(), "")).toBe(false);
    expect(seedCollabDocIfEmpty(new Y.Doc(), "   \n  ")).toBe(false);
  });
});
