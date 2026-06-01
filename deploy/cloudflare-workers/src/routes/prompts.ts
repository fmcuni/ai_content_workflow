// Prompt-template routes — ported from content_tool/api/routes/prompts.py.
//
// Mounted at /prompts in src/index.ts. All paths here are RELATIVE to that mount.
//
// Implemented:
//   GET  /graph                  — static LangGraph topology by entry mode
//   GET  /user-example           — example user prompt for a run + agent
//   GET  /templates              — list editable templates (agent + partial), no body
//   GET  /templates/:id          — full template detail
//   GET  /templates/:id/schema   — required/found placeholders + includes
//   GET  /templates/:id/consumers — agent templates that include this template
//   PUT  /templates/:id          — save an edit (optimistic-concurrency, versioned)
//   POST /templates/:id/preview  — render the assembled prompt for an unsaved draft
//   POST /templates/:id/revert   — restore a past version (versioned)
//   GET  /templates/:id/history  — version history, newest-first, body omitted
//   GET  /templates/:id/versions/:versionId — single version with body

import { Hono } from "hono";
import type { Context } from "hono";
import type { Env } from "../index";
import { withDb } from "../db/client";
import { pgTimestampToIso } from "../db/serialize";
import { getPromptGraph } from "../config/prompt_graph";
import {
  listTemplates,
  getTemplate,
  getTemplateHistory,
  getVersion,
} from "../db/prompts";
import type { PromptTemplateRow } from "../db/schema";
import {
  snapshot,
  invalidate,
  resolveBody,
  assembleWithOverride,
  PromptTemplateNotFound,
} from "../prompts/store";
import {
  EDITABLE_CATEGORIES,
  MAX_TEMPLATE_BYTES,
  REQUIRED_PLACEHOLDERS,
  sha256Hex,
  utf8ByteLength,
  findPlaceholders,
  findIncludes,
  partialIds,
  agentIds,
  consumersOf,
  partialsReferencedBy,
  substitutePreview,
} from "../prompts/editor";
import {
  renderUserPrompt,
  USER_PROMPT_AGENTS,
  MissingInputs,
} from "../prompts/user_example";

const DEFAULT_GRAPH_MODE = "refresh";

const DEFAULT_HISTORY_LIMIT = 50;
const MIN_HISTORY_LIMIT = 1;
const MAX_HISTORY_LIMIT = 200;

const EXPECTED_SHA_LENGTH = 64;

export const promptsRouter = new Hono<{ Bindings: Env }>();

/**
 * Resolve the editor identity from the trusted `X-Editor-Email` header. Mirrors
 * Python's `_require_editor` DEV-MODE default: a missing header falls back to
 * `dev@local` (the Workers backend ships no editor allowlist — the SSO proxy in
 * front of the frontend is the gate). The frontend injects this header for all
 * /api/prompts/* requests.
 */
function resolveEditor(c: Context<{ Bindings: Env }>): string {
  const email = (c.req.header("X-Editor-Email") ?? "").trim().toLowerCase();
  return email.length > 0 ? email : "dev@local";
}

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

// ---------------------------------------------------------------------------
// GET /user-example?run_id=<uuid>&agent=<agent>
//
// Render an example USER prompt for the given run + agent, reusing the same
// builders the production workflow uses. 400 for an unknown agent, 404 if the
// run is absent, 422 if a required derived row is missing.
// ---------------------------------------------------------------------------
promptsRouter.get("/user-example", async (c) => {
  const runId = c.req.query("run_id");
  const agent = c.req.query("agent");
  if (runId === undefined || runId === "") {
    return c.json({ detail: "run_id is required" }, 422);
  }
  if (agent === undefined || !USER_PROMPT_AGENTS.has(agent)) {
    const allowed = [...USER_PROMPT_AGENTS].sort().join(", ");
    return c.json({ detail: `agent must be one of [${allowed}]` }, 400);
  }
  try {
    const prompt = await withDb(c.env, c.executionCtx, (sql) =>
      renderUserPrompt(sql, runId, agent),
    );
    if (prompt === null) {
      return c.json({ detail: "run not found" }, 404);
    }
    return c.json({ run_id: runId, agent, prompt });
  } catch (err) {
    if (err instanceof MissingInputs) {
      return c.json({ detail: `missing inputs: ${err.message}` }, 422);
    }
    throw err;
  }
});

