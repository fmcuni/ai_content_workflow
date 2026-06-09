import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import * as Y from "yjs";

import { buildEditorExtensions } from "./editor-extensions";
import { replaceCollabDoc } from "@/lib/run-editor/collab-html";

/**
 * Phase 0b spike — prove the article body survives the collaboration round-trip:
 * HTML → (TipTap schema) → Yjs CRDT doc → (back to) HTML, with the custom
 * `FaqAccordion` node, tables, links, review anchors, and CJK all intact. This
 * is the biggest fidelity risk of moving the body onto Yjs (same class as the
 * 2026-06-09 FAQ-widget flattening regression).
 *
 * Both helpers build their schema through the SSOT `buildEditorExtensions`, so
 * the round-trip is proven against the exact schema the live editor uses.
 */

function makeEditor(ydoc: Y.Doc): Editor {
  return new Editor({
    element: document.createElement("div"),
    extensions: buildEditorExtensions({ collabDoc: ydoc }),
  });
}

/** What today's non-collaborative editor produces from the same HTML — the
 * fidelity baseline. The collab round-trip must add NO loss beyond this. */
function baselineHtml(html: string): string {
  const editor = new Editor({ element: document.createElement("div"), extensions: buildEditorExtensions() });
  try {
    editor.commands.setContent(html);
    return editor.getHTML();
  } finally {
    editor.destroy();
  }
}

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
  // Table content + structure (TipTap normalises the tags identically with or
  // without collaboration, so assert the data survives, not the exact attrs).
  expect(html).toContain("<table");
  expect(html).toContain("方案");
  expect(html).toContain("保費");
  expect(html).toContain("HK$100");
  // Link, review anchor, CJK heading.
  expect(html).toContain('href="https://gobowtie.com/my/vhis"');
  expect(html).toContain('data-review-id="r-abc123"');
  expect(html).toContain("產品比較");
}

describe("collab round-trip fidelity", () => {
  it("preserves FAQ widget, table, link, anchor and CJK from HTML → Yjs → second client → HTML", () => {
    const ydoc = new Y.Doc();
    const author = makeEditor(ydoc);
    try {
      author.commands.setContent(RICH_HTML);
      // A second client reading the SAME Yjs doc reconstructs the article.
      const reader = makeEditor(ydoc);
      try {
        const readerHtml = reader.getHTML();
        expectAllFeaturesPreserved(readerHtml);
        // Strongest proof: the Yjs round-trip is byte-identical to what today's
        // non-collaborative editor produces — collaboration adds zero loss.
        expect(readerHtml).toBe(baselineHtml(RICH_HTML));
      } finally {
        reader.destroy();
      }
    } finally {
      author.destroy();
    }
  });

  it("merges concurrent edits from two clients and keeps the FAQ widget intact", () => {
    const ydocA = new Y.Doc();
    const ydocB = new Y.Doc();

    const a = makeEditor(ydocA);
    const b = makeEditor(ydocB);
    try {
      // Seed A, then bring B to the same starting state.
      a.commands.setContent(RICH_HTML);
      Y.applyUpdate(ydocB, Y.encodeStateAsUpdate(ydocA));

      // Divergent edits: A prepends to the heading, B appends a paragraph.
      a.commands.insertContentAt(1, "新");
      b.commands.insertContentAt(b.state.doc.content.size - 1, "<p>新段落。</p>");

      // Exchange updates both ways (what the RunDoc DO relays in production).
      Y.applyUpdate(ydocA, Y.encodeStateAsUpdate(ydocB, Y.encodeStateVector(ydocA)));
      Y.applyUpdate(ydocB, Y.encodeStateAsUpdate(ydocA, Y.encodeStateVector(ydocB)));

      // Both clients converge to identical content, FAQ widget still intact.
      expect(a.getHTML()).toBe(b.getHTML());
      expectAllFeaturesPreserved(a.getHTML());
      expect(a.getHTML()).toContain("新段落。");
    } finally {
      a.destroy();
      b.destroy();
    }
  });

  it("replaceCollabDoc on a shared doc is reflected in a live editor bound to that doc", () => {
    const ydoc = new Y.Doc();
    // A live editor bound to the shared doc (stands in for the on-screen editor).
    const live = makeEditor(ydoc);
    try {
      live.commands.setContent(RICH_HTML);
      expectAllFeaturesPreserved(live.getHTML());

      // External working-body write (e.g. reject a tracked change) replaces the
      // whole shared fragment with new content — the live editor must reflect it.
      const replacement = "<h2>新標題</h2><p>替換後的內容。</p>";
      replaceCollabDoc(ydoc, replacement);

      const liveHtml = live.getHTML();
      expect(liveHtml).toContain("新標題");
      expect(liveHtml).toContain("替換後的內容。");
      // Old content is gone — this was a whole-fragment replace, not a merge.
      expect(liveHtml).not.toContain("產品比較");
      expect(liveHtml).not.toContain("editor__faq");
    } finally {
      live.destroy();
    }
  });
});
