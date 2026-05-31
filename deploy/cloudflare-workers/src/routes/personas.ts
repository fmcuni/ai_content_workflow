import { Hono } from "hono";
import type { Env } from "../index";
import { withDb } from "../db/client";
import { listPersonas, getPersonaBySlug } from "../db/personas";

const personasRouter = new Hono<{ Bindings: Env }>();

// GET /personas
// Returns a bare JSON array of personas ordered by created_at ASC.
// Query param `include_archived=true` includes archived rows; default excludes them.
personasRouter.get("/", async (c) => {
  const includeArchived = c.req.query("include_archived") === "true";
  // c.executionCtx from Hono has a compatible shape but a different TS type;
  // cast to the CF workers ExecutionContext that withDb expects.
  const ctx = c.executionCtx as ExecutionContext;
  const personas = await withDb(c.env, ctx, (sql) =>
    listPersonas(sql, includeArchived),
  );
  return c.json(personas);
});

// GET /personas/:slug
// Returns a single persona object, or 404 with FastAPI-compatible detail body.
personasRouter.get("/:slug", async (c) => {
  const slug = c.req.param("slug");
  const ctx = c.executionCtx as ExecutionContext;
  const persona = await withDb(c.env, ctx, (sql) =>
    getPersonaBySlug(sql, slug),
  );
  if (persona === null) {
    return c.json({ detail: "persona not found" }, 404);
  }
  return c.json(persona);
});

export { personasRouter };
export default personasRouter;
