import { Hono } from "hono";
import type { Env } from "../index";
import { getSql } from "../db/client";
import { queryWpCategories, queryWpUsers } from "../db/wp";
import type { WpOptionItem } from "../db/wp";
import { getPublishTargetForVoice } from "../db/publish_targets";

const wpOptionsRouter = new Hono<{ Bindings: Env }>();

// These options feed the author/category pickers on the HITL_2 publish panel —
// the last screen before pushing to WordPress. A single transient DB-connection
// blip (observed as an intermittent cold-start 500 on the first hit) would leave
// that picker empty at the worst possible moment, so each lookup is retried with
// a FRESH connection per attempt. A persistent failure still surfaces as a 500.
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
 */
async function resolveAuthRef(
  sql: ReturnType<typeof getSql>,
  runId: string | undefined,
): Promise<string> {
  if (!runId) return DEFAULT_AUTH_REF;
  const rows = await sql<{ persona: string | null }[]>`
    SELECT persona FROM content_tool.runs WHERE run_id = ${runId} LIMIT 1
  `;
  const persona = rows[0]?.persona;
  if (!persona) return DEFAULT_AUTH_REF;
  const target = await getPublishTargetForVoice(sql, persona);
  return target?.auth_ref ?? DEFAULT_AUTH_REF;
}

async function fetchOptionsWithRetry(
  env: Env,
  ctx: { waitUntil: (p: Promise<unknown>) => void },
  run: (sql: ReturnType<typeof getSql>) => Promise<WpOptionItem[]>,
): Promise<WpOptionItem[]> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const sql = getSql(env);
    try {
      return await run(sql);
    } catch (err) {
      lastErr = err;
    } finally {
      // Close the (possibly broken) socket after the response; a retry opens a
      // new one rather than reusing a connection that just failed.
      ctx.waitUntil(sql.end().catch(() => undefined));
    }
    if (attempt < MAX_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, attempt * RETRY_BASE_MS));
    }
  }
  throw lastErr;
}

// GET /wp-options/users?q=&run_id=
// Returns a bare array of { id, name, slug } for the run's CMS target.
wpOptionsRouter.get("/users", async (c) => {
  const q = c.req.query("q");
  const runId = c.req.query("run_id");
  const items = await fetchOptionsWithRetry(c.env, c.executionCtx, async (sql) => {
    const authRef = await resolveAuthRef(sql, runId);
    return queryWpUsers(sql, q, authRef);
  });
  return c.json(items);
});

// GET /wp-options/categories?q=&run_id=
// Returns a bare array of { id, name, slug } for the run's CMS target.
wpOptionsRouter.get("/categories", async (c) => {
  const q = c.req.query("q");
  const runId = c.req.query("run_id");
  const items = await fetchOptionsWithRetry(c.env, c.executionCtx, async (sql) => {
    const authRef = await resolveAuthRef(sql, runId);
    return queryWpCategories(sql, q, authRef);
  });
  return c.json(items);
});

export { wpOptionsRouter };
export default wpOptionsRouter;
