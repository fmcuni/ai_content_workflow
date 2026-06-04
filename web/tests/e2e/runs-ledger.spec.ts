import { expect, test, type Page, type Route } from "@playwright/test";

// Runs Ledger board (Phase 5) e2e. The board reads everything over `/api/*`, so
// we mock that surface at the browser layer — no live backend needed (mirrors
// the route-mocking approach in setup.spec.ts). A fake better-auth cookie keeps
// the optimistic `middleware.ts` redirect from bouncing /runs → /login.

type Json = Record<string, unknown>;

const WP_USERS = [
  { id: 1, name: "Alice Chan", slug: "alice" },
  { id: 2, name: "Bob Wong", slug: "bob" },
];
const WP_CATEGORIES = [
  { id: 10, name: "Health", slug: "health" },
  { id: 11, name: "Insurance", slug: "insurance" },
];
const PERSONAS = [
  { slug: "dr-wong", name: "Dr. Wong" },
  { slug: "amy", name: "Amy Lee" },
];

// One run per status group, a rewrite + a create (for the source-link check),
// a conflict row (for the 409 path), and a promoted child run for the batch.
function makeRuns(): Record<string, unknown>[] {
  return [
    {
      run_id: "r-rewrite", status: "hitl_2", topic: "Rewrite alpha guide",
      article_url: "https://www.bowtie.com.hk/blog/zh/alpha", mode: "small_refresh",
      created_at: "2026-06-04T09:00:00Z", chosen_route: "full_rewrite", iteration_count: 1,
      start_mode: "refresh", persona: "dr-wong", keywords: ["alpha", "guide"],
      wp_author_id: 1, wp_category_ids: [10], wp_slug: "alpha",
      wp_publish_status: "publish", wp_pushed_post_id: 555,
    },
    {
      run_id: "r-create", status: "hitl_1", topic: "Create beta article",
      article_url: "", mode: "create", created_at: "2026-06-04T08:30:00Z",
      chosen_route: null, iteration_count: 0, start_mode: "create",
      target_audience: "Parents", persona: "amy", keywords: [], wp_publish_status: "draft",
    },
    {
      run_id: "r-gen", status: "pending", topic: "Generating gamma",
      article_url: "", mode: "create", created_at: "2026-06-04T08:00:00Z",
      chosen_route: null, iteration_count: 0, start_mode: "create",
    },
    {
      run_id: "r-pub", status: "published", topic: "Published delta",
      article_url: "https://www.bowtie.com.hk/blog/zh/delta", mode: "small_refresh",
      created_at: "2026-06-03T08:00:00Z", chosen_route: "small_refresh", iteration_count: 1,
      start_mode: "refresh", wp_pushed_post_id: 600,
    },
    {
      run_id: "r-fail", status: "failed", topic: "Failed epsilon",
      article_url: "", mode: "create", created_at: "2026-06-03T07:00:00Z",
      chosen_route: null, iteration_count: 0, start_mode: "create",
      error: { type: "fetch_error", message: "boom" },
    },
    {
      run_id: "r-conflict", status: "hitl_2", topic: "Conflict zeta",
      article_url: "https://www.bowtie.com.hk/blog/zh/zeta", mode: "full",
      created_at: "2026-06-04T07:30:00Z", chosen_route: "full_rewrite", iteration_count: 1,
      start_mode: "refresh", wp_author_id: 1, wp_publish_status: "draft",
    },
    {
      run_id: "r-child", status: "pending", topic: "Promoted child article",
      article_url: "", mode: "create", created_at: "2026-06-04T06:00:00Z",
      chosen_route: null, iteration_count: 0, start_mode: "create",
      topic_candidate_id: "c-1",
    },
  ];
}

