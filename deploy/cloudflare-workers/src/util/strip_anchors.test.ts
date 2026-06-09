import { describe, expect, it } from "vitest";

import { stripAnchorSpans } from "./strip_anchors";

describe("stripAnchorSpans", () => {
  it("unwraps an AI-edit comment anchor, keeping the text", () => {
    expect(
      stripAnchorSpans('<p>a <span class="comment-anchor" data-comment-id="c1">b</span> c</p>'),
    ).toBe("<p>a b c</p>");
  });

  it("unwraps a human review-thread anchor", () => {
    expect(
      stripAnchorSpans('<p><span data-review-id="r1" class="review-anchor">note</span></p>'),
    ).toBe("<p>note</p>");
  });

  it("removes multiple, attribute-order-independent, back-to-back anchors", () => {
    const html =
      '<p><span data-comment-id="c1" class="comment-anchor">x</span>' +
      '<span class="review-anchor" data-review-id="r2" data-resolved="true">y</span></p>';
    expect(stripAnchorSpans(html)).toBe("<p>xy</p>");
  });

  it("leaves non-anchor spans untouched", () => {
    const html = '<p><span class="e-faq__list">keep</span></p>';
    expect(stripAnchorSpans(html)).toBe(html);
  });

  it("is a no-op on clean content", () => {
    expect(stripAnchorSpans("<h2>Title</h2><p>body</p>")).toBe("<h2>Title</h2><p>body</p>");
  });
});
