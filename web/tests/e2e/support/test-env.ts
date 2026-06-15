import fs from "node:fs";
import path from "node:path";

/**
 * Shared credential loader for the e2e harness.
 *
 * Reads the gitignored repo-root `.env.test.local` into `process.env` for the
 * test subprocess ONLY. Values are never echoed to stdout, so secrets (login
 * password, Supabase anon key) stay out of any agent/log context. This mirrors
 * the inline loaders in playwright.prod.config.ts / playwright.collab.config.ts,
 * consolidated so the Supabase harness and the existing prod specs share one
 * implementation.
 *
 * From this file (web/tests/e2e/support/) the repo root is four levels up.
 */
const REPO_ROOT_ENV = path.resolve(__dirname, "..", "..", "..", "..", ".env.test.local");

function parseEnvFileInto(filePath: string): void {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

// Accept several common key names so the harness works regardless of which the
// root .env.test.local used. First non-empty wins; never logged.
const EMAIL_KEYS = [
  "E2E_EMAIL", "TEST_LOGIN_EMAIL", "TEST_EMAIL", "TEST_USER_EMAIL",
  "LOGIN_EMAIL", "BOWTIE_EMAIL", "EMAIL", "USER_EMAIL", "PROD_EMAIL",
];
const PW_KEYS = [
  "E2E_PASSWORD", "TEST_LOGIN_PASSWORD", "TEST_PASSWORD", "TEST_USER_PASSWORD",
  "LOGIN_PASSWORD", "BOWTIE_PASSWORD", "PASSWORD", "USER_PASSWORD", "PROD_PASSWORD",
];
const BASE_KEYS = [
  "E2E_BASE_URL", "TEST_BASE_URL", "BASE_URL", "WEB_BASE_URL", "PROD_WEB_URL",
];
const SUPABASE_URL_KEYS = [
  "E2E_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_URL",
];
const SUPABASE_ANON_KEYS = [
  "E2E_SUPABASE_ANON_KEY", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "SUPABASE_ANON_KEY",
];

const pick = (keys: readonly string[]): string | undefined =>
  keys.map((k) => process.env[k]).find((v) => v != null && v !== "");

export interface TestEnv {
  /** Staff login email (for the Supabase password-grant). */
  email: string | undefined;
  /** Staff login password. */
  password: string | undefined;
  /** Web origin under test; defaults to the deployed prod web Worker. */
  baseUrl: string;
  /** Supabase project URL (required for the Supabase password-grant). */
  supabaseUrl: string | undefined;
  /** Supabase anon (publishable) key (required for the password-grant). */
  supabaseAnonKey: string | undefined;
  /** Always true — the app is Supabase-only (kept for harness-gate readability). */
  isSupabase: boolean;
}

let cached: TestEnv | null = null;

const DEFAULT_BASE_URL = "https://bowtie-content-tool-web.fmc.workers.dev";

/**
 * Load (once) the e2e credentials from the repo-root `.env.test.local`. Returns
 * a normalized {@link TestEnv}. Missing keys come back `undefined` so callers
 * can `test.skip(...)` rather than crash — nothing here throws or prints.
 */
export function loadTestEnv(): TestEnv {
  if (cached) return cached;
  parseEnvFileInto(REPO_ROOT_ENV);

  cached = {
    email: pick(EMAIL_KEYS),
    password: pick(PW_KEYS),
    baseUrl: pick(BASE_KEYS) ?? DEFAULT_BASE_URL,
    supabaseUrl: pick(SUPABASE_URL_KEYS),
    supabaseAnonKey: pick(SUPABASE_ANON_KEYS),
    // The app is Supabase-only; the field is retained so the spec CONFIGURED
    // gates (which also need creds) read clearly.
    isSupabase: true,
  };
  return cached;
}
