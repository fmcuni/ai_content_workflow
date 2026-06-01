import { defineConfig } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";

// Load the gitignored credential file at runtime. The values are injected into
// process.env for the test subprocess only — they are never echoed to stdout, so
// the password stays out of any agent/log context. Lives at the repo root.
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
const BASE_KEYS = ["E2E_BASE_URL", "TEST_BASE_URL", "BASE_URL", "WEB_BASE_URL", "PROD_WEB_URL"];
const pick = (keys: string[]): string | undefined =>
  keys.map((k) => process.env[k]).find((v) => v != null && v !== "");
// Only assign when a value exists — assigning undefined coerces to the string
// "undefined", which would defeat the spec's own fallbacks.
const setIf = (key: string, value: string | undefined): void => {
  if (value && !process.env[key]) process.env[key] = value;
};
setIf("E2E_EMAIL", pick(EMAIL_KEYS));
setIf("E2E_PASSWORD", pick(PW_KEYS));
setIf("E2E_BASE_URL", pick(BASE_KEYS));

// Prod-only config: NO webServer (does not start a local dev server). Runs the
// read-only visual smoke against the deployed Workers frontend.
export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "run-editor-visual.spec.ts",
  timeout: 60_000,
  retries: 1,
  reporter: [["list"]],
  use: { headless: true, viewport: { width: 1280, height: 900 } },
});
