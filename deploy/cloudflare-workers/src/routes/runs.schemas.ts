/**
 * Request-body validation schemas for the runs routes (WS5 MEDIUM finding).
 *
 * The run-creation + publish-bearing mutation handlers previously read bodies
 * via unchecked `c.req.json<T>()` casts. These Zod schemas reject malformed /
 * malicious input (bad URLs, oversized keyword lists, unknown enum values,
 * non-datetime publish times) BEFORE the body reaches the DB or WordPress.
 *
 * Design intent (matches the task brief):
 *   - REJECT malformed/malicious input, do NOT tighten product behavior.
 *   - Every field that today is optional stays `.optional()`; schemas
 *     `.passthrough()` so fields the pipeline reads but does not constrain
 *     (e.g. edited_html_body, comments, acf ids) are preserved untouched.
 *   - Enum allowlists are derived from the values the code ACTUALLY accepts:
 *       start_mode  ← VALID_START_MODES (runs.ts) / Literal["refresh","create"]
 *                     (content_tool/api/schemas.py)
 *       mode        ← Literal["auto","small_refresh","full_rewrite"] (schemas.py)
 *       new_route   ← Literal["small_refresh","full_rewrite"] (schemas.py)
 *       resume decision ← Literal["approve","edit_outline","override_route","cancel"]
 *       hitl-2 decision ← Literal["approve","request_changes","reject"]
 *       snapshot trigger ← "interval"|"navigate"|"unload"|"manual"|"generated"
 *       wp_publish_status ← WordPress core post statuses the value is sent to
 *                     verbatim (resolvePublishStatus passes it straight through).
 *                     The UI only emits draft/future/publish; private/pending are
 *                     valid WP statuses, so allowing them rejects garbage without
 *                     constraining real use.
 */
import { z } from "zod";

/** WordPress post statuses we accept on a publish/patch. `resolvePublishStatus`
 * sends this value to WP verbatim, so the allowlist is WP's own accepted set. */
const wpPublishStatus = z
  .enum(["draft", "publish", "future", "private", "pending"])
  .nullish();

/** ISO-8601 datetime string (e.g. "2026-07-01T09:00:00Z"). Nullable/optional. */
const wpPublishAt = z.string().datetime({ offset: true }).nullish();

/** Bounded list of keyword strings — caps payload size / abuse. */
const keywords = z.array(z.string()).max(20);

/** Shared WordPress destination metadata, all optional. Reused by the publish
 * and metadata routes so the enum/datetime rules stay in one place. */
const wpMetaFields = {
  wp_publish_status: wpPublishStatus,
  wp_publish_at: wpPublishAt,
  wp_author_id: z.number().int().nullish(),
  wp_category_ids: z.array(z.number().int()).nullish(),
  wp_tag_ids: z.array(z.number().int()).nullish(),
  wp_featured_media_id: z.number().int().nullish(),
  wp_slug: z.string().nullish(),
  wp_excerpt: z.string().nullish(),
};

/** Ghost destination metadata (kind='ghost' runs), all optional. Authors are
 * staff-user id strings, tags are names (matched/auto-created), feature image
 * is a URL. Bounded to cap payload abuse; empty url allowed (cleared field). */
const ghostMetaFields = {
  ghost_author_ids: z.array(z.string()).max(20).nullish(),
  ghost_tags: z.array(z.string()).max(50).nullish(),
  feature_image_url: z.string().url().or(z.literal("")).nullish(),
};

