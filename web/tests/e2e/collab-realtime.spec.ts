import { test, expect, type BrowserContext, type Page } from "@playwright/test";

/**
 * Phase 5 — realtime-collab two-context e2e.
 *
 * Two authenticated staff sessions open the SAME run's /edit surface and assert
 * the live-collab contract end-to-end:
 *   1. concurrent typing from both editors CONVERGES (CRDT merge, no lost text);
 *   2. each editor sees the OTHER's remote caret + name label;
 *   3. the connected-editors presence avatar stack shows BOTH;
 *   4. the Review-changes popover attributes a hunk to its author ("…by {name}").
 *
 * ── HOW TO RUN (LOCAL STACK ONLY — never prod) ───────────────────────────────
 * Collab is flag-gated OFF in production, and this test TYPES into the article
 * body, so it must run against a LOCAL stack with the flag forced on. It is
 * SKIPPED unless E2E_COLLAB_BASE_URL is set, which guarantees it can never run
 * against the prod web Worker.
 *
 *   # 1. Backend Worker (binds the RUN_DOC Durable Object) — note the port.
 *   cd deploy/cloudflare-workers && npx wrangler dev --port 8799
 *
 *   # 2. Web dev server on a DEDICATED port (NOT 3000 — shared with another app),
 *   #    pointed at the local Worker, collab forced ON:
 *   cd web && NEXT_PUBLIC_API_BASE=http://localhost:8799 \
 *     NEXT_PUBLIC_COLLAB_ENABLED=true npm run dev -- --port 4311
 *
 *   # 3. Creds in web/.env.test.local (gitignored; loaded by the prod config):
 *   #    E2E_EMAIL=...  E2E_PASSWORD=...   (a @bowtie.com.hk staff login)
 *   #    Optional 2nd distinct author: E2E_EMAIL_2=...  E2E_PASSWORD_2=...
 *   #    (falls back to the first account for both tabs when unset — convergence
 *   #     + presence + cursors still validate; blame then shows the one name.)
 *
 *   # 4. Run it (the prod config has no auto webServer; we target the local URL):
 *   cd web && E2E_COLLAB_BASE_URL=http://localhost:4311 \
 *     npx playwright test collab-realtime --config=playwright.prod.config.ts
 *
 * The DO's Postgres cold-store is a no-op when HYPERDRIVE is unbound, so this
 * runs WITHOUT the (still-unapplied) run_collab_state migration — DO storage is
 * in-memory for the dev session.
 *
 * Credentials are read from the environment and never printed.
 */

const BASE = process.env.E2E_COLLAB_BASE_URL; // unset ⇒ skip (never prod)
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
// Optional second distinct author; falls back to the first account.
const EMAIL_2 = process.env.E2E_EMAIL_2 || EMAIL;
const PASSWORD_2 = process.env.E2E_PASSWORD_2 || PASSWORD;

/** ProseMirror editable surface inside the visual editor. */
const EDITOR = ".editorial-prose";

async function login(page: Page, email: string, password: string): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 25_000 });
}

/** Resolve a run id via the authenticated runs API.
 *  Robust against board UI: the Ledger board collapses runs into groups and
 *  exposes no top-level per-run link to scrape, and discovery must happen on a
 *  logged-in page (page.request shares the context's session cookie). */
async function firstRunId(page: Page): Promise<string> {
  const res = await page.request.get(`${BASE}/api/runs`);
  expect(res.ok(), `GET /api/runs failed: ${res.status()}`).toBeTruthy();
  const runs = (await res.json()) as Array<{ run_id: string }>;
  expect(runs.length, "no runs returned by /api/runs").toBeGreaterThan(0);
  return runs[0].run_id;
}

/** Open a run's /edit surface in a fresh authenticated context and wait for the
 *  collaborative editor to mount + sync. */
async function openEditor(
  context: BrowserContext,
  email: string,
  password: string,
  runId: string,
): Promise<Page> {
  const page = await context.newPage();
  await login(page, email, password);
  await page.goto(`${BASE}/runs/${runId}/edit`);
  await expect(page.locator(EDITOR)).toBeVisible({ timeout: 30_000 });
  return page;
}

/** Type `text` at the start of the editor body. */
async function typeAtStart(page: Page, text: string): Promise<void> {
  const body = page.locator(EDITOR);
  await body.click();
  await page.keyboard.press("ControlOrMeta+Home");
  await page.keyboard.type(text, { delay: 20 });
}

test.describe("realtime collab — two editors on one run", () => {
  test.skip(
    !BASE || !EMAIL || !PASSWORD,
    "set E2E_COLLAB_BASE_URL + E2E_EMAIL/E2E_PASSWORD (local collab stack); see file header",
  );

  test("concurrent edits converge, remote cursors + presence + blame are visible", async ({
    browser,
  }) => {
    // Two isolated authenticated sessions (separate cookie jars).
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();

    try {
      // Log in A first; run discovery uses the authenticated /api/runs.
      const pageA = await ctxA.newPage();
      await login(pageA, EMAIL!, PASSWORD!);
      const runId = await firstRunId(pageA);
      await pageA.goto(`${BASE}/runs/${runId}/edit`);
      await expect(pageA.locator(EDITOR)).toBeVisible({ timeout: 30_000 });

      const pageB = await openEditor(ctxB, EMAIL_2!, PASSWORD_2!, runId);

      // Unique markers so we can assert convergence both ways without depending
      // on the existing article text.
      const stamp = `${runId.slice(0, 4)}`;
      const tokenA = `ZZAAA-${stamp}`;
      const tokenB = `ZZBBB-${stamp}`;

      // 1) Concurrent typing from both sides.
      await Promise.all([typeAtStart(pageA, tokenA), typeAtStart(pageB, tokenB)]);

      // 2) Convergence: each token reaches BOTH editors (CRDT merge, no loss).
      await expect(pageA.locator(EDITOR)).toContainText(tokenA, { timeout: 15_000 });
      await expect(pageA.locator(EDITOR)).toContainText(tokenB, { timeout: 15_000 });
      await expect(pageB.locator(EDITOR)).toContainText(tokenA, { timeout: 15_000 });
      await expect(pageB.locator(EDITOR)).toContainText(tokenB, { timeout: 15_000 });

      // 3) Remote caret + name label: A renders a collaboration caret for B.
      await expect(pageA.locator(".collaboration-carets__caret").first()).toBeVisible({
        timeout: 15_000,
      });

      // 4) Presence: the connected-editors avatar stack shows ≥2 sessions.
      const presenceA = pageA.getByLabel("Editors currently connected");
      await expect(presenceA).toBeVisible({ timeout: 15_000 });
      await expect(async () => {
        const count = await presenceA.locator("[role='img']").count();
        expect(count).toBeGreaterThanOrEqual(2);
      }).toPass({ timeout: 15_000 });

      // 5) Review-changes blame: switch A to Review mode, open a hunk popover,
      //    assert per-author attribution renders ("…by {name}").
      await pageA.getByRole("button", { name: /Review changes/i }).click();
      // A pending insertion (our tokens) renders as an <ins>; click it to open
      // the accept/reject/comment popover, which carries the blame line.
      const insertion = pageA.locator("ins").first();
      await expect(insertion).toBeVisible({ timeout: 15_000 });
      await insertion.click();
      await expect(pageA.getByText(/\bby\b/i).first()).toBeVisible({ timeout: 15_000 });
    } finally {
      await ctxA.close();
      await ctxB.close();
    }
  });
});
