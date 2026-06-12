import { defineConfig, devices } from "@playwright/test";

// Dedicated config for the Runs Ledger redesign e2e (tests/e2e/runs-ledger.spec.ts).
// The default config serves on the shared port 3000 — which a different
// "GEO Analytics" dev app also uses — with reuseExistingServer:true, so it would
// happily run the spec against the wrong app. This config pins a dedicated port
// (3210), forces a fresh server (reuseExistingServer only when the port is ours),
// and matches only this spec.
//
// The spec is fully mock-driven (page.route("**/api/**")), so no backend/auth
// stack is needed — just Next dev rendering /runs client-side.

const PORT = Number(process.env.RUNS_LEDGER_E2E_PORT ?? 3210);

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "runs-ledger.spec.ts",
  timeout: 60_000,
  retries: 0,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    headless: true,
    viewport: { width: 1280, height: 900 },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
