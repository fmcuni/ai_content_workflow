import { describe, expect, it } from "vitest";

import { setReviewSpanResolved, stripReviewSpan } from "@/lib/review-anchor";

describe("stripReviewSpan", () => {
  it("removes the review-anchor wrapper but keeps the inner text", () => {
    const html = `<p>Keep <span class="review-anchor" data-review-id="r-1">this</span> text</p>`;
    expect(stripReviewSpan(html, "r-1")).toBe("<p>Keep this text</p>");
  });

  it("matches regardless of attribute order", () => {
    const html = `<p><span data-review-id="r-2" class="review-anchor">x</span></p>`;
    expect(stripReviewSpan(html, "r-2")).toBe("<p>x</p>");
  });

  it("only strips the targeted id, leaving other review anchors intact", () => {
    const html =
      `<span data-review-id="r-1">a</span><span data-review-id="r-2">b</span>`;
    expect(stripReviewSpan(html, "r-1")).toBe(`a<span data-review-id="r-2">b</span>`);
  });

  it("does not touch AI comment anchors (different attribute)", () => {
    const html = `<span data-comment-id="c-1">a</span>`;
    expect(stripReviewSpan(html, "c-1")).toBe(html);
  });

  it("no-ops when the id is absent", () => {
    const html = "<p>nothing here</p>";
    expect(stripReviewSpan(html, "r-9")).toBe(html);
  });
});

describe("setReviewSpanResolved", () => {
  it("adds data-resolved when resolving", () => {
    const html = `<span class="review-anchor" data-review-id="r-1">x</span>`;
    expect(setReviewSpanResolved(html, "r-1", true)).toBe(
      `<span class="review-anchor" data-review-id="r-1" data-resolved="true">x</span>`,
    );
  });

  it("removes data-resolved when reopening", () => {
    const html = `<span data-review-id="r-1" data-resolved="true">x</span>`;
    expect(setReviewSpanResolved(html, "r-1", false)).toBe(
      `<span data-review-id="r-1">x</span>`,
    );
  });

  it("is idempotent when already in the desired state", () => {
    const open = `<span data-review-id="r-1">x</span>`;
    expect(setReviewSpanResolved(open, "r-1", false)).toBe(open);
  });

  it("leaves other ids untouched", () => {
    const html = `<span data-review-id="r-2">x</span>`;
    expect(setReviewSpanResolved(html, "r-1", true)).toBe(html);
  });
});
