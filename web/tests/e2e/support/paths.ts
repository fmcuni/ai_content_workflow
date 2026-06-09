import path from "node:path";

/**
 * Path to the Playwright storageState written by auth.setup.ts and consumed by
 * the authed projects in playwright.supabase.config.ts. Kept in its own module
 * (not the setup test file) so the config can import it without pulling a
 * `test()`-registering file into the config-load phase.
 *
 * Lives under tests/e2e/.auth/ (gitignored) because it holds a live session.
 */
export const SUPABASE_STORAGE_STATE = path.resolve(__dirname, "..", ".auth", "supabase-state.json");
