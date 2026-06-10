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

// Client-facing shape. Deliberately carries ONLY a generic configured/missing
// status — NEVER DB connection internals (host, port, sslmode, connection
// string). Leaking those to the browser exposes infrastructure detail; the
// detail is logged server-side instead (see `logConnectionDetails`).
interface SetupStatus {
  configured: boolean;
  missing: string[];
  wp_configured: boolean;
}

/**
 * Parse the NON-SECRET connection metadata (host, port, sslmode) from a Postgres
 * URL for server-side diagnostics. The username/password and the full URL are
 * NEVER returned or logged — only host/port/sslmode. Returns null when the URL
 * is absent or unparseable.
 */
function describeConnection(
  postgresUrl: string | undefined,
): { host: string; port: string; sslmode: string } | null {
  if (!postgresUrl) return null;
  try {
    const u = new URL(postgresUrl);
    return {
      host: u.hostname,
      port: u.port || "5432",
      sslmode: u.searchParams.get("sslmode") ?? "(default)",
    };
  } catch {
    return null;
  }
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

  // Log the connection internals server-side ONLY (host/port/sslmode — never
  // credentials or the full connection string). They must not reach the client.
  const conn = describeConnection(env.POSTGRES_URL);
  if (conn) {
    // eslint-disable-next-line no-console
    console.log(
      `[setup/status] db connection host=${conn.host} port=${conn.port} sslmode=${conn.sslmode}`,
    );
  }

  const body: SetupStatus = {
    configured: missing.length === 0,
    missing,
    wp_configured,
  };

  return c.json(body);
});

export { setupRouter };
export default setupRouter;
