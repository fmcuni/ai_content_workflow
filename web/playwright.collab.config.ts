import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Dedicated config for the realtime-collab two-context e2e
// (tests/e2e/collab-realtime.spec.ts). The prod config restricts testMatch to
// the read-only visual smoke and the default config starts a webServer on the
// shared port 3000 — neither runs the collab spec against an external local
// stack. This config reuses the prod config's root-credential loader, starts NO
// webServer (we point at a manually-started dev server via E2E_COLLAB_BASE_URL),
// and matches only the collab spec.

// Load the gitignored credential file at runtime. Values are injected into
// process.env for the test subprocess only — never echoed to stdout. Repo root.
const envPath = path.resolve(__dirname, "..", ".env.test.local");
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  }
}

// Accept common credential key names so the spec works regardless of which the
// root .env.test.local used. First non-empty wins; never logged.
const EMAIL_KEYS = ["E2E_EMAIL", "TEST_LOGIN_EMAIL", "TEST_EMAIL", "TEST_USER_EMAIL", "LOGIN_EMAIL", "BOWTIE_EMAIL", "EMAIL", "USER_EMAIL", "PROD_EMAIL"];
const PW_KEYS = ["E2E_PASSWORD", "TEST_LOGIN_PASSWORD", "TEST_PASSWORD", "TEST_USER_PASSWORD", "LOGIN_PASSWORD", "BOWTIE_PASSWORD", "PASSWORD", "USER_PASSWORD", "PROD_PASSWORD"];
const pick = (keys: string[]): string | undefined =>
  keys.map((k) => process.env[k]).find((v) => v != null && v !== "");
const setIf = (key: string, value: string | undefined): void => {
  if (value && !process.env[key]) process.env[key] = value;
};
setIf("E2E_EMAIL", pick(EMAIL_KEYS));
setIf("E2E_PASSWORD", pick(PW_KEYS));

// NO webServer: the collab stack (backend Worker + collab-ON web dev server) is
// started manually and targeted via E2E_COLLAB_BASE_URL (never prod).
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "collab-realtime.spec.ts",
  timeout: 90_000,
  retries: 0,
  reporter: [["list"]],
  use: { headless: true, viewport: { width: 1280, height: 900 } },
});
