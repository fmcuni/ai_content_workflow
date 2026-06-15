import { expect, test, type Page, type Route } from "@playwright/test";

// Runs Ledger (redesign) e2e. The ledger reads everything over `/api/*`, so a
// fake Supabase session cookie keeps `middleware.ts` from bouncing /runs → /login.
// The board defaults to the "drafted" tab and opens a bottom-sheet drawer per
// row; bulk actions fan out over the per-run endpoints.

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

// One run per status bucket the ledger tabs read: a LIVE drafted (hitl_2,
// wp_publish_status "publish"), a second drafted draft (the stale-version 409
// path), an outlined (hitl_1), a generating (pending), a published and a failed.
function makeRuns(): Record<string, unknown>[] {
  return [
    {
      run_id: "r-rewrite", status: "hitl_2", topic: "Rewrite alpha guide",
      article_url: "https://www.bowtie.com.hk/blog/zh/alpha", mode: "small_refresh",
      created_at: "2026-06-04T09:00:00Z", chosen_route: "full_rewrite", iteration_count: 1,
      start_mode: "refresh", persona: "dr-wong", keywords: ["alpha", "guide"],
      wp_author_id: 1, wp_category_ids: [10], wp_slug: "alpha",
      wp_publish_status: "publish", wp_pushed_post_id: 555,
      seo_title: "Alpha SEO title", meta_description: "Alpha meta",
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
      start_mode: "refresh", persona: "dr-wong", wp_author_id: 1, wp_publish_status: "draft",
      wp_slug: "zeta",
    },
  ];
}

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
    // middleware.ts presence-checks the chunked Supabase cookie `${name}.0`.
    { name: "bowtie-sb-auth.0", value: "e2e-stub", domain: "localhost", path: "/" },
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
    if (path === "/api/publish-targets" && method === "GET") return json(route, []);
    if (path === "/api/personas") return json(route, PERSONAS);

    // wp-options carry an optional ?run_id / ?persona discriminator (ignored here).
    if (path === "/api/wp-options/users") return json(route, WP_USERS);
    if (path === "/api/wp-options/categories") return json(route, WP_CATEGORIES);

    // ── Per-run endpoints the drawer + autosave reach ──────────────────────
    // GET a single run → return the matching fixture (drawer authoritative load).
    const runMatch = path.match(/^\/api\/runs\/([^/]+)$/);
    if (runMatch && method === "GET") {
      const target = runs.find((r) => r.run_id === runMatch[1]);
      return target ? json(route, target) : json(route, { detail: "not_found" }, 404);
    }

    // Outlined-mode panels.
    if (/\/gap-analysis$/.test(path) && method === "GET") return json(route, {});
    if (/\/outline$/.test(path) && method === "GET") {
      return json(route, { payload: { h1: "Outline H1", sections: [] } });
    }

    // Default-mode drawer data.
    if (/\/hitl2-snapshots$/.test(path) && method === "GET") return json(route, []);
    if (/\/existing-post$/.test(path) && method === "GET") {
      return json(route, { link: "https://example.com/post" });
    }

    // Dry-publish precedes the per-run approve confirm in the drawer.
    if (/\/dry-publish$/.test(path) && method === "POST") {
      return json(route, {
        target_label: "Bowtie WordPress (LIVE)",
        target_base_url: "",
        request_method: "PUT",
        request_url: "",
        request_headers: {},
        request_body: {},
      });
    }

    // Inline / drawer / bulk run PATCH — r-conflict simulates a stale-version 409.
    if (runMatch && method === "PATCH") {
      const runId = runMatch[1];
      const body = (req.postDataJSON() ?? {}) as Json;
      state.patchCalls.push({ runId, body });
      if (runId === "r-conflict") {
        return json(route, { detail: "stale_version" }, 409);
      }
      return json(route, { ok: true, version: 2 });
    }

    // Bulk + drawer publish reuse the single hitl-2 path — record it to prove
    // the count-confirm dialog gates it.
    const hitl2Match = path.match(/^\/api\/runs\/([^/]+)\/hitl-2$/);
    if (hitl2Match && method === "POST") {
      state.hitl2Calls.push(hitl2Match[1]);
      return json(route, { ok: true });
    }

    // Render / audit / cost load lazily — a 404 is a graceful empty.
    if (/\/(render|audit)$/.test(path) || path.startsWith("/api/costs/")) {
      return json(route, { detail: "not_found" }, 404);
    }
    return json(route, {});
  });

  await page.goto("/runs");
  await expect(page.getByRole("heading", { name: "Runs", exact: true })).toBeVisible();
  return state;
}

/** The ledger row (`<tr>`) showing the given topic. Topic is a plain span now. */
function rowByTopic(page: Page, topic: string) {
  return page.locator("tr", { hasText: topic });
}

test("defaults to the drafted tab and lists drafted runs", async ({ page }) => {
  await mountBoard(page);

  const drafted = page.getByRole("tab", { name: /drafted/ });
  await expect(drafted).toHaveAttribute("aria-selected", "true");
  // A hitl_2 run belongs to the drafted bucket, so its topic is visible.
  await expect(page.getByText("Rewrite alpha guide", { exact: true })).toBeVisible();
});

test("tab counts render and switching tabs filters", async ({ page }) => {
  await mountBoard(page);

  // Drafted (default) shows the hitl_2 rows but not the failed one.
  await expect(page.getByText("Failed epsilon", { exact: true })).toHaveCount(0);

  await page.getByRole("tab", { name: /failed/ }).click();

  await expect(page.getByText("Failed epsilon", { exact: true })).toBeVisible();
  // The drafted-only run is filtered out on the failed tab.
  await expect(page.getByText("Rewrite alpha guide", { exact: true })).toHaveCount(0);
});