// ---------------------------------------------------------------------------
// GET /templates/:id/schema
//
// Required placeholders (validation chips) + the placeholders/includes the
// current body references (preview tabs). 404 if the template is not editable.
// ---------------------------------------------------------------------------
promptsRouter.get("/templates/:id/schema", async (c) => {
  const templateId = c.req.param("id");
  return withDb(c.env, c.executionCtx, async (sql) => {
    const snap = await snapshot(sql);
    const row = snap.get(templateId);
    if (row === undefined || !EDITABLE_CATEGORIES.has(row.category)) {
      return c.json({ detail: `unknown template_id '${templateId}'` }, 404);
    }
    const required = [...(REQUIRED_PLACEHOLDERS[templateId] ?? [])].sort();
    const foundIncludes = findIncludes(row.body);
    const partials = partialIds(snap);
    const unknownIncludes = foundIncludes.filter((n) => !partials.has(n)).sort();
    return c.json({
      template_id: templateId,
      required_placeholders: required,
      found_placeholders: findPlaceholders(row.body),
      found_includes: foundIncludes,
      unknown_includes: unknownIncludes,
    });
  });
});

// ---------------------------------------------------------------------------
// GET /templates/:id/consumers
// ---------------------------------------------------------------------------
promptsRouter.get("/templates/:id/consumers", async (c) => {
  const templateId = c.req.param("id");
  return withDb(c.env, c.executionCtx, async (sql) => {
    const snap = await snapshot(sql);
    const row = snap.get(templateId);
    if (row === undefined || !EDITABLE_CATEGORIES.has(row.category)) {
      return c.json({ detail: `unknown template_id '${templateId}'` }, 404);
    }
    return c.json({ template_id: templateId, consumers: consumersOf(templateId, snap) });
  });
});

// ---------------------------------------------------------------------------
// PUT /templates/:id — validate + persist a template edit, stamping a version.
//
// Optimistic concurrency: the row is locked FOR UPDATE inside a transaction and
// its sha must still equal expected_sha256 (else 409). 404 unknown/uneditable,
// 413 over the byte cap, 400 missing required placeholder / unknown include.
// ---------------------------------------------------------------------------
type SaveResult =
  | { kind: "ok"; savedAt: string | null }
  | { kind: "not_found" }
  | { kind: "stale"; currentSha: string }
  | { kind: "too_large"; bytes: number }
  | { kind: "missing_placeholders"; missing: string[] }
  | { kind: "unknown_includes"; unknown: string[] };

