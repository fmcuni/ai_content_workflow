/**
 * URL → CMS slug helpers shared by the WordPress and Ghost publish paths.
 *
 * A "slug" here is the last non-empty path segment of an article URL — the
 * piece both CMSes derive the public permalink from. When the operator changes
 * the slug for an already-published article we want to CREATE a new post (and
 * surface the freshly published URL) rather than overwrite the existing one.
 */

/** Percent-decode a slug segment, best-effort (malformed input passes through). */
function decodeSlugSegment(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * Last non-empty path segment of a URL/path = the CMS slug, best-effort.
 * Handles trailing slash, query, hash, and bare paths. Returns null if none.
 */
export function slugFromUrl(url: string | null | undefined): string | null {
  if (url === null || url === undefined || url === "") return null;
  try {
    const path = url.includes("://") ? new URL(url).pathname : (url.split(/[?#]/)[0] ?? "");
    const segs = path.split("/").filter((s) => s.length > 0);
    const last = segs[segs.length - 1];
    return last !== undefined && last !== "" ? decodeURIComponent(last) : null;
  } catch {
    return null;
  }
}

/**
 * Force a fresh create when the operator changed the slug of an already-published
 * post. Returns `null` (→ upsert creates a NEW post) only when ALL hold:
 *   - there IS an existing post id (so a first-push create is never affected),
 *   - the existing URL yields a non-null slug, and
 *   - the operator's new slug is non-empty AND differs from the existing slug.
 * Otherwise returns the existing post id unchanged.
 *
 * Generic over the CMS id type: WordPress ids are numbers, Ghost ids are strings.
 */
export function resolvePostIdForSlug<T extends string | number>(
  existingPostId: T | null,
  existingUrl: string | null,
  newSlugRaw: string | null,
): T | null {
  const existingPostIdPresent = existingPostId !== null && (existingPostId as unknown) !== "";
  // Normalize both sides to decoded form before comparing. `slugFromUrl` already
  // decodes; `newSlugRaw` (run.wp_slug) is stored percent-encoded for CJK slugs
  // (e.g. "%e7%b4%ab..."), so a raw compare always mismatched the decoded URL
  // slug ("紫蘇油") and forced a spurious CREATE — a duplicate "紫蘇油-2" post
  // instead of updating the existing one. Decode is idempotent for ASCII slugs.
  const newSlug = decodeSlugSegment((newSlugRaw ?? "").trim());
  const existingSlug = slugFromUrl(existingUrl);
  if (existingPostIdPresent && existingSlug !== null && newSlug !== "" && newSlug !== existingSlug) {
    return null;
  }
  return existingPostId;
}
