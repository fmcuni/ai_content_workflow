import fs from "node:fs";
import path from "node:path";

import { test as setup } from "@playwright/test";

import { SUPABASE_STORAGE_STATE } from "./support/paths";
import { SupabaseTestConfigError, supabaseStorageState } from "./support/supabase-auth";
import { loadTestEnv } from "./support/test-env";

/**
 * Playwright setup project for the Supabase auth harness.
 *
 * Mints a real session via the Supabase password grant and writes a Playwright
 * `storageState` file consumed by the authed projects in
 * playwright.supabase.config.ts. Skips cleanly (does not fail the run) when the
 * harness env is incomplete — the harness ships for the user to run against a
 * live Supabase project with a provisioned @bowtie test account.
 *
 * We ALWAYS write a state file (an empty one when the env is incomplete or
 * sign-in fails) so the `supabase` project's `storageState: <path>` never errors
 * on a missing file — the smoke specs themselves `test.skip` when unconfigured.
 *
 * The state file may contain a live session token; it lands under
 * tests/e2e/.auth/ which is gitignored.
 */

const EMPTY_STATE = { cookies: [], origins: [] };

function writeState(state: unknown): void {
  fs.mkdirSync(path.dirname(SUPABASE_STORAGE_STATE), { recursive: true });
  fs.writeFileSync(SUPABASE_STORAGE_STATE, JSON.stringify(state, null, 2));
}

setup("authenticate via supabase password grant", async () => {
  const env = loadTestEnv();
  if (!env.isSupabase) {
    writeState(EMPTY_STATE);
    setup.skip(true, "supabase harness: set E2E_AUTH_PROVIDER=supabase (or NEXT_PUBLIC_AUTH_PROVIDER)");
    return;
  }

  try {
    writeState(await supabaseStorageState(env.baseUrl));
  } catch (e) {
    if (e instanceof SupabaseTestConfigError) {
      writeState(EMPTY_STATE);
      setup.skip(true, e.message);
      return;
    }
    throw e;
  }
});
