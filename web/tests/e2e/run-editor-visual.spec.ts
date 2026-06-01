import { test, expect, type Page } from "@playwright/test";

/**
 * READ-ONLY authenticated visual smoke for the shared run-editor shell across
 * /hitl2, /edit, /regenerate (post-refactor). Runs against the deployed prod
 * frontend via playwright.prod.config.ts.
 *
 * SAFETY: prod publishes to live WordPress. This spec only logs in, navigates,
 * asserts the shared chrome renders, and screenshots. It NEVER clicks
 * Approve / Save / Re-push / Regenerate or any mutating control.
 *
 * Credentials come from web/.env.test.local (loaded by the prod config); they
 * are never printed. Run: npx playwright test --config=playwright.prod.config.ts
 */

const BASE = process.env.E2E_BASE_URL || "https://bowtie-content-tool-web.fmc.workers.dev";
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;

const RUN_ID_RE = /\/runs\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/;

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.locator("#email").fill(EMAIL!);
  await page.locator("#password").fill(PASSWORD!);
  await page.getByRole("button", { name: /sign in/i }).click();
  // Leaves /login on success (better-auth pushes to redirect target).
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 25_000 });
}

async function firstRunId(page: Page): Promise<string> {
  await page.goto(`${BASE}/runs`);
  await page.waitForLoadState("networkidle");
  const href = await page
    .locator('a[href*="/runs/"]')
    .evaluateAll((els) =>
      els
        .map((e) => e.getAttribute("href") || "")
        .find((h) => /\/runs\/[0-9a-f]{8}-[0-9a-f]{4}-/.test(h)),
    );
  expect(href, "no run links found on /runs").toBeTruthy();
  const m = href!.match(RUN_ID_RE);
  expect(m, "could not parse a run id").toBeTruthy();
  return m![1];
}

test.describe("run-editor shared shell (read-only)", () => {
  test.skip(
    !EMAIL || !PASSWORD,
    "set E2E_EMAIL / E2E_PASSWORD in web/.env.test.local",
  );

  test("renders shared shell on /edit & /hitl2; /regenerate redirects to /edit", async ({ page }) => {
    await login(page);
    const runId = await firstRunId(page);

    // --- /edit -------------------------------------------------------------
    await page.goto(`${BASE}/runs/${runId}/edit`);
    await expect(page.getByRole("link", { name: /Run ·/ })).toBeVisible();
    await expect(page.getByRole("heading", { name: /Edit outline & article/i })).toBeVisible();
    await expect(page.getByText("Notes to AI", { exact: false })).toBeVisible();
    await expect(page.getByRole("tab", { name: /WP metadata/i })).toBeVisible(); // EditorRail
    await page.screenshot({ path: "test-results/run-editor-edit.png", fullPage: true });

    // --- /regenerate is retired → must redirect to /edit -------------------
    await page.goto(`${BASE}/runs/${runId}/regenerate`);
    await page.waitForURL(`**/runs/${runId}/edit`, { timeout: 15_000 });
    await expect(page.getByRole("heading", { name: /Edit outline & article/i })).toBeVisible();

    // --- /hitl2 (may be gate-resolved/read-only; shell still renders) ------
    await page.goto(`${BASE}/runs/${runId}/hitl2`);
    await expect(page.getByRole("link", { name: /Run ·/ })).toBeVisible();
    await expect(page.getByText("Notes to AI", { exact: false })).toBeVisible();
    await page.screenshot({ path: "test-results/run-editor-hitl2.png", fullPage: true });
  });
});
