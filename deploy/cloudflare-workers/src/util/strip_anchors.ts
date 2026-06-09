/**
 * Strip editor annotation anchors from an HTML body before it leaves for
 * WordPress. AI-edit comment anchors (`<span … data-comment-id="…">`) and human
 * review-thread anchors (`<span … data-review-id="…">`) are in-document markers
 * that wrap a text selection so the editor can attach a thread to it. They are
 * NOT article content: the published page must carry the text WITHOUT the
 * wrapper.
 *
 * Unwrap = keep the inner text, drop the `<span …>`/`</span>` wrapper. Matching
 * is attribute-order independent (`class` may precede the `data-*-id`). The
 * loop runs to a fixed point so adjacent or back-to-back anchors are all
 * removed. PURE: no DOM, just string assembly — must stay byte-for-byte
 * identical to the Python `strip_anchor_spans` so the parity gate holds.
 */
const ANCHOR_SPAN_RE =
  /<span\b[^>]*\bdata-(?:comment|review)-id="[^"]*"[^>]*>([\s\S]*?)<\/span>/gi;

export function stripAnchorSpans(html: string): string {
  let prev = html;
  for (;;) {
    const next = prev.replace(ANCHOR_SPAN_RE, "$1");
    if (next === prev) return next;
    prev = next;
  }
}
