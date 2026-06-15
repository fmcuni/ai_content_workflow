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
} = { userRole: "editor", persona: "bowtie-editor", target: null };

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
            wp_publish_status: "draft",
            wp_category_ids: null,
            wp_tag_ids: null,
            wp_excerpt: null,
            wp_slug: "my-slug",
            wp_author_id: null,
            wp_featured_media_id: null,
            wp_publish_at: null,
            wp_pushed_post_id: null,
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
            schema_jsonld: null,
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

beforeEach(() => {
  state.userRole = "editor";
  state.persona = "bowtie-editor";
  state.target = null;
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
