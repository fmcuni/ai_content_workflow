// Read-only prompt-template routes — ported from content_tool/api/routes/prompts.py.
//
// Mounted at /prompts in src/index.ts. All paths here are RELATIVE to that mount.
//
// Implemented:
//   GET /graph                  — static LangGraph topology by entry mode
//   GET /templates              — list editable templates (agent + partial), no body
//   GET /templates/:id          — full template detail
//   GET /templates/:id/history  — version history, newest-first, body omitted
//   GET /templates/:id/versions/:versionId — single version with body
//
// DEFERRED (ported later):
//   GET /user-example
//   GET /templates/:id/schema
//   GET /templates/:id/consumers

import { Hono } from "hono";
import type { Env } from "../index";
import { withDb } from "../db/client";
import { getPromptGraph } from "../config/prompt_graph";
import {
  listTemplates,
  getTemplate,
  getTemplateHistory,
  getVersion,
} from "../db/prompts";

const DEFAULT_GRAPH_MODE = "refresh";

const DEFAULT_HISTORY_LIMIT = 50;
const MIN_HISTORY_LIMIT = 1;
const MAX_HISTORY_LIMIT = 200;

export const promptsRouter = new Hono<{ Bindings: Env }>();

// ---------------------------------------------------------------------------
// GET /graph?mode=<mode>
//
// Returns the static LangGraph topology for the given entry mode. `mode`
// defaults to "refresh"; an unknown mode mirrors Python's 404 with the
// `unknown graph mode '<mode>'` detail message. No DB access — the registry is
// an in-memory constant (src/config/prompt_graph.ts).
// ---------------------------------------------------------------------------
promptsRouter.get("/graph", (c) => {
  const mode = c.req.query("mode") ?? DEFAULT_GRAPH_MODE;
  const graph = getPromptGraph(mode);
  if (graph === null) {
    return c.json({ detail: `unknown graph mode '${mode}'` }, 404);
  }
  return c.json(graph);
});

// ---------------------------------------------------------------------------
// GET /templates
// ---------------------------------------------------------------------------
promptsRouter.get("/templates", async (c) => {
  const templates = await withDb(c.env, c.executionCtx, (sql) => listTemplates(sql));
  return c.json({ templates });
});

// ---------------------------------------------------------------------------
// GET /templates/:id
// ---------------------------------------------------------------------------
promptsRouter.get("/templates/:id", async (c) => {
  const templateId = c.req.param("id");
  const detail = await withDb(c.env, c.executionCtx, (sql) =>
    getTemplate(sql, templateId),
  );
  if (!detail) {
    return c.json({ detail: `unknown template_id '${templateId}'` }, 404);
  }
  return c.json(detail);
});

// ---------------------------------------------------------------------------
// GET /templates/:id/history?limit=50
// ---------------------------------------------------------------------------
promptsRouter.get("/templates/:id/history", async (c) => {
  const templateId = c.req.param("id");

  const rawLimit = c.req.query("limit");
  let limit = DEFAULT_HISTORY_LIMIT;
  if (rawLimit !== undefined) {
    const parsed = parseInt(rawLimit, 10);
    if (!Number.isInteger(parsed) || parsed < MIN_HISTORY_LIMIT || parsed > MAX_HISTORY_LIMIT) {
      return c.json(
        { detail: `limit must be an integer between ${MIN_HISTORY_LIMIT} and ${MAX_HISTORY_LIMIT}` },
        422,
      );
    }
    limit = parsed;
  }

  const versions = await withDb(c.env, c.executionCtx, (sql) =>
    getTemplateHistory(sql, templateId, limit),
  );
  if (!versions) {
    return c.json({ detail: `unknown template_id '${templateId}'` }, 404);
  }
  return c.json({ template_id: templateId, versions });
});

// ---------------------------------------------------------------------------
// GET /templates/:id/versions/:versionId
// ---------------------------------------------------------------------------
promptsRouter.get("/templates/:id/versions/:versionId", async (c) => {
  const templateId = c.req.param("id");
  const versionId = c.req.param("versionId");

  const version = await withDb(c.env, c.executionCtx, (sql) =>
    getVersion(sql, templateId, versionId),
  );
  if (!version) {
    return c.json(
      { detail: `version '${versionId}' not found for template '${templateId}'` },
      404,
    );
  }
  return c.json(version);
});

export default promptsRouter;
