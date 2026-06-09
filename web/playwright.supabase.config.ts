import { defineConfig } from "@playwright/test";

import { SUPABASE_STORAGE_STATE } from "./tests/e2e/support/paths";
import { loadTestEnv } from "./tests/e2e/support/test-env";

/**
 * Playwright config for the Supabase auth harness (WS5 of the Supabase Auth
 * migration). Runs against an EXTERNAL target (no local webServer), mirroring
 * playwright.prod.config.ts — point it at a deployed or locally-running web
 * instance configured with NEXT_PUBLIC_AUTH_PROVIDER=supabase via E2E_BASE_URL.
 *
 * Flow:
 *   - the `setup` project runs auth.setup.ts → mints a password-grant session →
 *     writes storageState (skips cleanly if the harness env is incomplete);
 *   - the `supabase` project depends on `setup`, loads that storageState, and
 *     runs the supabase-* smoke specs already authenticated.
 *
 * Cannot be verified headlessly without a live Supabase project + a provisioned
 * @bowtie test account (with a password set for the grant). Ships for the user.
 *
 * Run: cd web && E2E_AUTH_PROVIDER=supabase \
 *        E2E_BASE_URL=https://<your-web> npx playwright test --config=playwright.supabase.config.ts
 */

// Populate process.env from the repo-root .env.test.local (never printed).
const env = loadTestEnv();

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 60_000,
  retries: 1,
  reporter: [["list"]],
  use: {
    baseURL: env.baseUrl,
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    {
      name: "setup",
      testMatch: /auth\.setup\.ts$/,
    },
    {
      name: "supabase",
      testMatch: /supabase-.*\.spec\.ts$/,
      dependencies: ["setup"],
      use: { storageState: SUPABASE_STORAGE_STATE },
    },
  ],
});
