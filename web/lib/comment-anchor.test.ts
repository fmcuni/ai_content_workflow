import { describe, expect, it } from "vitest";

import { stripCommentSpan } from "@/lib/comment-anchor";

describe("stripCommentSpan", () => {
  it("strips a bare comment-anchor span, keeping its inner text", () => {
    const html = '<p>keep <span data-comment-id="c-1">this</span> here</p>';
    expect(stripCommentSpan(html, "c-1")).toBe("<p>keep this here</p>");
  });

  it("strips the span even when TipTap adds a class attribute (the deletion bug)", () => {
    // TipTap serialises the anchor with class="comment-anchor" alongside
    // data-comment-id — the old `<span data-comment-id="…">` regex missed this,
    // leaving the highlight behind after the comment was deleted.
    const html = '<p>keep <span data-comment-id="c-1" class="comment-anchor">this</span> here</p>';
    expect(stripCommentSpan(html, "c-1")).toBe("<p>keep this here</p>");
  });

  it("strips regardless of attribute order", () => {
    const html = '<p><span class="comment-anchor" data-comment-id="c-2">x</span></p>';
    expect(stripCommentSpan(html, "c-2")).toBe("<p>x</p>");
  });

  it("only strips the targeted id, leaving other comment spans intact", () => {
    const html =
      '<span data-comment-id="c-1" class="comment-anchor">a</span>' +
      '<span data-comment-id="c-2" class="comment-anchor">b</span>';
    expect(stripCommentSpan(html, "c-1")).toBe('a<span data-comment-id="c-2" class="comment-anchor">b</span>');
  });

  it("no-ops when the span is absent", () => {
    const html = "<p>nothing to strip</p>";
    expect(stripCommentSpan(html, "c-9")).toBe(html);
  });
});
