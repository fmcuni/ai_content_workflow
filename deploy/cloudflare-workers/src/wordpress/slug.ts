/**
 * Canonicalization for WordPress post slugs.
 *
 * The Ledger board lets operators type a slug either decoded (`手足口病`) or
 * already percent-encoded (`%E6%89%8B%E8%B6%B3%E5%8F%A3%E7%97%85`). We store the
 * canonical **encoded** form so WordPress receives a valid slug and the grid can
 * show the decoded value by reversing it. Decode-then-encode is idempotent.
 *
 * Mirrors `content_tool/wordpress/slug.py::canonicalize_slug` byte-for-byte
 * (encodeURIComponent ⇔ Python `quote(safe="-_.!~*'()")`).
 */
export function canonicalizeSlug(raw: string | null | undefined): string | null {
  if (raw == null) {
    return null;
  }
  const stripped = raw.trim();
  if (stripped.length === 0) {
    return null;
  }
  // Decode first so an already-encoded slug is not double-encoded; a malformed
  // percent-sequence (decodeURIComponent throws) is treated as already-decoded.
  let decoded: string;
  try {
    decoded = decodeURIComponent(stripped);
  } catch {
    decoded = stripped;
  }
  return encodeURIComponent(decoded);
}