test("search filters rows", async ({ page }) => {
  await mountBoard(page);

  // Both drafted rows are visible to start.
  await expect(page.getByText("Rewrite alpha guide", { exact: true })).toBeVisible();
  await expect(page.getByText("Conflict zeta", { exact: true })).toBeVisible();

  await page.getByLabel("Search runs").fill("alpha");

  await expect(page.getByText("Rewrite alpha guide", { exact: true })).toBeVisible();
  await expect(page.getByText("Conflict zeta", { exact: true })).toHaveCount(0);
});

test("clicking a row opens the drawer and shows CMS destination", async ({ page }) => {
  await mountBoard(page);

  await rowByTopic(page, "Rewrite alpha guide").click();

  const drawer = page.getByRole("complementary", { name: /Run detail/ });
  await expect(drawer).toBeVisible();
  await expect(drawer.getByText("CMS destination", { exact: false })).toBeVisible();
  // Target the field by its label association — the fixture's run title
  // ("Alpha SEO title") also contains "SEO title", so a loose getByText is
  // ambiguous. getByLabel resolves to the single #f-seotitle input.
  await expect(drawer.getByLabel("SEO title")).toBeVisible();
  await expect(drawer.getByRole("button", { name: "Approve & publish" })).toBeVisible();
});

test("editing a drawer field fires a PATCH", async ({ page }) => {
  const state = await mountBoard(page);

  await rowByTopic(page, "Rewrite alpha guide").click();
  await expect(page.getByRole("complementary", { name: /Run detail/ })).toBeVisible();

  // Slug rides the PATCH path; the autosave debounce is 600ms.
  await page.locator("#f-slug").fill("alpha-revised");

  await expect
    .poll(() => state.patchCalls.map((c) => c.runId), { timeout: 4000 })
    .toContain("r-rewrite");
});

test("bulk select → approve & publish raises a LIVE count-confirm before publishing", async ({
  page,
}) => {
  const state = await mountBoard(page);

  // r-rewrite is the LIVE drafted run (wp_publish_status "publish").
  await rowByTopic(page, "Rewrite alpha guide")
    .getByRole("checkbox", { name: /^Select run/ })
    .check();

  await page
    .getByRole("toolbar", { name: "Bulk actions" })
    .getByRole("button", { name: "Approve & publish" })
    .click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText(/LIVE/)).toBeVisible();
  // Nothing published before the operator confirms.
  expect(state.hitl2Calls).toEqual([]);

  await dialog.getByRole("button", { name: "Confirm", exact: true }).click();

  await expect.poll(() => state.hitl2Calls, { timeout: 4000 }).toContain("r-rewrite");
});

test("bulk set CMS metadata fans out PATCH", async ({ page }) => {
  const state = await mountBoard(page);

  await rowByTopic(page, "Rewrite alpha guide")
    .getByRole("checkbox", { name: /^Select run/ })
    .check();

  await page
    .getByRole("toolbar", { name: "Bulk actions" })
    .getByRole("button", { name: "Set CMS metadata…" })
    .click();

  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();
  await expect(modal.getByText("Set CMS metadata", { exact: true })).toBeVisible();

  await modal.locator("#bm-pubstatus").selectOption("publish");
  await modal.getByRole("button", { name: "Apply to selection" }).click();

  await expect
    .poll(
      () =>
        state.patchCalls.find(
          (c) => c.runId === "r-rewrite" && c.body.wp_publish_status === "publish",
        ) != null,
      { timeout: 4000 },
    )
    .toBe(true);
});

// ── Mobile pass (390px) ────────────────────────────────────────────────────
// The `max-md:` (<768px) breakpoint reflows the dense table into cards, turns
// the drawer into a 92dvh stacked sheet with sticky actions, and widens the
// bulk bar to nearly full-width. iPhone-12-class viewport: 390×844.
test.describe("mobile viewport (390px)", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("table rows reflow into stacked cards", async ({ page }) => {
    await mountBoard(page);

    // The <tr> switches from table-row to a block card under max-md.
    const row = rowByTopic(page, "Rewrite alpha guide");
    await expect(row).toBeVisible();
    const display = await row.evaluate((el) => getComputedStyle(el).display);
    expect(display).toBe("block");
  });

  test("drawer is a ~92dvh stacked sheet with sticky actions", async ({ page }) => {
    await mountBoard(page);

    await rowByTopic(page, "Rewrite alpha guide").click();
    const drawer = page.getByRole("complementary", { name: /Run detail/ });
    await expect(drawer).toBeVisible();

    // 92dvh of an 844px viewport ≈ 776px — assert it fills most of the screen.
    const box = await drawer.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.height).toBeGreaterThan(844 * 0.7);

    // The publish action sits in the sticky action bar and stays reachable.
    await expect(drawer.getByRole("button", { name: "Approve & publish" })).toBeVisible();
  });

  test("bulk bar spans nearly the full viewport width", async ({ page }) => {
    await mountBoard(page);

    await rowByTopic(page, "Rewrite alpha guide")
      .getByRole("checkbox", { name: /^Select run/ })
      .check();

    const bar = page.getByRole("toolbar", { name: "Bulk actions" });
    await expect(bar).toBeVisible();
    // max-md:inset-x-2 → ~8px gutter each side of a 390px viewport (≈374px).
    const box = await bar.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.width).toBeGreaterThan(350);
  });
});
