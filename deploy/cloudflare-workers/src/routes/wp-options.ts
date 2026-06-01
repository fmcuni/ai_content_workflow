import { Hono } from "hono";
import type { Env } from "../index";
import { getSql } from "../db/client";
import { queryWpCategories, queryWpUsers } from "../db/wp";
import type { WpOptionItem } from "../db/wp";

const wpOptionsRouter = new Hono<{ Bindings: Env }>();

// These options feed the author/category pickers on the HITL_2 publish panel —
// the last screen before pushing to WordPress. A single transient DB-connection
// blip (observed as an intermittent cold-start 500 on the first hit) would leave
// that picker empty at the worst possible moment, so each lookup is retried with
// a FRESH connection per attempt. A persistent failure still surfaces as a 500.
const MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 100;

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

// GET /wp-options/users?q=
// Returns a bare array of { id, name, slug } matching the filter.
wpOptionsRouter.get("/users", async (c) => {
  const q = c.req.query("q");
  const items = await fetchOptionsWithRetry(c.env, c.executionCtx, (sql) =>
    queryWpUsers(sql, q),
  );
  return c.json(items);
});

// GET /wp-options/categories?q=
// Returns a bare array of { id, name, slug } matching the filter.
wpOptionsRouter.get("/categories", async (c) => {
  const q = c.req.query("q");
  const items = await fetchOptionsWithRetry(c.env, c.executionCtx, (sql) =>
    queryWpCategories(sql, q),
  );
  return c.json(items);
});

export { wpOptionsRouter };
export default wpOptionsRouter;
