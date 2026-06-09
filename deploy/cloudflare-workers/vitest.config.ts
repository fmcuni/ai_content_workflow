import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Workers-pool tests run under their own config (vitest.workers.config.ts).
    exclude: ["**/node_modules/**", "src/**/*.workers.test.ts"],
  },
});
