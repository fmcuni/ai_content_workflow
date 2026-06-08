/**
 * Pure HTML-string helpers for the human review-thread highlight spans
 * (`<span data-review-id="…" class="review-anchor">`). Separate from the AI
 * comment-anchor helpers in `comment-anchor.ts`.
 */

function escapeId(id: string): string {
  return id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Strip a single review-anchor span wrapper, keeping its inner text. Used when a
 * review thread is deleted so the highlight markup doesn't ride along into the
 * saved body. No-ops when the span is absent. Matches the wrapper regardless of
 * attribute order (TipTap serialises `class` alongside `data-review-id`).
 */
export function stripReviewSpan(html: string, id: string): string {
  const re = new RegExp(
    `<span\\b[^>]*\\bdata-review-id="${escapeId(id)}"[^>]*>(.*?)</span>`,
    "gs",
  );
  return html.replace(re, "$1");
}

/**
 * Toggle the `data-resolved` attribute on the review-anchor span(s) for a given
 * id, so a resolved thread's highlight dims (CSS `[data-resolved="true"]`). The
 * change round-trips through the TipTap `ReviewAnchor` mark's `resolved` attr.
 */
export function setReviewSpanResolved(html: string, id: string, resolved: boolean): string {
  const re = new RegExp(
    `(<span\\b[^>]*\\bdata-review-id="${escapeId(id)}"[^>]*?)(\\s+data-resolved="[^"]*")?(>)`,
    "gs",
  );
  return html.replace(re, (_m, open: string, _existing: string | undefined, close: string) =>
    resolved ? `${open} data-resolved="true"${close}` : `${open}${close}`,
  );
}
