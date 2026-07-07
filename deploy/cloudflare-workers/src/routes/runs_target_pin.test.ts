/**
 * Publish-target pin tests (bowtie-ins issue #15).
 *
 * A refresh run overwrites an existing CMS post, so approving at HITL_2 must
 * carry the exact target the reviewer saw in the dry-publish preview
 * (`confirmed_target`), and the pin is persisted for the publish step to
 * assert against. These exercise the real Hono handlers against a stateful
 * fake `sql` (same harness style as runs_hitl_concurrency.test.ts):
 *
 *   - approve of a refresh run WITHOUT confirmed_target → 409, gate NOT claimed
 *   - approve with a stale/mismatched target → 409 + expected_target payload
 *   - approve with the matching target → gate claimed, pin persisted, sendEvent
 *   - create-mode approve requires no confirmed_target (nothing to pin)
 *   - slug change: the expected pin is post_id null ("approved as create-new")
 *   - existing-post/refresh: re-resolving to a DIFFERENT post voids a pending
 *     approval (and now also caches the re-read wp_post_id)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

interface FakeRunRow {
  run_id: string;
  status: string;
  hitl_2_iteration: number;
  hitl_2_decision: string | null;
  approved_by: string | null;
  error: unknown;
  // Publish meta consumed by the approve pre-flight + pin derivation.
  persona: string;
  start_mode: string;
  wp_publish_status: string | null;
  wp_publish_at: string | null;
  wp_category_ids: unknown;
  wp_pushed_post_id: number | null;
  cms_post_id: string | null;
  article_url: string | null;
  approved_target_kind: string | null;
  approved_post_id: string | null;
  approved_target_label: string | null;
}

interface FakeFetchedArticle {
  wp_post_id: number | null;
  cms_post_id: string | null;
}

const state: {
  row: FakeRunRow | null;
  fetched: FakeFetchedArticle | null;
  sendEvents: unknown[];
  restarts: unknown[];
  claimBinds: unknown[] | null;
} = { row: null, fetched: null, sendEvents: [], restarts: [], claimBinds: null };

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
    const v = values[i];
    if (isFragment(v)) {
      out += v.text;
    }
    out += strings[i + 1] ?? "";
  }
  return out.replace(/\s+/g, " ").trim();
}

function makeFakeSql(): unknown {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
    const text = renderText(strings, values);
    const lower = text.toLowerCase();
    const row = state.row;

    if (!/^\s*(select|update|insert|delete)\b/.test(lower)) {
      return { __frag: true, text } as Fragment;
    }

    if (lower.startsWith("select")) {
      if (lower.includes("from content_tool.fetched_articles")) {
        // Copy: a real SELECT returns a snapshot, not a live reference the
        // later cache UPDATE would mutate out from under the handler.
        return state.fetched === null ? [] : [{ ...state.fetched }];
      }
      if (lower.includes("select r.render_id")) {
        return []; // no render edits to persist in these tests
      }
      if (lower.includes("from content_tool.renders")) {
        // republish needs a persisted render to push.
        return [
          {
            seo_title: "T",
            meta_description: "",
            html_body: "<p>x</p>",
            excerpt_suggestion: "",
            schema_jsonld: null,
          },
        ];
      }
      if (row === null) return [];
      // Copy: a real SELECT returns a snapshot, not a live reference that a
      // later UPDATE in the same handler would mutate out from under it.
      return [{ ...row }];
    }

    if (lower.startsWith("update") && row !== null) {
      // The restart route's atomic claim (RETURNING row, not a count).
      if (lower.includes("set status = 'pending'")) {
        if (row.status !== "failed") return [];
        row.status = "pending";
        row.error = null;
        return [{ run_id: row.run_id }];
      }
      // existing-post/refresh cache write.
      if (lower.includes("update content_tool.fetched_articles")) {
        const binds = values.filter((v) => !isFragment(v));
        if (state.fetched !== null && typeof binds[0] === "number") {
          state.fetched.wp_post_id = binds[0];
        }
        return { count: 1 };
      }
      // Pin-invalidation / compensation UPDATEs (no gate-status guard).
      if (lower.includes("hitl_2_decision = null")) {
        const wasApproved = row.hitl_2_decision === "approve";
        const guarded = lower.includes("and hitl_2_decision =");
        if (!guarded || wasApproved) {
          row.hitl_2_decision = null;
          row.approved_by = null;
          row.approved_target_kind = null;
          row.approved_post_id = null;
          row.approved_target_label = null;
          return { count: 1 };
        }
        return { count: 0 };
      }
      // The HITL_2 claim UPDATE (gate-status guard present).
      if (/where[\s\S]*status\s*=/.test(lower) && lower.includes("hitl_2_decision")) {
        if (row.status !== "hitl_2") return { count: 0 };
        const binds = values.filter((v) => !isFragment(v));
        state.claimBinds = binds;
        row.hitl_2_decision = "approve";
        row.status = "publishing";
        // SET binds end with the pin triple (kind, post_id, label), then the
        // WHERE binds follow (runId, gate-status literal).
        row.approved_target_kind = binds[binds.length - 5] as string | null;
        row.approved_post_id = binds[binds.length - 4] as string | null;
        row.approved_target_label = binds[binds.length - 3] as string | null;
        return { count: 1 };
      }
      return { count: 1 };
    }

    return { count: 0 };
  };
  (sql as unknown as { json: (v: unknown) => unknown }).json = (v: unknown) => ({
    __frag: true,
    text: JSON.stringify(v),
  });
  return sql;
}

vi.mock("../db/client", () => ({
  withDb: async (
    _env: unknown,
    _ctx: unknown,
    fn: (sql: unknown) => Promise<unknown>,
  ) => fn(makeFakeSql()),
}));

vi.mock("../gemini/do_client", () => ({ DoGeminiClient: class {} }));

// Pin the resolved publish target — these tests exercise the pin logic, not
// target resolution (covered by wp_factory.test.ts).
const targetState = { kind: "wordpress", label: "Bowtie Blog (prod)" };
vi.mock("../publishers/wp_factory", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../publishers/wp_factory")>();
  return {
    ...mod,
    resolvePublishTarget: async () => ({
      authRef: null,
      label: targetState.label,
      isDefault: true,
      kind: targetState.kind,
    }),
  };
});

// existing-post/refresh re-reads the post from WP — return a configurable post.
// republish pushes via upsert — record the calls so refusal tests can assert
// no CMS write ever happened.
const wpState = {
  post: null as null | Record<string, unknown>,
  upserts: [] as Array<Record<string, unknown>>,
};
vi.mock("../wordpress/client", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../wordpress/client")>();
  return {
    ...mod,
    WordPressClient: class {
      async fetchPostByUrl(): Promise<unknown> {
        return wpState.post;
      }
      async upsert(payload: Record<string, unknown>): Promise<unknown> {
        wpState.upserts.push(payload);
        return { id: 777, link: "https://blog.example.com/hello-world", status: "draft" };
      }
      // resolveWpNames best-effort lookups after the cache write.
      async getUser(): Promise<unknown> {
        return null;
      }
      async getCategory(): Promise<unknown> {
        return null;
      }
    },
  };
});

import { Hono } from "hono";
import type { AuthVars } from "../auth/middleware";
import runsRouter from "./runs";

type AuthApp = Hono<{ Variables: AuthVars }>;

const REVIEWER = "reviewer@bowtie.com.hk";

function makeEnv(): Record<string, unknown> {
  const instance = {
    sendEvent: async (e: unknown) => {
      state.sendEvents.push(e);
    },
    restart: async (arg?: unknown) => {
      state.restarts.push(arg);
    },
  };
  return {
    AUTH_DISABLED: "false",
    PRODUCTION: { get: async () => instance, create: async () => undefined },
    FRONTEND_ORIGIN: "https://example.test",
    BOOTSTRAP_ADMIN_EMAILS: REVIEWER,
    WP_TARGET: "prod",
    WP_BASE_URL: "https://blog.example.com",
  };
}

function makeApp(): AuthApp {
  const app = new Hono<{ Variables: AuthVars }>();
  app.use("*", async (c, next) => {
    c.set("userEmail", REVIEWER);
    await next();
  });
  app.route("/", runsRouter);
  return app;
}

async function req(method: string, path: string, body: unknown): Promise<Response> {
  const executionCtx = {
    waitUntil: (_p: Promise<unknown>) => undefined,
    passThroughOnException: () => undefined,
    props: {},
  };
  return makeApp().request(
    path,
    { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
    makeEnv(),
    executionCtx as unknown as ExecutionContext,
  );
}

function refreshRunAtGate(): FakeRunRow {
  return {
    run_id: "run-1",
    status: "hitl_2",
    hitl_2_iteration: 0,
    hitl_2_decision: null,
    approved_by: null,
    error: null,
    persona: "bowtie",
    start_mode: "refresh",
    wp_publish_status: "draft",
    wp_publish_at: null,
    wp_category_ids: null,
    wp_pushed_post_id: null,
    cms_post_id: null,
    article_url: "https://blog.example.com/hello-world",
    approved_target_kind: null,
    approved_post_id: null,
    approved_target_label: null,
  };
}

const MATCHING_TARGET = {
  kind: "wordpress",
  post_id: "123",
  label: "Bowtie Blog (prod)",
};

beforeEach(() => {
  state.row = refreshRunAtGate();
  state.fetched = { wp_post_id: 123, cms_post_id: null };
  state.sendEvents = [];
  state.restarts = [];
  state.claimBinds = null;
  targetState.kind = "wordpress";
  targetState.label = "Bowtie Blog (prod)";
  wpState.post = null;
  wpState.upserts = [];
});

describe("HITL_2 approve — target pin (issue #15)", () => {
  it("refuses to approve a refresh run without confirmed_target (gate not claimed)", async () => {
    // Act
    const res = await req("POST", "/run-1/hitl-2", { decision: "approve" });

    // Assert
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: string; expected_target: unknown };
    expect(body.detail).toContain("re-run the publish preview");
    expect(body.expected_target).toEqual(MATCHING_TARGET);
    expect(state.row?.hitl_2_decision).toBeNull();
    expect(state.sendEvents).toHaveLength(0);
  });

  it("refuses to approve when the confirmed post id no longer matches (approved A, would publish B)", async () => {
    // Arrange — the reviewer previewed post 999, but the run resolves post 123.
    const res = await req("POST", "/run-1/hitl-2", {
      decision: "approve",
      confirmed_target: { ...MATCHING_TARGET, post_id: "999" },
    });

    // Assert
    expect(res.status).toBe(409);
    expect(state.row?.hitl_2_decision).toBeNull();
    expect(state.sendEvents).toHaveLength(0);
  });

  it("refuses to approve when the target label/CMS diverges from the preview", async () => {
    const res = await req("POST", "/run-1/hitl-2", {
      decision: "approve",
      confirmed_target: { ...MATCHING_TARGET, label: "VHIS101 (prod)" },
    });

    expect(res.status).toBe(409);
    expect(state.sendEvents).toHaveLength(0);
  });

  it("approves with the matching target and persists the pin", async () => {
    const res = await req("POST", "/run-1/hitl-2", {
      decision: "approve",
      confirmed_target: MATCHING_TARGET,
    });

    expect(res.status).toBe(200);
    expect(state.row?.hitl_2_decision).toBe("approve");
    expect(state.row?.approved_target_kind).toBe("wordpress");
    expect(state.row?.approved_post_id).toBe("123");
    expect(state.row?.approved_target_label).toBe("Bowtie Blog (prod)");
    expect(state.sendEvents).toHaveLength(1);
  });

  it("pins post_id null when a slug change makes the publish create a new post", async () => {
    // Arrange — new slug differs from the article URL's slug → create-new.
    const confirmed = { ...MATCHING_TARGET, post_id: null };

    // Act
    const res = await req("POST", "/run-1/hitl-2", {
      decision: "approve",
      wp_slug: "brand-new-slug",
      confirmed_target: confirmed,
    });

    // Assert
    expect(res.status).toBe(200);
    expect(state.row?.approved_post_id).toBeNull();
    expect(state.row?.approved_target_kind).toBe("wordpress");

    // And the stale claim of the OLD post id must be refused.
    state.row = refreshRunAtGate();
    const stale = await req("POST", "/run-1/hitl-2", {
      decision: "approve",
      wp_slug: "brand-new-slug",
      confirmed_target: MATCHING_TARGET,
    });
    expect(stale.status).toBe(409);
  });

  it("approves a create-mode run without confirmed_target (nothing to pin)", async () => {
    state.row = { ...refreshRunAtGate(), start_mode: "create", article_url: null };
    state.fetched = null;

    const res = await req("POST", "/run-1/hitl-2", { decision: "approve" });

    expect(res.status).toBe(200);
    expect(state.row?.approved_target_kind).toBeNull();
    expect(state.sendEvents).toHaveLength(1);
  });
});

describe("existing-post/refresh — pin invalidation (issue #15)", () => {
  const rereadPost = (id: number): Record<string, unknown> => ({
    id,
    link: "https://blog.example.com/hello-world",
    author: 7,
    categories: [4],
    slug: "hello-world",
  });

  it("voids a pending approval when the re-read resolves a different post", async () => {
    // Arrange — approved against post 123; WP now resolves the URL to post 456.
    state.row = {
      ...refreshRunAtGate(),
      status: "publishing",
      hitl_2_decision: "approve",
      approved_target_kind: "wordpress",
      approved_post_id: "123",
      approved_target_label: "Bowtie Blog (prod)",
    };
    wpState.post = rereadPost(456);

    // Act
    const res = await req("POST", "/run-1/existing-post/refresh", {});

    // Assert — cache updated AND the stale approval voided.
    expect(res.status).toBe(200);
    expect(state.fetched?.wp_post_id).toBe(456);
    expect(state.row?.hitl_2_decision).toBeNull();
    expect(state.row?.approved_post_id).toBeNull();
  });

  it("keeps the approval when the re-read resolves the same post", async () => {
    state.row = {
      ...refreshRunAtGate(),
      status: "publishing",
      hitl_2_decision: "approve",
      approved_target_kind: "wordpress",
      approved_post_id: "123",
      approved_target_label: "Bowtie Blog (prod)",
    };
    wpState.post = rereadPost(123);

    const res = await req("POST", "/run-1/existing-post/refresh", {});

    expect(res.status).toBe(200);
    expect(state.row?.hitl_2_decision).toBe("approve");
    expect(state.row?.approved_post_id).toBe("123");
  });
});

describe("republish — target pin on the never-pushed refresh path (issue #15)", () => {
  it("refuses a never-pushed refresh re-push without a matching pin (no CMS write)", async () => {
    // Arrange — refresh run that never pushed (targets the FETCHED post) and
    // carries no pin (e.g. an approval that predates the pin columns).
    state.row = { ...refreshRunAtGate(), status: "failed" };
    state.fetched = { wp_post_id: 123, cms_post_id: null };

    // Act
    const res = await req("POST", "/run-1/republish", {});

    // Assert
    expect(res.status).toBe(409);
    const body = (await res.json()) as { detail: string };
    expect(body.detail).toContain("pinned HITL_2 approval");
    expect(wpState.upserts).toHaveLength(0);
  });

  it("re-pushes when the pin names exactly the fetched post", async () => {
    state.row = {
      ...refreshRunAtGate(),
      status: "failed",
      hitl_2_decision: "approve",
      approved_target_kind: "wordpress",
      approved_post_id: "123",
      approved_target_label: "Bowtie Blog (prod)",
    };
    state.fetched = { wp_post_id: 123, cms_post_id: null };

    const res = await req("POST", "/run-1/republish", {});

    expect(res.status).toBe(200);
    expect(wpState.upserts).toHaveLength(1);
    expect(wpState.upserts[0]?.postId).toBe(123);
  });

  it("needs no pin to re-push the run's own previously published post", async () => {
    state.row = { ...refreshRunAtGate(), status: "published", wp_pushed_post_id: 555 };

    const res = await req("POST", "/run-1/republish", {});

    expect(res.status).toBe(200);
    expect(wpState.upserts).toHaveLength(1);
    expect(wpState.upserts[0]?.postId).toBe(555);
  });
});

describe("restart — pin-mismatch failures re-gate at HITL_2 (issue #15)", () => {
  it("restarts FROM the HITL_2 gate when the failure was a publish target mismatch", async () => {
    // Arrange — the publish step voided the approval and failed with the
    // mismatch error; a plain restart would replay the cached approve event
    // straight into the same failure.
    state.row = {
      ...refreshRunAtGate(),
      status: "failed",
      hitl_2_iteration: 1,
      error: { type: "NonRetryableError", message: "publish target mismatch: approved …" },
    };

    // Act
    const res = await req("POST", "/run-1/restart", {});

    // Assert
    expect(res.status).toBe(200);
    expect(state.restarts).toHaveLength(1);
    expect(state.restarts[0]).toEqual({ from: { name: "gate-hitl2-1" } });
  });

  it("keeps the default full-replay restart for any other failure", async () => {
    state.row = {
      ...refreshRunAtGate(),
      status: "failed",
      error: { type: "Error", message: "WordPress upstream error" },
    };

    const res = await req("POST", "/run-1/restart", {});

    expect(res.status).toBe(200);
    expect(state.restarts).toHaveLength(1);
    expect(state.restarts[0]).toBeUndefined();
  });
});
