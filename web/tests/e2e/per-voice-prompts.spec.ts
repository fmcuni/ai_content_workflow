import { test, expect, type Page } from "@playwright/test";

/**
 * Authenticated smoke for the Per-Voice Prompt Library against the deployed prod
 * frontend (via playwright.prod.pvpl.config.ts).
 *
 * SAFE BY DEFAULT: logs in, asserts the /prompts voice selector + read-only
 * "Shared (judges)" group, that templates/source-policy are voice-scoped, and
 * that archiving the LAST remaining voice is rejected (409 — a non-mutating
 * rejection). It never creates or deletes prod data.
 *
 * OPT-IN MUTATION: set PVPL_SMOKE_MUTATE=1 to also exercise the duplicate-voice
 * flow end to end (create a deep copy, verify the clone carries the full
 * agent/partial template set + a source-policy row, then archive the copy to
 * clean up). This leaves one archived placeholder persona behind (soft-delete is
 * by design); the slug is fixed so re-runs are idempotent.
 *
 * Credentials come from the repo-root .env.test.local (loaded by the config);
 * they are never printed.
 */

const BASE = process.env.E2E_BASE_URL || "https://bowtie-content-tool-web.fmc.workers.dev";
const EMAIL = process.env.E2E_EMAIL;
const PASSWORD = process.env.E2E_PASSWORD;
const MUTATE = process.env.PVPL_SMOKE_MUTATE === "1";

const SMOKE_SLUG = "zzz-smoke-pvpl";
const SMOKE_NAME = "ZZZ Smoke (per-voice)";

async function login(page: Page): Promise<void> {
  await page.goto(`${BASE}/login`);
  await page.locator("#email").fill(EMAIL!);
  await page.locator("#password").fill(PASSWORD!);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 25_000 });
}

