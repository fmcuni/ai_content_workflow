/**
 * Shared, pure form-shaping helpers for the run-editor pages (/hitl2, /edit,
 * /regenerate). Every function is immutable — it returns new objects and never
 * mutates its arguments. See the spec at
 * docs/superpowers/specs/2026-06-01-run-editor-shared-components.md (§A).
 */
import type {
  ArticleEditRequest,
  DryPublishRequest,
  Hitl2Comment,
  Hitl2Request,
  Hitl2Snapshot,
  Hitl2SnapshotIn,
  Hitl2SnapshotTrigger,
} from "@/lib/types";

export type WpPublishStatus = "draft" | "future" | "publish";

const WP_PUBLISH_STATUSES: readonly WpPublishStatus[] = ["draft", "future", "publish"];

/** Narrow an arbitrary stored status string to the form union; else undefined. */
export function asPublishStatus(value: string | null | undefined): WpPublishStatus | undefined {
  return WP_PUBLISH_STATUSES.find((s) => s === value);
}

/**
 * True when the HTML body carries no real content. TipTap emits an empty string
 * (or a bare `<p></p>`) while it is torn down on unmount; persisting that would
 * clobber good work and, once reloaded, leave the editor blank.
 */
export function isBlankBody(html: string | null | undefined): boolean {
  if (!html) return true;
  // Mirrors the pre-refactor guard exactly — it does NOT collapse the literal
  // "&nbsp;" HTML entity, so "<p>&nbsp;</p>" reads as non-blank, just as before.
  return (
    html
      .replace(/<[^>]*>/g, "")
      .replace(/ /g, "")
      .trim().length === 0
  );
}

/** Build a snapshot DTO from the live editor state. */
export function buildSnapshotIn(
  html: string,
  form: Hitl2Request,
  comments: Hitl2Comment[],
  trigger: Hitl2SnapshotTrigger,
): Hitl2SnapshotIn {
  return {
    trigger,
    html_body: html,
    seo_title: form.edited_seo_title ?? null,
    meta_description: form.edited_meta_description ?? null,
    notes: form.notes ?? null,
    comments,
    wp_publish_status: form.wp_publish_status,
    wp_author_id: form.wp_author_id ?? null,
    wp_category_ids: form.wp_category_ids ?? null,
    wp_tag_ids: form.wp_tag_ids ?? null,
    wp_featured_media_id: form.wp_featured_media_id ?? null,
    wp_slug: form.wp_slug ?? null,
    wp_excerpt: form.wp_excerpt ?? null,
    wp_publish_at: form.wp_publish_at ?? null,
  };
}

/** Build the dry-publish request DTO from the live editor state. */
export function buildDryRequest(html: string, form: Hitl2Request): DryPublishRequest {
  return {
    edited_html_body: html,
    edited_seo_title: form.edited_seo_title ?? null,
    edited_meta_description: form.edited_meta_description ?? null,
    wp_publish_status: form.wp_publish_status,
    wp_author_id: form.wp_author_id ?? null,
    wp_category_ids: form.wp_category_ids ?? null,
    wp_tag_ids: form.wp_tag_ids ?? null,
    wp_featured_media_id: form.wp_featured_media_id ?? null,
    wp_slug: form.wp_slug ?? null,
    wp_excerpt: form.wp_excerpt ?? null,
    wp_publish_at: form.wp_publish_at ?? null,
  };
}

/** Build the article-save DTO (seo_title/meta_description default to ""). */
export function buildArticlePayload(html: string, form: Hitl2Request): ArticleEditRequest {
  return {
    html_body: html,
    seo_title: form.edited_seo_title ?? "",
    meta_description: form.edited_meta_description ?? "",
    wp_publish_status: form.wp_publish_status,
    wp_author_id: form.wp_author_id ?? null,
    wp_category_ids: form.wp_category_ids ?? null,
    wp_tag_ids: form.wp_tag_ids ?? null,
    wp_featured_media_id: form.wp_featured_media_id ?? null,
    wp_slug: form.wp_slug ?? null,
    wp_excerpt: form.wp_excerpt ?? null,
    wp_publish_at: form.wp_publish_at ?? null,
  };
}

/** Stable comparison key for dirty-tracking; ignores the (non-content) trigger. */
export function snapshotKey(s: Hitl2SnapshotIn): string {
  return JSON.stringify([
    s.html_body,
    s.seo_title ?? null,
    s.meta_description ?? null,
    s.notes ?? null,
    s.comments ?? [],
    s.wp_publish_status ?? null,
    s.wp_author_id ?? null,
    s.wp_category_ids ?? null,
    s.wp_tag_ids ?? null,
    s.wp_featured_media_id ?? null,
    s.wp_slug ?? null,
    s.wp_excerpt ?? null,
    s.wp_publish_at ?? null,
  ]);
}

/**
 * Shape a saved snapshot into the same form `buildSnapshotIn` produces, so a
 * freshly-restored page reads as clean (its key matches the live one exactly).
 */
export function snapshotInFromSaved(s: Hitl2Snapshot): Hitl2SnapshotIn {
  return {
    trigger: "manual",
    html_body: s.html_body,
    seo_title: s.seo_title ?? null,
    meta_description: s.meta_description ?? null,
    notes: s.notes ?? null,
    comments: s.comments ?? [],
    wp_publish_status: s.wp_publish_status ?? "draft",
    wp_author_id: s.wp_author_id ?? null,
    wp_category_ids: s.wp_category_ids ?? null,
    wp_tag_ids: s.wp_tag_ids ?? null,
    wp_featured_media_id: s.wp_featured_media_id ?? null,
    wp_slug: s.wp_slug ?? null,
    wp_excerpt: s.wp_excerpt ?? null,
    wp_publish_at: s.wp_publish_at ?? null,
  };
}

/**
 * Immutable mapper: overlay a restored snapshot onto an existing form. Mirrors
 * the /edit restore overlay — seo/meta/notes fall back to the prior form value
 * when the snapshot omits them, and an unknown wp_publish_status keeps the
 * prior form value.
 */
export function applySnapshotToForm(form: Hitl2Request, s: Hitl2Snapshot): Hitl2Request {
  return {
    ...form,
    edited_seo_title: s.seo_title ?? form.edited_seo_title,
    edited_meta_description: s.meta_description ?? form.edited_meta_description,
    notes: s.notes ?? form.notes,
    wp_publish_status: asPublishStatus(s.wp_publish_status) ?? form.wp_publish_status,
    // Fall back to the current form (WP prefill) when the snapshot didn't carry
    // these, so hydrating a snapshot never clears a known author/category/slug.
    wp_author_id: s.wp_author_id ?? form.wp_author_id ?? null,
    wp_category_ids: s.wp_category_ids ?? form.wp_category_ids ?? null,
    wp_tag_ids: s.wp_tag_ids ?? null,
    wp_featured_media_id: s.wp_featured_media_id ?? null,
    wp_slug: s.wp_slug ?? form.wp_slug ?? null,
    wp_excerpt: s.wp_excerpt ?? null,
    wp_publish_at: s.wp_publish_at ?? null,
  };
}
