import { Hono } from "hono";
import type { Env } from "../index";
import { withDb } from "../db/client";
import { listPublishTargets } from "../db/publish_targets";

const publishTargetsRouter = new Hono<{ Bindings: Env }>();

// GET /publish-targets
// Bare JSON array of CMS publish targets ordered by created_at ASC. Mirrors the
// Python `GET /publish-targets`. Query param `include_archived=true` includes
// archived rows; default excludes them. Non-secret config only.
publishTargetsRouter.get("/", async (c) => {
  const includeArchived = c.req.query("include_archived") === "true";
  const ctx = c.executionCtx as ExecutionContext;
  const targets = await withDb(c.env, ctx, (sql) =>
    listPublishTargets(sql, includeArchived),
  );
  return c.json(targets);
});

export { publishTargetsRouter };
export default publishTargetsRouter;
