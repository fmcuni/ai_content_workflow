import { Hono } from "hono";
import type { Env } from "../index";
import { getSql, isConnectionError, resetSqlCache } from "../db/client";
import { queryWpCategories, queryWpUsers } from "../db/wp";
import type { WpOptionItem } from "../db/wp";
import { getPublishTargetForVoice } from "../db/publish_targets";

const wpOptionsRouter = new Hono<{ Bindings: Env }>();

// These options feed the author/category pickers on the HITL_2 publish panel —
// the last screen before pushing to WordPress. A single transient DB-connection
// blip (observed as an intermittent cold-start 500 on the first hit) would leave
// that picker empty at the worst possible moment, so each lookup is retried. The
// client itself is the request-scoped cache (src/db/client.ts) — a retry only
// rebuilds a fresh connection when the failure looks connection-flavored
// (resetSqlCache() below), rather than unconditionally discarding a socket
// that may still be fine. A persistent failure still surfaces as a 500.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 100;

// Env-prefix of the legacy Bowtie target. A run with no voice/target (or no
// run_id at all) resolves here, matching the cache's default rows.
const DEFAULT_AUTH_REF = "WP";

/**
 * Resolve which CMS instance's cached taxonomy a request should read: the
 * publish-target auth_ref of the run's voice, or 'WP' (the Bowtie default) when
 * there's no run, no voice, or an unassigned voice. Archived targets still
 * resolve to their auth_ref — the picker just reads that instance's snapshot.
 *
 * A caller may scope by `persona` (voice slug) directly — the /runs board does
 * this so N rows of the same voice share one option lookup — or by `runId` (the
 * HITL_2 picker, which knows the run but not the voice). `persona` wins when
 * both are given; with neither, the legacy Bowtie default applies.
 */
async function resolveAuthRef(
  sql: ReturnType<typeof getSql>,
  runId: string | undefined,
  persona: string | undefined,
): Promise<string> {
  if (persona) {
    const target = await getPublishTargetForVoice(sql, persona);
    return target?.auth_ref ?? DEFAULT_AUTH_REF;
  }
  if (!runId) return DEFAULT_AUTH_REF;
  const rows = await sql<{ persona: string | null }[]>`
    SELECT persona FROM content_tool.runs WHERE run_id = ${runId} LIMIT 1
  `;
  const runPersona = rows[0]?.persona;
  if (!runPersona) return DEFAULT_AUTH_REF;
  const target = await getPublishTargetForVoice(sql, runPersona);
  return target?.auth_ref ?? DEFAULT_AUTH_REF;
}

async function fetchOptionsWithRetry(
  env: Env,
  _ctx: { waitUntil: (p: Promise<unknown>) => void },
  run: (sql: ReturnType<typeof getSql>) => Promise<WpOptionItem[]>,
): Promise<WpOptionItem[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const sql = getSql(env);
    try {
      return await run(sql);
    } catch (err) {
      lastErr = err;
      if (isConnectionError(err)) {
        // Drop the shared cached client so the retry (or the next request,
        // whichever comes first) builds a fresh one instead of reusing a
        // socket that just failed.
        resetSqlCache(env.HYPERDRIVE.connectionString);
      }
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, attempt * RETRY_BASE_MS));
    }
  }
  throw lastErr;
}

// GET /wp-options/users?q=&run_id=&persona=
// Returns a bare array of { id, name, slug } for the run's / voice's CMS target.
wpOptionsRouter.get("/users", async (c) => {
  const q = c.req.query("q");
  const runId = c.req.query("run_id");
  const persona = c.req.query("persona");
  const items = await fetchOptionsWithRetry(c.env, c.executionCtx, async (sql) => {
    const authRef = await resolveAuthRef(sql, runId, persona);
    return queryWpUsers(sql, q, authRef);
  });
  return c.json(items);
});

// GET /wp-options/categories?q=&run_id=&persona=
// Returns a bare array of { id, name, slug } for the run's / voice's CMS target.
wpOptionsRouter.get("/categories", async (c) => {
  const q = c.req.query("q");
  const runId = c.req.query("run_id");
  const persona = c.req.query("persona");
  const items = await fetchOptionsWithRetry(c.env, c.executionCtx, async (sql) => {
    const authRef = await resolveAuthRef(sql, runId, persona);
    return queryWpCategories(sql, q, authRef);
  });
  return c.json(items);
});

export { wpOptionsRouter };
export default wpOptionsRouter;
