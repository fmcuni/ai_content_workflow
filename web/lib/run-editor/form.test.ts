import { describe, expect, it } from "vitest";

import type {
  Hitl2Comment,
  Hitl2Request,
  Hitl2Snapshot,
} from "@/lib/types";

// The module under test does NOT exist yet — this import drives the RED state.
import {
  applySnapshotToForm,
  asPublishStatus,
  buildArticlePayload,
  buildDryRequest,
  buildSnapshotIn,
  isBlankBody,
  snapshotInFromSaved,
  snapshotKey,
} from "@/lib/run-editor/form";

// --- Fixtures ---------------------------------------------------------------

const sampleComments: Hitl2Comment[] = [
  { id: "c1", anchor_text: "lede", body: "punch this up" },
];

/** A fully-populated editor form, exercising every wp_* field. */
function makeForm(overrides: Partial<Hitl2Request> = {}): Hitl2Request {
  return {
    decision: "approve",
    notes: "tighten the intro",
    edited_seo_title: "SEO Title",
    edited_meta_description: "Meta description",
    wp_publish_status: "draft",
    wp_author_id: 7,
    wp_category_ids: [3, 4],
    wp_tag_ids: [9],
    wp_featured_media_id: 11,
    wp_slug: "my-slug",
    wp_excerpt: "An excerpt",
    wp_publish_at: "2026-06-01T00:00:00Z",
    ...overrides,
  };
}

/** A fully-populated saved snapshot, exercising every field. */
function makeSnapshot(overrides: Partial<Hitl2Snapshot> = {}): Hitl2Snapshot {
  return {
    snapshot_id: "s1",
    created_at: "2026-06-01T00:00:00Z",
    created_by: "tester",
    trigger: "interval",
    html_body: "<p>Saved body</p>",
    seo_title: "Saved SEO",
    meta_description: "Saved meta",
    notes: "saved notes",
    comments: sampleComments,
    wp_publish_status: "publish",
    wp_author_id: 7,
    wp_category_ids: [3, 4],
    wp_tag_ids: [9],
    wp_featured_media_id: 11,
    wp_slug: "saved-slug",
    wp_excerpt: "saved excerpt",
    wp_publish_at: "2026-06-02T00:00:00Z",
    ...overrides,
  };
}

// --- asPublishStatus --------------------------------------------------------

describe("asPublishStatus", () => {
  it("passes the three valid statuses through unchanged", () => {
    expect(asPublishStatus("draft")).toBe("draft");
    expect(asPublishStatus("future")).toBe("future");
    expect(asPublishStatus("publish")).toBe("publish");
  });

  it("returns undefined for empty string, null, undefined, and garbage", () => {
    expect(asPublishStatus("")).toBeUndefined();
    expect(asPublishStatus(null)).toBeUndefined();
    expect(asPublishStatus(undefined)).toBeUndefined();
    expect(asPublishStatus("garbage")).toBeUndefined();
    expect(asPublishStatus("DRAFT")).toBeUndefined();
  });
});

// --- isBlankBody ------------------------------------------------------------

describe("isBlankBody", () => {
  it("is true for null/undefined/empty/teardown markup/whitespace", () => {
    expect(isBlankBody(null)).toBe(true);
    expect(isBlankBody(undefined)).toBe(true);
    expect(isBlankBody("")).toBe(true);
    expect(isBlankBody("<p></p>")).toBe(true);
    expect(isBlankBody("   ")).toBe(true);
    // The non-breaking-space CHARACTER (U+00A0) is stripped, so an nbsp-only
    // paragraph is blank.
    expect(isBlankBody("<p> </p>")).toBe(true);
    expect(isBlankBody("<p>  </p>")).toBe(true);
  });

  it("is false when the body carries real text", () => {
    expect(isBlankBody("<p>Hi</p>")).toBe(false);
    expect(isBlankBody("plain text")).toBe(false);
    expect(isBlankBody("<p>Hello&nbsp;world</p>")).toBe(false);
    // The literal "&nbsp;" ENTITY is NOT collapsed — matches the pre-refactor
    // guard, which only stripped the U+00A0 character.
    expect(isBlankBody("<p>&nbsp;</p>")).toBe(false);
  });
});