promptsRouter.put("/templates/:id", async (c) => {
  const templateId = c.req.param("id");
  const editor = resolveEditor(c);
  const body = await c.req
    .json<{ template?: unknown; expected_sha256?: unknown }>()
    .catch(() => null);
  if (
    body === null ||
    typeof body.template !== "string" ||
    typeof body.expected_sha256 !== "string"
  ) {
    return c.json({ detail: "template and expected_sha256 are required" }, 422);
  }
  if (body.expected_sha256.length !== EXPECTED_SHA_LENGTH) {
    return c.json({ detail: "expected_sha256 must be 64 hex characters" }, 422);
  }

  const template = body.template;
  const expectedSha = body.expected_sha256;
  const newBytes = utf8ByteLength(template);
  const newSha = await sha256Hex(template);
  const versionId = crypto.randomUUID();

  const result = await withDb(c.env, c.executionCtx, (sql) =>
    sql.begin(async (tx): Promise<SaveResult> => {
      const rows = await tx<Pick<PromptTemplateRow, "category" | "sha256">[]>`
        SELECT category, sha256 FROM content_tool.prompt_templates
        WHERE template_id = ${templateId}
        FOR UPDATE
      `;
      const row = rows[0];
      if (row === undefined || !EDITABLE_CATEGORIES.has(row.category)) {
        return { kind: "not_found" };
      }
      const currentSha = row.sha256;
      if (currentSha !== expectedSha) {
        return { kind: "stale", currentSha };
      }
      if (newBytes > MAX_TEMPLATE_BYTES) {
        return { kind: "too_large", bytes: newBytes };
      }
      const required = REQUIRED_PLACEHOLDERS[templateId] ?? [];
      const present = new Set(findPlaceholders(template));
      const missing = required.filter((p) => !present.has(p)).slice().sort();
      if (missing.length > 0) {
        return { kind: "missing_placeholders", missing };
      }
      const partialRows = await tx<{ template_id: string }[]>`
        SELECT template_id FROM content_tool.prompt_templates WHERE category = 'partial'
      `;
      const partials = new Set(partialRows.map((r) => r.template_id));
      const badIncludes = findIncludes(template).filter((n) => !partials.has(n)).sort();
      if (badIncludes.length > 0) {
        return { kind: "unknown_includes", unknown: badIncludes };
      }

      await tx`
        UPDATE content_tool.prompt_templates
        SET body = ${template}, sha256 = ${newSha}, bytes = ${newBytes},
            updated_by = ${editor}, updated_at = now()
        WHERE template_id = ${templateId}
      `;
      const ins = await tx<{ saved_at: string }[]>`
        INSERT INTO content_tool.prompt_versions
          (version_id, template_id, sha256, parent_sha256, body, bytes, saved_by, kind)
        VALUES
          (${versionId}, ${templateId}, ${newSha}, ${currentSha}, ${template}, ${newBytes}, ${editor}, 'save')
        RETURNING saved_at
      `;
      return { kind: "ok", savedAt: ins[0]?.saved_at ?? null };
    }),
  );

  switch (result.kind) {
    case "not_found":
      return c.json({ detail: `unknown template_id '${templateId}'` }, 404);
    case "stale":
      return c.json(
        {
          detail: {
            error: "stale_sha",
            message: "template was changed since you loaded it",
            current_sha256: result.currentSha,
          },
        },
        409,
      );
    case "too_large":
      return c.json(
        { detail: `template exceeds ${MAX_TEMPLATE_BYTES} bytes (got ${result.bytes})` },
        413,
      );
    case "missing_placeholders":
      return c.json(
        {
          detail: {
            error: "missing_placeholders",
            message: "template removed required placeholders",
            missing: result.missing,
          },
        },
        400,
      );
    case "unknown_includes":
      return c.json(
        {
          detail: {
            error: "unknown_includes",
            message: "template references partials that do not exist",
            unknown: result.unknown,
          },
        },
        400,
      );
    case "ok":
      invalidate();
      return c.json({
        template_id: templateId,
        sha256: newSha,
        bytes: newBytes,
        version_id: versionId,
        saved_at: pgTimestampToIso(result.savedAt),
        saved_by: editor,
      });
  }
});

// ---------------------------------------------------------------------------
// POST /templates/:id/preview — render the assembled prompt for an unsaved draft.
//
// For a partial, `route` selects the consumer agent to preview against (the
// draft body is slotted into the consumer). For an agent prompt, `route` must
// equal the template_id and the submitted body is resolved directly.
// ---------------------------------------------------------------------------
promptsRouter.post("/templates/:id/preview", async (c) => {
  const templateId = c.req.param("id");
  const body = await c.req
    .json<{ template?: unknown; route?: unknown; context?: unknown }>()
    .catch(() => null);
  if (body === null || typeof body.template !== "string") {
    return c.json({ detail: "template is required" }, 422);
  }
  const template = body.template;
  const route = typeof body.route === "string" ? body.route : null;
  const context: Record<string, string> =
    body.context !== null && typeof body.context === "object"
      ? (body.context as Record<string, string>)
      : {};

  return withDb(c.env, c.executionCtx, async (sql) => {
    const snap = await snapshot(sql);
    const row = snap.get(templateId);
    if (row === undefined || !EDITABLE_CATEGORIES.has(row.category)) {
      return c.json({ detail: `unknown template_id '${templateId}'` }, 404);
    }

    let assembled: string;
    let routeId: string;
    const unknownIncludesError = (e: PromptTemplateNotFound) =>
      c.json(
        {
          detail: {
            error: "unknown_includes",
            message: "template references partials that do not exist",
            detail: e.message,
          },
        },
        400,
      );

    if (row.category === "partial") {
      if (route === null) {
        return c.json({ detail: "route is required when previewing a partial" }, 400);
      }
      if (!agentIds(snap).has(route)) {
        return c.json({ detail: `unknown route '${route}'` }, 400);
      }
      if (!partialsReferencedBy(route, snap).has(templateId)) {
        return c.json(
          { detail: `route '${route}' does not include partial '${templateId}'` },
          400,
        );
      }
      routeId = route;
      try {
        assembled = assembleWithOverride(routeId, snap, {
          overrideName: templateId,
          overrideBody: template,
        });
      } catch (e) {
        if (e instanceof PromptTemplateNotFound) return unknownIncludesError(e);
        throw e;
      }
    } else {
      routeId = route ?? templateId;
      if (routeId !== templateId) {
        return c.json({ detail: "route must equal template_id for agent prompts" }, 400);
      }
      try {
        assembled = resolveBody(template, snap);
      } catch (e) {
        if (e instanceof PromptTemplateNotFound) return unknownIncludesError(e);
        throw e;
      }
    }

    const resolved = await substitutePreview(sql, assembled, context, snap);
    return c.json({ resolved, route: routeId });
  });
});

