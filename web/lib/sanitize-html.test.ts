import { afterEach, describe, expect, it, vi } from "vitest";

import { sanitizeArticleHtml } from "@/lib/sanitize-html";
import { buildInlineDiffHtml, computeTrackedChanges } from "@/lib/tracked-changes";

describe("sanitizeArticleHtml", () => {
  it("strips <script> tags", () => {
    const out = sanitizeArticleHtml('<p>hi</p><script>alert(1)</script>');
    expect(out).not.toContain("<script");
    expect(out).toContain("<p>hi</p>");
  });

  it("strips on* event-handler attributes", () => {
    const out = sanitizeArticleHtml('<img src=x onerror=alert(1)>');
    expect(out.toLowerCase()).not.toContain("onerror");
    expect(out).not.toMatch(/\bon\w+\s*=/i);
  });

  it("preserves class attributes", () => {
    const out = sanitizeArticleHtml('<span class="comment">x</span>');
    expect(out).toContain('class="comment"');
  });

  it("preserves data-* attributes (comment-id / review anchors)", () => {
    const out = sanitizeArticleHtml('<span data-comment-id="abc-123" class="cm">x</span>');
    expect(out).toContain('data-comment-id="abc-123"');
    expect(out).toContain('class="cm"');
  });

  it("preserves the FAQ widget div structure", () => {
    const faq =
      '<div class="editor__faq"><div class="e-faq__wrap">' +
      '<div class="e-faq__list"><div class="e-faq__head">Q?' +
      '<span class="e-faq__icon icon-add"></span></div>' +
      '<div class="e-faq__body"><p>A.</p></div></div>' +
      "</div></div>";
    const out = sanitizeArticleHtml(faq);
    expect(out).toContain('class="editor__faq"');
    expect(out).toContain('class="e-faq__list"');
    expect(out).toContain('class="e-faq__head"');
    expect(out).toContain('class="e-faq__body"');
  });
});

describe("tracked-changes XSS sanitization (boundary)", () => {
  it("produces NO <script> tag from a malicious diff input", () => {
    const committed = "<p>safe baseline</p>";
    const working = '<p>safe baseline</p><script>alert(1)</script>';
    const { parts } = computeTrackedChanges(committed, working);
    const html = buildInlineDiffHtml(parts);
    expect(html).not.toContain("<script");
  });

  it("produces NO onerror / on* attribute from a malicious diff input", () => {
    const committed = "<p>safe baseline</p>";
    const working = '<p>safe baseline</p><img src=x onerror=alert(1)>';
    const { parts } = computeTrackedChanges(committed, working);
    const html = buildInlineDiffHtml(parts);
    expect(html.toLowerCase()).not.toContain("onerror");
    expect(html).not.toMatch(/\bon\w+\s*=/i);
  });

  it("strips XSS present in the committed baseline too", () => {
    const committed = '<p>x</p><script>alert(1)</script>';
    const working = "<p>x</p>";
    const { parts } = computeTrackedChanges(committed, working);
    const html = buildInlineDiffHtml(parts);
    expect(html).not.toContain("<script");
  });

  it("still wraps a legitimate text change in <ins>/<del>", () => {
    const { parts } = computeTrackedChanges("<p>red car</p>", "<p>blue car</p>");
    const html = buildInlineDiffHtml(parts);
    expect(html).toContain("<ins");
    expect(html).toContain("<del");
  });

  it("preserves comment spans (data-comment-id + class) through the diff", () => {
    const span = '<span class="cm-highlight" data-comment-id="c-1">flagged</span>';
    const committed = `<p>before ${span} after</p>`;
    const working = `<p>before ${span} after edited</p>`;
    const { parts } = computeTrackedChanges(committed, working);
    const html = buildInlineDiffHtml(parts);
    expect(html).toContain('data-comment-id="c-1"');
    expect(html).toContain('class="cm-highlight"');
  });

  it("preserves the FAQ widget markup through the diff", () => {
    const faq = (extra: string) =>
      '<div class="editor__faq"><div class="e-faq__wrap">' +
      '<div class="e-faq__list"><div class="e-faq__head">Question?' +
      '<span class="e-faq__icon icon-add"></span></div>' +
      `<div class="e-faq__body"><p>Answer.${extra}</p></div></div>` +
      "</div></div>";
    const { parts } = computeTrackedChanges(faq(""), faq(" more"));
    const html = buildInlineDiffHtml(parts);
    expect(html).toContain('class="e-faq__list"');
    expect(html).toContain('class="e-faq__head"');
    expect(html).toContain('class="e-faq__body"');
  });
});

describe("sanitizeArticleHtml — SSR fallback (no DOM / Workers runtime)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("strips script/on*/javascript: without a DOM and preserves legit markup", () => {
    vi.stubGlobal("window", undefined);
    const out = sanitizeArticleHtml(
      '<p class="a" data-comment-id="c1">hi</p>' +
        "<script>alert(1)</script>" +
        "<img src=x onerror=alert(1)>" +
        '<a href="javascript:alert(1)">x</a>',
    );
    expect(out).not.toContain("<script");
    expect(out.toLowerCase()).not.toContain("onerror");
    expect(out).not.toMatch(/\son[a-z]+\s*=/i);
    expect(out.toLowerCase()).not.toContain("javascript:");
    // legit markup (class + comment-anchor data-*) preserved verbatim
    expect(out).toContain('class="a"');
    expect(out).toContain('data-comment-id="c1"');
  });
});