// --- buildSnapshotIn --------------------------------------------------------

describe("buildSnapshotIn", () => {
  it("maps edited_* fields to snapshot fields and echoes the trigger + comments", () => {
    const form = makeForm();
    const snap = buildSnapshotIn("<p>Body</p>", form, sampleComments, "interval");

    expect(snap).toEqual({
      trigger: "interval",
      html_body: "<p>Body</p>",
      committed_html_body: null,
      seo_title: "SEO Title",
      meta_description: "Meta description",
      notes: "tighten the intro",
      comments: sampleComments,
      wp_publish_status: "draft",
      wp_author_id: 7,
      wp_category_ids: [3, 4],
      wp_tag_ids: [9],
      wp_featured_media_id: 11,
      wp_slug: "my-slug",
      wp_excerpt: "An excerpt",
      wp_publish_at: "2026-06-01T00:00:00Z",
    });
  });

  it("emits null for every absent wp_* / seo / meta / notes field", () => {
    const form: Hitl2Request = { decision: "approve", wp_publish_status: "draft" };
    const snap = buildSnapshotIn("<p>Body</p>", form, [], "manual");

    expect(snap).toEqual({
      trigger: "manual",
      html_body: "<p>Body</p>",
      committed_html_body: null,
      seo_title: null,
      meta_description: null,
      notes: null,
      comments: [],
      wp_publish_status: "draft",
      wp_author_id: null,
      wp_category_ids: null,
      wp_tag_ids: null,
      wp_featured_media_id: null,
      wp_slug: null,
      wp_excerpt: null,
      wp_publish_at: null,
    });
  });

  it("does not mutate the form argument", () => {
    const form = makeForm();
    const before = JSON.stringify(form);
    buildSnapshotIn("<p>Body</p>", form, sampleComments, "manual");
    expect(JSON.stringify(form)).toBe(before);
  });
});

// --- buildDryRequest --------------------------------------------------------

describe("buildDryRequest", () => {
  it("maps the editor state to a DryPublishRequest", () => {
    const form = makeForm();
    const req = buildDryRequest("<p>Body</p>", form);

    expect(req).toEqual({
      edited_html_body: "<p>Body</p>",
      edited_seo_title: "SEO Title",
      edited_meta_description: "Meta description",
      wp_publish_status: "draft",
      wp_author_id: 7,
      wp_category_ids: [3, 4],
      wp_tag_ids: [9],
      wp_featured_media_id: 11,
      wp_slug: "my-slug",
      wp_excerpt: "An excerpt",
      wp_publish_at: "2026-06-01T00:00:00Z",
    });
  });

  it("emits null for absent seo/meta/wp_* fields", () => {
    const form: Hitl2Request = { decision: "approve", wp_publish_status: "future" };
    const req = buildDryRequest("<p>Body</p>", form);

    expect(req).toEqual({
      edited_html_body: "<p>Body</p>",
      edited_seo_title: null,
      edited_meta_description: null,
      wp_publish_status: "future",
      wp_author_id: null,
      wp_category_ids: null,
      wp_tag_ids: null,
      wp_featured_media_id: null,
      wp_slug: null,
      wp_excerpt: null,
      wp_publish_at: null,
    });
  });
});

// --- buildArticlePayload ----------------------------------------------------

