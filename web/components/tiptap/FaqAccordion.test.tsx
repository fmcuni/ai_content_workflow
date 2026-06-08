import { describe, it, expect } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";

import { FaqAccordion } from "./FaqAccordion";
import { faqItemsToDomSpec, parseFaqElement, type FaqItem } from "./faq-markup";

// The exact widget the production renderer emits (render.ts → buildFaqHtml),
// preceded by the heading, as it is stored in `renders.html_body`.
const RENDERED_FAQ = `<h2>常見問題</h2>
<div class="editor__item editor__faq">
  <div class="e-faq__wrap">
    <div class="e-faq__list is--active">
      <div class="e-faq__head">What is X?<span class="e-faq__icon icon-add"></span></div>
      <div class="e-faq__body" style="display: block;">
        <p>X is a thing.</p>
      </div>
    </div>
    <div class="e-faq__list">
      <div class="e-faq__head">Is Y true?<span class="e-faq__icon icon-add"></span></div>
      <div class="e-faq__body"><p>Yes.</p></div>
    </div>
  </div>
</div>`;

const ITEMS: FaqItem[] = [
  { q: "What is X?", a: "X is a thing." },
  { q: "Is Y true?", a: "Yes." },
];

describe("faqItemsToDomSpec", () => {
  it("rebuilds the exact Bowtie widget structure with first-item active state", () => {
    const spec = faqItemsToDomSpec(ITEMS) as unknown as unknown[];
    expect(spec[0]).toBe("div");
    expect(spec[1]).toEqual({ class: "editor__item editor__faq" });

    const wrap = spec[2] as unknown[];
    expect(wrap[0]).toBe("div");
    expect(wrap[1]).toEqual({ class: "e-faq__wrap" });

    const first = wrap[2] as unknown[];
    expect(first[1]).toEqual({ class: "e-faq__list is--active" });
    const firstHead = first[2] as unknown[];
    expect(firstHead).toEqual([
      "div",
      { class: "e-faq__head" },
      "What is X?",
      ["span", { class: "e-faq__icon icon-add" }],
    ]);
    const firstBody = first[3] as unknown[];
    expect(firstBody[1]).toEqual({ class: "e-faq__body", style: "display: block;" });
    expect(firstBody[2]).toEqual(["p", "X is a thing."]);

    const second = wrap[3] as unknown[];
    expect(second[1]).toEqual({ class: "e-faq__list" });
    const secondBody = second[3] as unknown[];
    expect(secondBody[1]).toEqual({ class: "e-faq__body" });
  });
});

describe("parseFaqElement", () => {
  it("extracts Q/A pairs, dropping the empty icon span text", () => {
    const host = document.createElement("div");
    host.innerHTML = RENDERED_FAQ;
    const faqEl = host.querySelector(".editor__faq") as HTMLElement;
    expect(parseFaqElement(faqEl)).toEqual(ITEMS);
  });
});

describe("FaqAccordion in the editor", () => {
  it("round-trips the FAQ widget through getHTML instead of flattening it", () => {
    const element = document.createElement("div");
    const editor = new Editor({
      element,
      extensions: [StarterKit, FaqAccordion],
      content: RENDERED_FAQ,
    });
    try {
      const html = editor.getHTML();
      // The accordion survives — these are exactly what was being lost.
      expect(html).toContain('<div class="editor__item editor__faq">');
      expect(html).toContain('<div class="e-faq__wrap">');
      expect(html).toContain('<div class="e-faq__list is--active">');
      expect(html).toContain('<span class="e-faq__icon icon-add">');
      expect(html).toContain('<div class="e-faq__body" style="display: block;">');
      expect(html).toContain("What is X?");
      expect(html).toContain("Is Y true?");
      // The heading stays a normal heading, not absorbed into the widget.
      expect(html).toContain("<h2>常見問題</h2>");
    } finally {
      editor.destroy();
    }
  });
});
