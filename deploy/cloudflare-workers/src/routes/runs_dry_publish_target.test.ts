/**
 * Dry-publish per-voice target resolution (parity with the Python backend's
 * POST /runs/:id/dry-publish, content_tool/api/routes/runs.py).
 *
 * The preview an operator checks before approving HITL_2 must reflect the
 * voice's ACTUAL publish target — not the static WP_TARGET / WP_BASE_URL env —
 * so a voice pointed at a non-default CMS shows that CMS's label + base URL.
 *
 * Exercises the real Hono handler against a stateful fake `sql` (vi.mock on
 * ../db/client), mirroring runs_rbac.test.ts.
 *
 * Coverage:
 *   - voice assigned to a non-default target → resolved label + base URL + request URL
 *   - unassigned voice (NULL target) → default WP_TARGET label + WP_BASE_URL
 *   - archived target → resolution throws (no misleading default-target preview)
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

interface PublishTargetRow {
  publish_target_id: string;
  name: string;
  kind: string;
  auth_ref: string;
  status: string;
  is_archived: boolean;
}

const state: {
  userRole: string | null;
  persona: string;
  target: PublishTargetRow | null;
  // Slug-change-create-new + URL pull-through: control the run's chosen slug,
  // the already-published WP/Ghost id, and the previously published URL so the
  // preview's method (POST create vs PUT update) reflects the real publish.
  wpSlug: string | null;
  wpPushedPostId: number | null;
  cmsPostId: string | null;
  articleUrl: string | null;
  schemaJsonld: object[] | null;
  // Pre-flight publish guards (scheduled-without-date, categories-on-Ghost).
  wpPublishStatus: string | null;
  wpPublishAt: string | null;
  wpCategoryIds: number[] | null;
} = {
  userRole: "editor",
  persona: "bowtie-editor",
  target: null,
  wpSlug: "my-slug",
  wpPushedPostId: null,
  cmsPostId: null,
  articleUrl: null,
  schemaJsonld: null,
  wpPublishStatus: "draft",
  wpPublishAt: null,
  wpCategoryIds: null,
};

interface Fragment {
  __frag: true;
  text: string;
}
function isFragment(v: unknown): v is Fragment {
  return typeof v === "object" && v !== null && "__frag" in v;
}
function renderText(strings: TemplateStringsArray, values: unknown[]): string {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    if (isFragment(values[i])) out += (values[i] as Fragment).text;
    out += strings[i + 1] ?? "";
  }
  return out.replace(/\s+/g, " ").trim();
}

function makeFakeSql(): unknown {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
    const text = renderText(strings, values);
    const lower = text.toLowerCase();

    if (!/^\s*(select|update|insert|delete)\b/.test(lower)) {
      return { __frag: true, text } as Fragment;
    }

    if (lower.startsWith("select")) {
      // requireRole → loadRole: role lookup on the user table.
      if (lower.includes('from content_tool.app_user')) {
        return [{ role: state.userRole }];
      }
      // getPublishTargetForVoice: personas → publish_targets join.
      if (lower.includes("join content_tool.publish_targets")) {
        return state.target === null ? [] : [state.target];
      }
      // dry-publish run row.
      if (lower.includes("from content_tool.runs")) {
        return [
          {
            start_mode: "create",
            persona: state.persona,
            wp_publish_status: state.wpPublishStatus,
            wp_category_ids: state.wpCategoryIds,
            wp_tag_ids: null,
            wp_excerpt: null,
            wp_slug: state.wpSlug,
            wp_author_id: null,
            wp_featured_media_id: null,
            wp_publish_at: state.wpPublishAt,
            wp_pushed_post_id: state.wpPushedPostId,
            cms_post_id: state.cmsPostId,
            article_url: state.articleUrl,
          },
        ];
      }
      // dry-publish render row.
      if (lower.includes("from content_tool.renders")) {
        return [
          {
            seo_title: "Title",
            meta_description: "Meta",
            html_body: "<p>body</p>",
            excerpt_suggestion: null,
            slug_suggestion: null,
            schema_jsonld: state.schemaJsonld,
          },
        ];
      }
      return [];
    }
    return { count: 0 };
  };
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => ({
    __frag: true,
    text: JSON.stringify(v),
  });
  (sql as unknown as { unsafe: (s: string) => unknown }).unsafe = (s: string) => ({
    __frag: true,
    text: s,
  });
  return sql;
}

vi.mock("../db/client", () => ({
  withDb: async (_env: unknown, _ctx: unknown, fn: (sql: unknown) => Promise<unknown>) =>
    fn(makeFakeSql()),
}));
vi.mock("../gemini/do_client", () => ({ DoGeminiClient: class {} }));
// detectSeoPlugin hits the network; stub it so dry-publish stays offline.
vi.mock("../wordpress/client", async () => {
  const actual = await vi.importActual<typeof import("../wordpress/client")>(
    "../wordpress/client",
  );
  return { ...actual, detectSeoPlugin: async () => null };
});

import { Hono } from "hono";
import runsRouter from "./runs";
import type { AuthVars } from "../auth/middleware";

type AuthApp = Hono<{ Variables: AuthVars }>;

function appWith(authEmail: string): AuthApp {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    c.set("userEmail", authEmail);
    await next();
  });
  app.route("/", runsRouter);
  return app;
}

function makeEnv(): Record<string, unknown> {
  return {
    AUTH_DISABLED: "false",
    FRONTEND_ORIGIN: "https://example.test",
    BOOTSTRAP_ADMIN_EMAILS: "",
    WP_BASE_URL: "https://bowtie.example",
    WP_TARGET: "Bowtie production",
    VHIS101_WP_BASE_URL: "https://vhis101.example",
    VHIS101_WP_USERNAME: "vhis-user",
    VHIS101_WP_APP_PASSWORD: "vhis-pass",
    HCHK_GHOST_API_URL: "https://hchk.ghost.io",
    HCHK_GHOST_ADMIN_API_KEY: "0123456789abcdef:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
  };
}

async function dryPublish(): Promise<Response> {
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  };
  return appWith("editor@b.com").request(
    "/r1/dry-publish",
    { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    makeEnv(),
    executionCtx as unknown as ExecutionContext,
  );
}

const VHIS101_TARGET: PublishTargetRow = {
  publish_target_id: "00000000-0000-0000-0000-000000000002",
  name: "VHIS101 WordPress",
  kind: "wordpress",
  auth_ref: "VHIS101_WP",
  status: "active",
  is_archived: false,
};

const GHOST_TARGET: PublishTargetRow = {
  publish_target_id: "00000000-0000-0000-0000-000000000003",
  name: "HealthyCheckHK Ghost",
  kind: "ghost",
  auth_ref: "HCHK_GHOST",
  status: "active",
  is_archived: false,
};

beforeEach(() => {
  state.userRole = "editor";
  state.persona = "bowtie-editor";
  state.target = null;
  state.wpSlug = "my-slug";
  state.wpPushedPostId = null;
  state.cmsPostId = null;
  state.articleUrl = null;
  state.schemaJsonld = null;
  state.wpPublishStatus = "draft";
  state.wpPublishAt = null;
  state.wpCategoryIds = null;
});

describe("dry-publish per-voice target resolution", () => {
  it("reflects a non-default target's label, base URL, and request URL", async () => {
    state.target = VHIS101_TARGET;
    const res = await dryPublish();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.target_label).toBe("VHIS101 WordPress");
    expect(json.target_base_url).toBe("https://vhis101.example");
    expect(json.request_url).toBe("https://vhis101.example/wp-json/wp/v2/posts");
  });

  it("falls back to the default WP_TARGET label + WP_BASE_URL for an unassigned voice", async () => {
    state.target = null;
    const res = await dryPublish();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.target_label).toBe("Bowtie production");
    expect(json.target_base_url).toBe("https://bowtie.example");
    expect(json.request_url).toBe("https://bowtie.example/wp-json/wp/v2/posts");
  });

  it("errors (no misleading default preview) when the voice's target is archived", async () => {
    state.target = { ...VHIS101_TARGET, is_archived: true };
    const res = await dryPublish();
    expect(res.status).toBe(500);
  });
});

describe("dry-publish slug-change → create-new preview (WordPress)", () => {
  it("previews PUT (update) when the chosen slug matches the published post's slug", async () => {
    state.wpPushedPostId = 4175;
    state.articleUrl = "https://bowtie.example/blog/my-slug/";
    state.wpSlug = "my-slug";
    const res = await dryPublish();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.request_method).toBe("PUT");
    expect(json.request_url).toBe("https://bowtie.example/wp-json/wp/v2/posts/4175");
  });

  it("flips to POST (create new) when the operator changes the slug of a published post", async () => {
    state.wpPushedPostId = 4175;
    state.articleUrl = "https://bowtie.example/blog/my-slug/";
    state.wpSlug = "brand-new-slug";
    const res = await dryPublish();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.request_method).toBe("POST");
    expect(json.request_url).toBe("https://bowtie.example/wp-json/wp/v2/posts");
  });
});

describe("dry-publish Ghost preview", () => {
  it("does NOT include meta_title in the previewed Ghost post body", async () => {
    state.target = GHOST_TARGET;
    const res = await dryPublish();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { kind: string; request_body: { posts: unknown[] } };
    expect(json.kind).toBe("ghost");
    const post = json.request_body.posts[0] as Record<string, unknown>;
    expect("meta_title" in post).toBe(false);
  });

  it("includes the FAQ JSON-LD in codeinjection_head when the render has schema_jsonld", async () => {
    state.target = GHOST_TARGET;
    state.schemaJsonld = [
      { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: [] },
    ];
    const res = await dryPublish();
    expect(res.status).toBe(200);
    const json = (await res.json()) as { request_body: { posts: unknown[] } };
    const post = json.request_body.posts[0] as Record<string, unknown>;
    const head = String(post.codeinjection_head ?? "");
    expect(head).toContain('type="application/ld+json"');
    expect(head).toContain("FAQPage");
  });

  it("previews PUT (update) when the chosen slug matches the published Ghost post's slug", async () => {
    state.target = GHOST_TARGET;
    state.cmsPostId = "ghost-uuid-1";
    state.articleUrl = "https://hchk.ghost.io/my-slug/";
    state.wpSlug = "my-slug";
    const res = await dryPublish();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.request_method).toBe("PUT");
    expect(String(json.request_url)).toContain("/posts/ghost-uuid-1/");
  });

  it("flips to POST (create new) when the operator changes the slug of a published Ghost post", async () => {
    state.target = GHOST_TARGET;
    state.cmsPostId = "ghost-uuid-1";
    state.articleUrl = "https://hchk.ghost.io/my-slug/";
    state.wpSlug = "brand-new-slug";
    const res = await dryPublish();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.request_method).toBe("POST");
    expect(String(json.request_url)).toContain("/posts/?source=html");
  });
});

describe("dry-publish pre-flight validation_error", () => {
  it("flags a Ghost run scheduled with no publish date", async () => {
    state.target = GHOST_TARGET;
    state.wpPublishStatus = "future";
    state.wpPublishAt = null;
    const res = await dryPublish();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(String(json.validation_error)).toMatch(/scheduled publish needs a publish date/i);
  });

  it("flags a Ghost run carrying WordPress categories", async () => {
    state.target = GHOST_TARGET;
    state.wpCategoryIds = [12];
    const res = await dryPublish();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(String(json.validation_error)).toMatch(/Ghost has no categories/i);
  });

  it("flags a WordPress run scheduled with no publish date", async () => {
    state.target = VHIS101_TARGET;
    state.wpPublishStatus = "future";
    state.wpPublishAt = null;
    const res = await dryPublish();
    expect(res.status).toBe(200);
    const json = (await res.json()) as Record<string, unknown>;
    expect(String(json.validation_error)).toMatch(/scheduled publish needs a publish date/i);
  });

  it("returns validation_error=null for a valid draft preview (both CMSes)", async () => {
    state.target = GHOST_TARGET;
    const ghost = (await (await dryPublish()).json()) as Record<string, unknown>;
    expect(ghost.validation_error).toBeNull();

    state.target = VHIS101_TARGET;
    const wp = (await (await dryPublish()).json()) as Record<string, unknown>;
    expect(wp.validation_error).toBeNull();
  });

  it("allows a scheduled run once a publish date is set", async () => {
    state.target = GHOST_TARGET;
    state.wpPublishStatus = "future";
    state.wpPublishAt = "2026-07-01T09:00:00Z";
    const res = await dryPublish();
    const json = (await res.json()) as Record<string, unknown>;
    expect(json.validation_error).toBeNull();
  });
});
