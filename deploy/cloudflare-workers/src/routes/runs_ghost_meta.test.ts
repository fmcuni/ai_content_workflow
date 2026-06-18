/**
 * Ghost-CMS destination round-trip tests for the runs routes.
 *
 * The /runs PATCH endpoint and the GET list / detail payloads must round-trip
 * three Ghost fields so the web /runs drawer can persist + prefill a Ghost
 * author + tags + feature image:
 *   - PATCH /runs/:id persists ghost_author_ids / ghost_tags / feature_image_url
 *     with COALESCE semantics (null = leave unchanged; [] = clear) — matching
 *     the wp_category_ids convention.
 *   - GET /runs (list) and GET /runs/:id (detail) return all three, with the two
 *     jsonb arrays parsed back to real arrays (under Hyperdrive fetch_types:false
 *     jsonb arrives as a RAW STRING).
 *
 * Harness mirrors runs_validation.test.ts: a fake `sql` (vi.mock on ../db/client)
 * drives loadRole + the handlers. This file additionally CAPTURES the rendered
 * UPDATE text/values so the PATCH persistence + COALESCE-preserve behaviour can
 * be asserted, and returns RAW jsonb strings from the SELECTs so the GET parsing
 * is exercised.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Fake DB — records every UPDATE's rendered text + bound values, and serves
// list / detail rows with RAW jsonb strings (the Hyperdrive shape).
// ---------------------------------------------------------------------------
interface Captured {
  text: string;
  values: unknown[];
}

const state: {
  userRole: string | null;
  updates: Captured[];
  inserts: Captured[];
} = { userRole: "reviewer", updates: [], inserts: [] };

// jsonb arrays come back from a snapshot INSERT ... RETURNING as RAW STRINGS
// (Hyperdrive fetch_types:false), so the DTO mapper must JSON.parse them.
const SNAPSHOT_RETURNING_ROW = {
  snapshot_id: "snap-1",
  run_id: "r1",
  created_at: "2026-06-18T00:00:00Z",
  created_by: "a@b.com",
  trigger: "manual",
  html_body: "<p>x</p>",
  committed_html_body: null,
  seo_title: "S",
  meta_description: "M",
  notes: null,
  comments: null,
  wp_publish_status: null,
  wp_author_id: null,
  wp_category_ids: null,
  wp_tag_ids: null,
  wp_featured_media_id: null,
  wp_slug: null,
  wp_excerpt: null,
  wp_publish_at: null,
  ghost_author_ids: '["author-9"]',
  ghost_tags: '["Wellness"]',
  feature_image_url: "https://img.example/new.png",
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

// A run whose Ghost fields are already populated — lets the COALESCE-preserve
// assertions confirm omitted/null fields are not clobbered. jsonb columns are
// RAW STRINGS, exactly as Hyperdrive (fetch_types:false) returns them.
const GHOST_RUN_ROW = {
  run_id: "r1",
  status: "hitl_2",
  topic: "t",
  article_url: null,
  mode: "auto",
  created_at: "2026-06-18T00:00:00Z",
  updated_at: "2026-06-18T00:00:00Z",
  created_by: "a@b.com",
  chosen_route: null,
  iteration_count: 0,
  hitl_2_iteration: 0,
  approved_at: null,
  approved_by: null,
  hitl_2_decision: null,
  hitl_2_notes: null,
  keywords: "[]",
  persona: "ghost-voice",
  acf_adv_id: 0,
  acf_widget_id: 0,
  edit_note: null,
  start_mode: "create",
  topic_candidate_id: null,
  topic_batch_id: null,
  target_audience: null,
  auto_accept_hitl1: false,
  wp_publish_status: null,
  wp_author_id: null,
  wp_category_ids: null,
  wp_tag_ids: null,
  wp_featured_media_id: null,
  wp_slug: null,
  wp_excerpt: null,
  wp_publish_at: null,
  wp_pushed_post_id: null,
  wp_pushed_at: null,
  wp_push_error: null,
  // RAW jsonb strings — the GET mappers must JSON.parse these to arrays.
  ghost_author_ids: '["author-1","author-2"]',
  ghost_tags: '["Insurance","Health"]',
  feature_image_url: "https://img.example/cover.png",
  seo_title: "S",
  meta_description: "M",
  error: null,
};

function makeFakeSql(): unknown {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]): unknown => {
    const text = renderText(strings, values);
    const lower = text.toLowerCase();

    if (!/^\s*(select|update|insert|delete)\b/.test(lower)) {
      return { __frag: true, text } as Fragment;
    }

    if (lower.startsWith("select")) {
      if (lower.includes("from content_tool.app_user")) {
        return [{ role: state.userRole }];
      }
      // PATCH guard: run existence.
      if (lower.includes("select run_id from content_tool.runs")) {
        return [{ run_id: "r1" }];
      }
      // PATCH optimistic-concurrency token (latest render). Returning [] makes
      // the version-less PATCH path last-write-wins (no expected_version sent).
      // Matched BEFORE the list branch — the list query also joins renders in
      // its LATERAL, so key on the token query's distinctive `r.render_id`.
      if (lower.includes("select r.render_id")) {
        return [];
      }
      // GET list / detail of runs (matched before the renders/snapshots
      // branches: the list query embeds a LATERAL `FROM content_tool.renders`,
      // so key on the runs table first to avoid mis-routing it).
      if (lower.includes("from content_tool.runs")) {
        return [GHOST_RUN_ROW];
      }
      // Snapshot version-history list (selects from hitl2_snapshots).
      if (lower.includes("from content_tool.hitl2_snapshots")) {
        // count(*) probe → return a numeric string row.
        if (lower.includes("count(*)")) return [{ n: "1" }];
        // ensureGeneratedBaseline's `select snapshot_id … trigger = 'generated'`
        // → pretend one exists so the lazy seed is a no-op.
        if (lower.includes("trigger = 'generated'")) return [{ snapshot_id: "snap-0" }];
        return [SNAPSHOT_RETURNING_ROW];
      }
      // No render → ensureGeneratedBaseline + live-body lookups stay no-op.
      if (lower.includes("from content_tool.renders")) {
        return [];
      }
      // GET detail (single run) — distinctive bare `WHERE run_id = …`.
      if (lower.includes("where run_id =")) {
        return [GHOST_RUN_ROW];
      }
      return [];
    }

    if (lower.startsWith("update")) {
      state.updates.push({ text, values: [...values] });
      return { count: 1 };
    }

    // Snapshot INSERT ... RETURNING → capture + serve the inserted row.
    if (lower.startsWith("insert") && lower.includes("content_tool.hitl2_snapshots")) {
      state.inserts.push({ text, values: [...values] });
      return [SNAPSHOT_RETURNING_ROW];
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
  withDb: async (_env: unknown, _ctx: unknown, fn: (sql: unknown) => Promise<unknown>) =>
    fn(makeFakeSql()),
}));
vi.mock("../gemini/do_client", () => ({ DoGeminiClient: class {} }));

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
    PRODUCTION: { get: async () => ({}), create: async () => undefined },
    FRONTEND_ORIGIN: "https://example.test",
    BOOTSTRAP_ADMIN_EMAILS: "",
  };
}

async function req(app: AuthApp, method: string, path: string, body?: unknown): Promise<Response> {
  const executionCtx = {
    waitUntil: () => undefined,
    passThroughOnException: () => undefined,
    props: {},
  };
  const init: RequestInit =
    body === undefined
      ? { method }
      : { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
  return app.request(path, init, makeEnv(), executionCtx as unknown as ExecutionContext);
}

beforeEach(() => {
  state.userRole = "reviewer";
  state.updates = [];
  state.inserts = [];
});

// ---------------------------------------------------------------------------
// PATCH /runs/:id — Ghost field persistence + COALESCE preserve.
// ---------------------------------------------------------------------------
describe("PATCH /runs/:id Ghost metadata persistence", () => {
  it("persists ghost_author_ids, ghost_tags and feature_image_url", async () => {
    const res = await req(appWith("a@b.com"), "PATCH", "/r1", {
      ghost_author_ids: ["author-9"],
      ghost_tags: ["Wellness"],
      feature_image_url: "https://img.example/new.png",
    });
    expect(res.status).not.toBe(400);

    const upd = state.updates.find((u) => u.text.toLowerCase().includes("update content_tool.runs"));
    expect(upd).toBeDefined();
    const text = (upd as Captured).text;
    // All three columns written, COALESCE-guarded (the non-null arg => overwrite).
    expect(text).toContain("ghost_author_ids = COALESCE(");
    expect(text).toContain("ghost_tags = COALESCE(");
    expect(text).toContain("feature_image_url = COALESCE(");
    // Arrays bound as jsonb (sql.json fragment), image as a plain bound value.
    const flat = JSON.stringify((upd as Captured).values);
    expect(flat).toContain("author-9");
    expect(flat).toContain("Wellness");
    expect(flat).toContain("https://img.example/new.png");
  });

  it("preserves existing Ghost values when fields are omitted (COALESCE null)", async () => {
    const res = await req(appWith("a@b.com"), "PATCH", "/r1", {
      wp_publish_status: "publish",
    });
    expect(res.status).not.toBe(400);

    const upd = state.updates.find((u) => u.text.toLowerCase().includes("update content_tool.runs"));
    expect(upd).toBeDefined();
    const text = (upd as Captured).text;
    // Columns still present (so COALESCE preserves the stored values).
    expect(text).toContain("ghost_author_ids = COALESCE(");
    expect(text).toContain("ghost_tags = COALESCE(");
    expect(text).toContain("feature_image_url = COALESCE(");
    // The COALESCE first-arg for each ghost field is null (omitted => leave
    // unchanged), never a json fragment (which would overwrite/clear).
    const flat = JSON.stringify((upd as Captured).values);
    expect(flat).not.toContain("author");
    expect(flat).not.toContain("Insurance");
    expect(flat).not.toContain("Wellness");
  });

  it("clears a Ghost array when an empty array is sent", async () => {
    const res = await req(appWith("a@b.com"), "PATCH", "/r1", {
      ghost_tags: [],
    });
    expect(res.status).not.toBe(400);

    const upd = state.updates.find((u) => u.text.toLowerCase().includes("update content_tool.runs"));
    const text = (upd as Captured).text;
    // [] => toJsonb fragment ("[]" inlined into the SQL text by the fake
    // sql.json), NOT null — i.e. an explicit clear, distinct from omit/preserve.
    expect(text).toContain("ghost_tags = COALESCE([], ghost_tags)");
    expect(text).toContain("ghost_author_ids = COALESCE(");
  });
});

// ---------------------------------------------------------------------------
// GET payloads — list + detail must return all three, arrays parsed.
// ---------------------------------------------------------------------------
describe("GET /runs Ghost metadata payloads", () => {
  it("returns parsed Ghost arrays + image URL in the list payload", async () => {
    const res = await req(appWith("a@b.com"), "GET", "/");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    const row = body[0] as Record<string, unknown>;
    // Arrays, not raw strings.
    expect(row.ghost_author_ids).toEqual(["author-1", "author-2"]);
    expect(row.ghost_tags).toEqual(["Insurance", "Health"]);
    expect(row.feature_image_url).toBe("https://img.example/cover.png");
  });

  it("returns parsed Ghost arrays + image URL in the detail payload", async () => {
    const res = await req(appWith("a@b.com"), "GET", "/r1");
    expect(res.status).toBe(200);
    const row = (await res.json()) as Record<string, unknown>;
    expect(row.ghost_author_ids).toEqual(["author-1", "author-2"]);
    expect(row.ghost_tags).toEqual(["Insurance", "Health"]);
    expect(row.feature_image_url).toBe("https://img.example/cover.png");
  });
});

// ---------------------------------------------------------------------------
// hitl2 snapshots — Save + version history must round-trip Ghost metadata.
// ---------------------------------------------------------------------------
describe("hitl2 snapshots Ghost metadata round-trip", () => {
  it("persists Ghost metadata on POST and returns it parsed", async () => {
    const res = await req(appWith("a@b.com"), "POST", "/r1/hitl2-snapshots", {
      trigger: "manual",
      html_body: "<p>x</p>",
      ghost_author_ids: ["author-9"],
      ghost_tags: ["Wellness"],
      feature_image_url: "https://img.example/new.png",
    });
    expect(res.status).toBe(200);

    // INSERT wrote all three columns (arrays as jsonb fragments, image bound).
    const ins = state.inserts.find((i) =>
      i.text.toLowerCase().includes("insert into content_tool.hitl2_snapshots"),
    );
    expect(ins).toBeDefined();
    const text = (ins as Captured).text;
    expect(text).toContain("ghost_author_ids");
    expect(text).toContain("ghost_tags");
    expect(text).toContain("feature_image_url");
    const flat = JSON.stringify((ins as Captured).values);
    expect(flat).toContain("author-9");
    expect(flat).toContain("Wellness");
    expect(flat).toContain("https://img.example/new.png");

    // RETURNING DTO parses jsonb arrays back to real arrays (not raw strings).
    const out = (await res.json()) as Record<string, unknown>;
    expect(out.ghost_author_ids).toEqual(["author-9"]);
    expect(out.ghost_tags).toEqual(["Wellness"]);
    expect(out.feature_image_url).toBe("https://img.example/new.png");
  });

  it("returns parsed Ghost metadata in the version-history list", async () => {
    const res = await req(appWith("a@b.com"), "GET", "/r1/hitl2-snapshots");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    const row = body[0] as Record<string, unknown>;
    expect(row.ghost_author_ids).toEqual(["author-9"]);
    expect(row.ghost_tags).toEqual(["Wellness"]);
    expect(row.feature_image_url).toBe("https://img.example/new.png");
  });
});
