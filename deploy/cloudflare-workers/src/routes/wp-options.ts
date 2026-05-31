import { Hono } from "hono";
import type { Env } from "../index";
import { getSql } from "../db/client";
import { queryWpCategories, queryWpUsers } from "../db/wp";
import type { WpOptionItem } from "../db/wp";

const wpOptionsRouter = new Hono<{ Bindings: Env }>();

// GET /wp-options/users?q=
// Returns a bare array of { id, name, slug } matching the filter.
wpOptionsRouter.get("/users", async (c) => {
  const q = c.req.query("q");
  const sql = getSql(c.env);
  try {
    const items: WpOptionItem[] = await queryWpUsers(sql, q);
    return c.json(items);
  } finally {
    c.executionCtx.waitUntil(sql.end().catch(() => undefined));
  }
});

// GET /wp-options/categories?q=
// Returns a bare array of { id, name, slug } matching the filter.
wpOptionsRouter.get("/categories", async (c) => {
  const q = c.req.query("q");
  const sql = getSql(c.env);
  try {
    const items: WpOptionItem[] = await queryWpCategories(sql, q);
    return c.json(items);
  } finally {
    c.executionCtx.waitUntil(sql.end().catch(() => undefined));
  }
});

export { wpOptionsRouter };
export default wpOptionsRouter;