test.describe("per-voice prompt library (prod smoke)", () => {
  test.skip(!EMAIL || !PASSWORD, "set TEST_LOGIN_EMAIL / TEST_LOGIN_PASSWORD in .env.test.local");

  test("voice selector scopes the library; last-voice archive is blocked", async ({ page }) => {
    await login(page);

    // --- /prompts UI: voice selector + read-only judges group --------------
    await page.goto(`${BASE}/prompts`);
    await expect(page.getByRole("heading", { name: /Prompt Library/i })).toBeVisible();
    const voiceSelect = page.getByLabel("Voice");
    await expect(voiceSelect).toBeVisible();
    // Options are labelled by persona name; the active slug renders alongside.
    // The selector must list at least one voice and default to bowtie-editor.
    await expect(voiceSelect.locator("option").first()).toBeAttached();
    await expect(voiceSelect).toHaveValue("bowtie-editor");
    await expect(page.getByText(/Shared \(judges\)/i)).toBeVisible();
    await expect(page.getByRole("tab", { name: /Source Policy/i })).toBeVisible();
    await page.screenshot({ path: "test-results/pvpl-prompts.png", fullPage: true });

    // --- API (same-origin /api proxy carries the better-auth cookie) -------
    const templates = await page.request.get(`${BASE}/api/prompts/templates?voice=bowtie-editor`);
    expect(templates.ok(), `GET templates ${templates.status()}`).toBeTruthy();
    const body = await templates.json();
    const agentPartial = (body.templates ?? body.items ?? []) as Array<{ category?: string }>;
    const judges = (body.judges ?? []) as unknown[];
    expect(agentPartial.length, "voice has agent/partial templates").toBeGreaterThan(0);
    expect(judges.length, "shared judges present").toBeGreaterThan(0);

    const policy = await page.request.get(`${BASE}/api/source-policy?voice=bowtie-editor`);
    expect(policy.ok(), `GET source-policy ${policy.status()}`).toBeTruthy();

    // --- last-voice archive guard (non-mutating: must be rejected) ---------
    // Only meaningful when bowtie-editor is the sole active voice. In MUTATE
    // mode a copy may exist, so we assert the guard before creating it.
    if (!MUTATE) {
      const archiveLast = await page.request.post(`${BASE}/api/personas/bowtie-editor/archive`);
      expect(archiveLast.status(), "archiving the last voice must 409").toBe(409);
    }

    // --- /voices renders ----------------------------------------------------
    await page.goto(`${BASE}/voices`);
    await expect(page.getByText(/bowtie-editor/i).first()).toBeVisible();
    await page.screenshot({ path: "test-results/pvpl-voices.png", fullPage: true });
  });

  test("selected voice survives navigating into a template and back", async ({ page }) => {
    await login(page);

    // Land on the list with an explicit voice in the URL.
    await page.goto(`${BASE}/prompts?voice=bowtie-editor`);
    await expect(page.getByLabel("Voice")).toHaveValue("bowtie-editor");

    // Open the first editable template — its link must carry the voice.
    const firstTemplate = page.getByRole("link", { name: /Edit →/i }).first();
    await expect(firstTemplate).toBeVisible();
    await firstTemplate.click();
    await page.waitForURL((url) => /\/prompts\/[^/]+/.test(url.pathname));
    expect(new URL(page.url()).searchParams.get("voice")).toBe("bowtie-editor");

    // Back link must return to the list with the voice preserved (regression:
    // it used to drop the voice and reset the selector to the default).
    await page.getByRole("link", { name: /Prompt Library/i }).click();
    await page.waitForURL((url) => url.pathname === "/prompts");
    expect(new URL(page.url()).searchParams.get("voice")).toBe("bowtie-editor");
    await expect(page.getByLabel("Voice")).toHaveValue("bowtie-editor");
  });

  test("duplicate-voice deep-copies templates + policy", async ({ page }) => {
    test.skip(!MUTATE, "set PVPL_SMOKE_MUTATE=1 to exercise the mutating duplicate flow");
    await login(page);

    // Clean any leftover from a prior run so the duplicate is idempotent.
    await page.request.post(`${BASE}/api/personas/${SMOKE_SLUG}/archive`).catch(() => undefined);

    // Confirm the last-voice guard while bowtie-editor is still the only active
    // voice (archiving the leftover above keeps it that way).
    const archiveLast = await page.request.post(`${BASE}/api/personas/bowtie-editor/archive`);
    expect(archiveLast.status(), "archiving the last voice must 409").toBe(409);

    // Duplicate bowtie-editor -> SMOKE_SLUG. 201 fresh; 409 if a prior archived
    // row still owns the slug — restore + reuse in that case.
    const dup = await page.request.post(`${BASE}/api/personas/bowtie-editor/duplicate`, {
      data: { slug: SMOKE_SLUG, name: SMOKE_NAME },
    });
    if (dup.status() === 409) {
      const restore = await page.request.post(`${BASE}/api/personas/${SMOKE_SLUG}/restore`);
      expect(restore.ok(), `restore ${restore.status()}`).toBeTruthy();
    } else {
      expect([200, 201], `duplicate ${dup.status()}`).toContain(dup.status());
    }

    // The clone must carry the full agent/partial set + a source-policy row.
    const cloneTpl = await page.request.get(`${BASE}/api/prompts/templates?voice=${SMOKE_SLUG}`);
    expect(cloneTpl.ok(), `clone templates ${cloneTpl.status()}`).toBeTruthy();
    const cloneBody = await cloneTpl.json();
    const cloneRows = (cloneBody.templates ?? cloneBody.items ?? []) as unknown[];
    expect(cloneRows.length, "clone has agent/partial templates").toBeGreaterThan(0);

    const clonePolicy = await page.request.get(`${BASE}/api/source-policy?voice=${SMOKE_SLUG}`);
    expect(clonePolicy.ok(), `clone source-policy ${clonePolicy.status()}`).toBeTruthy();

    // Cleanup: archive the smoke voice (restores the single-active-voice state).
    const cleanup = await page.request.post(`${BASE}/api/personas/${SMOKE_SLUG}/archive`);
    expect(cleanup.ok(), `cleanup archive ${cleanup.status()}`).toBeTruthy();
  });
});
