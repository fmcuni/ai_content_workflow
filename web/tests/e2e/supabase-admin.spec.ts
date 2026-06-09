import { expect, test } from "@playwright/test";

import { loadTestEnv } from "./support/test-env";

/**
 * Supabase admin user-management smoke (WS5). Uses the authed storageState from
 * the `setup` project (playwright.supabase.config.ts). Requires the test account
 * to hold the `admin` role (manage_users) so the page renders.
 *
 * READ-ONLY BY DEFAULT: asserts the admin surface gates correctly and renders
 * the user list + Create-user dialog. It performs NO mutations against the
 * (possibly prod) GoTrue backend.
 *
 * OPT-IN MUTATION (E2E_ADMIN_MUTATE=1): exercises the full create → role-change →
 * disable → delete lifecycle against a fixed disposable address
 * (E2E_ADMIN_TEST_EMAIL, default zzz-e2e-harness@bowtie.com.hk). It cleans up by
 * deleting the user it created, so re-runs are idempotent. Only enable this
 * against a non-critical / staging Supabase project.
 *
 * Skips when the harness env is incomplete (see support/test-env.ts).
 */

const env = loadTestEnv();
const CONFIGURED = env.isSupabase && Boolean(env.email && env.password && env.supabaseUrl && env.supabaseAnonKey);
const MUTATE = process.env.E2E_ADMIN_MUTATE === "1";
const TEST_USER_EMAIL = process.env.E2E_ADMIN_TEST_EMAIL ?? "zzz-e2e-harness@bowtie.com.hk";

test.describe("supabase admin — user management", () => {
  test.skip(!CONFIGURED, "set E2E_AUTH_PROVIDER=supabase + creds + E2E_SUPABASE_URL/ANON_KEY in .env.test.local");

  test("admin sees Users & Roles + the Create-user dialog (read-only)", async ({ page }) => {
    await page.goto("/admin/users");

    // The page is gated by can("manage_users"); rendering the heading proves the
    // admin token resolved to a role that clears the gate.
    await expect(page.getByRole("heading", { name: /Users & Roles/i })).toBeVisible({ timeout: 15_000 });

    // Open the Create-user dialog and confirm its fields, then cancel — no write.
    await page.getByRole("button", { name: /^Create user$/i }).click();
    const dialog = page.getByRole("dialog", { name: /Create user/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByLabel("Email")).toBeVisible();
    await expect(dialog.getByLabel("Role")).toBeVisible();
    await dialog.getByRole("button", { name: /Cancel/i }).click();
    await expect(dialog).toBeHidden();
  });

  test("create → role-change → disable → delete lifecycle", async ({ page }) => {
    test.skip(!MUTATE, "set E2E_ADMIN_MUTATE=1 to run the mutating admin lifecycle");

    await page.goto("/admin/users");
    await expect(page.getByRole("heading", { name: /Users & Roles/i })).toBeVisible({ timeout: 15_000 });

    // --- create (idempotent on the fixed disposable address) ---------------
    await page.getByRole("button", { name: /^Create user$/i }).click();
    const dialog = page.getByRole("dialog", { name: /Create user/i });
    await dialog.getByLabel("Email").fill(TEST_USER_EMAIL);
    await dialog.getByLabel("Role").selectOption("author");
    await dialog.getByRole("button", { name: /Send invite/i }).click();
    // The dialog closes on success; if the user already exists, surface + clean
    // up below instead of failing the run.
    await expect(dialog).toBeHidden({ timeout: 15_000 }).catch(async () => {
      // Already-exists path: close the dialog and proceed to the lifecycle on the
      // existing row.
      await dialog.getByRole("button", { name: /Cancel/i }).click();
    });

    const roleSelect = page.getByLabel(`Role for ${TEST_USER_EMAIL}`);
    await expect(roleSelect).toBeVisible({ timeout: 15_000 });

    // --- role change -------------------------------------------------------
    await roleSelect.selectOption("reviewer");
    await expect(roleSelect).toHaveValue("reviewer");

    // --- disable -----------------------------------------------------------
    const row = page.locator("li", { hasText: TEST_USER_EMAIL });
    await row.getByRole("button", { name: /^Disable$/i }).click();
    await expect(row.getByRole("button", { name: /^Enable$/i })).toBeVisible({ timeout: 15_000 });

    // --- delete (cleanup) — confirm the window.confirm() prompt ------------
    page.once("dialog", (d) => void d.accept());
    await row.getByRole("button", { name: /^Delete$/i }).click();
    await expect(page.getByLabel(`Role for ${TEST_USER_EMAIL}`)).toHaveCount(0, { timeout: 15_000 });
  });
});
