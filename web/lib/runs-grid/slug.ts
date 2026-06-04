// Slug encode/decode for the Ledger's WordPress slug cell. Slugs are stored
// canonical percent-encoded (`%E6%89%8B…`) so WordPress receives a valid slug;
// the grid shows the decoded CJK (`手足口病`). `encodeSlug` is the canonicalizer
// (decode-then-encode, idempotent) and mirrors the backend `canonicalize_slug`
// (Python `urllib.parse.quote` / Workers `encodeURIComponent`). Pure +
// side-effect-free so the round-trip is unit-testable.

/**
 * Decode a stored slug for display. Falls back to the raw value if it isn't
 * valid percent-encoding (so a hand-typed decoded slug round-trips untouched).
 */
export function decodeSlug(slug: string | null | undefined): string {
  if (!slug) return "";
  try {
    return decodeURIComponent(slug);
  } catch {
    return slug;
  }
}

/**
 * Canonicalize operator input (decoded `手足口病` OR already-encoded `%E6%89%8B…`)
 * to the stored percent-encoded form. Decode-then-encode is idempotent;
 * `decodeSlug(encodeSlug(x))` reproduces the human-readable slug. Returns "" for
 * blank input.
 */
export function encodeSlug(raw: string | null | undefined): string {
  if (!raw) return "";
  const stripped = raw.trim();
  if (!stripped) return "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(stripped);
  } catch {
    decoded = stripped;
  }
  return encodeURIComponent(decoded);
}
