/**
 * Strip a single comment-anchor `<span data-comment-id="...">` wrapper from an
 * HTML string, keeping its inner text. Used when a comment is deleted or its
 * edit has been applied, so the annotation markup doesn't ride along into the
 * saved body. No-ops when the span is absent.
 */
export function stripCommentSpan(html: string, id: string): string {
  // Escape regex metacharacters in the id (defensive — ids are `c-<hex>` today).
  const safe = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`<span data-comment-id="${safe}">(.*?)</span>`, "gs");
  return html.replace(re, "$1");
}
