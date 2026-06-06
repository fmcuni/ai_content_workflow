import { defineConfig } from "@playwright/test";
// Importing the prod config runs its credential-loading side effect (reads the
// repo-root .env.test.local into process.env). We only override testMatch so the
// same cred handling drives the per-voice prompt-library smoke.
import "./playwright.prod.config";

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "per-voice-prompts.spec.ts",
  timeout: 60_000,
  retries: 1,
  reporter: [["list"]],
  use: { headless: true, viewport: { width: 1280, height: 900 } },
});