describe("buildArticlePayload", () => {
  it("maps the editor state to an ArticleEditRequest", () => {
    const form = makeForm();
    const payload = buildArticlePayload("<p>Body</p>", form);

    expect(payload).toEqual({
      html_body: "<p>Body</p>",
      seo_title: "SEO Title",
      meta_description: "Meta description",
      wp_publish_status: "draft",
      wp_author_id: 7,
      wp_category_ids: [3, 4],
      wp_tag_ids: [9],
      wp_featured_media_id: 11,
      wp_slug: "my-slug",
      wp_excerpt: "An excerpt",
      wp_publish_at: "2026-06-01T00:00:00Z",
    });
  });

  it("falls back to empty string for absent seo_title / meta_description", () => {
    const form: Hitl2Request = { decision: "approve", wp_publish_status: "draft" };
    const payload = buildArticlePayload("<p>Body</p>", form);

    expect(payload.seo_title).toBe("");
    expect(payload.meta_description).toBe("");
    expect(payload.wp_author_id).toBeNull();
    expect(payload.wp_excerpt).toBeNull();
  });
});

// --- snapshotKey ------------------------------------------------------------

describe("snapshotKey", () => {
  it("is identical for two equal snapshots regardless of key insertion order", () => {
    const a = buildSnapshotIn("<p>Body</p>", makeForm(), sampleComments, "interval");
    // Same content, but a different trigger and a shuffled object shape.
    const b = buildSnapshotIn("<p>Body</p>", makeForm(), sampleComments, "manual");
    expect(snapshotKey(a)).toBe(snapshotKey(b));
  });

  it("ignores the trigger (non-content) field", () => {
    const base = buildSnapshotIn("<p>Body</p>", makeForm(), sampleComments, "interval");
    const navigate = { ...base, trigger: "navigate" as const };
    const unload = { ...base, trigger: "unload" as const };
    expect(snapshotKey(navigate)).toBe(snapshotKey(unload));
  });

  it("changes when any content field changes", () => {
    const base = buildSnapshotIn("<p>Body</p>", makeForm(), sampleComments, "manual");
    const key = snapshotKey(base);

    expect(snapshotKey({ ...base, html_body: "<p>Other</p>" })).not.toBe(key);
    expect(snapshotKey({ ...base, seo_title: "Different" })).not.toBe(key);
    expect(snapshotKey({ ...base, meta_description: "Different" })).not.toBe(key);
    expect(snapshotKey({ ...base, notes: "Different" })).not.toBe(key);
    expect(snapshotKey({ ...base, comments: [] })).not.toBe(key);
    expect(snapshotKey({ ...base, wp_publish_status: "publish" })).not.toBe(key);
    expect(snapshotKey({ ...base, wp_author_id: 999 })).not.toBe(key);
    expect(snapshotKey({ ...base, wp_category_ids: [99] })).not.toBe(key);
    expect(snapshotKey({ ...base, wp_tag_ids: [99] })).not.toBe(key);
    expect(snapshotKey({ ...base, wp_featured_media_id: 99 })).not.toBe(key);
    expect(snapshotKey({ ...base, wp_slug: "other" })).not.toBe(key);
    expect(snapshotKey({ ...base, wp_excerpt: "other" })).not.toBe(key);
    expect(snapshotKey({ ...base, wp_publish_at: "2030-01-01" })).not.toBe(key);
  });

  it("serializes the fields in the documented order with ?? null / ?? [] defaults", () => {
    const minimal = buildSnapshotIn(
      "<p>Body</p>",
      { decision: "approve", wp_publish_status: "draft" },
      [],
      "manual",
    );
    expect(snapshotKey(minimal)).toBe(
      JSON.stringify([
        "<p>Body</p>",
        null, // committed_html_body
        null,
        null,
        null,
        [],
        "draft",
        null,
        null,
        null,
        null,
        null,
        null,
        null,
      ]),
    );
  });
});

// --- snapshotInFromSaved ----------------------------------------------------

