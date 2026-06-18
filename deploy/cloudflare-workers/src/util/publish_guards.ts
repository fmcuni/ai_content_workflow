/**
 * Pre-publish metadata guards shared by the HITL_2 approve path and the
 * dry-publish preview (src/routes/runs.ts). These turn two CMS-side failure
 * modes into friendly, pre-flight messages instead of a raw 4xx from
 * WordPress/Ghost at publish time:
 *
 *  - Scheduled status with no publish date — Ghost's Admin API rejects
 *    `status=scheduled` with no `published_at` (422); WordPress likewise needs a
 *    `date` for a future post. Applies to BOTH kinds.
 *  - Categories on a Ghost target — Ghost has no category taxonomy (tags only),
 *    so `wp_category_ids` is meaningless there. The web hides the picker for
 *    Ghost runs; this makes the API contract self-documenting rather than
 *    silently dropping the value (see docs/ghost-parity-followups.md findings
 *    4 & 5).
 *
 * Pure + synchronous — no DB, no env, no I/O — so it is trivially unit-tested
 * and callable from both the approve mutation and the dry-publish preview.
 */

export interface PublishGuardInput {
  /** Resolved publish-target kind ("wordpress" | "ghost"). */
  kind: string;
  /** WordPress-style status ("publish" | "draft" | "future" | ...) or null. */
  status: string | null | undefined;
  /** ISO-8601 publish timestamp (or a pg timestamp string), or null. */
  publishAt: string | null | undefined;
  /** Effective WordPress category ids, or null. */
  categoryIds: readonly number[] | null | undefined;
}

const SCHEDULED_STATUSES = new Set(["future", "scheduled"]);

/**
 * Return a human-readable validation error, or `null` when the metadata is
 * publishable. The first failing check wins (scheduling is the more common
 * mistake, so it is reported first).
 */
export function checkPublishGuards(input: PublishGuardInput): string | null {
  const status = (input.status ?? "").trim().toLowerCase();
  const hasPublishAt = typeof input.publishAt === "string" && input.publishAt.trim() !== "";
  if (SCHEDULED_STATUSES.has(status) && !hasPublishAt) {
    return "A scheduled publish needs a publish date/time. Set a future date or choose a different status.";
  }

  if (input.kind === "ghost" && Array.isArray(input.categoryIds) && input.categoryIds.length > 0) {
    return "Ghost has no categories — remove the categories or use tags (ghost_tags) instead.";
  }

  return null;
}
