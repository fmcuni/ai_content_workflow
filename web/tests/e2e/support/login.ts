import { type Page } from "@playwright/test";

import { supabaseAuthCookies } from "./supabase-auth";
import { loadTestEnv } from "./test-env";

/**
 * Login for the e2e harness (Supabase Auth).
 *
 * The app signs in via Google OAuth, which can't run headless, so the harness
 * mints a real session via the Supabase password grant and injects the session
 * cookie into the browser context before navigating. See support/supabase-auth.ts
 * for why this is faithful to the app. Requires E2E_EMAIL / E2E_PASSWORD; specs
 * `test.skip` when absent.
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

  await page.context().addCookies(await supabaseAuthCookies(baseUrl));
  await page.goto(`${baseUrl}${landingPath}`);
  await page.waitForURL((url) => !url.pathname.startsWith("/login"), { timeout: 25_000 });
}