describe("snapshotInFromSaved", () => {
  it("forces trigger to manual", () => {
    const saved = makeSnapshot({ trigger: "unload" });
    expect(snapshotInFromSaved(saved).trigger).toBe("manual");
  });

  it("defaults wp_publish_status to draft when absent", () => {
    const saved = makeSnapshot({ wp_publish_status: null });
    expect(snapshotInFromSaved(saved).wp_publish_status).toBe("draft");
  });

  it("passes wp_publish_status through when present", () => {
    const saved = makeSnapshot({ wp_publish_status: "publish" });
    expect(snapshotInFromSaved(saved).wp_publish_status).toBe("publish");
  });

  it("coerces absent comments to an empty array", () => {
    const saved = makeSnapshot({ comments: null });
    expect(snapshotInFromSaved(saved).comments).toEqual([]);
  });

  it("round-trips: key matches the equivalent live snapshot", () => {
    const saved = makeSnapshot({ trigger: "interval" });
    const fromSaved = snapshotInFromSaved(saved);

    // An equivalent live snapshot built from a form carrying the same content.
    const live = buildSnapshotIn(
      saved.html_body,
      makeForm({
        edited_seo_title: saved.seo_title,
        edited_meta_description: saved.meta_description,
        notes: saved.notes,
        wp_publish_status: "publish",
        wp_author_id: saved.wp_author_id,
        wp_category_ids: saved.wp_category_ids,
        wp_tag_ids: saved.wp_tag_ids,
        wp_featured_media_id: saved.wp_featured_media_id,
        wp_slug: saved.wp_slug,
        wp_excerpt: saved.wp_excerpt,
        wp_publish_at: saved.wp_publish_at,
      }),
      saved.comments ?? [],
      "manual",
    );

    expect(snapshotKey(fromSaved)).toBe(snapshotKey(live));
  });
});

// --- applySnapshotToForm ----------------------------------------------------

describe("applySnapshotToForm", () => {
  it("returns a NEW object and does not mutate the input form", () => {
    const form = makeForm();
    const snapshot = makeSnapshot();
    const result = applySnapshotToForm(form, snapshot);

    expect(result).not.toBe(form);
    expect(form.wp_slug).toBe("my-slug"); // original untouched
  });

  it("overlays the snapshot's fields onto the form", () => {
    const form = makeForm({ wp_publish_status: "draft" });
    const snapshot = makeSnapshot();
    const result = applySnapshotToForm(form, snapshot);

    expect(result.edited_seo_title).toBe("Saved SEO");
    expect(result.edited_meta_description).toBe("Saved meta");
    expect(result.notes).toBe("saved notes");
    expect(result.wp_publish_status).toBe("publish");
    expect(result.wp_author_id).toBe(7);
    expect(result.wp_category_ids).toEqual([3, 4]);
    expect(result.wp_tag_ids).toEqual([9]);
    expect(result.wp_featured_media_id).toBe(11);
    expect(result.wp_slug).toBe("saved-slug");
    expect(result.wp_excerpt).toBe("saved excerpt");
    expect(result.wp_publish_at).toBe("2026-06-02T00:00:00Z");
  });

  it("falls back to the prior form's wp_publish_status when the snapshot value is unknown", () => {
    const form = makeForm({ wp_publish_status: "future" });
    const snapshot = makeSnapshot({ wp_publish_status: "garbage" });
    const result = applySnapshotToForm(form, snapshot);

    expect(result.wp_publish_status).toBe("future");
  });

  it("preserves the form's decision field", () => {
    const form = makeForm({ decision: "request_changes" });
    const result = applySnapshotToForm(form, makeSnapshot());
    expect(result.decision).toBe("request_changes");
  });

  it("keeps the form's author/category/slug when the snapshot omits them", () => {
    // Regression: a snapshot that never captured author/category/slug must not
    // null them out over the WP prefill ("auto-filled then cleared" bug).
    const form = makeForm({ wp_author_id: 7, wp_category_ids: [3, 4], wp_slug: "my-slug" });
    const snapshot = makeSnapshot({
      wp_author_id: null,
      wp_category_ids: null,
      wp_slug: null,
    });
    const result = applySnapshotToForm(form, snapshot);

    expect(result.wp_author_id).toBe(7);
    expect(result.wp_category_ids).toEqual([3, 4]);
    expect(result.wp_slug).toBe("my-slug");
  });
});