// ---------------------------------------------------------------------------
// POST /templates/:id/revert — restore a past version's body, versioned as a
// kind='revert' row. Same optimistic-concurrency gate as PUT.
// ---------------------------------------------------------------------------
type RevertResult =
  | { kind: "ok"; savedAt: string | null; newSha: string; newBytes: number }
  | { kind: "not_found" }
  | { kind: "stale"; currentSha: string }
  | { kind: "unknown_version" }
  | { kind: "too_large" };

promptsRouter.post("/templates/:id/revert", async (c) => {
  const templateId = c.req.param("id");
  const editor = resolveEditor(c);
  const body = await c.req
    .json<{ target_version_id?: unknown; expected_sha256?: unknown }>()
    .catch(() => null);
  if (
    body === null ||
    typeof body.target_version_id !== "string" ||
    typeof body.expected_sha256 !== "string" ||
    body.expected_sha256.length !== EXPECTED_SHA_LENGTH
  ) {
    return c.json(
      { detail: "target_version_id and a 64-char expected_sha256 are required" },
      422,
    );
  }
  const targetVersionId = body.target_version_id;
  const expectedSha = body.expected_sha256;
  const versionId = crypto.randomUUID();

  const result = await withDb(c.env, c.executionCtx, (sql) =>
    sql.begin(async (tx): Promise<RevertResult> => {
      const rows = await tx<Pick<PromptTemplateRow, "category" | "sha256">[]>`
        SELECT category, sha256 FROM content_tool.prompt_templates
        WHERE template_id = ${templateId}
        FOR UPDATE
      `;
      const row = rows[0];
      if (row === undefined || !EDITABLE_CATEGORIES.has(row.category)) {
        return { kind: "not_found" };
      }
      const currentSha = row.sha256;
      if (currentSha !== expectedSha) {
        return { kind: "stale", currentSha };
      }

      const targetRows = await tx<{ body: string }[]>`
        SELECT body FROM content_tool.prompt_versions
        WHERE version_id = ${targetVersionId} AND template_id = ${templateId}
        LIMIT 1
      `;
      const target = targetRows[0];
      if (target === undefined) {
        return { kind: "unknown_version" };
      }

      const newText = target.body;
      const newBytes = utf8ByteLength(newText);
      if (newBytes > MAX_TEMPLATE_BYTES) {
        return { kind: "too_large" };
      }
      const newSha = await sha256Hex(newText);

      await tx`
        UPDATE content_tool.prompt_templates
        SET body = ${newText}, sha256 = ${newSha}, bytes = ${newBytes},
            updated_by = ${editor}, updated_at = now()
        WHERE template_id = ${templateId}
      `;
      const ins = await tx<{ saved_at: string }[]>`
        INSERT INTO content_tool.prompt_versions
          (version_id, template_id, sha256, parent_sha256, body, bytes, saved_by, kind)
        VALUES
          (${versionId}, ${templateId}, ${newSha}, ${currentSha}, ${newText}, ${newBytes}, ${editor}, 'revert')
        RETURNING saved_at
      `;
      return { kind: "ok", savedAt: ins[0]?.saved_at ?? null, newSha, newBytes };
    }),
  );

  switch (result.kind) {
    case "not_found":
      return c.json({ detail: `unknown template_id '${templateId}'` }, 404);
    case "stale":
      return c.json(
        {
          detail: {
            error: "stale_sha",
            message: "template was changed since you loaded it",
            current_sha256: result.currentSha,
          },
        },
        409,
      );
    case "unknown_version":
      return c.json({ detail: `unknown version_id '${targetVersionId}'` }, 404);
    case "too_large":
      return c.json({ detail: `target version exceeds ${MAX_TEMPLATE_BYTES} bytes` }, 413);
    case "ok":
      invalidate();
      return c.json({
        template_id: templateId,
        sha256: result.newSha,
        bytes: result.newBytes,
        version_id: versionId,
        saved_at: pgTimestampToIso(result.savedAt),
        saved_by: editor,
        reverted_from_version_id: targetVersionId,
      });
  }
});

export default promptsRouter;