const BATCH = {
  batch_id: "b-1", status: "ready_for_review", created_by: "editor@bowtie.com.hk",
  created_at: "2026-06-04T09:30:00Z", updated_at: "2026-06-04T09:30:00Z",
  research_theme: "Summer childhood illnesses", target_audience: "Parents",
  topic_count: 3, keywords_per_topic: 4, must_cover: [], must_avoid: [],
  priority_focus: "Prevention", notes: null, persona_default: null,
  acf_adv_id_default: null, acf_widget_id_default: null,
  auto_accept_hitl1_default: false, cost_cents: 1234, last_error: null,
};

const BATCH_DETAIL = {
  ...BATCH,
  candidates: [
    {
      candidate_id: "c-1", batch_id: "b-1", position: 0, status: "promoted",
      topic: "Promoted child article", keywords: [], original_topic: "Promoted child article",
      original_keywords: [], existing: null, existing_note: null, existing_url: null,
      hot_topic: null, hot_topic_note: null, existing_search_debug: null,
      persona_slug: null, acf_adv_id: null, acf_widget_id: null, operator_note: null,
      promote_mode: "create", promoted_run_id: "r-child", last_error: null,
      last_edited_by: null, last_edited_at: null,
      created_at: "2026-06-04T09:30:00Z", updated_at: "2026-06-04T09:30:00Z",
    },
    {
      candidate_id: "c-2", batch_id: "b-1", position: 1, status: "pending",
      topic: "Unpromoted candidate", keywords: [], original_topic: "Unpromoted candidate",
      original_keywords: [], existing: null, existing_note: null, existing_url: null,
      hot_topic: null, hot_topic_note: null, existing_search_debug: null,
      persona_slug: null, acf_adv_id: null, acf_widget_id: null, operator_note: null,
      promote_mode: null, promoted_run_id: null, last_error: null,
      last_edited_by: null, last_edited_at: null,
      created_at: "2026-06-04T09:30:00Z", updated_at: "2026-06-04T09:30:00Z",
    },
  ],
};

interface MockState {
  hitl2Calls: string[];
  patchCalls: { runId: string; body: Json }[];
}

function json(route: Route, body: unknown, status = 200) {
  return route.fulfill({ status, contentType: "application/json", body: JSON.stringify(body) });
}

/** Seed auth + a full `/api/*` mock surface, then return the recorded-call state. */
async function mountBoard(page: Page): Promise<MockState> {
  const runs = makeRuns();
  const state: MockState = { hitl2Calls: [], patchCalls: [] };

  await page.context().addCookies([
    { name: "better-auth.session_token", value: "e2e-stub", domain: "localhost", path: "/" },
  ]);

  await page.route("**/api/**", async (route) => {
    const req = route.request();
    const method = req.method();
    const path = new URL(req.url()).pathname;

    if (path === "/api/setup/status") {
      return json(route, { configured: true, missing: [], wp_configured: true });
    }
    if (path.startsWith("/api/auth")) {
      return json(route, { user: { email: "e2e@bowtie.com.hk" }, session: {} });
    }
    if (path === "/api/me") return json(route, { email: "e2e@bowtie.com.hk", role: "admin" });
    if (path === "/api/runs" && method === "GET") return json(route, runs);
    if (path === "/api/topic-batches" && method === "GET") return json(route, [BATCH]);
    if (path === "/api/topic-batches/b-1" && method === "GET") return json(route, BATCH_DETAIL);
    if (path === "/api/wp-options/users") return json(route, WP_USERS);
    if (path === "/api/wp-options/categories") return json(route, WP_CATEGORIES);
    if (path === "/api/personas") return json(route, PERSONAS);

    // Inline run PATCH — r-conflict simulates a stale-version 409.
    const patchMatch = path.match(/^\/api\/runs\/([^/]+)$/);
    if (patchMatch && method === "PATCH") {
      const runId = patchMatch[1];
      const body = (req.postDataJSON() ?? {}) as Json;
      state.patchCalls.push({ runId, body });
      if (runId === "r-conflict") {
        return json(route, { detail: "stale_version" }, 409);
      }
      const target = runs.find((r) => r.run_id === runId);
      if (target && typeof body.wp_author_id === "number") target.wp_author_id = body.wp_author_id;
      return json(route, { ok: true, version: 2 });
    }

    // Bulk publish reuses the single hitl-2 path — record it to prove the
    // count-confirm dialog gates it.
    const hitl2Match = path.match(/^\/api\/runs\/([^/]+)\/hitl-2$/);
    if (hitl2Match && method === "POST") {
      state.hitl2Calls.push(hitl2Match[1]);
      return json(route, { ok: true });
    }

    // Render / audit / cost load lazily on expand — a 404 is a graceful empty.
    if (/\/(render|audit)$/.test(path) || path.startsWith("/api/costs/")) {
      return json(route, { detail: "not_found" }, 404);
    }
    return json(route, {});
  });

  await page.goto("/runs");
  await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
  return state;
}

