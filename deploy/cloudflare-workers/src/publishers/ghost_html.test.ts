import { describe, it, expect } from "vitest";
import { wrapNonNativeHtmlForGhost } from "./ghost_html";

// The exact FAQ block our renderer emits (render.ts::buildFaqHtml).
const FAQ_BLOCK = [
  '<div class="editor__item editor__faq">',
  '  <div class="e-faq__wrap">',
  '    <div class="e-faq__list is--active">',
  '      <div class="e-faq__head">What is covered?<span class="e-faq__icon icon-add"></span></div>',
  '      <div class="e-faq__body" style="display: block;">',
  "        <p>Everything in the plan.</p>",
  "      </div>",
  "    </div>",
  "  </div>",
  "</div>",
].join("\n");

const KG_BEGIN = "<!--kg-card-begin: html-->";
const KG_END = "<!--kg-card-end: html-->";

describe("wrapNonNativeHtmlForGhost", () => {
  it("fences the FAQ accordion block in a Ghost HTML card", () => {
    const out = wrapNonNativeHtmlForGhost(`<h2>FAQ</h2>\n${FAQ_BLOCK}\n`);
    expect(out).toContain(`${KG_BEGIN}\n<div class="editor__item editor__faq">`);
    expect(out).toContain(`</div>\n${KG_END}`);
    // Every accordion class survives inside the fence.
    for (const cls of ["editor__faq", "e-faq__wrap", "e-faq__head", "e-faq__body", "is--active"]) {
      expect(out).toContain(cls);
    }
  });

  it("leaves native prose untouched and unfenced", () => {
    const html = "<h2>Heading</h2>\n<p>Body <strong>text</strong>.</p>\n<ul><li>One</li></ul>";
    expect(wrapNonNativeHtmlForGhost(html)).toBe(html);
  });

  it("does not match indented inner </div> closes (only the outer wrapper)", () => {
    const out = wrapNonNativeHtmlForGhost(FAQ_BLOCK);
    // Exactly one begin/end pair — the block is wrapped once, not per inner div.
    expect(out.match(new RegExp(KG_BEGIN, "g"))?.length).toBe(1);
    expect(out.match(new RegExp(KG_END, "g"))?.length).toBe(1);
  });

  it("is idempotent — re-wrapping an already-fenced block does not nest", () => {
    const once = wrapNonNativeHtmlForGhost(FAQ_BLOCK);
    const twice = wrapNonNativeHtmlForGhost(once);
    expect(twice).toBe(once);
    expect(twice.match(new RegExp(KG_BEGIN, "g"))?.length).toBe(1);
  });

  it("wraps each FAQ block when several are present", () => {
    const out = wrapNonNativeHtmlForGhost(`${FAQ_BLOCK}\n<p>mid</p>\n${FAQ_BLOCK}`);
    expect(out.match(new RegExp(KG_BEGIN, "g"))?.length).toBe(2);
  });
});
