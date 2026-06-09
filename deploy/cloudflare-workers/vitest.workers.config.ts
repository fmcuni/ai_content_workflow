import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// Separate project for tests that need the real workerd runtime (Durable
// Objects, hibernatable WebSockets). The default `vitest.config.ts` keeps the
// fast node-env unit tests; these `*.workers.test.ts` files run inside workerd
// via @cloudflare/vitest-pool-workers (v0.16 / vitest 4 plugin API).
//
// Hermetic harness: `main` is a minimal worker that only exposes the RunDoc DO
// (src/run-doc.harness.ts) so the spike does not boot the full app (Hyperdrive,
// Workflows, auth). Phase 1 folds RunDoc into the real wrangler.jsonc wiring.
export default defineConfig({
  plugins: [
    cloudflareTest({
      main: "./src/run-doc.harness.ts",
      miniflare: {
        compatibilityDate: "2026-05-30",
        compatibilityFlags: ["nodejs_compat"],
        durableObjects: {
          RUN_DOC: { className: "RunDoc" },
        },
      },
    }),
  ],
  test: {
    include: ["src/**/*.workers.test.ts"],
  },
});