/** The grid row (`<tr>`) whose identity cell links to the given run topic. */
function rowByTopic(page: Page, topic: string) {
  return page.locator("tr", { has: page.getByRole("link", { name: topic, exact: true }) });
}

test("renders the four status groups", async ({ page }) => {
  await mountBoard(page);
  for (const label of [
    "Needs your review",
    "Generating",
    "Approved & published",
    "Failed & closed",
  ]) {
    await expect(page.getByText(label, { exact: true })).toBeVisible();
  }
});

test("source link appears on rewrites only", async ({ page }) => {
  await mountBoard(page);
  // Rewrite row carries the ↗ source link to its origin article.
  const rewriteRow = rowByTopic(page, "Rewrite alpha guide");
  await expect(rewriteRow.getByRole("link", { name: /↗/ })).toBeVisible();
  // The create row has no source article, so no source link.
  const createRow = rowByTopic(page, "Create beta article");
  await expect(createRow.getByRole("link", { name: /↗/ })).toHaveCount(0);
});

test("expanding a batch reveals its nested promoted runs", async ({ page }) => {
  await mountBoard(page);
  await expect(page.getByText("Promoted child article")).toHaveCount(0);
  await page.getByRole("button", { name: "Show promoted runs" }).click();
  await expect(page.getByText(/└ Promoted runs/)).toBeVisible();
  await expect(page.getByRole("link", { name: "Promoted child article", exact: true })).toBeVisible();
});

test("inline author edit persists via PATCH", async ({ page }) => {
  const state = await mountBoard(page);
  const row = rowByTopic(page, "Rewrite alpha guide");
  await row.getByLabel("WordPress author").selectOption("2");

  await expect.poll(() => state.patchCalls.length).toBeGreaterThan(0);
  const call = state.patchCalls.at(-1);
  expect(call?.runId).toBe("r-rewrite");
  expect(call?.body).toMatchObject({ wp_author_id: 2 });
  // Persisted: after the optimistic update + refetch the new author sticks.
  await expect(row.getByLabel("WordPress author")).toHaveValue("2");
});

test("a 409 on inline edit surfaces the stale-version toast", async ({ page }) => {
  await mountBoard(page);
  const row = rowByTopic(page, "Conflict zeta");
  await row.getByLabel("WordPress author").selectOption("2");
  await expect(
    page.getByText("This run changed since you loaded it — reloading the latest."),
  ).toBeVisible();
});

test("bulk publish raises the live count-confirm before any publish call", async ({ page }) => {
  const state = await mountBoard(page);
  // Select the live (publish-status) HITL_2 rewrite.
  await rowByTopic(page, "Rewrite alpha guide").getByLabel(/^Select run/).check();

  await page.getByRole("toolbar", { name: "Bulk actions" }).getByRole("button", { name: "Publish", exact: true }).click();

  // The count-confirm dialog appears and flags the live target…
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/LIVE/)).toBeVisible();
  // …and NOTHING was published before the operator confirms.
  expect(state.hitl2Calls).toEqual([]);

  // Confirming then fires exactly the one eligible publish.
  await dialog.getByRole("button", { name: "Confirm" }).click();
  await expect.poll(() => state.hitl2Calls).toEqual(["r-rewrite"]);
});
