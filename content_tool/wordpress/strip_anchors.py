"""Strip editor annotation anchors from an HTML body before publishing.

AI-edit comment anchors (``<span … data-comment-id="…">``) and human
review-thread anchors (``<span … data-review-id="…">``) are in-document markers
that wrap a text selection so the editor can attach a thread to it. They are NOT
article content: the published page must carry the text WITHOUT the wrapper.

Mirror of the Workers ``stripAnchorSpans`` (``src/util/strip_anchors.ts``) —
keep this byte-for-byte equivalent so the parity gate holds.
"""

import re

_ANCHOR_SPAN_RE = re.compile(
    r'<span\b[^>]*\bdata-(?:comment|review)-id="[^"]*"[^>]*>(.*?)</span>',
    re.IGNORECASE | re.DOTALL,
)


def strip_anchor_spans(html: str) -> str:
    """Unwrap every comment/review anchor span, keeping its inner text.

    Runs to a fixed point so adjacent or back-to-back anchors are all removed.
    """
    prev = html
    while True:
        nxt = _ANCHOR_SPAN_RE.sub(r"\1", prev)
        if nxt == prev:
            return nxt
        prev = nxt
