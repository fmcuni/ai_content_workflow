import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const rootDir = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": rootDir,
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    // Scope to the shared-lib + component unit tests only. Never pick up the
    // Playwright specs under tests/e2e/**.
    include: [
      "lib/**/*.test.ts",
      "lib/**/*.test.tsx",
      "components/**/*.test.tsx",
      // WS3 admin user-management page lives under app/admin/users; its RTL
      // test sits beside it. Still excludes the Playwright specs (tests/e2e/**).
      "app/**/*.test.tsx",
    ],
  },
});
