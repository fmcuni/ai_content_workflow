import { expect, test } from "@playwright/test";

import { loadTestEnv } from "./support/test-env";

/**
 * Supabase auth smoke (WS5). Run via playwright.supabase.config.ts against a web
 * instance configured with NEXT_PUBLIC_AUTH_PROVIDER=supabase. The `setup`
 * project injects a password-grant session into storageState; these specs use it.
 *
 * Covers the "login round-trip (password-grant inject)" + role-gated chrome:
 *   - an authenticated context lands on app pages without bouncing to /login,
 *     and the Masthead account menu shows the operator email + role badge;
 *   - an unauthenticated context is redirected to /login (negative control).
 *
 * SAFE: navigation + assertions only; never clicks a mutating control.
 * Skips when the harness env is incomplete (see support/test-env.ts).
 */

const env = loadTestEnv();
const CONFIGURED = env.isSupabase && Boolean(env.email && env.password && env.supabaseUrl && env.supabaseAnonKey);

test.describe("supabase auth — authenticated", () => {
  test.skip(!CONFIGURED, "set E2E_AUTH_PROVIDER=supabase + creds + E2E_SUPABASE_URL/ANON_KEY in .env.test.local");

  test("authed context reaches /runs and shows the account menu + role", async ({ page }) => {
    await page.goto("/runs");
    // Did NOT bounce to /login → the injected Supabase session is honored.
    await expect(page).toHaveURL(/\/runs(\/|$|\?)/);

    const accountMenu = page.getByRole("button", { name: /account menu/i });
    await expect(accountMenu).toBeVisible({ timeout: 15_000 });

    await accountMenu.click();
    // The dropdown reveals the operator's email and a role badge.
    await expect(page.getByText(env.email!, { exact: false })).toBeVisible();
    await expect(
      page.getByText(/^(viewer|author|reviewer|admin)$/i),
    ).toBeVisible();
  });
});

test.describe("supabase auth — unauthenticated", () => {
  // Drop the project storageState so this context carries no session cookie.
  test.use({ storageState: { cookies: [], origins: [] } });

  test.skip(!env.isSupabase, "set E2E_AUTH_PROVIDER=supabase in .env.test.local");

  test("no session → /runs redirects to /login", async ({ page }) => {
    await page.goto("/runs");
    await page.waitForURL(/\/login(\?|$)/, { timeout: 15_000 });
    await expect(page.getByRole("button", { name: /sign in/i })).toBeVisible();
  });
});
