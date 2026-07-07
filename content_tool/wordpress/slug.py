"""Canonicalization for WordPress post slugs.

The Ledger board lets operators type a slug either decoded (``手足口病``) or
already percent-encoded (``%E6%89%8B%E8%B6%B3%E5%8F%A3%E7%97%85``). We store the
canonical **encoded** form so WordPress receives a valid slug and the grid can
show the decoded value by reversing it. Decode-then-encode is idempotent, so
re-canonicalizing an already-canonical slug is a no-op.

The ``safe`` set matches JavaScript's ``encodeURIComponent`` exactly so the
Python backend and the Workers/TS backend produce byte-identical output (parity).
"""

from urllib.parse import quote, unquote, urlsplit

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


def slug_from_url(url: str | None) -> str | None:
    """Last non-empty path segment of a URL/path = the CMS slug, best-effort.

    Handles trailing slash, query, hash, and bare paths. Returns ``None`` if
    none. Python twin of the TS ``slugFromUrl`` (``deploy/cloudflare-workers/
    src/util/url_slug.ts``) — keep both in sync.
    """
    if not url:
        return None
    try:
        path = urlsplit(url).path if "://" in url else url.split("?")[0].split("#")[0]
        segments = [s for s in path.split("/") if s]
        if not segments:
            return None
        return unquote(segments[-1])
    except ValueError:
        return None


def resolve_post_id_for_slug[T: (int, str)](
    existing_post_id: T | None,
    existing_url: str | None,
    new_slug_raw: str | None,
) -> T | None:
    """Force a fresh create when the operator changed the slug of a published post.

    Returns ``None`` (→ upsert creates a NEW post) only when ALL hold:
      - there IS an existing post id (so a first-push create is never affected),
      - the existing URL yields a non-null slug, and
      - the operator's new slug is non-empty AND differs from the existing slug.
    Otherwise returns the existing post id unchanged.

    Generic over the CMS id type: WordPress ids are ints, Ghost ids are strings
    (Ghost is TS-only today, but the signature stays generic for parity).
    Python twin of the TS ``resolvePostIdForSlug`` (``deploy/cloudflare-workers/
    src/util/url_slug.ts``) — keep both in sync.
    """
    existing_present = existing_post_id is not None and existing_post_id != ""
    try:
        new_slug = unquote((new_slug_raw or "").strip())
    except ValueError:
        new_slug = (new_slug_raw or "").strip()
    existing_slug = slug_from_url(existing_url)
    slug_changed = new_slug != "" and new_slug != existing_slug
    if existing_present and existing_slug is not None and slug_changed:
        return None
    return existing_post_id
