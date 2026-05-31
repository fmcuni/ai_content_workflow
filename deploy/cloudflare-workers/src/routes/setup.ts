import { Hono } from "hono";
import type { Env } from "../index";

// Extra env vars read by this route that are not yet on the Env interface.
// The integration agent should add these to Env in src/index.ts:
//   WP_BASE_URL?: string
//   WP_TARGET?: string
//   WP_USERNAME?: string
//   WP_APP_PASSWORD?: string
interface SetupEnv extends Env {
  WP_BASE_URL?: string;
  WP_TARGET?: string;
  WP_USERNAME?: string;
  WP_APP_PASSWORD?: string;
}

// Mirrors Python _REQUIRED_FIELDS = ("postgres_url", "gemini_api_key").
// The field-name strings in `missing` MUST match Python exactly so the
// frontend renders identically.
const REQUIRED_FIELDS = [
  { name: "postgres_url", envKey: "POSTGRES_URL" },
  { name: "gemini_api_key", envKey: "GEMINI_API_KEY" },
] as const satisfies ReadonlyArray<{ name: string; envKey: string }>;

interface SetupStatus {
  configured: boolean;
  missing: string[];
  wp_configured: boolean;
}

const setupRouter = new Hono<{ Bindings: SetupEnv }>();

// GET /setup/status
// No DB access. Reads env bindings/secrets only.
// Mirrors: content_tool/api/routes/setup.py  @router.get("/status")
setupRouter.get("/status", (c) => {
  const env = c.env;

  const missing: string[] = REQUIRED_FIELDS
    .filter(({ envKey }) => !env[envKey as keyof SetupEnv])
    .map(({ name }) => name);

  const wp_configured = Boolean(env.WP_USERNAME && env.WP_APP_PASSWORD);

  const body: SetupStatus = {
    configured: missing.length === 0,
    missing,
    wp_configured,
  };

  return c.json(body);
});

export { setupRouter };
export default setupRouter;