// ---------------------------------------------------------------------------
// POST /runs — run creation
// ---------------------------------------------------------------------------
export const createRunSchema = z
  .object({
    // refresh runs require a real URL; create runs must omit it. The URL shape
    // is validated here; the create-vs-refresh business rule stays in the
    // handler (it returns 422, not 400).
    article_url: z.string().url().nullish(),
    start_mode: z.enum(["refresh", "create"]).optional(),
    mode: z.enum(["auto", "small_refresh", "full_rewrite"]).optional(),
    keywords: keywords.optional(),
    topic: z.string().optional(),
    persona: z.string().optional(),
    acf_adv_id: z.number().int().optional(),
    acf_widget_id: z.number().int().optional(),
    editor_email: z.string().optional(),
    topic_category: z.string().nullish(),
    edit_note: z.string().nullish(),
    topic_candidate_id: z.string().nullish(),
    target_audience: z.string().nullish(),
    triggered_by_evaluation_id: z.string().nullish(),
    auto_accept_hitl1: z.boolean().optional(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// POST /runs/:id/resume — HITL_1 decision
// ---------------------------------------------------------------------------
export const resumeSchema = z
  .object({
    decision: z.enum(["approve", "edit_outline", "override_route", "cancel"]).optional(),
    edited_outline: z.unknown().optional(),
    new_route: z.enum(["small_refresh", "full_rewrite"]).nullish(),
    notes: z.string().nullish(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// POST /runs/:id/hitl-2 — HITL_2 decision (+ inline edits + WP destination)
// ---------------------------------------------------------------------------
export const hitl2Schema = z
  .object({
    decision: z.enum(["approve", "request_changes", "reject"]).optional(),
    notes: z.string().nullish(),
    comments: z.array(z.unknown()).nullish(),
    editor_email: z.string().nullish(),
    edited_html_body: z.string().nullish(),
    edited_seo_title: z.string().nullish(),
    edited_meta_description: z.string().nullish(),
    ...wpMetaFields,
    ...ghostMetaFields,
  })
  .passthrough();

// ---------------------------------------------------------------------------
// POST /runs/:id/dry-publish — preview publish payload (+ inline edits + WP)
// ---------------------------------------------------------------------------
export const dryPublishSchema = z
  .object({
    edited_html_body: z.string().nullish(),
    edited_seo_title: z.string().nullish(),
    edited_meta_description: z.string().nullish(),
    ...wpMetaFields,
    ...ghostMetaFields,
  })
  .passthrough();

// ---------------------------------------------------------------------------
// PUT /runs/:id/article — save edited article body + WP destination
// ---------------------------------------------------------------------------
export const articleEditSchema = z
  .object({
    html_body: z.string().optional(),
    seo_title: z.string().optional(),
    meta_description: z.string().optional(),
    expected_version: z.number().int().nullish(),
    ...wpMetaFields,
    ...ghostMetaFields,
  })
  .passthrough();

// ---------------------------------------------------------------------------
// PATCH /runs/:id — partial WP-destination metadata patch
// ---------------------------------------------------------------------------
export const runWpMetaPatchSchema = z
  .object({
    acf_adv_id: z.number().int().nullish(),
    acf_widget_id: z.number().int().nullish(),
    wp_author_id: z.number().int().nullish(),
    wp_category_ids: z.array(z.number().int()).nullish(),
    wp_slug: z.string().nullish(),
    wp_publish_status: wpPublishStatus,
    wp_publish_at: wpPublishAt,
    ...ghostMetaFields,
    expected_version: z.number().int().nullish(),
  })
  .passthrough();

// ---------------------------------------------------------------------------
// POST /runs/:id/hitl2-snapshots — autosave snapshot (+ WP destination)
// ---------------------------------------------------------------------------
export const hitl2SnapshotSchema = z
  .object({
    trigger: z.enum(["interval", "navigate", "unload", "manual", "generated"]).optional(),
    html_body: z.string().optional(),
    committed_html_body: z.string().nullish(),
    seo_title: z.string().nullish(),
    meta_description: z.string().nullish(),
    notes: z.string().nullish(),
    comments: z.array(z.unknown()).nullish(),
    ...wpMetaFields,
    ...ghostMetaFields,
  })
  .passthrough();

/** Standard 400 response payload. Surfaces only the flattened FIELD names that
 * failed — never raw values, stack traces, or internal schema text. */
export function validationErrorBody(error: z.ZodError): {
  error: string;
  fields: string[];
} {
  const fields = Array.from(
    new Set(error.issues.map((i) => i.path.map(String).join(".")).filter((p) => p.length > 0)),
  );
  return { error: "invalid request body", fields };
}
