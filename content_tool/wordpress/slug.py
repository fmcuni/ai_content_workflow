"""Canonicalization for WordPress post slugs.

The Ledger board lets operators type a slug either decoded (``手足口病``) or
already percent-encoded (``%E6%89%8B%E8%B6%B3%E5%8F%A3%E7%97%85``). We store the
canonical **encoded** form so WordPress receives a valid slug and the grid can
show the decoded value by reversing it. Decode-then-encode is idempotent, so
re-canonicalizing an already-canonical slug is a no-op.

The ``safe`` set matches JavaScript's ``encodeURIComponent`` exactly so the
Python backend and the Workers/TS backend produce byte-identical output (parity).
"""

from urllib.parse import quote, unquote

# Characters JS encodeURIComponent leaves unescaped: ALPHA / DIGIT / - _ . ! ~ * ' ( ).
# Python's quote always keeps ALPHA/DIGIT/_.-~; we add the rest so the two match.
_SLUG_SAFE = "-_.!~*'()"


def canonicalize_slug(raw: str | None) -> str | None:
    """Return the canonical percent-encoded slug, or ``None`` for blank input.

    ``unquote`` first so an already-encoded slug is not double-encoded; ``quote``
    re-encodes to the form WordPress receives. Idempotent.
    """
    if raw is None:
        return None
    stripped = raw.strip()
    if not stripped:
        return None
    return quote(unquote(stripped), safe=_SLUG_SAFE)
