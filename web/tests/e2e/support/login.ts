import { type Page } from "@playwright/test";

import { supabaseAuthCookies } from "./supabase-auth";
import { loadTestEnv } from "./test-env";

/**
 * Provider-aware login for the e2e harness.
 *
 * - **better-auth** (default): fills the email/password form on `/login` and
 *   waits to leave it. This is byte-identical to the per-spec `login()` helpers
 *   it replaces, so the existing prod smokes behave exactly as before.
 * - **supabase**: there is no password form (the app uses magic links), so we
 *   inject a real password-grant session cookie into the browser context and
 *   navigate. See support/supabase-auth.ts for why this is faithful to the app.
 *
 * Both paths require E2E_EMAIL / E2E_PASSWORD; specs `test.skip` when absent.
 */

/** Legacy better-auth form login. Unchanged behavior, extracted for reuse. */
export async function loginViaForm(
  page: Page,
  baseUrl: string,
  email: string,
  password: string,
): Promise<void> {
  await page.goto(`${baseUrl}/login`);
  await page.locator("#email").fill(email);
  await page.locator("#password").fill(password);
  await page.getByRole("button", { name: /sign in/i }).click();
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 25_000 });
}

/**
 * Ensure the page's context is authenticated, branching on the configured auth
 * provider. For Supabase it seeds the session cookie before any navigation; for
 * better-auth it drives the login form. `landingPath` (default `/runs`) is where
 * we land + assert we're no longer bounced to `/login`.
 */
export async function ensureLoggedIn(
  page: Page,
  opts: { baseUrl?: string; email?: string; password?: string; landingPath?: string } = {},
): Promise<void> {
  const env = loadTestEnv();
  const baseUrl = opts.baseUrl ?? env.baseUrl;
  const email = opts.email ?? env.email;
  const password = opts.password ?? env.password;
  const landingPath = opts.landingPath ?? "/runs";

  if (!email || !password) {
    throw new Error("ensureLoggedIn: missing E2E_EMAIL / E2E_PASSWORD");
  }

  if (env.isSupabase) {
    await page.context().addCookies(await supabaseAuthCookies(baseUrl));
    await page.goto(`${baseUrl}${landingPath}`);
    await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 25_000 });
    return;
  }

  await loginViaForm(page, baseUrl, email, password);
}
